/**
 * The person's Jenkins, read and driven with their own API token for the Automations page:
 * jobs (folders and multibranch branches included) with their last build, a job's builds and
 * parameters, the end of a build's log, and Build now. The controller URL comes from the
 * deployment. API-token requests need no CSRF crumb.
 */
import type {
  JenkinsBuild,
  JenkinsJob,
  JenkinsJobDetail,
  JenkinsParameter,
  JenkinsStatus,
} from "@rakazo/contracts";

const REQUEST_TIMEOUT_MS = 20_000;
const CONSOLE_TAIL_BYTES = 256_000;
const CONSOLE_MAX_READ_BYTES = 30_000_000;
const BUILD_FIELDS = "number,result,building,timestamp,duration,url";
const JOB_FIELDS = `_class,name,fullName,url,color,lastBuild[${BUILD_FIELDS}]`;

export class JenkinsError extends Error {
  constructor(
    message: string,
    readonly status: number | null = null,
  ) {
    super(message);
    this.name = "JenkinsError";
  }
}

type Json = Record<string, unknown>;
type Fetch = typeof globalThis.fetch;

function obj(value: unknown): Json {
  return value && typeof value === "object" ? (value as Json) : {};
}
function str(value: unknown): string {
  return typeof value === "string" ? value : "";
}
function arr(value: unknown): Json[] {
  return Array.isArray(value) ? value.map(obj) : [];
}

/** A job's color (blue, red_anime, …) or a build's result as one status. */
export function jenkinsStatus(
  color: string,
  result?: string | null,
  building?: boolean,
): JenkinsStatus {
  if (building || color.endsWith("_anime")) return "building";
  const value = (result ?? "").toUpperCase() || color.replace(/_anime$/, "");
  switch (value) {
    case "SUCCESS":
    case "blue":
    case "green":
      return "passed";
    case "FAILURE":
    case "red":
      return "failed";
    case "UNSTABLE":
    case "yellow":
      return "unstable";
    case "ABORTED":
    case "aborted":
      return "aborted";
    case "disabled":
      return "disabled";
    case "NOT_BUILT":
    case "notbuilt":
      return "notbuilt";
    default:
      return "unknown";
  }
}

function build(raw: Json): JenkinsBuild {
  const timestamp = Number(raw.timestamp);
  const duration = Number(raw.duration);
  return {
    number: Number(raw.number),
    status: jenkinsStatus("", str(raw.result) || null, raw.building === true),
    startedAt:
      Number.isFinite(timestamp) && timestamp > 0 ? new Date(timestamp).toISOString() : null,
    durationMs: Number.isFinite(duration) && duration > 0 ? duration : null,
    url: str(raw.url) || null,
  };
}

function kind(className: string, parentKind: JenkinsJob["kind"] | null): JenkinsJob["kind"] {
  if (/MultiBranch|OrganizationFolder/i.test(className)) return "multibranch";
  if (/Folder/i.test(className)) return "folder";
  return parentKind === "multibranch" ? "branch" : "job";
}

/**
 * A job's path from its folders and name, as Jenkins names them (a multibranch branch keeps its
 * `%2F`): `team/job/app`. URLs encode each name once; bots' Jenkins tools take the same path.
 */
export function jenkinsJobPath(parts: string[]): string {
  return parts.join("/job/");
}

export class JenkinsClient {
  constructor(
    private readonly baseUrl: string,
    private readonly authorization: string,
    private readonly fetchImpl: Fetch = globalThis.fetch,
  ) {}

  private url(path: string, query: Record<string, string> = {}) {
    const url = new URL(`${this.baseUrl.replace(/\/+$/, "")}${path}`);
    for (const [key, value] of Object.entries(query)) url.searchParams.set(key, value);
    return url;
  }

  /** `/job/team/job/app` with every name encoded, so a path cannot leave the controller. */
  private jobUrlPath(path: string) {
    const parts = path.split("/");
    const valid =
      parts.length % 2 === 1 &&
      parts.every((part, index) =>
        index % 2 === 1 ? part === "job" : part !== "" && part !== "." && part !== "..",
      );
    if (!valid) throw new JenkinsError("Not a Jenkins job path.");
    const names = parts.filter((_, index) => index % 2 === 0);
    return `/job/${names.map((name) => encodeURIComponent(name)).join("/job/")}`;
  }

