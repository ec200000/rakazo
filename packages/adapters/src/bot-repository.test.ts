import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GitBranchNameSchema, GitRepositoryUrlSchema } from "@rakazo/contracts";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  listRemoteBranches,
  REPO_PUSH_SCRIPT,
  REPO_STATUS_SCRIPT,
  REPO_SYNC_SCRIPT,
  repositoryCredential,
  repositoryFolder,
  repositoryGitEnv,
} from "./bot-repository.js";
import { botRepositoryInstruction } from "./run-instructions.js";
import { REPO_TOOL_NAMES } from "./run-tool-selection.js";

const ENV = { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" };
let root: string;
let origin: string;
let home: string;

function git(cwd: string, ...args: string[]) {
  return execFileSync("git", args, { cwd, env: ENV }).toString().trim();
}

function script(source: string, vars: Record<string, string>) {
  try {
    const stdout = execFileSync("bash", ["-c", source], {
      cwd: home,
      env: { ...ENV, ...vars },
      stdio: ["ignore", "pipe", "pipe"],
    }).toString();
    return { code: 0, out: stdout };
  } catch (error) {
    const failed = error as { status: number; stdout: Buffer; stderr: Buffer };
    return { code: failed.status, out: `${failed.stdout}${failed.stderr}` };
  }
}

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "bot-repository-test-"));
  const work = join(root, "work");
  origin = join(root, "origin.git");
  home = join(root, "home");
  mkdirSync(work);
  mkdirSync(home);
  git(work, "init", "--quiet", "--initial-branch=main");
  git(work, "config", "user.email", "t@example.test");
  git(work, "config", "user.name", "T");
  writeFileSync(join(work, "app.txt"), "v1\n");
  git(work, "add", ".");
  git(work, "commit", "--quiet", "-m", "first");
  git(work, "checkout", "--quiet", "-b", "feature/existing");
  writeFileSync(join(work, "feature.txt"), "f\n");
  git(work, "add", ".");
  git(work, "commit", "--quiet", "-m", "feature");
  execFileSync("git", ["clone", "--quiet", "--bare", work, origin], { env: ENV });
});

afterAll(() => rmSync(root, { recursive: true, force: true }));

const vars = (branch: string) => ({
  REPO_URL: origin,
  REPO_DIR: "repos/app",
  REPO_BASE: "main",
  REPO_BRANCH: branch,
  REPO_USER_NAME: "Itay",
  REPO_USER_EMAIL: "itay@example.test",
});

describe("repository scripts", () => {
  it("creates the person's new branch from the base, and tracks an existing one", () => {
    const created = script(REPO_SYNC_SCRIPT, vars("users/itay/new-work"));
    expect(created.code).toBe(0);
    expect(created.out).toContain("Created users/itay/new-work from origin/main");
    const repo = join(home, "repos/app");
    expect(git(repo, "rev-parse", "--abbrev-ref", "HEAD")).toBe("users/itay/new-work");
    expect(git(repo, "config", "user.name")).toBe("Itay");

    const tracked = script(REPO_SYNC_SCRIPT, vars("feature/existing"));
    expect(tracked.code).toBe(0);
    expect(git(repo, "rev-parse", "--abbrev-ref", "HEAD")).toBe("feature/existing");
    expect(git(repo, "log", "-1", "--format=%s")).toBe("feature");
  });

  it("only pushes the working branch", () => {
    const repo = join(home, "repos/app");
    script(REPO_SYNC_SCRIPT, vars("users/itay/new-work"));
    writeFileSync(join(repo, "app.txt"), "v2\n");
    git(repo, "commit", "--quiet", "-am", "change");
    const refused = script(REPO_PUSH_SCRIPT, vars("feature/existing"));
    expect(refused.code).not.toBe(0);
    expect(refused.out).toContain("not the working branch feature/existing");
    const pushed = script(REPO_PUSH_SCRIPT, vars("users/itay/new-work"));
    expect(pushed.code).toBe(0);
    expect(git(origin, "log", "-1", "--format=%s", "users/itay/new-work")).toBe("change");
  });

  it("asks for a branch instead of inventing one, and reports status without the network", () => {
    const none = script(REPO_SYNC_SCRIPT, vars(""));
    expect(none.code).toBe(0);
    expect(none.out).toContain("Ask the person to choose one in the Branch box");
    expect(script(REPO_STATUS_SCRIPT, vars("x")).out).toContain("Repository: repos/app");
    expect(script(REPO_STATUS_SCRIPT, { ...vars("x"), REPO_DIR: "repos/none" }).out).toContain(
      "Not cloned yet",
    );
  });
});

