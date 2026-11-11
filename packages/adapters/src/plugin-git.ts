/**
 * Plugin acquisition from hosts other than github.com: any HTTPS git server the deployment file
 * lists (read with the git CLI), and folders on the server's own disk. Files are read as data
 * under the same limits as GitHub plugins; nothing from the repository is executed.
 */
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { lstat, mkdtemp, readdir, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import type { DeploymentConfig } from "@rakazo/contracts";
import type {
  PluginRepoEntry,
  PluginRepoFetcher,
  PluginRepoFile,
  PluginSourceRef,
} from "./plugin-connectors.js";
import { collectRepoFiles, fetchGitHubRepo } from "./plugin-connectors.js";

const FULL_SHA = /^[a-f0-9]{40}$/;
const MAX_LISTED_ENTRIES = 5000;
const MAX_READ_BYTES = 4_000_000;
const GIT_TIMEOUT_MS = 60_000;
/** Bundles that hold the system's trusted CAs on common Linux images. */
const SYSTEM_CA_BUNDLES = [
  "/etc/ssl/certs/ca-certificates.crt",
  "/etc/pki/tls/certs/ca-bundle.crt",
];

export type GitHostCredentials = { username: string; token?: string };
export type GitHosts = ReadonlyMap<string, GitHostCredentials>;
export type GitRunner = (
  args: string[],
  options: { cwd: string; env: NodeJS.ProcessEnv; signal: AbortSignal; maxBuffer: number },
) => Promise<Buffer>;

export const runGit: GitRunner = (args, options) =>
  new Promise((resolve, reject) => {
    execFile("git", args, { ...options, encoding: "buffer" }, (error, stdout, stderr) => {
      if (!error) return resolve(stdout);
      if ((error as { code?: unknown }).code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER")
        return reject(new Error("Plugin file is too large"));
      // stderr never holds the credential: it travels in config, not in the URL.
      const detail = stderr.toString("utf8").trim().split("\n").at(-1)?.slice(0, 300);
      reject(new Error(`git ${args[0]} failed${detail ? `: ${detail}` : ""}`));
    });
  });

/** The `git.hosts` key that allows every HTTPS git host. */
export const ANY_GIT_HOST = "*";

/**
 * How `host` may be read: its own entry, else the "*" entry, which allows every HTTPS host
 * anonymously. A token under "*" is never sent, so one host's key cannot reach another.
 */
export function gitHostCredentials(hosts: GitHosts, host: string): GitHostCredentials | undefined {
  const own = hosts.get(host.toLowerCase());
  if (own) return own;
  const any = hosts.get(ANY_GIT_HOST);
  return any ? { username: any.username } : undefined;
}

/** Whether plugins and marketplaces may come from `host` through git. */
export function allowsGitHost(hosts: GitHosts, host: string): boolean {
  const name = host.toLowerCase();
  // github.com keeps its public API unless the deployment lists it by name.
  if (name === "github.com") return hosts.has(name);
  return gitHostCredentials(hosts, name) !== undefined;
}

/** Hosts the deployment file allows, with their credentials. */
export function gitHostsFromConfig(
  config: DeploymentConfig | null,
): Map<string, GitHostCredentials> {
  return new Map(
    Object.entries(config?.git.hosts ?? {}).map(([host, entry]) => [host.toLowerCase(), entry]),
  );
}

let caBundle: Promise<string | undefined> | undefined;

/** System CAs plus NODE_EXTRA_CA_CERTS, as git replaces rather than extends its CA list. */
function extraCaBundle(): Promise<string | undefined> {
  caBundle ??= (async () => {
    const extra = process.env.NODE_EXTRA_CA_CERTS;
    if (!extra) return undefined;
    const parts: string[] = [];
    for (const path of SYSTEM_CA_BUNDLES) {
      const text = await readFile(path, "utf8").catch(() => undefined);
      if (text) {
        parts.push(text);
        break;
      }
    }
    parts.push(await readFile(extra, "utf8"));
    const dir = await mkdtemp(join(tmpdir(), "rakazo-ca-"));
    const path = join(dir, "ca.pem");
    await writeFile(path, parts.join("\n"), { mode: 0o600 });
    return path;
  })();
  return caBundle;
}

/**
 * Settings for one fetch, passed through GIT_CONFIG_* so the credential never appears on a
 * command line. Only https is allowed and the token is sent to its own host alone.
 */
export function gitEnvironment(
  home: string,
  gitUrl: string,
  credentials: GitHostCredentials,
  caFile: string | undefined,
  base: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const origin = new URL(gitUrl).origin;
  const config: Array<[string, string]> = [
    ["protocol.allow", "never"],
    ["protocol.https.allow", "always"],
    ["credential.helper", ""],
    ["core.askPass", ""],
  ];
  if (credentials.token) {
    const basic = Buffer.from(`${credentials.username}:${credentials.token}`).toString("base64");
    config.push([`http.${origin}/.extraHeader`, `Authorization: Basic ${basic}`]);
  }
  if (caFile) config.push(["http.sslCAInfo", caFile]);
  const env: NodeJS.ProcessEnv = {
    PATH: base.PATH,
    HOME: home,
    GIT_TERMINAL_PROMPT: "0",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_COUNT: String(config.length),
  };
  for (const key of ["HTTPS_PROXY", "https_proxy", "NO_PROXY", "no_proxy"]) {
    if (base[key]) env[key] = base[key];
  }
  for (const [index, [key, value]] of config.entries()) {
    env[`GIT_CONFIG_KEY_${index}`] = key;
    env[`GIT_CONFIG_VALUE_${index}`] = value;
  }
  return env;
}

export type GitSnapshot = {
  sha: string;
  entries: PluginRepoEntry[];
  read: (path: string) => Promise<string>;
};

/** `git ls-tree -r -l -z` output: "<mode> <type> <oid> <size>\t<path>\0". */
export function parseLsTree(output: Buffer): Array<PluginRepoEntry & { oid: string }> {
  const out: Array<PluginRepoEntry & { oid: string }> = [];
  for (const record of output.toString("utf8").split("\0")) {
    if (!record) continue;
    const tab = record.indexOf("\t");
    const [mode, type, oid, size] = record.slice(0, tab).trim().split(/\s+/);
    if (!mode || !type || !oid || tab < 0) throw new Error("Could not list the plugin repository");
    out.push({
      path: record.slice(tab + 1),
      mode,
      type,
      oid,
      ...(size && size !== "-" ? { size: Number(size) } : {}),
    });
    if (out.length > MAX_LISTED_ENTRIES) throw new Error("Plugin directory has too many files");
  }
  return out;
}

/** Fetches one commit of `gitUrl` into a scratch repository and hands its files to `use`. */
export async function withGitSnapshot<T>(
  gitUrl: string,
  ref: string | undefined,
  options: { hosts: GitHosts; signal?: AbortSignal; run?: GitRunner },
  use: (snapshot: GitSnapshot) => Promise<T>,
): Promise<T> {
  const credentials = gitHostCredentials(options.hosts, new URL(gitUrl).hostname);
  if (!credentials) throw new Error("This plugin host isn't allowed here");
  const run = options.run ?? runGit;
  const dir = await mkdtemp(join(tmpdir(), "rakazo-git-"));
  try {
    const signal = AbortSignal.any([
      ...(options.signal ? [options.signal] : []),
      AbortSignal.timeout(GIT_TIMEOUT_MS),
    ]);
    const env = gitEnvironment(dir, gitUrl, credentials, await extraCaBundle());
    const git = (args: string[], maxBuffer = 1_000_000) =>
      run(args, { cwd: dir, env, signal, maxBuffer });
    await git(["init", "--quiet", "--bare", "."]);
    await git(["fetch", "--quiet", "--depth=1", "--no-tags", "--", gitUrl, ref ?? "HEAD"]);
    const sha = (await git(["rev-parse", "--verify", "FETCH_HEAD^{commit}"])).toString().trim();
    if (!FULL_SHA.test(sha)) throw new Error("Could not resolve plugin commit SHA");
    if (ref && FULL_SHA.test(ref) && ref !== sha)
      throw new Error("Plugin commit SHA did not match the requested pin");
    const listing = parseLsTree(await git(["ls-tree", "-r", "-l", "-z", sha], 32_000_000));
    const oids = new Map(listing.map((entry) => [entry.path, entry.oid]));
    return await use({
      sha,
      entries: listing.map(({ oid: _oid, ...entry }) => entry),
      read: async (path) => {
        const oid = oids.get(path);
        if (!oid) throw new Error("Request failed: HTTP 404");
        return (await git(["cat-file", "blob", oid], MAX_READ_BYTES)).toString("utf8");
      },
    });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

export function fetchGitRepo(
  ref: PluginSourceRef,
  options: { hosts: GitHosts; signal?: AbortSignal; run?: GitRunner },
): ReturnType<PluginRepoFetcher> {
  return withGitSnapshot(ref.gitUrl, ref.ref, options, async (snapshot) => ({
    files: await collectRepoFiles(snapshot.entries, ref.subdir, snapshot.read),
    resolvedSha: snapshot.sha,
  }));
}

/**
 * A plugin folder on the server's disk. A link is followed only when it resolves inside the
 * folder, as ConfigMap and Secret mounts link every file through `..data`; any other link is
 * listed, never followed. The content hash stands in for a commit, so a changed folder reads
 * as a new version.
 */
export async function readPluginFolder(
  folder: string,
): Promise<{ files: PluginRepoFile[]; resolvedSha: string }> {
  const root = await realpath(folder);
  const inside = (target: string) => target === root || target.startsWith(`${root}${sep}`);
  const listing: PluginRepoEntry[] = [];
  const targets = new Map<string, string>();
  const walk = async (dir: string, prefix: string): Promise<void> => {
    for (const name of (await readdir(dir)).sort()) {
      // Mount internals (..data, ..2026_…) hold the same files the links point at.
      if (name === ".git" || name.startsWith("..")) continue;
      const full = join(dir, name);
      const path = prefix ? `${prefix}/${name}` : name;
      let target = full;
      if ((await lstat(full)).isSymbolicLink()) {
        target = await realpath(full).catch(() => "");
        if (!inside(target)) {
          listing.push({ path, type: "blob", mode: "120000" });
          continue;
        }
      }
      const info = await stat(target);
      if (info.isDirectory()) await walk(target, path);
      else if (info.isFile()) {
        listing.push({ path, type: "blob", mode: "100644", size: info.size });
        targets.set(path, target);
      }
      if (listing.length > MAX_LISTED_ENTRIES)
        throw new Error("Plugin directory has too many files");
    }
  };
  await walk(root, "");
  const files = await collectRepoFiles(listing, undefined, (path) =>
    readFile(targets.get(path) ?? join(root, path), "utf8"),
  );
  const hash = createHash("sha1");
  for (const file of files) hash.update(`${file.path}\0${file.content}\0`);
  return { files, resolvedSha: hash.digest("hex") };
}

/** github.com through its public API unless the deployment lists it; allowed hosts through git. */
export function createPluginRepoFetcher(options: {
  hosts: GitHosts;
  run?: GitRunner;
}): PluginRepoFetcher {
  return (ref, signal) => {
    const host = new URL(ref.gitUrl).hostname.toLowerCase();
    if (allowsGitHost(options.hosts, host)) return fetchGitRepo(ref, { ...options, signal });
    if (host === "github.com") return fetchGitHubRepo(ref, signal);
    return Promise.reject(new Error("This plugin host isn't allowed here"));
  };
}
