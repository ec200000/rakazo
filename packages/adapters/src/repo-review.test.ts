import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  isRepoRelativePath,
  parseRepoChanges,
  parseRepoFileDiff,
  REPO_CHANGES_SCRIPT,
  REPO_FILE_DIFF_SCRIPT,
  unquoteGitPath,
} from "./repo-review.js";

const ENV = { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" };
let root: string;
let home: string;

function git(cwd: string, ...args: string[]) {
  return execFileSync("git", args, { cwd, env: ENV }).toString().trim();
}

function script(source: string, vars: Record<string, string>) {
  return execFileSync("bash", ["-c", source], {
    cwd: home,
    env: { ...ENV, ...vars },
    stdio: ["ignore", "pipe", "pipe"],
  }).toString();
}

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "repo-review-test-"));
  const work = join(root, "work");
  const origin = join(root, "origin.git");
  home = join(root, "home");
  mkdirSync(work);
  mkdirSync(home);
  git(work, "init", "--quiet", "--initial-branch=main");
  git(work, "config", "user.email", "t@example.test");
  git(work, "config", "user.name", "T");
  writeFileSync(join(work, "app.txt"), "one\ntwo\nthree\n");
  writeFileSync(join(work, "old.txt"), "bye\n");
  writeFileSync(join(work, ".gitignore"), "node_modules/\n");
  git(work, "add", ".");
  git(work, "commit", "--quiet", "-m", "first");
  execFileSync("git", ["clone", "--quiet", "--bare", work, origin], { env: ENV });
  const repo = join(home, "repos", "app");
  mkdirSync(join(home, "repos"));
  execFileSync("git", ["clone", "--quiet", origin, repo], { env: ENV });
  git(repo, "config", "user.email", "t@example.test");
  git(repo, "config", "user.name", "T");
  git(repo, "checkout", "--quiet", "-b", "feature/x");
  writeFileSync(join(repo, "app.txt"), "one\n2\nthree\nfour\n");
  git(repo, "rm", "--quiet", "old.txt");
  writeFileSync(join(repo, "new file.ts"), "export const a = 1;\n");
  git(repo, "add", ".");
  git(repo, "commit", "--quiet", "-m", "Change app");
  git(repo, "push", "--quiet", "--set-upstream", "origin", "feature/x");
  // Not committed: an edit, a new file, and an ignored folder.
  writeFileSync(join(repo, "new file.ts"), "export const a = 2;\n");
  writeFileSync(join(repo, "draft.md"), "# a\nb\n");
  mkdirSync(join(repo, "node_modules"));
  writeFileSync(join(repo, "node_modules", "x.js"), "x\n");
});

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("repository changes", () => {
  it("lists what the branch changes against its base, committed or not", () => {
    const changes = parseRepoChanges(
      script(REPO_CHANGES_SCRIPT, { REPO_DIR: "repos/app", REPO_BASE: "main" }),
    );
    expect(changes.state).toBe("ready");
    expect(changes.branch).toBe("feature/x");
    expect(changes.ahead).toBe(0);
    expect(changes.behind).toBe(0);
    expect(changes.commits.map((commit) => commit.subject)).toEqual(["Change app"]);
    expect(changes.files).toEqual([
      { path: "app.txt", status: "modified", additions: 2, deletions: 1, uncommitted: false },
      { path: "draft.md", status: "untracked", additions: 2, deletions: 0, uncommitted: true },
      { path: "new file.ts", status: "added", additions: 1, deletions: 0, uncommitted: true },
      { path: "old.txt", status: "deleted", additions: 0, deletions: 1, uncommitted: false },
    ]);
    expect(changes.truncated).toBe(false);
  });

  it("shows one file's diff, and a whole new file", () => {
    const vars = { REPO_DIR: "repos/app", REPO_BASE: "main" };
    const app = parseRepoFileDiff(script(REPO_FILE_DIFF_SCRIPT, { ...vars, REPO_PATH: "app.txt" }));
    expect(app.diff).toContain("-two\n+2\n");
    expect(app.diff).toContain("+four");
    const draft = parseRepoFileDiff(
      script(REPO_FILE_DIFF_SCRIPT, { ...vars, REPO_PATH: "draft.md" }),
    );
    expect(draft.diff).toContain("+# a\n+b");
    const spaced = parseRepoFileDiff(
      script(REPO_FILE_DIFF_SCRIPT, { ...vars, REPO_PATH: "new file.ts" }),
    );
    expect(spaced.diff).toContain("+export const a = 2;");
  });

  it("says when the repository is not cloned yet", () => {
    const vars = { REPO_DIR: "repos/missing", REPO_BASE: "main" };
    expect(parseRepoChanges(script(REPO_CHANGES_SCRIPT, vars)).state).toBe("not-cloned");
    expect(parseRepoFileDiff(script(REPO_FILE_DIFF_SCRIPT, { ...vars, REPO_PATH: "a" }))).toEqual({
      diff: "",
      truncated: false,
    });
  });

  it("undoes git's path quoting", () => {
    expect(unquoteGitPath('"new file.ts"')).toBe("new file.ts");
    expect(unquoteGitPath('"a\\tb\\"c"')).toBe('a\tb"c');
    expect(unquoteGitPath('"\\327\\251.txt"')).toBe("ש.txt");
    expect(unquoteGitPath("plain.txt")).toBe("plain.txt");
  });

  it("accepts only paths inside the repository", () => {
    expect(isRepoRelativePath("src/app.ts")).toBe(true);
    expect(isRepoRelativePath("new file.ts")).toBe(true);
    for (const bad of [
      "",
      "/etc/passwd",
      "../x",
      "a/../../x",
      ".git/config",
      "-rf",
      "a\nb",
      "a//b",
    ]) {
      expect(isRepoRelativePath(bad)).toBe(false);
    }
  });
});