describe("repository credentials", () => {
  const scope = { spaceId: "s", userId: "u" };
  const deps = (installs: Array<{ source: string; secretId: string }>, token = "pat-123") => ({
    prisma: {
      capabilityInstall: { findMany: vi.fn().mockResolvedValue(installs) },
      secret: { findFirst: vi.fn().mockResolvedValue({ id: "sec", ciphertext: "c" }) },
    },
    secretStore: { load: vi.fn().mockResolvedValue(token) },
  });

  it("uses the person's connection for the same server only", async () => {
    const url = "https://ado.example/tfs/DefaultCollection/Pay/_git/api";
    const found = await repositoryCredential(
      deps([
        { source: "https://other.example/api", secretId: "x" },
        { source: "https://ado.example/tfs/DefaultCollection", secretId: "sec" },
      ]) as never,
      scope,
      url,
    );
    expect(found?.header).toBe(`Basic ${Buffer.from(":pat-123").toString("base64")}`);
    expect(found?.secrets).toContain("pat-123");
    expect(
      await repositoryCredential(
        deps([{ source: "https://other.example/api", secretId: "x" }]) as never,
        scope,
        url,
      ),
    ).toBeNull();
  });

  it("hands git the header for that origin only", () => {
    const env = repositoryGitEnv(
      "https://ado.example/tfs/C/_git/api",
      { header: "Basic abc", secrets: [], source: "connection" },
      "/tmp/ca.pem",
    );
    expect(env).toEqual({
      GIT_TERMINAL_PROMPT: "0",
      GIT_CONFIG_COUNT: "2",
      GIT_CONFIG_KEY_0: "http.https://ado.example/.extraHeader",
      GIT_CONFIG_VALUE_0: "Authorization: Basic abc",
      GIT_CONFIG_KEY_1: "http.sslCAInfo",
      GIT_CONFIG_VALUE_1: "/tmp/ca.pem",
    });
  });

  it("lists branches from ls-remote", async () => {
    const run = vi
      .fn()
      .mockResolvedValue(
        Buffer.from("a1\trefs/heads/main\nb2\trefs/heads/feature/x\nc3\trefs/tags/v1\n"),
      );
    expect(await listRemoteBranches("https://ado.example/r", null, run)).toEqual([
      "feature/x",
      "main",
    ]);
    expect(run.mock.calls[0]![0]).toEqual([
      "-c",
      "protocol.allow=never",
      "-c",
      "protocol.https.allow=always",
      "ls-remote",
      "--heads",
      "--",
      "https://ado.example/r",
    ]);
  });
});

describe("repository settings", () => {
  it("names folders after the repository", () => {
    expect(repositoryFolder("https://ado.example/tfs/C/Pay%20Team/_git/api.git")).toBe("repos/api");
  });

  it("accepts git branch names and https clone URLs only", () => {
    for (const ok of ["main", "feature/login", "users/itay/fix-1"])
      expect(GitBranchNameSchema.safeParse(ok).success).toBe(true);
    for (const bad of ["-x", "a..b", "a b", "x.lock", "a/", "a@{1}"])
      expect(GitBranchNameSchema.safeParse(bad).success).toBe(false);
    expect(GitRepositoryUrlSchema.safeParse("https://ado.example/_git/r").success).toBe(true);
    for (const bad of ["http://ado.example/r", "https://me:pat@ado.example/r", "git@host:r"])
      expect(GitRepositoryUrlSchema.safeParse(bad).success).toBe(false);
  });

  it("tells the bot its repository and to ask for a branch it does not have", () => {
    expect(
      botRepositoryInstruction({ repoUrl: null, repoBaseBranch: null, repoBranch: null }),
    ).toBe("");
    const waiting = botRepositoryInstruction({
      repoUrl: "https://ado.example/_git/r",
      repoBaseBranch: null,
      repoBranch: null,
    });
    expect(waiting).toContain("base branch main");
    expect(waiting).toContain("ask them to choose or type one in the Branch box");
    expect(
      botRepositoryInstruction({
        repoUrl: "https://a/_git/r",
        repoBaseBranch: "dev",
        repoBranch: "f",
      }),
    ).toContain("working branch f");
    const offer = botRepositoryInstruction({
      repoUrl: "https://a/_git/r",
      repoBaseBranch: "dev",
      repoBranch: "f",
    });
    expect(offer).toContain("offer a pull request yourself: call ask_user");
    expect(offer).toContain("into dev");
    expect(offer).toContain("Open it only after they agree");
    expect([...REPO_TOOL_NAMES]).toEqual(["repo_status", "repo_sync", "repo_push"]);
  });
});
