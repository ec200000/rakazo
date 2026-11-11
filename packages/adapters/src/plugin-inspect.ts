/**
 * Lists what one git repository offers before anything is installed: the plugins its catalog
 * index names, or, without an index, every plugin folder and skill folder in it. One shallow
 * snapshot is read as data; nothing from the repository runs.
 */
import type { PluginMarketplaceEntry, PluginMarketplaceInspection } from "@rakazo/contracts";
import { parseSkillMd } from "@rakazo/core";
import { folderPluginName, parsePluginSource } from "./plugin-connectors.js";
import type { GitHosts, GitRunner, GitSnapshot } from "./plugin-git.js";
import { ANY_GIT_HOST, gitHostCredentials, withGitSnapshot } from "./plugin-git.js";
import { PLUGIN_INDEX_FORMATS, parsePluginMarketplace } from "./plugin-marketplace.js";

type InspectedPlugin = PluginMarketplaceInspection["plugins"][number];
type InspectedSkill = NonNullable<InspectedPlugin["skills"]>[number];

const MAX_PLUGINS = 500;
/** SKILL.md files read for their names; later ones are listed by folder name. */
const MAX_READ_SKILLS = 400;
const MAX_SKILL_BYTES = 100_000;
const READ_CONCURRENCY = 8;
const PLUGIN_MANIFESTS = [
  ".claude-plugin/plugin.json",
  ".cursor-plugin/plugin.json",
  ".grok-plugin/plugin.json",
];
const BUNDLED_SKILL = /^(?:(.*)\/)?skills\/([^/]+)\/SKILL\.md$/;
const LONE_SKILL = /^(?:(.*)\/)?SKILL\.md$/;

export async function inspectPluginRepository(
  url: string,
  options: { hosts: GitHosts; run?: GitRunner; signal?: AbortSignal },
): Promise<PluginMarketplaceInspection> {
  const ref = parsePluginSource(url);
  const host = new URL(ref.gitUrl).hostname.toLowerCase();
  // A public github.com repository is read over git like any other, without credentials.
  const hosts: GitHosts =
    host === "github.com" && !options.hosts.has(host)
      ? new Map([...options.hosts, [host, { username: "x-access-token" }]])
      : options.hosts;
  if (!gitHostCredentials(hosts, host)) {
    throw new Error(
      `${host} is not an allowed git host on this server. Ask your administrator to allow it.`,
    );
  }
  try {
    return await withGitSnapshot(
      ref.gitUrl,
      ref.ref,
      { hosts, run: options.run, signal: options.signal },
      (snapshot) => inspectSnapshot(snapshot, ref, hosts),
    );
  } catch (error) {
    throw new Error(gitFailure(error, host));
  }
}

async function inspectSnapshot(
  snapshot: GitSnapshot,
  ref: ReturnType<typeof parsePluginSource>,
  hosts: GitHosts,
): Promise<PluginMarketplaceInspection> {
  const base = ref.subdir ? `${ref.subdir}/` : "";
  const blobs = snapshot.entries.filter(
    (entry) => entry.type === "blob" && entry.mode !== "120000" && entry.path.startsWith(base),
  );
  const paths = new Set(blobs.map((entry) => entry.path.slice(base.length)));
  const sizes = new Map(blobs.map((entry) => [entry.path.slice(base.length), entry.size ?? 0]));
  if (!paths.size && ref.subdir) throw new Error(`Folder "${ref.subdir}" not found`);
  const repository = ref.gitUrl + (ref.ref ? `@${ref.ref}` : "");
  const repoName = decodeURIComponent(new URL(ref.gitUrl).pathname.split("/").at(-1) ?? "");
  const reader = skillReader(snapshot, base, sizes);

  const index = PLUGIN_INDEX_FORMATS.find((format) => paths.has(format.path));
  let indexName: string | undefined;
  let plugins: InspectedPlugin[] = [];
  let skipped = 0;
  if (index) {
    const text = await snapshot.read(`${base}${index.path}`);
    indexName = indexTitle(text);
    const hostNames = new Set([...hosts.keys()].filter((key) => key !== ANY_GIT_HOST));
    if (hosts.has(ANY_GIT_HOST)) hostNames.add(ANY_GIT_HOST);
    const parsed = parsePluginMarketplace(
      text,
      { name: indexName ?? repoName, repository },
      hostNames,
      base,
    );
    skipped = parsed.skipped;
    plugins = await Promise.all(
      parsed.entries.map(async (entry) => {
        const dir = localFolder(entry, ref.gitUrl, base);
        const skills = dir === null ? null : await reader.pluginSkills(dir, paths);
        return { ...entry, skillCount: skills?.length ?? 0, skills };
      }),
    );
  }
  const indexed = plugins.length > 0;
  if (!indexed) plugins = await discover(paths, reader, ref, repoName);
  plugins.sort((a, b) => a.displayName.localeCompare(b.displayName));
  return {
    url: repository + (ref.subdir ? `#${ref.subdir}` : ""),
    name: indexName ?? repoName,
    sha: snapshot.sha,
    indexed,
    plugins: plugins.slice(0, MAX_PLUGINS),
    skipped: skipped + Math.max(0, plugins.length - MAX_PLUGINS),
  };
}