  private async request(
    method: string,
    path: string,
    query: Record<string, string> = {},
    timeoutMs = REQUEST_TIMEOUT_MS,
  ): Promise<Response> {
    let response: Response;
    try {
      response = await this.fetchImpl(this.url(path, query), {
        method,
        headers: { Authorization: this.authorization, Accept: "application/json" },
        redirect: "manual",
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (error) {
      const cause = obj(obj(error).cause);
      const code = str(cause.code) || (error instanceof Error ? error.name : "");
      throw new JenkinsError(
        code === "TimeoutError"
          ? "Jenkins did not answer in time."
          : `Could not reach Jenkins (${code || (error instanceof Error ? error.message : "network error")}).`,
      );
    }
    if (
      response.status === 401 ||
      (response.status >= 300 && response.status < 400 && method === "GET")
    ) {
      throw new JenkinsError(
        "Jenkins refused your API token. Check your Jenkins connection in Integrations (user name:API token).",
        401,
      );
    }
    if (response.status === 403) {
      throw new JenkinsError("Your Jenkins user is not allowed to do this.", 403);
    }
    if (response.status === 404) throw new JenkinsError("Not found in Jenkins.", 404);
    if (!response.ok && !(response.status >= 300 && response.status < 400)) {
      throw new JenkinsError(`Jenkins answered ${response.status}.`, response.status);
    }
    return response;
  }

  private async json(path: string, tree: string) {
    const response = await this.request("GET", `${path}/api/json`, { tree });
    return obj(await response.json().catch(() => null));
  }

  private job(raw: Json, parents: string[], parentKind: JenkinsJob["kind"] | null): JenkinsJob {
    const name = str(raw.name);
    const jobKind = kind(str(raw._class), parentKind);
    const last = obj(raw.lastBuild);
    return {
      path: jenkinsJobPath([...parents, name]),
      fullName: str(raw.fullName) || [...parents, name].join("/"),
      name,
      folder: parents.length ? parents.join("/") : null,
      kind: jobKind,
      status:
        jobKind === "folder" || jobKind === "multibranch"
          ? "unknown"
          : jenkinsStatus(
              str(raw.color),
              last.number ? str(last.result) || null : null,
              last.building === true,
            ),
      lastBuild: last.number ? build(last) : null,
      url: str(raw.url) || null,
    };
  }

  /** Every job three levels deep: top-level jobs, folders' jobs, and multibranch branches. */
  async jobs(): Promise<JenkinsJob[]> {
    const tree = `jobs[${JOB_FIELDS},jobs[${JOB_FIELDS},jobs[${JOB_FIELDS}]]]`;
    const root = await this.json("", tree);
    const out: JenkinsJob[] = [];
    const walk = (items: Json[], parents: string[], parentKind: JenkinsJob["kind"] | null) => {
      for (const raw of items) {
        const job = this.job(raw, parents, parentKind);
        out.push(job);
        if (Array.isArray(raw.jobs)) walk(arr(raw.jobs), [...parents, job.name], job.kind);
      }
    };
    walk(arr(root.jobs), [], null);
    return out;
  }

  async jobDetail(path: string): Promise<Omit<JenkinsJobDetail, "watchers">> {
    const raw = await this.json(
      this.jobUrlPath(path),
      `${JOB_FIELDS},description,buildable,builds[${BUILD_FIELDS}]{0,25},jobs[${JOB_FIELDS}],` +
        "property[parameterDefinitions[_class,name,type,description,choices,defaultParameterValue[value]]]",
    );
    const parts = path.split("/job/");
    const job = this.job(raw, parts.slice(0, -1), null);
    const parameters: JenkinsParameter[] = arr(raw.property).flatMap((property) =>
      arr(property.parameterDefinitions).map((definition) => {
        const type = str(definition.type).toLowerCase();
        const choices = Array.isArray(definition.choices) ? definition.choices.map(String) : [];
        const fallback = obj(definition.defaultParameterValue).value;
        return {
          name: str(definition.name),
          type: type.includes("boolean")
            ? "boolean"
            : type.includes("choice")
              ? "choice"
              : type.includes("password")
                ? "password"
                : type.includes("text")
                  ? "text"
                  : type.includes("string")
                    ? "string"
                    : "other",
          description: str(definition.description) || null,
          defaultValue: fallback === undefined || fallback === null ? null : String(fallback),
          choices,
        } satisfies JenkinsParameter;
      }),
    );
    return {
      ...job,
      path,
      description: str(raw.description),
      buildable: raw.buildable !== false,
      parameters,
      builds: arr(raw.builds).map(build),
      jobs: arr(raw.jobs).map((child) => this.job(child, parts, job.kind)),
    };
  }

  /** The last part of a build's log; long logs are read through and only their end kept. */
  async consoleTail(path: string, number: number) {
    const response = await this.request(
      "GET",
      `${this.jobUrlPath(path)}/${number}/consoleText`,
      {},
      60_000,
    );
    const building = response.headers.get("x-more-data") === "true";
    let tail = new Uint8Array(0);
    let read = 0;
    let truncated = false;
    if (response.body) {
      const reader = response.body.getReader();
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        read += value.byteLength;
        const joined = new Uint8Array(tail.byteLength + value.byteLength);
        joined.set(tail);
        joined.set(value, tail.byteLength);
        if (joined.byteLength > CONSOLE_TAIL_BYTES) {
          tail = joined.subarray(joined.byteLength - CONSOLE_TAIL_BYTES);
          truncated = true;
        } else tail = joined;
        if (read > CONSOLE_MAX_READ_BYTES) {
          await reader.cancel().catch(() => undefined);
          break;
        }
      }
    }
    let text = new TextDecoder().decode(tail);
    // Start the tail at a whole line.
    if (truncated) text = text.slice(text.indexOf("\n") + 1);
    return { text, truncated, building };
  }

  /** Build now, with parameters for a parameterized job. */
  async build(path: string, parameters?: Record<string, string>) {
    const hasParameters = parameters && Object.keys(parameters).length > 0;
    await this.request(
      "POST",
      `${this.jobUrlPath(path)}/${hasParameters ? "buildWithParameters" : "build"}`,
      hasParameters ? parameters : {},
    );
  }
}
