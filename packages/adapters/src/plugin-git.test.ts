import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { parsePluginDirectory, parsePluginSource } from "./plugin-connectors.js";
import type { GitRunner } from "./plugin-git.js";
import {
  createPluginRepoFetcher,
  fetchGitRepo,
  gitEnvironment,
  parseLsTree,
  readPluginFolder,
  runGit,
} from "./plugin-git.js";
import { createPluginMarketplace } from "./plugin-marketplace.js";

const URL = "https://git.example.test/platform/agents/plugins";
const schema = "https://agent-plugins.org/schemas/1.1.0/plugin.schema.json";
const hosts = new Map([["git.example.test", { username: "oauth2", token: "t0ken" }]]);
let root: string;
let repo: string;
let firstSha: string;

/** The real git, pointed at a local repository in place of the HTTPS URL. */
const localRun: GitRunner = (args, options) =>
  runGit(
    args.map((arg) => (arg === URL ? repo : arg)),
    // Local paths are the file protocol, which production settings refuse.
    { ...options, env: { ...options.env, GIT_CONFIG_COUNT: "0" } },
  );

function git(...args: string[]) {
  return execFileSync("git", args, {
    cwd: repo,
    env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" },
  })
    .toString()
    .trim();
}

function write(path: string, content: string) {
  mkdirSync(join(repo, path, ".."), { recursive: true });
  writeFileSync(join(repo, path), content);
}

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "plugin-git-test-"));
  repo = join(root, "repo");
  mkdirSync(repo);
  git("init", "--quiet", "--initial-branch=main");
  git("config", "user.email", "test@example.test");
  git("config", "user.name", "Test");
  write("k8s/plugin.json", JSON.stringify({ $schema: schema, name: "k8s-tools" }));
  write(
    "k8s/skills/triage/SKILL.md",
    "---\nname: triage\ndescription: Triage a failing pod\n---\n\nCheck events first.\n",
  );
  write(
    "k8s/mcp.json",
    JSON.stringify({
      $schema: schema.replace("plugin.schema", "mcp.schema"),
      mcpServers: { cluster: { type: "streamable-http", url: "https://mcp.example.test/mcp" } },
    }),
  );
  write("k8s/scripts/run.sh", "echo never fetched\n");
  git("add", ".");
  git("commit", "--quiet", "-m", "first");
  firstSha = git("rev-parse", "HEAD");
  symlinkSync("/etc/passwd", join(repo, "k8s/skills/link"));
  write(
    ".cursor-plugin/marketplace.json",
    JSON.stringify({
      name: "internal",
      plugins: [
        { name: "k8s-tools", description: "Cluster tools", source: "./k8s" },
        { name: "elsewhere", source: "https://other.example.test/a/b" },
      ],
    }),
  );
  git("add", ".");
  git("commit", "--quiet", "-m", "second");
});

afterAll(() => rmSync(root, { recursive: true, force: true }));

describe("fetchGitRepo", () => {
  it("reads a plugin folder from any allowed git host", async () => {
    const ref = parsePluginSource(`${URL}@main#k8s`);
    const repoFiles = await fetchGitRepo(ref, { hosts, run: localRun });
    expect(repoFiles.resolvedSha).toBe(git("rev-parse", "HEAD"));
    const byPath = new Map(repoFiles.files.map((file) => [file.path, file.content]));
    expect(byPath.get("k8s/plugin.json")).toContain("k8s-tools");
    // Listed but not fetched: scripts never install.
    expect(byPath.get("k8s/scripts/run.sh")).toBe("");
    // A link is recorded as unreadable, never followed.
    expect(byPath.get("k8s/skills/link")).toBe("\u0001");
  });

  it("pins a commit and parses like any other plugin", async () => {
    const ref = parsePluginSource(`${URL}@${firstSha}#k8s`);
    const repoFiles = await fetchGitRepo(ref, { hosts, run: localRun });
    expect(repoFiles.resolvedSha).toBe(firstSha);
    const parsed = parsePluginDirectory({
      resolvedSha: repoFiles.resolvedSha,
      files: repoFiles.files.map((file) => ({ ...file, path: file.path.slice("k8s/".length) })),
    });
    expect(parsed.name).toBe("k8s-tools");
    expect(parsed.skills.map((skill) => skill.name)).toEqual(["triage"]);
    expect(parsed.mcpServers.map((server) => server.endpoint)).toEqual([
      "https://mcp.example.test/mcp",
    ]);
  });

  it("refuses hosts the deployment does not list", async () => {
    const fetcher = createPluginRepoFetcher({ hosts, run: localRun });
    await expect(fetcher(parsePluginSource("https://elsewhere.example.test/a/b"))).rejects.toThrow(
      "This plugin host isn't allowed here",
    );
  });
});

