/**
 * Installs what the operator's deployment file (`rakazo.jsonc`) lists into every account: its MCP
 * servers and skills as one install, and each listed plugin as another. They are ordinary
 * capability installs, so runs, Integrations, OAuth and health checks treat them like any
 * plugin, but they are read-only to users and follow the file: a changed file replaces them.
 */
import { createHash } from "node:crypto";
import type { PluginRepoFetcher, PluginSkillEntry } from "@rakazo/adapters";
import {
  buildMcpCredentialBlob,
  deploymentSkills,
  mcpStdioRefusal,
  parsePluginDirectory,
  persistPreparedSecret,
  previewPluginInstall,
  readPluginFolder,
} from "@rakazo/adapters";
import type { Actor, DeploymentConfig, McpServerConfigInput } from "@rakazo/contracts";
import { McpServerConfigInput as McpServerConfigSchema } from "@rakazo/contracts";
import type { Prisma } from "@rakazo/db";
import { runAsSystem, runAsSystemInTransaction, runAsTenant, spaceAvailability } from "@rakazo/db";
import { getLogger } from "@rakazo/logging";
import { assertNameFreeWhereAvailable, lockOwner } from "./availability.js";
import { assertMcpRemoteEndpoint, mayUsePrivateEndpoint, mcpStdioPolicy } from "./mcp-servers.js";
import type { RouterDeps } from "./router.js";
import { computerContext } from "./routes/shared.js";

/** Sources of the installs this module owns; nothing else may start with it. */
export const DEPLOYMENT_SOURCE_PREFIX = "deployment:";
const CONFIG_SOURCE = `${DEPLOYMENT_SOURCE_PREFIX}config`;
const RETRY_MS = 60_000;

export function isDeploymentInstall(install: { source: string } | null | undefined): boolean {
  return Boolean(install?.source.startsWith(DEPLOYMENT_SOURCE_PREFIX));
}

type UnitServer = { name: string; input: McpServerConfigInput; allBots: boolean };

/** One install the file asks for. */
export type DeploymentUnit = {
  source: string;
  name: string;
  description: string;
  digest: string;
  servers: UnitServer[];
  skills: PluginSkillEntry[];
  version: string | null;
};

/** A plugin that could not be read now keeps whatever was installed from it before. */
type UnitState = DeploymentUnit | { source: string; unavailable: true };

function sha256(value: unknown): string {
  return `sha256:${createHash("sha256").update(JSON.stringify(value)).digest("hex")}`;
}

/** The file's `mcp` entries as the inputs the MCP routes validate. */
export function configServers(config: DeploymentConfig): UnitServer[] {
  return Object.entries(config.mcp).map(([name, server]) => {
    const base = {
      slug: "deployment",
      name,
      description: server.description ?? "",
      enabled: server.enabled,
    };
    const input =
      server.type === "remote"
        ? McpServerConfigSchema.parse({
            ...base,
            transport: server.transport === "sse" ? "sse" : "streamable_http",
            endpoint: server.url,
            headers: server.headers,
          })
        : McpServerConfigSchema.parse({
            ...base,
            transport: "stdio",
            command: server.command[0],
            args: server.command.slice(1),
            env: server.environment,
          });
    return { name, input, allBots: server.allBots };
  });
}

