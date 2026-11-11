import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { previewPluginInstall } from "./plugin-connectors.js";
import type { GitRunner } from "./plugin-git.js";
import { createPluginRepoFetcher, gitHostCredentials, runGit } from "./plugin-git.js";
import { inspectPluginRepository } from "./plugin-inspect.js";

const MARKETPLACE = "https://git.example.test/team/marketplace";
const SKILLS = "https://code.other.test/team/skills-repo";
const anyHost = new Map([["*", { username: "oauth2", token: "never-sent" }]]);
let root: string;
const repos = new Map<string, string>();

/** The real git, pointed at local repositories in place of the HTTPS URLs. */
const localRun: GitRunner = (args, options) =>
  runGit(
    args.map((arg) => repos.get(arg) ?? arg),
    { ...options, env: { ...options.env, GIT_CONFIG_COUNT: "0" } },
  );

function makeRepo(url: string, files: Record<string, string>) {
  const dir = join(root, String(repos.size));
  mkdirSync(dir);
  const git = (...args: string[]) =>
    execFileSync("git", args, {
      cwd: dir,
      env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" },
    });
  git("init", "--quiet", "--initial-branch=main");
  git("config", "user.email", "test@example.test");
  git("config", "user.name", "Test");
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(join(dir, path, ".."), { recursive: true });
    writeFileSync(join(dir, path), content);
  }
  git("add", ".");
  git("commit", "--quiet", "-m", "first");
  repos.set(url, dir);
}

const skill = (name: string, description: string) =>
  `---\nname: ${name}\ndescription: ${description}\n---\n\nSteps for ${name}.\n`;

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "plugin-inspect-test-"));
  makeRepo(MARKETPLACE, {
    ".claude-plugin/marketplace.json": JSON.stringify({
      name: "Team tools",
      plugins: [
        { name: "docs", description: "Writing help", source: "./plugins/docs" },
        { name: "public", source: { source: "github", repo: "acme/public-plugin" } },
      ],
    }),
    "plugins/docs/.claude-plugin/plugin.json": JSON.stringify({ name: "docs", version: "1.0.0" }),
    "plugins/docs/skills/proofread/SKILL.md": skill("proofread", "Fix grammar"),
    "plugins/docs/skills/summarize/SKILL.md": skill("summarize", "Shorten a text"),
    "plugins/docs/agents/editor.md": skill("editor", "Edits drafts"),
  });
  makeRepo(SKILLS, {
    "skills/deploy/SKILL.md": skill("deploy", "Ship a release"),
    "skills/broken/SKILL.md": "no front matter",
    "loose/one/SKILL.md": skill("one-off", "A lone skill"),
    "loose/one/reference.md": "More detail.",
    "plugins/ops/.claude-plugin/plugin.json": JSON.stringify({
      name: "ops",
      description: "Operations",
    }),
    "plugins/ops/skills/restart/SKILL.md": skill("restart", "Restart a service"),
    "README.md": "# Skills",
  });
});

afterAll(() => rmSync(root, { recursive: true, force: true }));

describe("inspectPluginRepository", () => {
  it("lists a catalog's plugins with the skills of the ones it holds", async () => {
    const result = await inspectPluginRepository(MARKETPLACE, { hosts: anyHost, run: localRun });
    expect(result).toMatchObject({ name: "Team tools", indexed: true, url: MARKETPLACE });
    expect(result.sha).toMatch(/^[a-f0-9]{40}$/);
    const docs = result.plugins.find((plugin) => plugin.name === "docs");
    expect(docs).toMatchObject({
      source: `${MARKETPLACE}#plugins/docs`,
      skillCount: 3,
      skills: [
        { name: "editor", description: "Edits drafts" },
        { name: "proofread", description: "Fix grammar" },
        { name: "summarize", description: "Shorten a text" },
      ],
    });
    expect(result.plugins.find((plugin) => plugin.name === "public")).toMatchObject({
      source: "https://github.com/acme/public-plugin",
      skills: null,
    });
  });

  it("finds plugin folders and lone skills in a repository without a catalog", async () => {
    const result = await inspectPluginRepository(SKILLS, { hosts: anyHost, run: localRun });
    expect(result.indexed).toBe(false);
    expect(
      result.plugins.map((plugin) => ({
        source: plugin.source,
        name: plugin.name,
        skills: plugin.skills?.map((s) => [s.name, s.problem ?? null]),
      })),
    ).toEqual([
      { source: `${SKILLS}#loose/one`, name: "one", skills: [["one-off", null]] },
      { source: `${SKILLS}#plugins/ops`, name: "ops", skills: [["restart", null]] },
      {
        source: SKILLS,
        name: "skills-repo",
        skills: [
          ["broken", expect.any(String)],
          ["deploy", null],
        ],
      },
    ]);
  });

  it("keeps a branch and folder from the URL", async () => {
    const result = await inspectPluginRepository(`${SKILLS}@main#plugins`, {
      hosts: anyHost,
      run: localRun,
    });
    expect(result.url).toBe(`${SKILLS}@main#plugins`);
    expect(result.plugins.map((plugin) => plugin.source)).toEqual([`${SKILLS}@main#plugins/ops`]);
  });

  it("refuses hosts the server does not allow and explains a missing repository", async () => {
    await expect(
      inspectPluginRepository(SKILLS, {
        hosts: new Map([["git.example.test", { username: "x" }]]),
        run: localRun,
      }),
    ).rejects.toThrow("code.other.test is not an allowed git host on this server");
    repos.set("https://code.other.test/team/missing", join(root, "missing"));
    await expect(
      inspectPluginRepository("https://code.other.test/team/missing", {
        hosts: anyHost,
        run: localRun,
      }),
    ).rejects.toThrow(/^Repository not found/);
  });
});

describe("installing what the inspection found", () => {
  const fetcher = createPluginRepoFetcher({ hosts: anyHost, run: localRun });

  it("previews a lone skill folder as a one-skill plugin with its references", async () => {
    const plugin = await previewPluginInstall({ source: `${SKILLS}#loose/one`, fetcher });
    expect(plugin).toMatchObject({ format: "folder", name: "one" });
    expect(plugin.skills).toEqual([
      expect.objectContaining({ name: "one-off", files: { "reference.md": "More detail." } }),
    ]);
  });

  it("previews skills without a manifest under the repository's name", async () => {
    const plugin = await previewPluginInstall({ source: SKILLS, fetcher });
    expect(plugin).toMatchObject({ format: "folder", name: "skills-repo" });
    expect(plugin.skills.map((s) => s.name)).toEqual(["deploy"]);
  });

  it("previews a .claude-plugin plugin", async () => {
    const plugin = await previewPluginInstall({ source: `${SKILLS}#plugins/ops`, fetcher });
    expect(plugin).toMatchObject({ format: "claude", name: "ops", description: "Operations" });
  });

  it("never sends the wildcard entry's token", () => {
    expect(gitHostCredentials(anyHost, "code.other.test")).toEqual({ username: "oauth2" });
  });
});
