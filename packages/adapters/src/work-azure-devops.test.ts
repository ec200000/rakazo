import { describe, expect, it } from "vitest";
import { AzureDevOpsClient, overallCheckState } from "./work-azure-devops.js";

const BASE = "https://ado.example/DefaultCollection";
const AUTH = `Basic ${Buffer.from(":tok").toString("base64")}`;

function pr(id: number, extra: Record<string, unknown>) {
  return {
    pullRequestId: id,
    title: `PR ${id}`,
    status: "active",
    creationDate: `2026-11-0${id % 9}T10:00:00Z`,
    sourceRefName: "refs/heads/feature/x",
    targetRefName: "refs/heads/main",
    repository: {
      id: "r1",
      name: "skills",
      webUrl: `${BASE}/Team/_git/skills`,
      project: { id: "p1", name: "Team" },
    },
    reviewers: [],
    ...extra,
  };
}

/** A small Azure DevOps Server: one project, three pull requests, and what they change. */
function fakeServer() {
  const calls: { method: string; path: string; body: unknown }[] = [];
  const fetch = (async (input: string | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    const path = url.pathname.replace("/DefaultCollection", "");
    const method = init?.method ?? "GET";
    calls.push({ method, path, body: init?.body ? JSON.parse(String(init.body)) : undefined });
    expect(url.searchParams.get("api-version")).toBe("7.1");
    if ((init?.headers as Record<string, string>).Authorization !== AUTH) {
      return new Response("", { status: 401 });
    }
    const json = (value: unknown) => Response.json(value);
    if (path === "/_apis/connectionData") {
      return json({ authenticatedUser: { id: "me", providerDisplayName: "Itay" } });
    }
    if (path === "/_apis/projects") return json({ value: [{ id: "p1", name: "Team" }] });
    if (path === "/p1/_apis/git/pullrequests") {
      if (url.searchParams.get("searchCriteria.status") === "completed") {
        return json({
          value: [
            pr(90, {
              status: "completed",
              closedDate: "2026-11-09T00:00:00Z",
              createdBy: { id: "me" },
            }),
          ],
        });
      }
      return json({
        value: [
          pr(101, {
            createdBy: { id: "me", displayName: "Itay" },
            reviewers: [{ id: "dana", displayName: "Dana", vote: 0 }],
          }),
          pr(102, {
            createdBy: { id: "dana", displayName: "Dana" },
            reviewers: [{ id: "me", displayName: "Itay", vote: 0, isRequired: true }],
          }),
          pr(103, { createdBy: { id: "omer", displayName: "Omer" }, isDraft: true }),
        ],
      });
    }
    const base = "/p1/_apis/git/repositories/r1/pullRequests";
    if (path === `${base}/101/statuses`) {
      return json({
        value: [
          { id: 1, state: "pending", context: { genre: "jenkins", name: "build" } },
          {
            id: 2,
            state: "failed",
            description: "Build #12 failed",
            targetUrl: "https://jenkins/job/x/12",
            context: { genre: "jenkins", name: "build" },
          },
        ],
      });
    }
    if (path.endsWith("/statuses"))
      return json({ value: [{ id: 1, state: "succeeded", context: { name: "ci" } }] });
    if (path === "/p1/_apis/policy/evaluations") {
      return json({
        value: [
          {
            status: "approved",
            configuration: {
              isEnabled: true,
              type: { displayName: "Minimum number of reviewers" },
            },
          },
        ],
      });
    }
    if (path === `${base}/101`) {
      if (method === "PATCH") return json({});
      return json(
        pr(101, {
          createdBy: { id: "me", displayName: "Itay" },
          description: "Adds a note",
          lastMergeSourceCommit: { commitId: "abc" },
        }),
      );
    }
    if (path === `${base}/101/iterations`) return json({ value: [{ id: 1 }, { id: 2 }] });
    if (path === `${base}/101/iterations/2/changes`) {
      return json({
        changeEntries: [
          {
            changeType: "edit",
            item: { path: "/note.txt", objectId: "b2", originalObjectId: "b1" },
          },
          { changeType: "add", item: { path: "/plan.md", objectId: "b3" } },
          { changeType: "add", item: { path: "/docs", isFolder: true } },
        ],
      });
    }
    if (path === `${base}/101/threads`) {
      if (method === "POST") return json({ id: 9 });
      return json({
        value: [
          {
            id: 5,
            status: "active",
            threadContext: { filePath: "/note.txt", rightFileStart: { line: 2 } },
            comments: [
              {
                id: 1,
                author: { displayName: "Dana" },
                content: "Why this line?",
                publishedDate: "2026-11-10T00:00:00Z",
              },
            ],
          },
          { id: 6, comments: [{ id: 1, commentType: "system", content: "Itay voted" }] },
        ],
      });
    }
    if (path === `${base}/101/reviewers/me`) return json({ vote: 10 });
    const blobs: Record<string, string> = { b1: "one\n", b2: "one\ntwo\n", b3: "# Plan\n" };
    const blob = /\/blobs\/(\w+)$/.exec(path);
    if (blob) return new Response(blobs[blob[1] as string] ?? "", { status: 200 });
    return new Response(JSON.stringify({ message: `no route ${path}` }), { status: 404 });
  }) as typeof globalThis.fetch;
  return { fetch, calls };
}

