/**
 * A bot's git repository: the person's credential for its server, the git settings that carry
 * it to one command, and the fixed scripts the repo tools run in the bot's computer. Branch names
 * always come from the person (the bot's Branch box); nothing here invents one.
 */

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SecretStore } from "@rakazo/adapter-kit";
import type { PrismaClient } from "@rakazo/db";
import { availableInSpace, itemSecretIn } from "@rakazo/db";
import { deploymentConfig } from "./deployment-config-file.js";
import type { GitRunner } from "./plugin-git.js";
import { extraCaBundle, gitHostCredentials, gitHostsFromConfig, runGit } from "./plugin-git.js";

export type RepositoryCredential = {
  /** The value of the Authorization header git sends to the repository's origin. */
  header: string;
  /** Values to redact from anything a command prints. */
  secrets: string[];
  /** Where it came from, for messages. */
  source: "connection" | "server";
};

function basic(username: string, token: string): RepositoryCredential["header"] {
  return `Basic ${Buffer.from(`${username}:${token}`).toString("base64")}`;
}

/**
 * The person's credential for a repository: the API connection they made for that server
 * (Integrations, Azure DevOps), else the deployment's `git.hosts` entry for its host. Null when
 * neither has one; a public repository still clones without it.
 */
export async function repositoryCredential(
  deps: { prisma: PrismaClient; secretStore: SecretStore },
  scope: { spaceId: string; userId: string },
  repoUrl: string,
  options: { serverFallback?: boolean } = {},
): Promise<RepositoryCredential | null> {
  const url = new URL(repoUrl);
  const installs = await deps.prisma.capabilityInstall.findMany({
    where: { kind: "api", secretId: { not: null }, ...availableInSpace(scope) },
    select: { source: true, secretId: true },
    orderBy: { createdAt: "desc" },
  });
  for (const install of installs) {
    let origin: string;
    try {
      origin = new URL(install.source).origin;
    } catch {
      continue;
    }
    if (origin !== url.origin || !install.secretId) continue;
    const row = await deps.prisma.secret.findFirst({
      where: { id: install.secretId, ...itemSecretIn(scope) },
      select: { id: true, ciphertext: true },
    });
    if (!row) continue;
    const token = (await deps.secretStore.load(row.ciphertext, row.id)).trim();
    if (!token) continue;
    const [user, pass] = token.includes(":") ? token.split(/:(.*)/s) : ["", token];
    const header = basic(user ?? "", pass ?? "");
    return {
      header,
      secrets: [token, header, header.slice("Basic ".length)],
      source: "connection",
    };
  }
  // Pages that act as the person (pull requests, work items) never borrow the server's token.
  if (options.serverFallback === false) return null;
  const server = gitHostCredentials(gitHostsFromConfig(deploymentConfig()), url.hostname);
  if (server?.token) {
    const header = basic(server.username, server.token);
    return {
      header,
      secrets: [server.token, header, header.slice("Basic ".length)],
      source: "server",
    };
  }
  return null;
}

/** Environment that hands one git command the credential, for the repository's origin only. */
export function repositoryGitEnv(
  repoUrl: string,
  credential: RepositoryCredential | null,
  caFile?: string,
): Record<string, string> {
  const config: Array<[string, string]> = [];
  if (credential) {
    config.push([
      `http.${new URL(repoUrl).origin}/.extraHeader`,
      `Authorization: ${credential.header}`,
    ]);
  }
  if (caFile) config.push(["http.sslCAInfo", caFile]);
  const env: Record<string, string> = {
    GIT_TERMINAL_PROMPT: "0",
    GIT_CONFIG_COUNT: String(config.length),
  };
  for (const [index, [key, value]] of config.entries()) {
    env[`GIT_CONFIG_KEY_${index}`] = key;
    env[`GIT_CONFIG_VALUE_${index}`] = value;
  }
  return env;
}

/** The folder the repository lives in, under the bot's workspace: repos/<name>. */
export function repositoryFolder(repoUrl: string): string {
  const last = decodeURIComponent(
    new URL(repoUrl).pathname.split("/").filter(Boolean).at(-1) ?? "",
  );
  const name = last
    .replace(/\.git$/, "")
    .replace(/[^A-Za-z0-9._-]+/g, "-")
    .replace(/^[.-]+/, "");
  return `repos/${name || "repository"}`;
}

