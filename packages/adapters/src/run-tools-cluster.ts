/**
 * cluster_read and cluster_change: oc, kubectl and helm against the person's own clusters, run in
 * the bot's computer with their token in a one-command kubeconfig. cluster_change is in the
 * explicit-approval list, so the person approves every change with its namespace, summary and
 * preview in front of them.
 */
import { randomUUID } from "node:crypto";
import { COMPUTER_COMMAND_OUTPUT_MAX_CHARS } from "@rakazo/contracts";
import { redactSecrets, sandboxCommandTimeoutMs } from "@rakazo/core";
import { RunHistoryWriteError } from "@rakazo/db";
import { getLogger } from "@rakazo/logging";
import type { PersonCluster } from "./cluster-access.js";
import {
  CLUSTER_COMMAND_SCRIPT,
  clusterToken,
  parseClusterCommand,
  personClusters,
} from "./cluster-access.js";
import { resolveBotWorkspaceCwd } from "./computer-support.js";
import type { RunContext } from "./run-context.js";
import { addRunSecrets } from "./run-context.js";
import type { ToolCall, ToolHandlers } from "./run-tool-gate.js";

const NAMESPACE = /^[a-z0-9]([-a-z0-9]*[a-z0-9])?$/;
const TOKEN = /^[A-Za-z0-9._~+/=:-]+$/;

function pickCluster(clusters: PersonCluster[], wanted: string): PersonCluster | string {
  if (clusters.length === 0) {
    return "No cluster is connected. Ask the person to connect one in Integrations (OpenShift cluster: API URL and their token from oc whoami -t).";
  }
  if (!wanted) {
    if (clusters.length === 1) return clusters[0] as PersonCluster;
    return `Name the cluster: ${clusters.map((cluster) => `"${cluster.name}" (${cluster.url})`).join(", ")}.`;
  }
  const lower = wanted.toLowerCase();
  const match = clusters.find(
    (cluster) =>
      cluster.id === wanted || cluster.name.toLowerCase() === lower || cluster.url === wanted,
  );
  return (
    match ??
    `No connected cluster named ${wanted}. Connected: ${clusters.map((cluster) => cluster.name).join(", ")}.`
  );
}

async function runClusterCommand(ctx: RunContext, call: ToolCall, change: boolean) {
  const { deps, run, bot, context } = ctx;
  const command = typeof call.args.command === "string" ? call.args.command : "";
  let parsed: ReturnType<typeof parseClusterCommand>;
  try {
    parsed = parseClusterCommand(command);
  } catch (error) {
    return call.finish({ error: error instanceof Error ? error.message : String(error) });
  }
  if (!change && parsed.changes) {
    return call.finish({
      error:
        "This command changes the cluster. Preview it first (helm diff, --dry-run, oc diff), then use cluster_change with the namespace, a summary and the preview; the person approves it.",
    });
  }
  let argv = parsed.argv;
  if (change) {
    const namespace = typeof call.args.namespace === "string" ? call.args.namespace.trim() : "";
    if (!NAMESPACE.test(namespace))
      return call.finish({ error: "Give the namespace the change is in." });
    if (parsed.namespace && parsed.namespace !== namespace) {
      return call.finish({ error: `The command targets ${parsed.namespace}, not ${namespace}.` });
    }
    if (!parsed.namespace) argv = [...argv, "--namespace", namespace];
  }
  const clusters = await personClusters(deps.prisma, { spaceId: run.spaceId, userId: run.userId });
  const cluster = pickCluster(
    clusters,
    typeof call.args.cluster === "string" ? call.args.cluster.trim() : "",
  );
  if (typeof cluster === "string") return call.finish({ error: cluster });
  const token = await clusterToken(
    { prisma: deps.prisma, secretStore: deps.secretStore },
    { spaceId: run.spaceId, userId: run.userId },
    cluster.id,
  );
  if (!token || !TOKEN.test(token)) {
    return call.finish({
      error: `The token saved for ${cluster.name} cannot be used; ask the person to reconnect it.`,
    });
  }
  addRunSecrets(ctx, [token]);
  const requestedCwd =
    typeof call.args.cwd === "string" && call.args.cwd.trim() ? call.args.cwd.trim() : undefined;
  const cwd = resolveBotWorkspaceCwd(ctx.computer.mode, bot.id, requestedCwd);
  const shown = `${argv.join(" ")}  # ${cluster.name}`;
  const event = {
    executionId: call.executionId,
    kind: "shell" as const,
    command: shown,
    cwd: cwd ?? ".",
  };
  const append = (payload: Record<string, unknown>) =>
    deps.events
      .append({
        spaceId: run.spaceId,
        threadId: ctx.thread.id,
        botId: bot.id,
        runId: ctx.runId,
        type: "computer.command",
        payload: { ...event, ...payload },
      })
      .catch((error: unknown) => {
        if (!(error instanceof RunHistoryWriteError))
          getLogger().error("cluster command event", error);
      });
  await append({ status: "running", exitCode: null, output: "" });
  let stdout = "";
  let stderr = "";
  let code = 1;
  try {
    const computer = await ctx.computer.get("tool", call.name);
    for await (const item of deps.sandbox.execute(
      computer,
      {
        argv: [
          "bash",
          "-c",
          CLUSTER_COMMAND_SCRIPT,
          `rakazo-cluster-${randomUUID().slice(0, 8)}`,
          ...argv,
        ],
        cwd,
        env: { RAKAZO_CLUSTER_URL: cluster.url, RAKAZO_CLUSTER_TOKEN: token },
        timeoutMs: sandboxCommandTimeoutMs(),
      },
      context,
    )) {
      if (item.type === "stdout") stdout += item.data;
      else if (item.type === "stderr") stderr += item.data;
      else code = item.code;
    }
  } catch (error) {
    stderr += error instanceof Error ? error.message : String(error);
  }
  const safeOut = redactSecrets(stdout, ctx.secrets).slice(-COMPUTER_COMMAND_OUTPUT_MAX_CHARS);
  const safeErr = redactSecrets(stderr, ctx.secrets).slice(-20_000);
  await append({
    status: "done",
    exitCode: code,
    output: `${safeOut}${safeErr}`.slice(-COMPUTER_COMMAND_OUTPUT_MAX_CHARS),
  });
  const hint =
    code !== 0 && /Unauthorized|token has expired|must be logged in/i.test(safeErr)
      ? ` The cluster refused the token for ${cluster.name}; ask the person to reconnect it in Integrations with a fresh token from oc whoami -t.`
      : "";
  return call.finish({ cluster: cluster.name, code, stdout: safeOut, stderr: `${safeErr}${hint}` });
}

export const clusterTools: ToolHandlers = {
  cluster_read: (ctx, call) => runClusterCommand(ctx, call, false),
  cluster_change: (ctx, call) => runClusterCommand(ctx, call, true),
};