describe("Azure DevOps pull requests", () => {
  it("groups the collection's pull requests for the person, with their checks", async () => {
    const server = fakeServer();
    const client = new AzureDevOpsClient(BASE, AUTH, "7.1", server.fetch);
    const { me, pullRequests } = await client.pullRequests();
    expect(me).toEqual({ id: "me", name: "Itay", me: true });
    const byId = new Map(pullRequests.map((item) => [item.id, item]));
    expect(byId.get(101)?.group).toBe("mine");
    expect(byId.get(101)?.checks).toBe("failing");
    expect(byId.get(102)?.group).toBe("review");
    expect(byId.get(102)?.checks).toBe("passing");
    expect(byId.get(103)).toMatchObject({ group: "others", isDraft: true, checks: "none" });
    expect(byId.get(90)?.group).toBe("done");
    expect(byId.get(101)?.webUrl).toBe(`${BASE}/Team/_git/skills/pullrequest/101`);
  });

  it("reads one pull request's checks, files, comments and diffs", async () => {
    const client = new AzureDevOpsClient(BASE, AUTH, "7.1", fakeServer().fetch);
    const ref = { projectId: "p1", repositoryId: "r1", id: 101 };
    const detail = await client.pullRequest(ref);
    expect(detail.description).toBe("Adds a note");
    expect(detail.checkList).toContainEqual({
      name: "jenkins/build",
      state: "failing",
      description: "Build #12 failed",
      url: "https://jenkins/job/x/12",
    });
    expect(detail.files.map((file) => [file.path, file.change])).toEqual([
      ["/note.txt", "edit"],
      ["/plan.md", "add"],
    ]);
    expect(detail.threads).toEqual([
      {
        id: 5,
        status: "active",
        filePath: "/note.txt",
        line: 2,
        comments: [
          { id: 1, author: "Dana", content: "Why this line?", createdAt: "2026-11-10T00:00:00Z" },
        ],
      },
    ]);
    const diff = await client.fileDiff(ref, "/note.txt");
    expect(diff.diff).toContain(" one\n+two\n");
    expect(diff.additions).toBe(1);
    expect((await client.fileDiff(ref, "/plan.md")).diff).toContain("+# Plan");
  });

  it("votes, comments and merges as the person", async () => {
    const server = fakeServer();
    const client = new AzureDevOpsClient(BASE, AUTH, "7.1", server.fetch);
    const ref = { projectId: "p1", repositoryId: "r1", id: 101 };
    await client.vote(ref, 10);
    await client.comment(ref, "Looks good");
    await client.complete(ref, { strategy: "squash", deleteSourceBranch: true, auto: false });
    const writes = server.calls.filter((call) => call.method !== "GET");
    expect(writes).toEqual([
      {
        method: "PUT",
        path: "/p1/_apis/git/repositories/r1/pullRequests/101/reviewers/me",
        body: { vote: 10 },
      },
      {
        method: "POST",
        path: "/p1/_apis/git/repositories/r1/pullRequests/101/threads",
        body: {
          comments: [{ parentCommentId: 0, content: "Looks good", commentType: 1 }],
          status: 1,
        },
      },
      {
        method: "PATCH",
        path: "/p1/_apis/git/repositories/r1/pullRequests/101",
        body: {
          status: "completed",
          lastMergeSourceCommit: { commitId: "abc" },
          completionOptions: { mergeStrategy: "squash", deleteSourceBranch: true },
        },
      },
    ]);
  });

  it("explains a refused token", async () => {
    const client = new AzureDevOpsClient(BASE, "Basic bad", "7.1", fakeServer().fetch);
    await expect(client.pullRequests()).rejects.toThrow(/refused your token/);
  });

  it("takes the worst check", () => {
    expect(overallCheckState([{ state: "passing" }, { state: "failing" }])).toBe("failing");
    expect(overallCheckState([{ state: "passing" }, { state: "pending" }])).toBe("pending");
    expect(overallCheckState([])).toBe("none");
  });
});