/** Plugin folders (a manifest, or a skills/ folder) and lone skill folders, outermost first. */
async function discover(
  paths: Set<string>,
  reader: ReturnType<typeof skillReader>,
  ref: ReturnType<typeof parsePluginSource>,
  repoName: string,
): Promise<InspectedPlugin[]> {
  const roots = new Set<string>();
  for (const path of paths) {
    const bundled = BUNDLED_SKILL.exec(path);
    if (bundled) roots.add(bundled[1] ?? "");
    for (const manifest of PLUGIN_MANIFESTS) {
      if (path === manifest) roots.add("");
      else if (path.endsWith(`/${manifest}`)) roots.add(path.slice(0, -manifest.length - 1));
    }
  }
  const lone = [...paths].flatMap((path) => {
    if (BUNDLED_SKILL.test(path)) return [];
    const match = LONE_SKILL.exec(path);
    return match ? [match[1] ?? ""] : [];
  });
  const base = ref.subdir ? `${ref.subdir}/` : "";
  const entry = (dir: string, fields: Partial<PluginMarketplaceEntry>): PluginMarketplaceEntry => {
    const full = `${base}${dir}`.replace(/\/+$/, "");
    const suffix = full ? `#${full}` : "";
    const source = ref.gitUrl + (ref.ref ? `@${ref.ref}` : "") + suffix;
    const name = fields.name ?? folderPluginName({ gitUrl: ref.gitUrl, subdir: full });
    return {
      id: `${repoName}:${source}`,
      name,
      displayName: fields.displayName ?? titleCase(name),
      description: fields.description ?? "",
      keywords: [],
      category: null,
      logo: null,
      homepage: null,
      domains: [],
      registry: repoName,
      source,
      installedSource: ref.gitUrl + suffix,
      hasConnector: fields.hasConnector ?? false,
      skillCount: 0,
    };
  };
  const plugins: InspectedPlugin[] = [];
  for (const dir of [...roots].sort()) {
    const skills = await reader.pluginSkills(dir, paths);
    const manifest = await reader.manifest(dir, paths);
    const prefix = dir ? `${dir}/` : "";
    plugins.push({
      ...entry(dir, {
        ...(manifest?.name ? { name: manifest.name } : {}),
        description: manifest?.description ?? "",
        hasConnector: paths.has(`${prefix}mcp.json`) || paths.has(`${prefix}.mcp.json`),
      }),
      skillCount: skills.length,
      skills,
    });
  }
  for (const dir of lone.sort()) {
    const [skill] = await reader.skills([`${dir ? `${dir}/` : ""}SKILL.md`]);
    if (!skill) continue;
    plugins.push({
      ...entry(dir, {
        displayName: skill.name,
        description: skill.description,
      }),
      skillCount: 1,
      skills: [skill],
    });
  }
  return plugins;
}

