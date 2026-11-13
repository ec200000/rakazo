/**
 * Test containers beside a bot's computer, e.g. a database for its tests. Each is a pod and a
 * ClusterIP service in the computers' namespace, labelled with the bot and the computer, reachable
 * only from computer pods (the chart's network policy), pulled through the image mirror, and
 * removed when the bot stops it or its computer stops. They need no permission beyond what
 * Rakazo already has for computer pods (plus services).
 */
import type { CoreV1Api, V1Pod, V1Service } from "@kubernetes/client-node";
import { mirroredImage, packageMirrorsFromEnv } from "./package-mirrors.js";

export const SERVICE_APP_LABEL = "rakazo-service";
const BOT_LABEL = "rakazo-bot-id";
const COMPUTER_LABEL = "rakazo-computer-id";
const NAME_LABEL = "rakazo-service-name";
export const MAX_SERVICES_PER_BOT = 3;
const READY_TIMEOUT_MS = 180_000;

export type ServiceSpec = {
  name: string;
  image: string;
  port: number;
  env?: Record<string, string>;
  args?: string[];
  /** Paths the container writes to (data folders), mounted as empty scratch space. */
  writablePaths?: string[];
};

export type RunningService = {
  name: string;
  host: string;
  port: number;
  image: string;
  status: string;
};

type Core = Pick<
  CoreV1Api,
  | "createNamespacedPod"
  | "deleteNamespacedPod"
  | "readNamespacedPod"
  | "listNamespacedPod"
  | "createNamespacedService"
  | "deleteNamespacedService"
>;

const SERVICE_NAME = /^[a-z][a-z0-9-]{0,19}$/;
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

function shortId(value: string) {
  return (
    value
      .toLowerCase()
      .replace(/[^a-z0-9]/g, "")
      .slice(-10) || "x"
  );
}

/** A Kubernetes name for one bot's service: rkz-<bot>-<name>. */
export function serviceObjectName(botId: string, name: string) {
  return `rkz-${shortId(botId)}-${name}`;
}

function status(pod: V1Pod): string {
  const waiting = pod.status?.containerStatuses?.[0]?.state?.waiting;
  if (waiting?.reason) return waiting.reason;
  const ready = pod.status?.containerStatuses?.[0]?.ready;
  if (pod.status?.phase === "Running" && ready) return "ready";
  return pod.status?.phase ?? "Pending";
}

export class KubernetesBotServices {
  constructor(
    private readonly core: () => Promise<Core>,
    private readonly namespace: string,
    private readonly runAsUser: number | undefined,
  ) {}

  private selector(botId: string, extra: Record<string, string> = {}) {
    return Object.entries({ app: SERVICE_APP_LABEL, [BOT_LABEL]: botId, ...extra })
      .map(([key, value]) => `${key === "app" ? "app.kubernetes.io/name" : key}=${value}`)
      .join(",");
  }

  async list(botId: string): Promise<RunningService[]> {
    const core = await this.core();
    const pods = await core.listNamespacedPod({
      namespace: this.namespace,
      labelSelector: this.selector(botId),
    });
    return pods.items.map((pod) => {
      const name = pod.metadata?.labels?.[NAME_LABEL] ?? pod.metadata?.name ?? "";
      return {
        name,
        host: `${pod.metadata?.name}.${this.namespace}.svc`,
        port: pod.spec?.containers?.[0]?.ports?.[0]?.containerPort ?? 0,
        image: pod.spec?.containers?.[0]?.image ?? "",
        status: status(pod),
      };
    });
  }