describe("Azure Boards work items", () => {
  function boards() {
    const calls: {
      method: string;
      path: string;
      version: string | null;
      body: unknown;
      type?: string;
    }[] = [];
    const fetch = (async (input: string | URL, init?: RequestInit) => {
      const url = new URL(String(input));
      const path = url.pathname.replace("/DefaultCollection", "");
      calls.push({
        method: init?.method ?? "GET",
        path,
        version: url.searchParams.get("api-version"),
        body: init?.body ? JSON.parse(String(init.body)) : undefined,
        type: (init?.headers as Record<string, string>)["Content-Type"],
      });
      if (path === "/_apis/connectionData")
        return Response.json({ authenticatedUser: { id: "me" } });
      if (path === "/_apis/wit/wiql") return Response.json({ workItems: [{ id: 7 }, { id: 5 }] });
      if (path === "/_apis/wit/workitems") {
        return Response.json({
          value: [
            {
              id: 5,
              fields: {
                "System.Title": "Old",
                "System.State": "Active",
                "System.WorkItemType": "Task",
                "System.TeamProject": "Team",
              },
            },
            {
              id: 7,
              fields: {
                "System.Title": "Login loops",
                "System.State": "New",
                "System.WorkItemType": "Bug",
                "System.TeamProject": "Team",
                "System.AssignedTo": { id: "me", displayName: "Itay" },
                "System.Tags": "auth; urgent",
                "Microsoft.VSTS.Common.Priority": 1,
              },
            },
          ],
        });
      }
      if (path === "/_apis/wit/workitems/7" && (init?.method ?? "GET") === "GET") {
        return Response.json({
          id: 7,
          fields: {
            "System.Title": "Login loops",
            "System.State": "New",
            "System.WorkItemType": "Bug",
            "System.TeamProject": "Team",
            "Microsoft.VSTS.TCM.ReproSteps":
              "<div>Open <b>/login</b></div><ul><li>it loops</li></ul>",
          },
          relations: [{ url: "vstfs:///Git/PullRequestId/p1%2Fr1%2F101" }],
        });
      }
      if (path === "/Team/_apis/wit/workitemtypes/Bug/states") {
        return Response.json({
          value: [
            { name: "New", category: "Proposed" },
            { name: "Active", category: "InProgress" },
          ],
        });
      }
      if (path === "/Team/_apis/wit/workItems/7/comments") {
        if (init?.method === "POST") return Response.json({});
        return Response.json({
          comments: [
            {
              id: 1,
              text: "<p>Seen on prod</p>",
              createdBy: { displayName: "Dana" },
              createdDate: "2026-11-10T00:00:00Z",
            },
          ],
        });
      }
      if (path === "/_apis/wit/workitems/7") return Response.json({});
      return new Response("", { status: 404 });
    }) as typeof globalThis.fetch;
    return { fetch, calls };
  }

  it("lists the person's work items in the query's order", async () => {
    const server = boards();
    const items = await new AzureDevOpsClient(BASE, AUTH, "7.1", server.fetch).workItems(
      "assigned",
    );
    expect(items.map((item) => [item.id, item.type, item.state])).toEqual([
      [7, "Bug", "New"],
      [5, "Task", "Active"],
    ]);
    expect(items[0]).toMatchObject({
      assignedTo: { me: true },
      tags: ["auth", "urgent"],
      priority: 1,
    });
    expect(items[0]?.webUrl).toBe(`${BASE}/Team/_workitems/edit/7`);
    const wiql = server.calls.find((call) => call.path === "/_apis/wit/wiql");
    expect(String((wiql?.body as { query: string }).query)).toContain("[System.AssignedTo] = @Me");
  });

  it("reads one with its states, comments and pull requests, and changes it", async () => {
    const server = boards();
    const client = new AzureDevOpsClient(BASE, AUTH, "7.1", server.fetch);
    const item = await client.workItem(7);
    expect(item.description).toBe("Open /login\n- it loops");
    expect(item.states.map((state) => state.name)).toEqual(["New", "Active"]);
    expect(item.stateCategory).toBe("Proposed");
    expect(item.comments).toEqual([
      { id: 1, author: "Dana", text: "Seen on prod", createdAt: "2026-11-10T00:00:00Z" },
    ]);
    expect(item.pullRequests.map((pr) => pr.id)).toEqual([101]);
    expect(server.calls.find((call) => call.path.endsWith("/comments"))?.version).toBe(
      "7.1-preview.4",
    );
    await client.setWorkItemState(7, "Active");
    await client.commentOnWorkItem(7, "On it <now>");
    const writes = server.calls.filter((call) => call.method !== "GET");
    expect(writes[0]).toMatchObject({
      method: "PATCH",
      path: "/_apis/wit/workitems/7",
      type: "application/json-patch+json",
      body: [{ op: "add", path: "/fields/System.State", value: "Active" }],
    });
    expect(writes[1]).toMatchObject({ method: "POST", body: { text: "On it &lt;now&gt;" } });
  });
});
