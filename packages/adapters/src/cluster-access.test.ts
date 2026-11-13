import { execFileSync } from "node:child_process";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { CLUSTER_COMMAND_SCRIPT, parseClusterCommand, splitCommand } from "./cluster-access.js";

const dir = mkdtempSync(join(tmpdir(), "cluster-access-test-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe("cluster commands", () => {
  it("splits like a shell, without running one", () => {
    expect(splitCommand(`helm upgrade app ./chart --set 'image.tag=1 2' -n "pay ments"`)).toEqual([
      "helm",
      "upgrade",
      "app",
      "./chart",
      "--set",
      "image.tag=1 2",
      "-n",
      "pay ments",
    ]);
    expect(() => splitCommand("oc get 'pods")).toThrow(/unclosed quote/);
  });

  it("tells reads from changes", () => {
    const read = (command: string) => parseClusterCommand(command).changes;
    expect(read("oc get pods -n payments")).toBe(false);
    expect(read("kubectl logs deploy/api --tail=50")).toBe(false);
    expect(read("oc rollout status deploy/api")).toBe(false);
    expect(read("helm list -A")).toBe(false);
    expect(read("helm diff upgrade app ./chart")).toBe(false);
    expect(read("helm upgrade app ./chart --dry-run")).toBe(false);
    expect(read("oc apply -f deploy.yaml --dry-run=server")).toBe(false);
    expect(read("helm upgrade app ./chart")).toBe(true);
    expect(read("oc rollout restart deploy/api")).toBe(true);
    expect(read("oc delete pod x")).toBe(true);
    expect(read("kubectl scale deploy/api --replicas=0")).toBe(true);
    expect(parseClusterCommand("oc get pods --namespace=payments").namespace).toBe("payments");
  });

  it("refuses other programs, shell tricks and swapped credentials", () => {
    expect(() => parseClusterCommand("bash -c 'oc get pods'")).toThrow(/oc, kubectl or helm/);
    expect(() => parseClusterCommand("oc get pods | grep x")).toThrow(/without pipes/);
    expect(() => parseClusterCommand("oc get pods --token=abc")).toThrow(
      /--token is set by Rakazo/,
    );
    expect(() => parseClusterCommand("helm list --kube-apiserver https://x")).toThrow(
      /set by Rakazo/,
    );
    expect(() => parseClusterCommand("oc get pods --as=system:admin")).toThrow(/set by Rakazo/);
  });

  it("gives the command a kubeconfig with the token, and removes it afterwards", () => {
    const bin = join(dir, "bin");
    execFileSync("mkdir", ["-p", bin]);
    // A stand-in oc that shows what it sees.
    writeFileSync(
      join(bin, "oc"),
      '#!/bin/sh\necho "args: $*"\necho "token env: ${RAKAZO_CLUSTER_TOKEN:-unset}"\ngrep -E "server:|token:" "$KUBECONFIG"\necho "$KUBECONFIG" > "$OUT"\n',
    );
    chmodSync(join(bin, "oc"), 0o755);
    const out = join(dir, "kubeconfig-path");
    const output = execFileSync(
      "bash",
      ["-c", CLUSTER_COMMAND_SCRIPT, "test", "oc", "get", "pods"],
      {
        env: {
          PATH: `${bin}:/usr/bin:/bin`,
          HOME: dir,
          OUT: out,
          RAKAZO_CLUSTER_URL: "https://api.cluster.example:6443",
          RAKAZO_CLUSTER_TOKEN: "sha256~secret",
        },
      },
    ).toString();
    expect(output).toContain("args: get pods");
    expect(output).toContain("token env: unset");
    expect(output).toContain("server: https://api.cluster.example:6443");
    expect(output).toContain("token: sha256~secret");
    const kubeconfig = execFileSync("cat", [out]).toString().trim();
    expect(() => execFileSync("test", ["-e", kubeconfig])).toThrow();
  });
});