/** Clones once, fetches, then switches to the person's branch (made from the base when new). */
export const REPO_SYNC_SCRIPT = `set -eu
mkdir -p "$(dirname "$REPO_DIR")"
if [ ! -d "$REPO_DIR/.git" ]; then git clone --no-tags "$REPO_URL" "$REPO_DIR"; fi
cd "$REPO_DIR"
git remote set-url origin "$REPO_URL"
[ -n "\${REPO_USER_NAME:-}" ] && git config user.name "$REPO_USER_NAME"
[ -n "\${REPO_USER_EMAIL:-}" ] && git config user.email "$REPO_USER_EMAIL"
git fetch --prune origin
if [ -z "\${REPO_BRANCH:-}" ]; then
  git status --short --branch
  echo "No working branch is set. Ask the person to choose one in the Branch box above the chat."
  exit 0
fi
if git show-ref --verify --quiet "refs/heads/$REPO_BRANCH"; then
  git checkout "$REPO_BRANCH"
  if git show-ref --verify --quiet "refs/remotes/origin/$REPO_BRANCH"; then
    git merge --ff-only "origin/$REPO_BRANCH" || echo "Local commits differ from origin/$REPO_BRANCH; left as they are."
  fi
elif git show-ref --verify --quiet "refs/remotes/origin/$REPO_BRANCH"; then
  git checkout -b "$REPO_BRANCH" --track "origin/$REPO_BRANCH"
else
  git checkout -b "$REPO_BRANCH" "origin/$REPO_BASE"
  echo "Created $REPO_BRANCH from origin/$REPO_BASE; it is not pushed yet."
fi
echo "Repository: $REPO_DIR"
git status --short --branch
git log --oneline -3`;

/** Pushes the working branch, and only it. */
export const REPO_PUSH_SCRIPT = `set -eu
cd "$REPO_DIR"
current="$(git rev-parse --abbrev-ref HEAD)"
if [ "$current" != "$REPO_BRANCH" ]; then
  echo "On $current, not the working branch $REPO_BRANCH. Run repo_sync first." >&2
  exit 1
fi
git push --set-upstream origin "$REPO_BRANCH"
git status --short --branch`;

/** Local state only; needs no credential. */
export const REPO_STATUS_SCRIPT = `cd "$REPO_DIR" 2>/dev/null || { echo "Not cloned yet: run repo_sync."; exit 0; }
echo "Repository: $REPO_DIR"
git status --short --branch
echo "Recent commits:"
git log --oneline -5`;

/** The repository's branch names, read by the server with the person's credential. */
export async function listRemoteBranches(
  repoUrl: string,
  credential: RepositoryCredential | null,
  run: GitRunner = runGit,
  base: NodeJS.ProcessEnv = process.env,
): Promise<string[]> {
  const dir = await mkdtemp(join(tmpdir(), "rakazo-branches-"));
  try {
    const env: NodeJS.ProcessEnv = {
      PATH: base.PATH,
      HOME: dir,
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_GLOBAL: "/dev/null",
      ...repositoryGitEnv(repoUrl, credential, await extraCaBundle()),
    };
    for (const key of ["HTTPS_PROXY", "https_proxy", "NO_PROXY", "no_proxy"]) {
      if (base[key]) env[key] = base[key];
    }
    const output = await run(
      [
        "-c",
        "protocol.allow=never",
        "-c",
        "protocol.https.allow=always",
        "ls-remote",
        "--heads",
        "--",
        repoUrl,
      ],
      { cwd: dir, env, signal: AbortSignal.timeout(30_000), maxBuffer: 8_000_000 },
    );
    return output
      .toString("utf8")
      .split("\n")
      .map((line) => line.split("\t")[1]?.trim() ?? "")
      .filter((ref) => ref.startsWith("refs/heads/"))
      .map((ref) => ref.slice("refs/heads/".length))
      .sort((a, b) => a.localeCompare(b));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
