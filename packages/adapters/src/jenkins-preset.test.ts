import { describe, expect, it, vi } from "vitest";
import { InstalledConnectorProvider, mcpSourcePresets } from "./installed-connectors.js";
import { JENKINS_PRESET_ID, jenkinsInstallConfig, jenkinsPreset } from "./jenkins-preset.js";

const CONTROLLER = "https://93.184.216.34/jenkins";

async function call(tool: string, args: Record<string, unknown>) {
  const install = {
    id: "jenkins",
    kind: "api",
    source: CONTROLLER,
    secretId: null,
    createdAt: new Date(0),
    config: { ...jenkinsInstallConfig(), auth: { type: "none" } },
  };
  const prisma = {
    capabilityInstall: {
      findMany: vi.fn().mockResolvedValue([install]),
      findFirst: vi.fn().mockResolvedValue(install),
    },
  };
  const requests: Array<{ method: string; url: string }> = [];
  const results: unknown[] = [];
  const fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const request = input instanceof Request ? input : new Request(input, init);
    requests.push({ method: request.method, url: request.url });
    return Response.json({ number: 12, result: "FAILURE" });
  });
  const provider = new InstalledConnectorProvider(prisma as never, {} as never, { fetch });
  const context = { spaceId: "s", userId: "u", signal: new AbortController().signal } as never;
  const found = (await provider.discoverTools(context)).find((entry) => entry.name === tool);
  if (!found) throw new Error(`no tool ${tool}: ${(await provider.discoverTools(context)).map((e) => e.name).join(",")}`);
  for await (const event of provider.execute(
    { tool: found.name, args, executionId: "x", route: found.route },
    context,
  )) {
    if (event.type === "result") results.push(event.data);
    if (event.type === "error") results.push(event.message);
  }
  return { request: requests[0], result: results[0] };
}

describe("Jenkins preset", () => {
  it("is offered only when the deployment names a controller", () => {
    expect(jenkinsPreset(undefined)).toBeNull();
    expect(jenkinsPreset(`${CONTROLLER}/`)).toMatchObject({
      id: JENKINS_PRESET_ID,
      kind: "api",
      url: CONTROLLER,
    });
    expect(mcpSourcePresets({ jenkinsUrl: CONTROLLER }).map((preset) => preset.id)).toContain(
      "jenkins",
    );
  });

  it("reads a branch job inside folders, keeping the path's slashes", async () => {
    const { request } = await call("jenkins_last_completed_build", {
      job: "team/job/skills ci/job/feature%2Fkind-test",
    });
    const url = new URL(request?.url ?? "");
    expect(url.pathname).toBe(
      "/jenkins/job/team/job/skills%20ci/job/feature%252Fkind-test/lastCompletedBuild/api/json",
    );
    expect(url.searchParams.get("tree")).toContain("number,result");
  });

  it("refuses a job path that climbs out of the job tree", async () => {
    const { request, result } = await call("jenkins_get_job", { job: "team/../../script" });
    expect(request).toBeUndefined();
    expect(String(result)).toMatch(/"\.\."/);
  });
});