describe("gitEnvironment", () => {
  it("allows only https, sends the token to its own host, and keeps it off the command line", () => {
    const env = gitEnvironment("/tmp/x", URL, { username: "oauth2", token: "t0ken" }, "/ca.pem", {
      PATH: "/bin",
      HTTPS_PROXY: "http://proxy.example.test:3128",
      SECRET: "not passed",
    });
    const config = Object.fromEntries(
      Array.from({ length: Number(env.GIT_CONFIG_COUNT) }, (_, i) => [
        env[`GIT_CONFIG_KEY_${i}`],
        env[`GIT_CONFIG_VALUE_${i}`],
      ]),
    );
    expect(config).toMatchObject({
      "protocol.allow": "never",
      "protocol.https.allow": "always",
      "http.https://git.example.test/.extraHeader": `Authorization: Basic ${Buffer.from("oauth2:t0ken").toString("base64")}`,
      "http.sslCAInfo": "/ca.pem",
    });
    expect(env).toMatchObject({
      GIT_TERMINAL_PROMPT: "0",
      HTTPS_PROXY: "http://proxy.example.test:3128",
    });
    expect(env.SECRET).toBeUndefined();
  });
});

describe("parseLsTree", () => {
  it("reads blobs, links and submodules", () => {
    const out = Buffer.from(
      `100644 blob ${"a".repeat(40)}      12\tplugin.json\0` +
        `120000 blob ${"b".repeat(40)}       5\tlink\0` +
        `160000 commit ${"c".repeat(40)}       -\tvendor/sub\0`,
    );
    expect(parseLsTree(out)).toEqual([
      { path: "plugin.json", mode: "100644", type: "blob", oid: "a".repeat(40), size: 12 },
      { path: "link", mode: "120000", type: "blob", oid: "b".repeat(40), size: 5 },
      { path: "vendor/sub", mode: "160000", type: "commit", oid: "c".repeat(40) },
    ]);
  });
});

describe("readPluginFolder", () => {
  it("reads a folder on disk with a content hash for its version", async () => {
    const first = await readPluginFolder(join(repo, "k8s"));
    expect(first.resolvedSha).toMatch(/^[a-f0-9]{40}$/);
    expect(first.files.find((file) => file.path === "skills/link")?.content).toBe("\u0001");
    expect(parsePluginDirectory(first).skills.map((skill) => skill.name)).toEqual(["triage"]);
    expect((await readPluginFolder(join(repo, "k8s"))).resolvedSha).toBe(first.resolvedSha);
  });
});

