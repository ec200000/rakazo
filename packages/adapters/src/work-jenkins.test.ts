import { describe, expect, it } from "vitest";
import { JenkinsClient, jenkinsJobPath, jenkinsStatus } from "./work-jenkins.js";

const BASE = "https://jenkins.example/ci";
const AUTH = `Basic ${Buffer.from("itay:tok").toString("base64")}`;

function fakeJenkins() {
  const calls: string[] = [];
  const fetch = (async (input: string | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    calls.push(`${init?.method ?? "GET"} ${url.pathname}${url.search}`);
    if ((init?.headers as Record<string, string>).Authorization !== AUTH) {
      return new Response("", { status: 401 });
    }
    const path = url.pathname.replace("/ci", "");
    if (path === "/api/json") {
      return Response.json({
        jobs: [
          {
            _class: "hudson.model.FreeStyleProject",
            name: "nightly",
            color: "blue",
            lastBuild: { number: 7, result: "SUCCESS", timestamp: 1, duration: 1000 },
          },
          {
            _class: "com.cloudbees.hudson.plugins.folder.Folder",
            name: "team",
            jobs: [
              {
                _class: "org.jenkinsci.plugins.workflow.multibranch.WorkflowMultiBranchProject",
                name: "skills ci",
                jobs: [
                  {
                    _class: "org.jenkinsci.plugins.workflow.job.WorkflowJob",
                    name: "feature%2Fkind-test",
                    color: "red_anime",
                    lastBuild: { number: 13, building: true },
                  },
                ],
              },
            ],
          },
        ],
      });
    }
    if (path === "/job/team/job/skills%20ci/job/feature%252Fkind-test/api/json") {
      return Response.json({
        _class: "org.jenkinsci.plugins.workflow.job.WorkflowJob",
        name: "feature%2Fkind-test",
        color: "red",
        builds: [{ number: 12, result: "FAILURE", timestamp: 1_700_000_000_000, duration: 61_000 }],
        property: [
          {
            parameterDefinitions: [
              {
                name: "ENV",
                type: "ChoiceParameterDefinition",
                choices: ["dev", "prod"],
                defaultParameterValue: { value: "dev" },
              },
            ],
          },
        ],
      });
    }
    if (path.endsWith("/12/consoleText")) {
      const long = `${"x".repeat(300_000)}\nStarted\n[ERROR] 2 tests failed\nFinished: FAILURE\n`;
      return new Response(long, { status: 200 });
    }
    if (path.endsWith("/buildWithParameters") && init?.method === "POST")
      return new Response("", { status: 201 });
    return new Response("", { status: 404 });
  }) as typeof globalThis.fetch;
  return { fetch, calls };
}

describe("Jenkins client", () => {
  it("lists jobs in folders and multibranch projects with their status", async () => {
    const jobs = await new JenkinsClient(BASE, AUTH, fakeJenkins().fetch).jobs();
    expect(
      jobs.map((job) => [job.path, job.kind, job.status, job.lastBuild?.number ?? null]),
    ).toEqual([
      ["nightly", "job", "passed", 7],
      ["team", "folder", "unknown", null],
      ["team/job/skills ci", "multibranch", "unknown", null],
      ["team/job/skills ci/job/feature%2Fkind-test", "branch", "building", 13],
    ]);
  });

  it("reads a job's builds and parameters, and the end of a long log", async () => {
    const client = new JenkinsClient(BASE, AUTH, fakeJenkins().fetch);
    const path = "team/job/skills ci/job/feature%2Fkind-test";
    const detail = await client.jobDetail(path);
    expect(detail.builds[0]).toMatchObject({ number: 12, status: "failed", durationMs: 61_000 });
    expect(detail.parameters).toEqual([
      {
        name: "ENV",
        type: "choice",
        description: null,
        defaultValue: "dev",
        choices: ["dev", "prod"],
      },
    ]);
    const log = await client.consoleTail(path, 12);
    expect(log.truncated).toBe(true);
    expect(log.text.endsWith("[ERROR] 2 tests failed\nFinished: FAILURE\n")).toBe(true);
    expect(log.text.length).toBeLessThanOrEqual(256_000);
  });

  it("starts a parameterized build and refuses paths that leave the job tree", async () => {
    const server = fakeJenkins();
    const client = new JenkinsClient(BASE, AUTH, server.fetch);
    await client.build("nightly", { ENV: "prod" });
    expect(server.calls.at(-1)).toBe("POST /ci/job/nightly/buildWithParameters?ENV=prod");
    for (const bad of ["../x", "a/../b", "a/b", "a/job/", "a//job/b"]) {
      await expect(client.jobDetail(bad)).rejects.toThrow(/Not a Jenkins job path/);
    }
  });

  it("explains a refused token, and reads colors and results", async () => {
    await expect(new JenkinsClient(BASE, "Basic x", fakeJenkins().fetch).jobs()).rejects.toThrow(
      /refused your API token/,
    );
    expect(jenkinsStatus("red_anime")).toBe("building");
    expect(jenkinsStatus("", "UNSTABLE")).toBe("unstable");
    expect(jenkinsJobPath(["team", "a b"])).toBe("team/job/a b");
  });
});
