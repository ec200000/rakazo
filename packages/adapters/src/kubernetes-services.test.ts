import { describe, expect, it, vi } from "vitest";
import { createdPullRequest } from "./auto-pr-watch.js";
import { KubernetesBotServices, serviceObjectName } from "./kubernetes-services.js";

function fakeCore() {
  const pods = new Map<string, Record<string, unknown>>();
  const services = new Map<string, unknown>();
  const core = {
    createNamespacedPod: vi.fn(async ({ body }: { body: Record<string, unknown> }) => {
      const name = (body.metadata as { name: string }).name;
      pods.set(name, {
        ...body,
        status: { phase: "Running", containerStatuses: [{ ready: true, state: { running: {} } }] },
      });
      return body;
    }),
    createNamespacedService: vi.fn(async ({ body }: { body: { metadata: { name: string } } }) => {
      services.set(body.metadata.name, body);
      return body;
    }),
    readNamespacedPod: vi.fn(async ({ name }: { name: string }) => pods.get(name)),
    listNamespacedPod: vi.fn(async ({ labelSelector }: { labelSelector: string }) => ({
      items: [...pods.values()].filter((pod) => {
        const labels = (pod.metadata as { labels: Record<string, string> }).labels;
        return labelSelector.split(",").every((pair) => {
          const [key, value] = pair.split("=");
          return labels[key as string] === value;
        });
      }),
    })),
    deleteNamespacedPod: vi.fn(async ({ name }: { name: string }) => pods.delete(name)),
    deleteNamespacedService: vi.fn(async ({ name }: { name: string }) => services.delete(name)),
  };
  return { core, pods, services };
}

describe("test containers beside a computer", () => {
  it("starts one through the image mirror, lists it, and stops it", async () => {
    const fake = fakeCore();
    process.env.RAKAZO_PACKAGE_MIRRORS = JSON.stringify({ images: "af.example/docker-remote" });
    const services = new KubernetesBotServices(async () => fake.core as never, "sandboxes", 1000);
    const started = await services.start("cmBot123456", "rakazo-computer-abc", {
      name: "db",
      image: "postgres:16",
      port: 5432,
      env: { POSTGRES_PASSWORD: "test" },
      writablePaths: ["/var/lib/postgresql/data"],
    });
    delete process.env.RAKAZO_PACKAGE_MIRRORS;
    const name = serviceObjectName("cmBot123456", "db");
    expect(started).toEqual({
      name: "db",
      host: `${name}.sandboxes.svc`,
      port: 5432,
      image: "af.example/docker-remote/library/postgres:16",
      status: "ready",
    });
    const pod = fake.pods.get(name) as { spec: Record<string, unknown> };
    expect(pod.spec).toMatchObject({
      automountServiceAccountToken: false,
      securityContext: { runAsUser: 1000 },
      volumes: [{ name: "scratch-0", emptyDir: {} }],
    });
    expect(fake.services.has(name)).toBe(true);
    expect((await services.list("cmBot123456")).map((service) => service.name)).toEqual(["db"]);
    expect(await services.list("someoneElse")).toEqual([]);
    await expect(
      services.start("cmBot123456", "c", { name: "db", image: "x", port: 1 }),
    ).rejects.toThrow(/already running/);
    expect(await services.stop("cmBot123456", "db")).toBe(true);
    expect(fake.pods.size).toBe(0);
    expect(fake.services.size).toBe(0);
  });

  it("refuses bad names, ports, variables and paths", async () => {
    const services = new KubernetesBotServices(
      async () => fakeCore().core as never,
      "ns",
      undefined,
    );
    await expect(
      services.start("b", "c", { name: "Bad Name", image: "x", port: 1 }),
    ).rejects.toThrow(/lowercase/);
    await expect(services.start("b", "c", { name: "db", image: "x", port: 0 })).rejects.toThrow(
      /port/,
    );
    await expect(
      services.start("b", "c", { name: "db", image: "x", port: 1, env: { "A-B": "1" } }),
    ).rejects.toThrow(/environment variable/);
    await expect(
      services.start("b", "c", { name: "db", image: "x", port: 1, writablePaths: ["data"] }),
    ).rejects.toThrow(/absolute/);
  });
});

describe("pull requests the bot opens", () => {
  const result = {
    status: 201,
    data: {
      pullRequestId: 101,
      title: "Add a note",
      sourceRefName: "refs/heads/feature/x",
      repository: { id: "r1", project: { id: "p1" } },
    },
  };
  it("recognizes a created pull request, directly or through the tool catalog", () => {
    expect(createdPullRequest("ado_create_pull_request", {}, result)).toEqual({
      projectId: "p1",
      repositoryId: "r1",
      id: 101,
      title: "Add a note",
      sourceBranch: "feature/x",
    });
    expect(
      createdPullRequest(
        "installed_execute_tool",
        { id: "ado_create_pull_request", arguments: {} },
        result,
      ),
    ).toMatchObject({ id: 101 });
    expect(createdPullRequest("ado_get_pull_request", {}, result)).toBeNull();
    expect(
      createdPullRequest("ado_create_pull_request", {}, { error: true, status: 409 }),
    ).toBeNull();
  });
});

describe("a test container that cannot start", () => {
  it("says the cluster has no room, and cleans up", async () => {
    const fake = fakeCore();
    fake.core.createNamespacedPod.mockImplementation(
      async ({ body }: { body: Record<string, unknown> }) => {
        const name = (body.metadata as { name: string }).name;
        fake.pods.set(name, {
          ...body,
          status: {
            phase: "Pending",
            conditions: [
              {
                type: "PodScheduled",
                status: "False",
                reason: "Unschedulable",
                message: "0/1 nodes are available: 1 Insufficient cpu.",
              },
            ],
          },
        });
        return body;
      },
    );
    vi.useFakeTimers();
    const services = new KubernetesBotServices(async () => fake.core as never, "ns", undefined);
    const attempt = services.start("b", "c", { name: "db", image: "postgres:16", port: 5432 });
    const settled = expect(attempt).rejects.toThrow(
      /no room for it right now \(0\/1 nodes are available: 1 Insufficient cpu\.\)/,
    );
    await vi.advanceTimersByTimeAsync(200_000);
    await settled;
    vi.useRealTimers();
    expect(fake.pods.size).toBe(0);
    expect(fake.services.size).toBe(0);
  });
});
