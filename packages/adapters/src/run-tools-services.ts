/**
 * service_start, service_list and service_stop: test containers (a database, a cache, a mock API)
 * beside the bot's computer, where computers run on Kubernetes. The computer reaches each at the
 * host and port service_start returns.
 */
import { getLogger } from "@rakazo/logging";
import { KubernetesBotServices } from "./kubernetes-services.js";
import type { RunContext } from "./run-context.js";
import type { ToolCall, ToolHandlers } from "./run-tool-gate.js";

let manager: KubernetesBotServices | null | undefined;

/** The service pods manager, when computers run on Kubernetes; null elsewhere. */
export function botServices(env: NodeJS.ProcessEnv = process.env): KubernetesBotServices | null {
  if (manager !== undefined) return manager;
  const namespace = env.KUBERNETES_SANDBOX_NAMESPACE?.trim();
  if (env.SANDBOX_PROVIDER?.trim() !== "kubernetes" || !namespace) {
    manager = null;
    return manager;
  }
  const runAsUser = Number(env.KUBERNETES_SANDBOX_RUN_AS_USER);
  manager = new KubernetesBotServices(
    async () => {
      const kubernetes = await import("@kubernetes/client-node");
      const config = new kubernetes.KubeConfig();
      config.loadFromDefault();
      return config.makeApiClient(kubernetes.CoreV1Api);
    },
    namespace,
    Number.isSafeInteger(runAsUser) && runAsUser > 0 ? runAsUser : undefined,
  );
  return manager;
}

function strings(value: unknown): Record<string, string> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>).map(([key, item]) => [key, String(item)]),
  );
}

async function withServices(
  call: ToolCall,
  run: (services: KubernetesBotServices) => Promise<unknown>,
) {
  const services = botServices();
  if (!services)
    return call.finish({ error: "Service containers need computers that run on Kubernetes." });
  try {
    return call.finish(await run(services));
  } catch (error) {
    getLogger().warn("service tool", { tool: call.name, error: String(error) });
    return call.finish({ error: error instanceof Error ? error.message : String(error) });
  }
}

export const serviceTools: ToolHandlers = {
  service_start: (ctx: RunContext, call: ToolCall) =>
    withServices(call, async (services) => {
      // The computer must exist: services follow its life and are reached from it.
      const computer = await ctx.computer.get("tool", call.name);
      const started = await services.start(
        ctx.bot.id,
        computer.providerRef || computer.id,
        {
          name: String(call.args.name ?? "").trim(),
          image: String(call.args.image ?? "").trim(),
          port: Number(call.args.port),
          env: strings(call.args.env),
          args: Array.isArray(call.args.args) ? call.args.args.map(String) : undefined,
          writablePaths: Array.isArray(call.args.writablePaths)
            ? call.args.writablePaths.map(String)
            : undefined,
        },
        ctx.context.signal,
      );
      return {
        ...started,
        note: `Reach it from your computer at ${started.host}:${started.port}. It stops with your computer, or with service_stop.`,
      };
    }),
  service_list: (ctx, call) =>
    withServices(call, async (services) => ({ services: await services.list(ctx.bot.id) })),
  service_stop: (ctx, call) =>
    withServices(call, async (services) => {
      const name = String(call.args.name ?? "").trim();
      return (await services.stop(ctx.bot.id, name))
        ? { stopped: name }
        : { error: `No service named ${name} is running.` };
    }),
};