function skillReader(snapshot: GitSnapshot, base: string, sizes: Map<string, number>) {
  let budget = MAX_READ_SKILLS;
  async function skills(files: string[]): Promise<InspectedSkill[]> {
    const out: InspectedSkill[] = new Array(files.length);
    const queue = files.map((path, index) => ({ path, index }));
    await Promise.all(
      Array.from({ length: READ_CONCURRENCY }, async () => {
        for (let job = queue.shift(); job; job = queue.shift()) {
          out[job.index] = await skill(job.path);
        }
      }),
    );
    return out.sort((a, b) => a.name.localeCompare(b.name));
  }
  async function skill(path: string): Promise<InspectedSkill> {
    const folder = path.split("/").at(-2) ?? path;
    const fallback =
      path.endsWith("/SKILL.md") || path === "SKILL.md"
        ? folder
        : path.split("/").at(-1)!.replace(/\.md$/, "");
    if ((sizes.get(path) ?? 0) > MAX_SKILL_BYTES)
      return { name: fallback, description: "", problem: "SKILL.md is too large" };
    if (budget <= 0) return { name: fallback, description: "" };
    budget -= 1;
    try {
      const parsed = parseSkillMd(await snapshot.read(`${base}${path}`));
      return "error" in parsed
        ? { name: fallback, description: "", problem: parsed.error }
        : { name: parsed.name, description: parsed.description };
    } catch {
      return { name: fallback, description: "", problem: "Could not be read" };
    }
  }
  return {
    skills,
    /** A plugin folder's skills, and its sub-agents, which install as skills too. */
    pluginSkills(dir: string, paths: Set<string>) {
      const prefix = dir ? `${dir}/` : "";
      const files = [...paths].filter((path) => {
        if (!path.startsWith(prefix)) return false;
        const rest = path.slice(prefix.length);
        return /^skills\/[^/]+\/SKILL\.md$/.test(rest) || /^agents\/[^/]+\.md$/.test(rest);
      });
      return skills(files);
    },
    async manifest(dir: string, paths: Set<string>) {
      const prefix = dir ? `${dir}/` : "";
      const path = PLUGIN_MANIFESTS.map((manifest) => `${prefix}${manifest}`).find((candidate) =>
        paths.has(candidate),
      );
      if (!path || (sizes.get(path) ?? 0) > 64_000) return undefined;
      try {
        const raw = JSON.parse(await snapshot.read(`${base}${path}`)) as Record<string, unknown>;
        return {
          name: typeof raw.name === "string" ? raw.name : undefined,
          description: typeof raw.description === "string" ? raw.description : undefined,
        };
      } catch {
        return undefined;
      }
    },
  };
}

/** The folder of an index entry inside this repository, relative to `base`; null when elsewhere. */
function localFolder(entry: PluginMarketplaceEntry, gitUrl: string, base: string): string | null {
  const installed = entry.installedSource;
  const dir =
    installed === gitUrl
      ? ""
      : installed.startsWith(`${gitUrl}#`)
        ? installed.slice(gitUrl.length + 1)
        : null;
  if (dir === null) return null;
  if (!base) return dir;
  const root = base.slice(0, -1);
  if (dir === root) return "";
  return dir.startsWith(base) ? dir.slice(base.length) : null;
}

function indexTitle(text: string): string | undefined {
  try {
    const name = (JSON.parse(text) as { name?: unknown }).name;
    return typeof name === "string" && name.trim() ? name.trim().slice(0, 120) : undefined;
  } catch {
    return undefined;
  }
}

function titleCase(name: string): string {
  return name
    .split(/[-_\s]+/)
    .filter(Boolean)
    .map((word) => word[0]!.toUpperCase() + word.slice(1))
    .join(" ");
}

/** git's last error line, with the cases a person can act on spelled out. */
function gitFailure(error: unknown, host: string): string {
  const message = error instanceof Error ? error.message : String(error);
  // Only git's own failures need explaining; the inspector's are already plain.
  if (!message.startsWith("git ")) return message;
  if (
    /could not read Username|Authentication failed|HTTP 401|HTTP 403|returned error: 40[13]/i.test(
      message,
    )
  )
    return `${host} asked for a login. Ask your administrator to add a token for it under git.hosts in rakazo.jsonc.`;
  if (
    /not found|HTTP 404|returned error: 404|not a git repository|repository exists/i.test(message)
  )
    return "Repository not found. Check the URL, and that it points at a git repository.";
  if (/Could not resolve host/i.test(message))
    return `Could not find the host ${host}. Check the URL.`;
  if (/SSL certificate|server certificate verification failed|self.signed/i.test(message))
    return `${host}'s certificate is not trusted. Ask your administrator to add its CA to Rakazo's trusted CAs.`;
  if (/couldn't find remote ref|unknown revision/i.test(message))
    return "That branch, tag or commit was not found in the repository.";
  return message;
}
