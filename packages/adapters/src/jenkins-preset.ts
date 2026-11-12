/**
 * Jenkins as a ready-made API connector: the deployment names its controller, each person
 * connects it with their own user name and API token (sent as Basic auth, which Jenkins accepts
 * without a CSRF crumb), and their bots can list jobs, read builds and logs, and start builds.
 * Routines watch a job's last completed build with these tools.
 */
import type { McpSourcePreset } from "@rakazo/contracts";

export const JENKINS_PRESET_ID = "jenkins";

const job = {
  type: "string",
  description:
    "The job's path as in its URL after the first /job/: `app`, or `team/job/app` for job app in " +
    "folder team (each folder adds /job/). A multibranch branch is `app/job/feature%2Fx`.",
};
const number = { type: "integer", description: "Build number." };
const BUILD_FIELDS = "number,result,building,timestamp,duration,url,displayName";

function object(properties: Record<string, unknown>, required: string[]) {
  return { type: "object", properties, required, additionalProperties: false };
}

/** The operations a person's bot gets once they connect Jenkins. */
export function jenkinsOperations() {
  return [
    {
      id: "jenkins_whoami",
      name: "jenkins_whoami",
      description: "Who am I in Jenkins. The signed-in Jenkins user.",
      method: "GET" as const,
      path: "/me/api/json",
      readOnly: true,
      inputSchema: object({}, []),
      fixedQuery: { tree: "id,fullName" },
    },
    {
      id: "jenkins_list_jobs",
      name: "jenkins_list_jobs",
      description:
        "List Jenkins jobs. Jobs and folders two levels deep, with their color " +
        "(blue passed, red failed, *_anime building, disabled, notbuilt) and URL.",
      method: "GET" as const,
      path: "/api/json",
      readOnly: true,
      inputSchema: object({}, []),
      fixedQuery: { tree: "jobs[name,fullName,url,color,jobs[name,fullName,url,color]]" },
    },
    {
      id: "jenkins_get_job",
      name: "jenkins_get_job",
      description:
        "Get a Jenkins job: its last builds, parameters, and sub-jobs (folder or multibranch branches).",
      method: "GET" as const,
      path: "/job/{+job}/api/json",
      readOnly: true,
      inputSchema: object({ job }, ["job"]),
      fixedQuery: {
        tree:
          `name,fullName,url,color,buildable,lastBuild[${BUILD_FIELDS}],lastCompletedBuild[${BUILD_FIELDS}],` +
          `builds[${BUILD_FIELDS}]{0,10},jobs[name,url,color],` +
          "property[parameterDefinitions[name,type,description,defaultParameterValue[value]]]",
      },
    },
    {
      id: "jenkins_last_completed_build",
      name: "jenkins_last_completed_build",
      description:
        "A job's last finished build: number and result (SUCCESS, FAILURE, UNSTABLE, ABORTED). " +
        "Watch number and result to hear about each finished build.",
      method: "GET" as const,
      path: "/job/{+job}/lastCompletedBuild/api/json",
      readOnly: true,
      inputSchema: object({ job }, ["job"]),
      fixedQuery: { tree: `${BUILD_FIELDS},changeSets[items[msg,author[fullName]]]` },
    },
    {
      id: "jenkins_get_build",
      name: "jenkins_get_build",
      description: "Get one Jenkins build: result, causes, parameters, and the commits it built.",
      method: "GET" as const,
      path: "/job/{+job}/{number}/api/json",
      readOnly: true,
      inputSchema: object({ job, number }, ["job", "number"]),
      fixedQuery: {
        tree:
          `${BUILD_FIELDS},actions[causes[shortDescription],parameters[name,value]],` +
          "changeSets[items[msg,author[fullName]]]",
      },
    },
    {
      id: "jenkins_console",
      name: "jenkins_console",
      description:
        "Read a Jenkins build's console log from byte offset start (0 for the beginning). Long " +
        "logs come back truncated; read a later part with a larger start. Failures are usually " +
        "near the end.",
      method: "GET" as const,
      path: "/job/{+job}/{number}/logText/progressiveText",
      readOnly: true,
      inputSchema: object(
        { job, number, start: { type: "integer", description: "Byte offset to read from." } },
        ["job", "number"],
      ),
      fixedQuery: {},
    },
    {
      id: "jenkins_build",
      name: "jenkins_build",
      description:
        "Start a build of a Jenkins job that has no parameters. Ask the person first; it runs " +
        "as them.",
      method: "POST" as const,
      path: "/job/{+job}/build",
      readOnly: false,
      inputSchema: object({ job }, ["job"]),
      fixedQuery: {},
    },
  ];
}

/** The Jenkins preset when the deployment names its controller. */
export function jenkinsPreset(url: string | undefined): McpSourcePreset | null {
  const controller = url?.trim().replace(/\/+$/, "");
  if (!controller) return null;
  return {
    id: JENKINS_PRESET_ID,
    name: "Jenkins",
    kind: "api",
    url: controller,
    credentialLabel: "Jenkins user name:API token",
  };
}

/** The install config a Jenkins preset expands to. */
export function jenkinsInstallConfig() {
  return { auth: { type: "basic" as const }, headers: {}, operations: jenkinsOperations() };
}
