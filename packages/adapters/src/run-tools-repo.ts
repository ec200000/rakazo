/**
 * repo_status, repo_sync and repo_push: fixed git scripts run in the bot's computer for its
 * repository. The person's git credential reaches only the one command that needs the network,
 * as git config in its environment, and is redacted from everything the command prints; the
 * model never sees it and cannot put it in a command of its own.
 */
import { randomUUID } from "node:crypto";
import type { ComputerCommand } from "@rakazo/contracts";
import { COMPUTER_COMMAND_OUTPUT_MAX_CHARS, GitBranchNameSchema } from "@rakazo/contracts";
import { redactSecrets, sandboxCommandTimeoutMs } from "@rakazo/core";
import { RunHistoryWriteError } from "@rakazo/db";
import { getLogger } from "@rakazo/logging";
import {
  REPO_PUSH_SCRIPT,
  REPO_STATUS_SCRIPT,
  REPO_SYNC_SCRIPT,
  repositoryCredential,
  repositoryFolder,
  repositoryGitEnv,
} from "./bot-repository.js";
import { resolveBotWorkspaceCwd } from "./computer-support.js";
import type { RunContext } from "./run-context.js";
import { addRunSecrets } from "./run-context.js";
import type { ToolCall, ToolHandlers } from "./run-tool-gate.js";

const DEFAULT_BASE_BRANCH = "main";

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

async function runRepoScript(
  ctx: RunContext,
  call: ToolCall,
  script: string,
  options: { network: boolean },
) {
  const { bot, deps, run, context } = ctx;
  const repoUrl = bot.repoUrl;
  if (!repoUrl)
    return call.finish({ error: "This bot has no repository. Set one in its settings." });
  const branch =
    bot.repoBranch && GitBranchNameSchema.safeParse(bot.repoBranch).success ? bot.repoBranch : "";
  const base =
    bot.repoBaseBranch && GitBranchNameSchema.safeParse(bot.repoBaseBranch).success
      ? bot.repoBaseBranch
      : DEFAULT_BASE_BRANCH;
  if (call.name === "repo_push" && !branch) {
    return call.finish({
      error:
        "No working branch is set. Ask the person to choose one in the Branch box above the chat.",
    });
  }
  const credential = options.network
    ? await repositoryCredential(
        { prisma: deps.prisma, secretStore: deps.secretStore },
        { spaceId: run.spaceId, userId: run.userId },
        repoUrl,
      )
    : null;
  if (credential) addRunSecrets(ctx, credential.secrets);
  const person = options.network
    ? await deps.prisma.user.findUnique({
        where: { id: run.userId },
        select: { name: true, email: true },
      })
    : null;
  const folder = repositoryFolder(repoUrl);
  const env: Record<string, string> = {
    ...(options.network ? repositoryGitEnv(repoUrl, credential) : {}),
    REPO_URL: repoUrl,
    REPO_DIR: folder,
    REPO_BASE: base,
    REPO_BRANCH: branch,
    ...(person?.name ? { REPO_USER_NAME: person.name } : {}),
    ...(person?.email ? { REPO_USER_EMAIL: person.email } : {}),
  };
  const cwd = resolveBotWorkspaceCwd(ctx.computer.mode, bot.id, undefined);
  const commandEvent = {
    executionId: call.executionId,
    kind: "shell" as const,
    command: call.name,
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
      : "";
  return call.finish({
    stdout: safeOut,
    stderr: `${safeErr}${hint}`,
    code,
    repository: repoUrl,
    folder,
    baseBranch: base,
    workingBranch: branch || null,
    ...(call.name === "repo_push" && code === 0
      ? {
          next: `Pushed. If this finishes the task, ask the person with ask_user whether to open a pull request from ${branch} into ${base}.`,
        }
      : {}),
  });
}

export const repoTools: ToolHandlers = {
  repo_status: (ctx, call) => runRepoScript(ctx, call, REPO_STATUS_SCRIPT, { network: false }),
  repo_sync: (ctx, call) => runRepoScript(ctx, call, REPO_SYNC_SCRIPT, { network: true }),
  repo_push: (ctx, call) => runRepoScript(ctx, call, REPO_PUSH_SCRIPT, { network: true }),
};
