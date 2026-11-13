import { createHash } from "node:crypto";
import { ORPCError } from "@orpc/server";
import {
  AZURE_DEVOPS_PRESET_ID,
  applyMcpSourcePreset,
  azureDevOpsInstallConfig,
  azureDevOpsPreset,
  createPluginMarketplace,
  gitHostsFromConfig,
  inspectPluginRepository,
  isTransientFetchError,
  JENKINS_PRESET_ID,
  jenkinsInstallConfig,
  jenkinsPreset,
  mcpSourcePresets,
  OPENSHIFT_PRESET_ID,
  openshiftInstallConfig,
  pluginPreviewDto,
  prepareApiInstall,
  prepareGraphqlInstall,
  previewPluginInstall,
  sanitizeIntegrationError,
  verifyMcpInstall,
} from "@rakazo/adapters";
import type { Actor } from "@rakazo/contracts";
import { comparePlugins, containsSecret, matchesPluginQuery } from "@rakazo/core";
import type { Prisma } from "@rakazo/db";
import { AVAILABILITY_SELECT, availableInSpace, itemSecretIn, spaceAvailability } from "@rakazo/db";
import { requireAdmin } from "../admins.js";
import { syncAllBranchBuildWatches } from "../auto-routines.js";
import { isDeploymentInstall } from "../deployment-capabilities.js";
import { searchIntegrationCatalog } from "../integration-catalog.js";
import { assertMcpRemoteEndpoint, mayUsePrivateEndpoint } from "../mcp-servers.js";
import { installPlugin, lockPluginInstalls, setPluginParts } from "../plugin-installs.js";
import {
  approvedPluginEntries,
  listPluginSubmissions,
  reviewPluginSubmission,
} from "../plugin-submissions.js";
import type { RouterContext } from "./context.js";

