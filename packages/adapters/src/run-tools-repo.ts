/**
 * repo_status, repo_sync and repo_push: fixed git scripts run in the bot's computer, once per
 * repository the bot works on (or the one it names). The person's git credential reaches only
 * the one command that needs the network, as git config in its environment, and is redacted
 * from everything the command prints; the model never sees it and cannot put it in a command of
 * its own.
 */
import { randomUUID } from "node:crypto";
import type { ComputerCommand } from "@rakazo/contracts";
import { COMPUTER_COMMAND_OUTPUT_MAX_CHARS, GitBranchNameSchema } from "@rakazo/contracts";
import { redactSecrets, sandboxCommandTimeoutMs } from "@rakazo/core";
import { botRepositories, RunHistoryWriteError } from "@rakazo/db";
import { getLogger } from "@rakazo/logging";
import type { BotRepositoryEntry } from "./bot-repository.js";
import {
  botRepositoryEntries,
  REPO_PUSH_SCRIPT,
  REPO_STATUS_SCRIPT,
  REPO_SYNC_SCRIPT,
  repositoryCredential,
  repositoryGitEnv,
} from "./bot-repository.js";
import { resolveBotWorkspaceCwd } from "./computer-support.js";
import type { RunContext } from "./run-context.js";
import { addRunSecrets } from "./run-context.js";
import type { ToolCall, ToolHandlers } from "./run-tool-gate.js";

function record(ctx: RunContext, payload: ComputerCommand) {
  const { deps, run, runId, bot, thread } = ctx;
  return deps.events
    .append({
      spaceId: run.spaceId,
      threadId: thread.id,
      botId: bot.id,
      runId,
      type: "computer.command",
      payload,
    })
    .catch((error: unknown) => {
      if (!(error instanceof RunHistoryWriteError)) getLogger().error("repo command event", error);
    });
}

/** The bot's repositories with valid base branches, and the one branch the person chose. */
export function botRepositoryPlan(bot: {
  repos?: unknown;
  repoUrl?: string | null;
  repoBaseBranch?: string | null;
  repoBranch?: string | null;
}) {
  const repositories = botRepositoryEntries(
    botRepositories(bot).map((repo) => ({
      ...repo,
      baseBranch:
        repo.baseBranch && GitBranchNameSchema.safeParse(repo.baseBranch).success
          ? repo.baseBranch
          : null,
    })),
  );
  const branch =
    bot.repoBranch && GitBranchNameSchema.safeParse(bot.repoBranch).success ? bot.repoBranch : "";
  return { repositories, branch };
}

type RepoResult = {
  repository: string;
  folder: string;
  baseBranch: string;
  code: number;
  stdout: string;
  stderr: string;
};