/** Reads the file's own entries and each plugin it lists. */
export async function deploymentUnits(
  config: DeploymentConfig,
  fetcher: PluginRepoFetcher | undefined,
  policy: unknown,
): Promise<UnitState[]> {
  const units: UnitState[] = [];
  const servers = configServers(config);
  const skills = deploymentSkills(config);
  if (servers.length || skills.length) {
    units.push({
      source: CONFIG_SOURCE,
      name: "Server configuration",
      description: "Set by the server's administrator",
      digest: sha256({ servers, skills, policy }),
      servers,
      skills,
      version: null,
    });
  }
  for (const source of config.plugins) {
    const key = `${DEPLOYMENT_SOURCE_PREFIX}plugin:${source}`;
    try {
      const plugin = source.startsWith("/")
        ? parsePluginDirectory(await readPluginFolder(source))
        : await previewPluginInstall({ source, fetcher });
      for (const skipped of plugin.skipped)
        getLogger().warn("deployment plugin part skipped", {
          "plugin.source": source,
          "plugin.part": skipped.name,
          reason: skipped.reason,
        });
      units.push({
        source: key,
        name: plugin.name,
        description: plugin.description,
        digest: sha256({ plugin: plugin.digest, policy }),
        servers: plugin.mcpServers.map((server) => ({
          name: server.name,
          allBots: true,
          input: McpServerConfigSchema.parse({
            slug: "deployment",
            name: `${plugin.name}: ${server.name}`.slice(0, 120),
            transport: server.transport,
            endpoint: server.endpoint,
            headers: server.headers,
          }),
        })),
        skills: plugin.skills,
        version: plugin.resolvedSha,
      });
    } catch (error) {
      getLogger().error("deployment plugin could not be read", {
        "plugin.source": source,
        error: error instanceof Error ? error.message : String(error),
      });
      units.push({ source: key, unavailable: true });
    }
  }
  return units;
}

/** What a unit's install shows in Integrations, in the shape plugin previews use. */
function previewConfig(unit: DeploymentUnit): Prisma.InputJsonValue {
  return {
    format: "agent-plugins",
    name: unit.name,
    version: null,
    description: unit.description,
    author: null,
    homepage: null,
    repository: null,
    license: null,
    keywords: [],
    resolvedSha: unit.version ?? createHash("sha1").update(unit.digest).digest("hex"),
    digest: unit.digest,
    skipped: [],
    builtinNames: [],
    skills: unit.skills.map(({ name, description }) => ({ name, description })),
    mcpServers: unit.servers.flatMap(({ name, input }) =>
      input.transport === "stdio"
        ? []
        : [
            {
              name,
              transport: input.transport,
              endpoint: input.endpoint,
              staticHeaderKeys: Object.keys(input.headers),
            },
          ],
    ),
    requestedRef: null,
    subdir: null,
    parts: ["connector", "skills"],
    managed: true,
  };
}

type Removal = (
  tx: Prisma.TransactionClient,
  actor: Actor,
  server: { id: string; secretId: string | null },
) => Promise<Array<{ threadId: string; seq: number }>>;

export type DeploymentSyncDeps = Pick<
  RouterDeps,
  "prisma" | "secrets" | "env" | "remoteConnectors" | "events" | "pluginRepoFetcher"
> & {
  removeMcpServerInTransaction: Removal;
};

