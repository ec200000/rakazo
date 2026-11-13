/**
 * A person's own OpenShift / Kubernetes clusters for their bots: each connects a cluster in
 * Integrations ("OpenShift cluster": the API server URL and their token from `oc whoami -t`).
 * Bots run oc, kubectl and helm against it in their computer with that token, in a kubeconfig that
 * exists only for the one command. Reading is free (cluster_read); every change goes through
 * cluster_change, which always waits for the person's approval with the namespace, a summary and a
 * preview in front of them.
 */
import type { SecretStore } from "@rakazo/adapter-kit";
import type { McpSourcePreset } from "@rakazo/contracts";
import type { PrismaClient } from "@rakazo/db";
import { availableInSpace, itemSecretIn } from "@rakazo/db";

export const OPENSHIFT_PRESET_ID = "openshift";
const WHOAMI_OPERATION = "cluster_whoami";

/** The OpenShift cluster preset: the person enters their cluster's API URL and token. */
export function openshiftPreset(): McpSourcePreset {
  return {
    id: OPENSHIFT_PRESET_ID,
    name: "OpenShift cluster",
    kind: "api",
    urlPlaceholder: "https://api.cluster.example:6443",
    credentialLabel: "API token (oc whoami -t)",
  };
}

/** The install config an OpenShift cluster connection expands to: one read, for checking. */
export function openshiftInstallConfig() {
  return {
    auth: { type: "bearer" as const },
    headers: {},
    operations: [
      {
        id: WHOAMI_OPERATION,
        name: WHOAMI_OPERATION,
        description: "Who am I on this cluster: the user the token belongs to.",
        method: "GET" as const,
        path: "/apis/user.openshift.io/v1/users/~",
        readOnly: true,
        inputSchema: { type: "object", properties: {}, additionalProperties: false },
        fixedQuery: {},
      },
    ],
  };
}

function isClusterConfig(config: unknown): boolean {
  const operations = (config as { operations?: { id?: string }[] } | null)?.operations;
  return (
    Array.isArray(operations) && operations.some((operation) => operation?.id === WHOAMI_OPERATION)
  );
}

export type PersonCluster = { id: string; name: string; url: string };

/** The clusters this person connected, without their tokens. */
export async function personClusters(
  prisma: PrismaClient,
  scope: { spaceId: string; userId: string },
): Promise<PersonCluster[]> {
  const installs = await prisma.capabilityInstall.findMany({
    where: { kind: "api", secretId: { not: null }, ...availableInSpace(scope) },
    select: { id: true, name: true, source: true, config: true },
    orderBy: { createdAt: "asc" },
  });
  return installs
    .filter((install) => isClusterConfig(install.config))
    .map((install) => ({
      id: install.id,
      name: install.name,
      url: install.source.replace(/\/+$/, ""),
    }));
}

/** One cluster's token, for the one command that needs it. */
export async function clusterToken(
  deps: { prisma: PrismaClient; secretStore: SecretStore },
  scope: { spaceId: string; userId: string },
  clusterId: string,
): Promise<string | null> {
  const install = await deps.prisma.capabilityInstall.findFirst({
    where: { id: clusterId, kind: "api", ...availableInSpace(scope) },
    select: { secretId: true, config: true },
  });
  if (!install?.secretId || !isClusterConfig(install.config)) return null;
  const row = await deps.prisma.secret.findFirst({
    where: { id: install.secretId, ...itemSecretIn(scope) },
    select: { id: true, ciphertext: true },
  });
  if (!row) return null;
  return (await deps.secretStore.load(row.ciphertext, row.id)).trim() || null;
}

/** Splits a command like a shell would (quotes, backslashes), without running a shell. */
export function splitCommand(command: string): string[] {
  const words: string[] = [];
  let current = "";
  let started = false;
  let quote: '"' | "'" | null = null;
  for (let i = 0; i < command.length; i += 1) {
    const char = command[i] as string;
    if (quote) {
      if (char === quote) quote = null;
      else if (char === "\\" && quote === '"' && i + 1 < command.length) current += command[++i];
      else current += char;
      continue;
    }
    if (char === "'" || char === '"') {
      quote = char;
      started = true;
    } else if (char === "\\" && i + 1 < command.length) {
      current += command[++i];
      started = true;
    } else if (/\s/.test(char)) {
      if (started) words.push(current);
      current = "";
      started = false;
    } else {
      current += char;
      started = true;
    }
  }
  if (quote) throw new Error("The command has an unclosed quote.");
  if (started) words.push(current);
  return words;
}