export function capabilitiesRoutes(ctx: RouterContext) {
  const { deps, removeMcpServerInTransaction, authed } = ctx;
  const config = deps.deploymentConfig;
  const pluginMarketplace = createPluginMarketplace(deps.pluginMarketplaceRead, {
    registries: config?.marketplaces,
    defaultRegistries: config?.defaultMarketplaces,
    hosts: gitHostsFromConfig(config ?? null),
  });
  /** Installs from the deployment file follow the file; users cannot remove or trim them. */
  const assertNotManaged = async (actor: Actor, id: string) => {
    const install = await deps.prisma.capabilityInstall.findFirst({
      where: { id, ...availableInSpace(actor) },
      select: { source: true },
    });
    if (isDeploymentInstall(install))
      throw new ORPCError("FORBIDDEN", {
        message: "This is set by the server's administrator and can't be changed here",
      });
  };
  /** Removes an install and, for a plugin, the servers, secrets and skills it added. */
  const removeInstall = async (actor: Actor, id: string) => {
    const notify: Array<{ threadId: string; seq: number }> = [];
    await deps.prisma.$transaction(async (tx) => {
      // Parts changes hold this lock while adding children; reading them without it could
      // miss a connector committed meanwhile and leave its secret behind.
      await lockPluginInstalls(tx, actor);
      const existing = await tx.capabilityInstall.findFirst({
        where: { id, ...availableInSpace(actor) },
      });
      if (!existing) return;
      if (existing.kind === "plugin") {
        const servers = await tx.mcpServer.findMany({
          where: { installId: existing.id, userId: actor.userId },
          select: { id: true, secretId: true },
        });
        for (const server of servers) {
          notify.push(...(await removeMcpServerInTransaction(tx, actor, server)));
        }
        await tx.agentSkill.deleteMany({ where: { installId: existing.id } });
      }
      await tx.capabilityInstall.delete({ where: { id: existing.id } });
      if (existing.secretId) {
        const shared = await tx.capabilityInstall.count({
          where: { secretId: existing.secretId },
        });
        if (shared === 0) {
          await tx.secret.deleteMany({
            where: { id: existing.secretId, ...itemSecretIn(actor) },
          });
        }
      }
    });
    for (const event of notify) await deps.events.notify(event.threadId, event.seq);
  };
  return {
    marketplace: {
      inspect: authed.marketplace.inspect.handler(async ({ input, context }) => {
        try {
          return await inspectPluginRepository(input.url, {
            hosts: gitHostsFromConfig(config ?? null),
            signal: context.signal,
          });
        } catch (error) {
          throw new ORPCError("BAD_REQUEST", {
            message: error instanceof Error ? error.message : "Could not read the repository",
          });
        }
      }),
      catalog: authed.marketplace.catalog.handler(async ({ input }) => {
        const [catalog, approved] = await Promise.all([
          pluginMarketplace.catalog(input.query),
          approvedPluginEntries(deps.prisma),
        ]);
        // A plugin also listed by another registry shows once, as the version we reviewed.
        const reviewed = new Set(approved.map((entry) => entry.installedSource));
        return {
          ...catalog,
          entries: [
            ...approved.filter((entry) => matchesPluginQuery(entry, input.query)),
            ...catalog.entries.filter((entry) => !reviewed.has(entry.installedSource)),
          ].sort(comparePlugins),
        };
      }),
      submissions: authed.marketplace.submissions.handler(async ({ context, input }) => {
        await requireAdmin(deps, context.actor.userId);
        return listPluginSubmissions(deps.prisma, input.status);
      }),
      review: authed.marketplace.review.handler(async ({ context, input }) => {
        await requireAdmin(deps, context.actor.userId);
        return reviewPluginSubmission(deps, input, context.signal);
      }),
    },
    capabilities: {
      list: authed.capabilities.list.handler(async ({ context }) => {
        const rows = await deps.prisma.capabilityInstall.findMany({
          where: availableInSpace(context.actor),
          include: { availableIn: AVAILABILITY_SELECT },
        });
        return rows.map((row) => ({
          id: row.id,
          kind: row.kind as "skill" | "plugin" | "mcp" | "api" | "connection",
          name: row.name,
          source: row.source,
          version: row.version,
          digest: row.digest,
          secretConfigured: Boolean(row.secretId),
          config: row.config as Record<string, unknown>,
          availability: spaceAvailability(row),
          createdAt: row.createdAt.toISOString(),
        }));
      }),
      sourcePresets: authed.capabilities.sourcePresets.handler(() =>
        mcpSourcePresets({
          echoUrl: deps.env.echoUrl,
          azureDevOpsUrl: deps.env.azureDevOpsUrl,
          jenkinsUrl: deps.env.jenkinsUrl,
        }),
      ),
      catalogSearch: authed.capabilities.catalogSearch.handler(async ({ context, input }) => {
        const baseUrl =
          deps.env.integrationsCatalogUrl ??
          (input.usePublicCatalog ? "https://integrations.sh" : undefined);
        if (!baseUrl) return { enabled: false, results: [] };
        try {
          const results = await searchIntegrationCatalog({
            baseUrl,
            query: input.query,
            signal: context.signal ?? new AbortController().signal,
            fetch: deps.remoteConnectors?.fetch,
          });
          return { enabled: true, results };
        } catch (error) {
          throw new ORPCError("BAD_GATEWAY", {
            message: error instanceof Error ? error.message : "Integration catalog search failed",
          });
        }
      }),
      install: authed.capabilities.install.handler(async ({ context, input }) => {
        if (input.kind === "plugin") {
          return installPlugin(
            {
              prisma: deps.prisma,
              secrets: deps.secrets,
              fetcher: deps.pluginRepoFetcher,
              assertEndpoint: (endpoint) => assertMcpRemoteEndpoint(endpoint, deps),
            },
            context.actor,
            input,
            context.signal,
          );
        }
        let source = input.source.trim();
        let config = input.config;
        const credential = input.credential?.trim() || undefined;
        if (
          credential &&
          credential.length >= 8 &&
          (source.includes(credential) || containsSecret(config, [credential]))
        ) {
          throw new ORPCError("BAD_REQUEST", {
            message: "Put credentials only in the encrypted credential field",
          });
        }
        if (JSON.stringify(config).length > 2_000_000) {
          throw new ORPCError("BAD_REQUEST", { message: "Capability configuration is too large" });
        }
        if (
          credential &&
          input.kind !== "mcp" &&
          input.kind !== "api" &&
          input.kind !== "graphql"
        ) {
          throw new ORPCError("BAD_REQUEST", {
            message: "Credentials are only accepted for MCP, API, and GraphQL tool sources",
          });
        }
        try {
          if (input.kind === "mcp") {
            ({ source, config } = applyMcpSourcePreset(
              source,
              config,
              mcpSourcePresets({
                echoUrl: deps.env.echoUrl,
                azureDevOpsUrl: deps.env.azureDevOpsUrl,
              }),
            ));
            const verified = await verifyMcpInstall({
              source,
              config,
              credential,
              signal: context.signal,
              remote: deps.remoteConnectors,
              allowPrivateEndpoint: mayUsePrivateEndpoint(deps),
            });
            config = verified.config;
          }
          if (input.kind === "api") {
            // The Azure DevOps preset: the deployment's collection, its operations, the person's token.
            const azureDevOps = azureDevOpsPreset(deps.env.azureDevOpsUrl);
            if (config.preset === AZURE_DEVOPS_PRESET_ID) {
              if (!azureDevOps?.url)
                throw new Error("Azure DevOps is not configured on this server");
              source = azureDevOps.url;
              config = azureDevOpsInstallConfig(deps.env.azureDevOpsApiVersion);
            }
            // An OpenShift cluster: the person's own API URL and token; bots run oc and helm with it.
            if (config.preset === OPENSHIFT_PRESET_ID) {
              let api: URL;
              try {
                api = new URL(source);
              } catch {
                throw new Error(
                  "Enter the cluster's API URL, e.g. https://api.cluster.example:6443",
                );
              }
              if (api.protocol !== "https:")
                throw new Error("The cluster's API URL must use https");
              if (!credential) throw new Error("Paste your token from oc whoami -t");
              source = api.origin;
              config = openshiftInstallConfig();
            }
            // The Jenkins preset: the deployment's controller, its operations, the person's token.
            if (config.preset === JENKINS_PRESET_ID) {
              const jenkins = jenkinsPreset(deps.env.jenkinsUrl);
              if (!jenkins?.url) throw new Error("Jenkins is not configured on this server");
              source = jenkins.url;
              config = jenkinsInstallConfig();
            }
            const prepared = await prepareApiInstall({
              source,
              config,
              credential,
              signal: context.signal,
              remote: deps.remoteConnectors,
              allowPrivateEndpoint: mayUsePrivateEndpoint(deps),
            });
            source = prepared.source;
            config = prepared.config;
          }
          if (input.kind === "graphql") {
            const prepared = await prepareGraphqlInstall({
              source,
              config,
              credential,
              signal: context.signal,
              remote: deps.remoteConnectors,
              allowPrivateEndpoint: mayUsePrivateEndpoint(deps),
            });
            source = prepared.source;
            config = prepared.config;
          }
        } catch (error) {
          const message = sanitizeIntegrationError(error);
          throw new ORPCError("BAD_REQUEST", {
            message: credential ? message.split(credential).join("[redacted]") : message,
          });
        }
        const stored = credential
          ? await deps.secrets.put(credential, {
              operationId: "capabilities.install",
              traceId: "capabilities.install",
              spaceId: context.actor.spaceId,
              userId: context.actor.userId,
              signal: context.signal ?? new AbortController().signal,
            })
          : undefined;
        const digest = `sha256:${createHash("sha256")
          .update(JSON.stringify({ kind: input.kind, source, config }))
          .digest("hex")}`;
        const row = await deps.prisma.$transaction(async (tx) => {
          if (stored) {
            // A source the user adds reaches all their spaces, so its secret is the account's.
            await tx.secret.create({
              data: {
                id: stored.id,
                spaceId: null,
                userId: context.actor.userId,
                kind: "connector",
                ciphertext: stored.ciphertext,
              },
            });
          }
          return tx.capabilityInstall.create({
            data: {
              spaceId: context.actor.spaceId,
              userId: context.actor.userId,
              allSpaces: true,
              kind: input.kind,
              name: input.name.trim(),
              source,
              secretId: stored?.id,
              config: config as Prisma.InputJsonValue,
              digest,
              version: "1.0.0",
            },
          });
        });
        // Bots with Jenkins jobs start watching their branch's builds once Jenkins is connected.
        if (input.kind === "api" && jenkinsPreset(deps.env.jenkinsUrl)?.url === source) {
          await syncAllBranchBuildWatches(deps, context.actor);
        }
        return {
          id: row.id,
          kind: row.kind as "skill" | "plugin" | "mcp" | "api" | "connection",
          name: row.name,
          source: row.source,
          version: row.version,
          digest: row.digest,
          secretConfigured: Boolean(row.secretId),
          config: row.config as Record<string, unknown>,
          availability: spaceAvailability(row),
          createdAt: row.createdAt.toISOString(),
        };
      }),
      pluginPreview: authed.capabilities.pluginPreview.handler(async ({ context, input }) => {
        try {
          const preview = await previewPluginInstall({
            source: input.source,
            signal: context.signal,
            fetcher: deps.pluginRepoFetcher,
          });
          for (const server of preview.mcpServers) {
            await assertMcpRemoteEndpoint(server.endpoint, deps);
          }
          // Browse lists only plugins that install completely; one that turns out partial leaves it.
          if (preview.skipped.some((part) => part.kind !== "unsupported_field"))
            pluginMarketplace.markUnreadable(input.source);
          else pluginMarketplace.clearUnreadable(input.source);
          return {
            ...pluginPreviewDto(preview),
            pinnedSource: `${preview.source.gitUrl}@${preview.resolvedSha}${preview.source.subdir ? `#${preview.source.subdir}` : ""}`,
            installedSource: `${preview.source.gitUrl}${preview.source.subdir ? `#${preview.source.subdir}` : ""}`,
          };
        } catch (error) {
          // Only content we can't support leaves browse; a slow or failing GitHub is retried.
          if (!isTransientFetchError(error)) pluginMarketplace.markUnreadable(input.source);
          throw new ORPCError("BAD_REQUEST", {
            message: "Could not preview a supported plugin from this repository",
          });
        }
      }),
      remove: authed.capabilities.remove.handler(async ({ context, input }) => {
        await assertNotManaged(context.actor, input.id);
        await removeInstall(context.actor, input.id);
        return { ok: true as const };
      }),
      pluginParts: authed.capabilities.pluginParts.handler(async ({ context, input }) => {
        await assertNotManaged(context.actor, input.id);
        const notify: Array<{ threadId: string; seq: number }> = [];
        const install = await setPluginParts(
          {
            prisma: deps.prisma,
            secrets: deps.secrets,
            fetcher: deps.pluginRepoFetcher,
            assertEndpoint: (endpoint) => assertMcpRemoteEndpoint(endpoint, deps),
            removeServer: async (tx, server) =>
              notify.push(...(await removeMcpServerInTransaction(tx, context.actor, server))),
          },
          context.actor,
          input,
          context.signal,
        );
        for (const event of notify) await deps.events.notify(event.threadId, event.seq);
        if (!install) await removeInstall(context.actor, input.id);
        return { install };
      }),
    },
  };
}