describe("readPluginFolder with a mounted ConfigMap's layout", () => {
  it("follows links that stay inside the folder and skips the mount's internals", async () => {
    const mount = join(root, "mount");
    const data = join(mount, "..2026_11_10_00_00_00.000000001");
    mkdirSync(join(data, "skills", "triage"), { recursive: true });
    writeFileSync(join(data, "plugin.json"), JSON.stringify({ $schema: schema, name: "mounted" }));
    writeFileSync(
      join(data, "skills", "triage", "SKILL.md"),
      "---\nname: triage\ndescription: Triage a failing pod\n---\n\nSteps.\n",
    );
    symlinkSync(data, join(mount, "..data"));
    symlinkSync(join("..data", "plugin.json"), join(mount, "plugin.json"));
    symlinkSync(join("..data", "skills"), join(mount, "skills"));
    symlinkSync("/etc/passwd", join(mount, "escape.md"));
    const folder = await readPluginFolder(mount);
    expect(folder.files.map((file) => file.path)).toEqual([
      "escape.md",
      "plugin.json",
      "skills/triage/SKILL.md",
    ]);
    expect(folder.files[0]?.content).toBe("\u0001");
    expect(parsePluginDirectory(folder).skills.map((skill) => skill.name)).toEqual(["triage"]);
  });
});

describe("parsePluginSource on other hosts", () => {
  it("accepts nested group paths and GitLab tree links", () => {
    expect(parsePluginSource("https://gitlab.example.test/a/b/c/plugins.git@v1#tools")).toEqual({
      gitUrl: "https://gitlab.example.test/a/b/c/plugins",
      ref: "v1",
      subdir: "tools",
    });
    expect(
      parsePluginSource("https://gitlab.example.test/group/plugins/-/tree/main/k8s/tools"),
    ).toEqual({
      gitUrl: "https://gitlab.example.test/group/plugins",
      ref: "main",
      subdir: "k8s/tools",
    });
    expect(() => parsePluginSource("https://github.com/a/b/c")).toThrow();
  });

  it("accepts Azure DevOps Server repository and folder links", () => {
    expect(
      parsePluginSource(
        "https://ado.example.test:8443/tfs/DefaultCollection/Platform%20Team/_git/agent-plugins@main#k8s",
      ),
    ).toEqual({
      gitUrl:
        "https://ado.example.test:8443/tfs/DefaultCollection/Platform%20Team/_git/agent-plugins",
      ref: "main",
      subdir: "k8s",
    });
    expect(
      parsePluginSource(
        "https://ado.example.test/DefaultCollection/Platform/_git/agent-plugins?path=/k8s/tools&version=GBrelease&_a=contents",
      ),
    ).toEqual({
      gitUrl: "https://ado.example.test/DefaultCollection/Platform/_git/agent-plugins",
      ref: "release",
      subdir: "k8s/tools",
    });
    expect(
      parsePluginSource(
        `https://ado.example.test/DefaultCollection/Platform/_git/agent-plugins?version=GC${"a".repeat(40)}`,
      ).ref,
    ).toBe("a".repeat(40));
    // Encoded dot segments resolve like plain ones, on the same host; encoded slashes are refused.
    expect(parsePluginSource("https://ado.example.test/a/%2e%2e/_git/b").gitUrl).toBe(
      "https://ado.example.test/_git/b",
    );
    expect(() => parsePluginSource("https://ado.example.test/a%2Fb/_git/c")).toThrow();
    // Only Azure DevOps folder links may carry a query.
    expect(() => parsePluginSource("https://git.example.test/a/b?token=x")).toThrow();
    expect(() => parsePluginSource("https://ado.example.test/a/_git/b?token=x")).toThrow();
  });
});

describe("an internal marketplace", () => {
  it("lists the plugins a catalog on another git host vendors", async () => {
    const marketplace = createPluginMarketplace(
      () => Promise.reject(new Error("no public reads")),
      {
        defaultRegistries: false,
        registries: [{ name: "Internal", url: URL }],
        hosts,
        run: localRun,
      },
    );
    const catalog = await marketplace.catalog("");
    expect(catalog.unavailableRegistries).toEqual([]);
    expect(catalog.entries).toEqual([
      expect.objectContaining({
        name: "k8s-tools",
        registry: "Internal",
        source: `${URL}#k8s`,
        hasConnector: true,
        skillCount: 1,
      }),
    ]);
    // Hosted on a server the deployment does not list.
    expect(catalog.skippedEntries).toBe(1);
  });
});