  async start(
    botId: string,
    computerId: string,
    spec: ServiceSpec,
    signal?: AbortSignal,
  ): Promise<RunningService> {
    if (!SERVICE_NAME.test(spec.name)) {
      throw new Error("Name the service with lowercase letters, digits and dashes (e.g. db).");
    }
    if (!Number.isInteger(spec.port) || spec.port < 1 || spec.port > 65_535)
      throw new Error("Give the port it listens on.");
    for (const key of Object.keys(spec.env ?? {})) {
      if (!ENV_NAME.test(key)) throw new Error(`${key} is not an environment variable name.`);
    }
    for (const path of spec.writablePaths ?? []) {
      if (!path.startsWith("/") || path.includes(".."))
        throw new Error(`${path} is not an absolute path.`);
    }
    const existing = await this.list(botId);
    if (existing.some((service) => service.name === spec.name)) {
      throw new Error(
        `A service named ${spec.name} is already running; stop it first or use another name.`,
      );
    }
    if (existing.length >= MAX_SERVICES_PER_BOT) {
      throw new Error(`At most ${MAX_SERVICES_PER_BOT} services run at once; stop one first.`);
    }
    const name = serviceObjectName(botId, spec.name);
    const labels = {
      "app.kubernetes.io/name": SERVICE_APP_LABEL,
      [BOT_LABEL]: botId,
      [COMPUTER_LABEL]: shortId(computerId),
      [NAME_LABEL]: spec.name,
    };
    const image = mirroredImage(spec.image, packageMirrorsFromEnv());
    const volumes = (spec.writablePaths ?? []).map((_, index) => ({
      name: `scratch-${index}`,
      emptyDir: {},
    }));
    const pod: V1Pod = {
      apiVersion: "v1",
      kind: "Pod",
      metadata: { name, namespace: this.namespace, labels },
      spec: {
        automountServiceAccountToken: false,
        enableServiceLinks: false,
        restartPolicy: "Never",
        ...(this.runAsUser
          ? {
              securityContext: {
                runAsUser: this.runAsUser,
                runAsGroup: this.runAsUser,
                fsGroup: this.runAsUser,
              },
            }
          : {}),
        ...(volumes.length ? { volumes } : {}),
        containers: [
          {
            name: "service",
            image,
            imagePullPolicy: "IfNotPresent",
            ...(spec.args?.length ? { args: spec.args } : {}),
            env: Object.entries(spec.env ?? {}).map(([key, value]) => ({ name: key, value })),
            ports: [{ containerPort: spec.port, protocol: "TCP" }],
            securityContext: {
              allowPrivilegeEscalation: false,
              capabilities: { drop: ["ALL"] },
            },
            resources: {
              limits: { cpu: "1", memory: "1Gi" },
              requests: { cpu: "50m", memory: "128Mi" },
            },
            readinessProbe: {
              tcpSocket: { port: spec.port },
              periodSeconds: 2,
              failureThreshold: 90,
            },
            ...((spec.writablePaths ?? []).length
              ? {
                  volumeMounts: (spec.writablePaths ?? []).map((path, index) => ({
                    name: `scratch-${index}`,
                    mountPath: path,
                  })),
                }
              : {}),
          },
        ],
      },
    };
    const service: V1Service = {
      apiVersion: "v1",
      kind: "Service",
      metadata: { name, namespace: this.namespace, labels },
      spec: {
        selector: { [BOT_LABEL]: botId, [NAME_LABEL]: spec.name },
        ports: [{ port: spec.port, targetPort: spec.port }],
      },
    };
    const core = await this.core();
    await core.createNamespacedPod({ namespace: this.namespace, body: pod });
    try {
      await core.createNamespacedService({ namespace: this.namespace, body: service });
    } catch (error) {
      await this.remove(name).catch(() => undefined);
      throw error;
    }
    const deadline = Date.now() + READY_TIMEOUT_MS;
    let state = "Pending";
    while (Date.now() < deadline) {
      signal?.throwIfAborted();
      const current = await core.readNamespacedPod({ name, namespace: this.namespace });
      state = status(current);
      if (state === "ready") break;
      if (
        /ErrImagePull|ImagePullBackOff|InvalidImageName|CrashLoopBackOff|Error/.test(state) ||
        current.status?.phase === "Failed"
      ) {
        await this.remove(name).catch(() => undefined);
        throw new Error(
          `${spec.name} did not start (${state}${state.includes("Image") ? `: is ${image} in the image mirror?` : ""}).`,
        );
      }
      await new Promise((resolve) => setTimeout(resolve, 2_000));
    }
    if (state !== "ready") {
      const current = await core
        .readNamespacedPod({ name, namespace: this.namespace })
        .catch(() => null);
      const unscheduled = current?.status?.conditions?.find(
        (condition) => condition.type === "PodScheduled" && condition.status === "False",
      );
      await this.remove(name).catch(() => undefined);
      throw new Error(
        unscheduled
          ? `${spec.name} could not start: the cluster has no room for it right now (${unscheduled.message ?? unscheduled.reason ?? "unschedulable"}).`
          : `${spec.name} was not ready within ${READY_TIMEOUT_MS / 60_000} minutes (${state}).`,
      );
    }
    return {
      name: spec.name,
      host: `${name}.${this.namespace}.svc`,
      port: spec.port,
      image,
      status: state,
    };
  }

  private async remove(name: string) {
    const core = await this.core();
    await Promise.allSettled([
      core.deleteNamespacedPod({ name, namespace: this.namespace, gracePeriodSeconds: 0 }),
      core.deleteNamespacedService({ name, namespace: this.namespace }),
    ]);
  }

  async stop(botId: string, name: string): Promise<boolean> {
    const running = await this.list(botId);
    if (!running.some((service) => service.name === name)) return false;
    await this.remove(serviceObjectName(botId, name));
    return true;
  }

  /** Every service of a computer, when it stops. */
  async stopForComputer(computerId: string) {
    const core = await this.core();
    const pods = await core.listNamespacedPod({
      namespace: this.namespace,
      labelSelector: `app.kubernetes.io/name=${SERVICE_APP_LABEL},${COMPUTER_LABEL}=${shortId(computerId)}`,
    });
    await Promise.allSettled(pods.items.map((pod) => this.remove(pod.metadata?.name ?? "")));
  }
}
