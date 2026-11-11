import { describe, expect, it, vi } from "vitest";
import {
  AZURE_DEVOPS_PRESET_ID,
  azureDevOpsInstallConfig,
  azureDevOpsOperations,
  azureDevOpsPreset,
} from "./azure-devops-preset.js";
import { applyCredential } from "./connector-http.js";
import { InstalledConnectorProvider, mcpSourcePresets } from "./installed-connectors.js";

const COLLECTION = "https://93.184.216.34/tfs/DefaultCollection";

async function call(tool: string, args: Record<string, unknown>) {
  const install = {
    id: "ado",
    kind: "api",
    source: COLLECTION,
    secretId: null,
    createdAt: new Date(0),
    config: { ...azureDevOpsInstallConfig("7.0"), auth: { type: "none" } },
  };
  const prisma = {
    capabilityInstall: {
      findMany: vi.fn().mockResolvedValue([install]),
      findFirst: vi.fn().mockResolvedValue(install),
    },
  };
  const requests: Array<{ method: string; url: string; body: string }> = [];
  const fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const request = input instanceof Request ? input : new Request(input, init);
    requests.push({ method: request.method, url: request.url, body: await request.text() });
    return Response.json({ value: [] });
  });
  const provider = new InstalledConnectorProvider(prisma as never, {} as never, { fetch });
  const context = { spaceId: "s", userId: "u", signal: new AbortController().signal } as never;
  const found = (await provider.discoverTools(context)).find((entry) => entry.name.endsWith(tool));
  if (!found)
    throw new Error(
      `no tool ${tool}: ${(await provider.discoverTools(context)).map((entry) => entry.name).join(", ")}`,
    );
  for await (const _event of provider.execute(
    { tool: found.name, args, executionId: "x", route: found.route },
    context,
  ));
  return requests[0]!;
}

describe("Azure DevOps preset", () => {
  it("is offered only when the deployment names a collection", () => {
    expect(azureDevOpsPreset(undefined)).toBeNull();
    expect(azureDevOpsPreset(`${COLLECTION}/`)).toEqual({
      id: AZURE_DEVOPS_PRESET_ID,
      name: "Azure DevOps",
      kind: "api",
      url: COLLECTION,
      credentialLabel: "Personal access token",
    });
    expect(
      mcpSourcePresets({ echoUrl: "https://echo.example", azureDevOpsUrl: COLLECTION }).map(
        (preset) => [preset.id, preset.url],
      ),
    ).toEqual([
      ["executor", undefined],
      ["echo", "https://echo.example/mcp"],
      ["azure-devops", COLLECTION],
    ]);
  });

  it("lists a person's pull requests with the API version always set", async () => {
    const request = await call("ado_list_pull_requests", {
      project: "Payments Team",
      "searchCriteria.creatorId": "me-1",
      "searchCriteria.status": "active",
    });
    const url = new URL(request.url);
    expect(request.method).toBe("GET");
    expect(url.pathname).toBe("/tfs/DefaultCollection/Payments%20Team/_apis/git/pullrequests");
    expect(Object.fromEntries(url.searchParams)).toEqual({
      "api-version": "7.0",
      "searchCriteria.creatorId": "me-1",
      "searchCriteria.status": "active",
    });
  });

  it("creates a pull request with the branches it is given", async () => {
    const request = await call("ado_create_pull_request", {
      project: "payments",
      repository: "api",
      sourceRefName: "refs/heads/feature/login",
      targetRefName: "refs/heads/main",
      title: "Fix login timeout",
    });
    expect(request.method).toBe("POST");
    expect(new URL(request.url).pathname).toBe(
      "/tfs/DefaultCollection/payments/_apis/git/repositories/api/pullrequests",
    );
    expect(JSON.parse(request.body)).toEqual({
      sourceRefName: "refs/heads/feature/login",
      targetRefName: "refs/heads/main",
      title: "Fix login timeout",
    });
  });

  it("reads files at a commit as JSON with content", async () => {
    const request = await call("ado_get_file", {
      project: "payments",
      repository: "api",
      path: "/src/app.ts",
      "versionDescriptor.version": "abc123",
      "versionDescriptor.versionType": "commit",
    });
    expect(Object.fromEntries(new URL(request.url).searchParams)).toMatchObject({
      path: "/src/app.ts",
      includeContent: "true",
      $format: "json",
      "versionDescriptor.version": "abc123",
    });
  });

  it("keeps every operation's path relative and versioned", () => {
    for (const operation of azureDevOpsOperations()) {
      expect(operation.path.startsWith("/")).toBe(true);
      if (operation.id !== "ado_whoami") expect(operation.fixedQuery["api-version"]).toBe("6.0");
    }
  });
});

describe("basic credentials", () => {
  it("sends a bare token with an empty user name, and a user:token pair as is", () => {
    const headers: Record<string, string> = {};
    applyCredential(new URL(COLLECTION), headers, { type: "basic" }, "pat123");
    expect(headers.authorization).toBe(`Basic ${Buffer.from(":pat123").toString("base64")}`);
    applyCredential(new URL(COLLECTION), headers, { type: "basic" }, "me:pat123");
    expect(headers.authorization).toBe(`Basic ${Buffer.from("me:pat123").toString("base64")}`);
  });
});