export function createDeploymentSync(config: DeploymentConfig, deps: DeploymentSyncDeps) {
  const log = getLogger();
  // Validation depends on these settings too, so a changed policy installs again.
  const policy = {
    stdio: mcpStdioPolicy(deps),
    privateEndpoints: mayUsePrivateEndpoint(deps),
  };
  let units: UnitState[] | undefined;
  let fingerprint = "";
  const synced = new Map<string, string>();
  const retryAt = new Map<string, number>();
  const inFlight = new Map<string, Promise<void>>();

  /** Refuses a server this deployment would not run, as the MCP routes do, minus the admin check. */
  async function assertRunnable(server: UnitServer) {
    if (server.input.transport === "stdio") {
      const refusal = mcpStdioRefusal(server.input.command, policy.stdio);
      if (refusal) throw new Error(`MCP server ${server.name}: ${refusal}`);
      return;
    }
    try {
      await assertMcpRemoteEndpoint(server.input.endpoint, deps);
    } catch (error) {
      throw new Error(
        `MCP server ${server.name}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  async function removeInstall(
    tx: Prisma.TransactionClient,
    actor: Actor,
    install: { id: string },
    notify: Array<{ threadId: string; seq: number }>,
  ) {
    const servers = await tx.mcpServer.findMany({
      where: { installId: install.id, userId: actor.userId },
      select: { id: true, secretId: true },
    });
    for (const server of servers)
      notify.push(...(await deps.removeMcpServerInTransaction(tx, actor, server)));
    await tx.agentSkill.deleteMany({ where: { installId: install.id } });
    await tx.capabilityInstall.delete({ where: { id: install.id } });
  }

  /** Brings one account's installs in line with `unit`; the prepared secrets are already stored. */
  async function writeUnit(
    tx: Prisma.TransactionClient,
    actor: Actor,
    unit: DeploymentUnit,
    stored: Array<Awaited<ReturnType<RouterDeps["secrets"]["put"]>> | null>,
  ) {
    const install = await tx.capabilityInstall.create({
      data: {
        spaceId: actor.spaceId,
        userId: actor.userId,
        allSpaces: true,
        kind: "plugin",
        name: unit.name,
        source: unit.source,
        version: unit.version,
        digest: unit.digest,
        config: previewConfig(unit),
      },
    });
    const everywhere = spaceAvailability({
      spaceId: actor.spaceId,
      allSpaces: true,
      availableIn: [],
    });
    await runAsSystemInTransaction(tx, "add the deployment's skills to an account", async () => {
      for (const skill of unit.skills) {
        try {
          await assertNameFreeWhereAvailable(tx, "skill", actor, skill.name, everywhere);
        } catch {
          // The account's own skill keeps the name; the deployment's is left out for it.
          log.warn("deployment skill name already used", { "skill.name": skill.name });
          continue;
        }
        await tx.agentSkill.create({
          data: {
            spaceId: actor.spaceId,
            userId: actor.userId,
            allSpaces: true,
            name: skill.name,
            description: skill.description,
            content: skill.content,
            ...(skill.files ? { files: skill.files } : {}),
            source: "plugin",
            installId: install.id,
          },
        });
      }
      for (const [index, server] of unit.servers.entries()) {
        const secret = stored[index];
        if (secret)
          await tx.secret.create({
            data: {
              id: secret.id,
              userId: actor.userId,
              spaceId: null,
              kind: "mcp",
              ciphertext: secret.ciphertext,
            },
          });
        const input = server.input;
        const suffix = createHash("sha256")
          .update(`${install.id}:${index}`)
          .digest("hex")
          .slice(0, 12);
        await tx.mcpServer.create({
          data: {
            spaceId: actor.spaceId,
            userId: actor.userId,
            allSpaces: true,
            allBots: server.allBots,
            installId: install.id,
            slug: `${server.name.replace(/[^a-z0-9_-]/g, "-").slice(0, 48)}-${suffix}`,
            name: input.name,
            description: input.description || `Set by the server's administrator`,
            transport: input.transport,
            endpoint: "endpoint" in input ? input.endpoint : null,
            command: "command" in input ? input.command : null,
            hasArgs: "args" in input && input.args.length > 0,
            env: ("env" in input
              ? Object.fromEntries(Object.keys(input.env).map((key) => [key, true]))
              : {}) as Prisma.InputJsonValue,
            headers: ("headers" in input
              ? Object.fromEntries(Object.keys(input.headers).map((key) => [key, true]))
              : {}) as Prisma.InputJsonValue,
            secretId: secret?.id,
            enabled: input.enabled,
          },
        });
      }
    });
  }

  /** Encrypts each server's credentials, then commits the unit; unreferenced secrets are removed. */
  async function installUnit(actor: Actor, unit: DeploymentUnit) {
    for (const server of unit.servers) await assertRunnable(server);
    const stored: Array<Awaited<ReturnType<RouterDeps["secrets"]["put"]>> | null> = [];
    const notify: Array<{ threadId: string; seq: number }> = [];
    const prepare = async (index: number): Promise<void> => {
      const server = unit.servers[index];
      if (!server) {
        await deps.prisma.$transaction(async (tx) => {
          await lockOwner(tx, actor.userId, "plugin");
          // Another instance may have done this meanwhile.
          const now = await runAsSystemInTransaction(tx, "the account's deployment installs", () =>
            tx.capabilityInstall.findFirst({
              where: { userId: actor.userId, kind: "plugin", source: unit.source },
            }),
          );
          if (now?.digest === unit.digest) return;
          if (now) await removeInstall(tx, actor, now, notify);
          await writeUnit(tx, actor, unit, stored);
        });
        return;
      }
      const material = buildMcpCredentialBlob(server.input);
      const secret = material
        ? await deps.secrets.put(material, computerContext(actor, "mcp", "mcp.create"))
        : null;
      stored.push(secret);
      return persistPreparedSecret(deps.prisma, deps.secrets, secret ?? undefined, () =>
        prepare(index + 1),
      );
    };
    await prepare(0);
    for (const event of notify) await deps.events.notify(event.threadId, event.seq);
  }

  async function syncAccount(actor: Actor, wanted: UnitState[]) {
    const existing = await runAsSystem("the account's deployment installs", () =>
      deps.prisma.capabilityInstall.findMany({
        where: {
          userId: actor.userId,
          kind: "plugin",
          source: { startsWith: DEPLOYMENT_SOURCE_PREFIX },
        },
        select: { id: true, source: true, digest: true },
      }),
    );
    const failures: string[] = [];
    for (const unit of wanted) {
      if ("unavailable" in unit) continue;
      const current = existing.find((install) => install.source === unit.source) ?? null;
      if (current?.digest === unit.digest) continue;
      try {
        await installUnit(actor, unit);
      } catch (error) {
        failures.push(`${unit.name}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    const keep = new Set(wanted.map((unit) => unit.source));
    const stale = existing.filter((install) => !keep.has(install.source));
    if (stale.length) {
      const notify: Array<{ threadId: string; seq: number }> = [];
      await deps.prisma.$transaction(async (tx) => {
        await lockOwner(tx, actor.userId, "plugin");
        for (const install of stale) await removeInstall(tx, actor, install, notify);
      });
      for (const event of notify) await deps.events.notify(event.threadId, event.seq);
    }
    if (failures.length) throw new Error(failures.join("; "));
  }

  /** Installs the file's capabilities for this account once per process and file version. */
  async function ensure(actor: Actor): Promise<void> {
    if (!units) return;
    if (synced.get(actor.userId) === fingerprint) return;
    if ((retryAt.get(actor.userId) ?? 0) > Date.now()) return;
    const running = inFlight.get(actor.userId);
    if (running) return running;
    const wanted = units;
    const version = fingerprint;
    const run = runAsTenant(actor, () => syncAccount(actor, wanted))
      .then(() => {
        synced.set(actor.userId, version);
        retryAt.delete(actor.userId);
      })
      .catch((error: unknown) => {
        retryAt.set(actor.userId, Date.now() + RETRY_MS);
        log.error("deployment capabilities could not be installed", {
          "user.id": actor.userId,
          error: error instanceof Error ? error.message : String(error),
        });
      })
      .finally(() => inFlight.delete(actor.userId));
    inFlight.set(actor.userId, run);
    return run;
  }

  /** Every account that belongs to a space, in the first space it joined. */
  async function accounts(): Promise<Actor[]> {
    return runAsSystem("install the deployment's capabilities for every account", async () => {
      const members = await deps.prisma.spaceMember.findMany({
        orderBy: [{ userId: "asc" }, { createdAt: "asc" }],
        distinct: ["userId"],
        select: { userId: true, spaceId: true },
      });
      const users = await deps.prisma.user.findMany({
        where: { id: { in: members.map((member) => member.userId) } },
        select: { id: true, email: true },
      });
      const emails = new Map(users.map((user) => [user.id, user.email]));
      return members.flatMap((member) => {
        const email = emails.get(member.userId);
        return email
          ? [{ userId: member.userId, spaceId: member.spaceId, email, isDeploymentOwner: false }]
          : [];
      });
    });
  }

  return {
    ensure,
    /** Reads the file's plugins, then brings every existing account up to date. */
    async start(): Promise<void> {
      units = await deploymentUnits(config, deps.pluginRepoFetcher, policy);
      fingerprint = sha256(units);
      const ready = units.filter((unit) => !("unavailable" in unit)).length;
      log.info("deployment capabilities loaded", {
        "deployment.units": ready,
        "deployment.unavailable": units.length - ready,
      });
      for (const actor of await accounts()) await ensure(actor);
    },
  };
}

export type DeploymentSync = ReturnType<typeof createDeploymentSync>;