const TOOLS = new Set(["oc", "kubectl", "helm"]);
/** Flags that would swap the person's own access for something else. */
const FORBIDDEN_FLAGS = [
  "--kubeconfig",
  "--token",
  "--server",
  "--as",
  "--as-group",
  "--as-uid",
  "--insecure-skip-tls-verify",
  "--kube-token",
  "--kube-apiserver",
  "--kube-as-user",
  "--kube-as-group",
  "--kube-insecure-skip-tls-verify",
  "--certificate-authority",
  "--client-certificate",
  "--client-key",
  "--username",
  "--password",
  "--context",
  "--cluster",
  "--user",
];
const SHELL_LIKE = /[;&|`$<>]/;

const OC_READ = new Set([
  "get",
  "describe",
  "logs",
  "explain",
  "api-resources",
  "api-versions",
  "version",
  "whoami",
  "status",
  "projects",
  "top",
  "events",
  "diff",
  "auth",
]);
const HELM_READ = new Set([
  "list",
  "ls",
  "status",
  "get",
  "history",
  "show",
  "inspect",
  "template",
  "lint",
  "search",
  "version",
  "env",
  "diff",
  "pull",
  "verify",
]);

export type ClusterCommand = {
  argv: string[];
  tool: "oc" | "kubectl" | "helm";
  changes: boolean;
  /** The namespace the command names with -n / --namespace, if any. */
  namespace: string | null;
};

/** Checks an oc, kubectl or helm command and says whether it changes anything. */
export function parseClusterCommand(command: string): ClusterCommand {
  const argv = splitCommand(command.trim());
  const tool = argv[0];
  if (!tool || !TOOLS.has(tool)) throw new Error("Start the command with oc, kubectl or helm.");
  for (const word of argv.slice(1)) {
    if (SHELL_LIKE.test(word)) {
      throw new Error(
        "Run one oc, kubectl or helm command, without pipes, redirects or variables.",
      );
    }
    const flag = word.split("=")[0] as string;
    if (FORBIDDEN_FLAGS.includes(flag)) {
      throw new Error(`${flag} is set by Rakazo: commands run with the person's own access.`);
    }
  }
  let namespace: string | null = null;
  const words = argv.slice(1).filter((word, index, all) => {
    if (word === "-n" || word === "--namespace") {
      namespace = all[index + 1] ?? null;
      return false;
    }
    if (word.startsWith("--namespace=")) {
      namespace = word.slice("--namespace=".length) || null;
      return false;
    }
    if (index > 0 && (all[index - 1] === "-n" || all[index - 1] === "--namespace")) return false;
    return true;
  });
  const positional = words.filter((word) => !word.startsWith("-"));
  const verb = positional[0] ?? "";
  let changes: boolean;
  if (tool === "helm") {
    const dryRun = argv.includes("--dry-run") || argv.some((word) => word.startsWith("--dry-run="));
    changes =
      !HELM_READ.has(verb) &&
      !(verb === "repo" && positional[1] === "list") &&
      !(verb === "dependency" && positional[1] === "list") &&
      !dryRun;
  } else {
    const sub = positional[1] ?? "";
    changes =
      !OC_READ.has(verb) &&
      !(verb === "rollout" && (sub === "status" || sub === "history")) &&
      !(verb === "config" && sub === "view") &&
      !(verb === "project" && positional.length === 1) &&
      !argv.some((word) => word === "--dry-run=client" || word === "--dry-run=server");
  }
  return { argv, tool: tool as ClusterCommand["tool"], changes, namespace };
}

/**
 * Runs `"$@"` with a kubeconfig made from RAKAZO_CLUSTER_URL and RAKAZO_CLUSTER_TOKEN in a private
 * temporary folder, removed when the command ends.
 */
export const CLUSTER_COMMAND_SCRIPT = `set -eu
dir=$(mktemp -d)
trap 'rm -rf "$dir"' EXIT
umask 077
cat > "$dir/config" <<KUBECONFIG
apiVersion: v1
kind: Config
clusters:
- name: cluster
  cluster:
    server: $RAKAZO_CLUSTER_URL
users:
- name: person
  user:
    token: $RAKAZO_CLUSTER_TOKEN
contexts:
- name: person
  context:
    cluster: cluster
    user: person
current-context: person
KUBECONFIG
unset RAKAZO_CLUSTER_TOKEN
export KUBECONFIG="$dir/config"
export HELM_CACHE_HOME="$HOME/.cache/helm" HELM_CONFIG_HOME="$HOME/.config/helm"
"$@"`;