async function runInRepository(
  ctx: RunContext,
  call: ToolCall,
  script: string,
  repo: BotRepositoryEntry,
  branch: string,
  network: boolean,
  person: { name: string | null; email: string | null } | null,
): Promise<RepoResult> {
  const { bot, deps, run, context } = ctx;
  const credential = network
    ? await repositoryCredential(
        { prisma: deps.prisma, secretStore: deps.secretStore },
        { spaceId: run.spaceId, userId: run.userId },
        repo.url,
      )
    : null;
  if (credential) addRunSecrets(ctx, credential.secrets);
  const env: Record<string, string> = {
    ...(network ? repositoryGitEnv(repo.url, credential) : {}),
    REPO_URL: repo.url,
    REPO_DIR: repo.folder,
    REPO_BASE: repo.baseBranch,
    REPO_BRANCH: branch,
    ...(person?.name ? { REPO_USER_NAME: person.name } : {}),
    ...(person?.email ? { REPO_USER_EMAIL: person.email } : {}),
  };
  const cwd = resolveBotWorkspaceCwd(ctx.computer.mode, bot.id, undefined);
  const commandEvent = {
    executionId: `${call.executionId}:${repo.folder}`,
    kind: "shell" as const,
    command: `${call.name} ${repo.folder}`,
    cwd: cwd ?? ".",
  };
  await record(ctx, { ...commandEvent, status: "running", exitCode: null, output: "" });
  ctx.computer.checkpoint.markDirty();
  let stdout = "";
  let stderr = "";
  let code = 1;
  try {
    const computer = await ctx.computer.get("tool", call.name);
    for await (const event of deps.sandbox.execute(
      computer,
      {
        argv: ["bash", "-c", script, `rakazo-${call.name}-${randomUUID().slice(0, 8)}`],
        cwd,
        env,
        timeoutMs: sandboxCommandTimeoutMs(),
      },
      context,
    )) {
      if (event.type === "stdout") stdout += event.data;
      else if (event.type === "stderr") stderr += event.data;
      else code = event.code;
    }
  } catch (error) {
    stderr += error instanceof Error ? error.message : String(error);
  }
  const safeOut = redactSecrets(stdout, ctx.secrets);
  const safeErr = redactSecrets(stderr, ctx.secrets);
  await record(ctx, {
    ...commandEvent,
    status: "done",
    exitCode: code,
    output: `${safeOut}${safeErr}`.slice(-COMPUTER_COMMAND_OUTPUT_MAX_CHARS),
  });
  const hint =
    code !== 0 && /Authentication failed|could not read Username|403|401/.test(safeErr)
      ? credential
        ? " The server refused the saved credential; ask the person to check their Azure DevOps connection in Integrations."
        : " The server asked for a login; ask the person to connect Azure DevOps in Integrations with a personal access token."
      : code !== 0 && /would be overwritten|Please commit your changes or stash them/.test(`${safeOut}${safeErr}`)
        ? ` ${repo.folder} has uncommitted changes that switching to ${branch} would overwrite. Show the person what changed (git status) and ask whether to commit them on the current branch, stash them, or discard them; do nothing to them before they answer.`
        : "";
  return {
    repository: repo.url,
    folder: repo.folder,
    baseBranch: repo.baseBranch,
    code,
    stdout: safeOut,
    stderr: `${safeErr}${hint}`,
  };
}

async function runRepoScript(
  ctx: RunContext,
  call: ToolCall,
  script: string,
  options: { network: boolean },
) {
  const { repositories, branch } = botRepositoryPlan(ctx.bot);
  if (repositories.length === 0) {
    return call.finish({ error: "This bot has no repository. Set one in its settings." });
  }
  const wanted = typeof call.args.repository === "string" ? call.args.repository.trim() : "";
  const selected = wanted
    ? repositories.filter(
        (repo) =>
          repo.folder === wanted ||
          repo.folder === `repos/${wanted}` ||
          repo.url === wanted ||
          repo.url.replace(/\.git$/, "") === wanted.replace(/\.git$/, ""),
      )
    : repositories;
  if (selected.length === 0) {
    return call.finish({
      error: `No repository named ${wanted}. This bot's repositories: ${repositories.map((repo) => repo.folder).join(", ")}.`,
    });
  }
  if (call.name === "repo_push" && !branch) {
    return call.finish({
      error:
        "No working branch is set. Ask the person to choose one in the Branch box above the chat.",
    });
  }
  const person = options.network
    ? await ctx.deps.prisma.user.findUnique({
        where: { id: ctx.run.userId },
        select: { name: true, email: true },
      })
    : null;
  const results: RepoResult[] = [];
  // One at a time: the repositories share the computer, and output stays in order.
  for (const repo of selected) {
    results.push(await runInRepository(ctx, call, script, repo, branch, options.network, person));
  }
  const pushed = call.name === "repo_push" ? results.filter((result) => result.code === 0) : [];
  return call.finish({
    workingBranch: branch || null,
    results,
    ...(pushed.length
      ? {
          next: `Pushed ${pushed.map((result) => result.folder).join(", ")}. If this finishes the task, ask the person with ask_user, once for each pushed repository, whether to open a pull request from ${branch} into its base branch.`,
        }
      : {}),
  });
}

export const repoTools: ToolHandlers = {
  repo_status: (ctx, call) => runRepoScript(ctx, call, REPO_STATUS_SCRIPT, { network: false }),
  repo_sync: (ctx, call) => runRepoScript(ctx, call, REPO_SYNC_SCRIPT, { network: true }),
  repo_push: (ctx, call) => runRepoScript(ctx, call, REPO_PUSH_SCRIPT, { network: true }),
};
