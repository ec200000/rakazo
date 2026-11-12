/**
 * The person's Azure DevOps Server, read and acted on with their own token for the Pull requests
 * page: every active pull request in the collection, grouped for them, with checks (pipeline
 * statuses such as Jenkins', and branch policies), files, diffs and comments, and their votes,
 * comments and merges. The collection URL comes from the deployment, never from the person.
 */
import type {
  CheckState,
  MergeStrategy,
  PullRequestCheck,
  PullRequestDetail,
  PullRequestFile,
  PullRequestList,
  PullRequestRef,
  PullRequestSummary,
  PullRequestThread,
  WorkItemDetail,
  WorkItemSummary,
  WorkItemView,
  WorkPerson,
} from "@rakazo/contracts";
import { unifiedDiff } from "./text-diff.js";

const REQUEST_TIMEOUT_MS = 20_000;
const MAX_PROJECTS = 60;
const MAX_FILE_BYTES = 1_000_000;
const CHECKED_GROUPS = new Set(["review", "mine"]);

export class AzureDevOpsError extends Error {
  constructor(
    message: string,
    readonly status: number | null = null,
  ) {
    super(message);
    this.name = "AzureDevOpsError";
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
function list(value: unknown): Json[] {
  const items = Array.isArray(value)
    ? value
    : Array.isArray(obj(value).value)
      ? obj(value).value
      : [];
  return (items as unknown[]).map(obj);
}
function branch(ref: unknown): string {
  return str(ref).replace(/^refs\/heads\//, "");
}

async function mapLimit<T, R>(items: T[], limit: number, run: (item: T) => Promise<R>) {
  const results: R[] = new Array(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (next < items.length) {
        const index = next;
        next += 1;
        results[index] = await run(items[index] as T);
      }
    }),
  );
  return results;
}

/** Explains an Azure DevOps response the person can act on. */
function failure(status: number, body: string): AzureDevOpsError {
  const message = str(obj(safeJson(body)).message);
  if (status === 401) {
    return new AzureDevOpsError(
      "Azure DevOps refused your token. Check your Azure DevOps connection in Integrations.",
      status,
    );
  }
  if (status === 403) {
    return new AzureDevOpsError(
      message || "Your Azure DevOps token is not allowed to do this (check its scopes).",
      status,
    );
  }
  if (status === 404) return new AzureDevOpsError(message || "Not found in Azure DevOps.", status);
  return new AzureDevOpsError(message || `Azure DevOps answered ${status}.`, status);
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function checkState(value: string): CheckState {
  const state = value.toLowerCase();
  if (["succeeded", "approved"].includes(state)) return "passing";
  if (["failed", "error", "rejected", "broken"].includes(state)) return "failing";
  if (["pending", "running", "queued"].includes(state)) return "pending";
  return "none";
}

/** The worst of a pull request's checks: one failure fails it, one pending keeps it pending. */
export function overallCheckState(checks: { state: CheckState }[]): CheckState {
  if (checks.some((check) => check.state === "failing")) return "failing";
  if (checks.some((check) => check.state === "pending")) return "pending";
  if (checks.some((check) => check.state === "passing")) return "passing";
  return "none";
}

export class AzureDevOpsClient {
  private meCache: WorkPerson | null = null;

  constructor(
    private readonly collectionUrl: string,
    private readonly authorization: string,
    private readonly apiVersion: string,
    private readonly fetchImpl: Fetch = globalThis.fetch,
  ) {}

  private url(
    path: string,
    query: Record<string, string | number | undefined> = {},
    apiVersion = this.apiVersion,
  ) {
    const url = new URL(`${this.collectionUrl.replace(/\/+$/, "")}${path}`);
    for (const [key, value] of Object.entries(query)) {
      if (value !== undefined) url.searchParams.set(key, String(value));
    }
    url.searchParams.set("api-version", apiVersion);
    return url;
  }

  /** Work item comments are still a preview API: 6.0-preview.3, or 7.1-preview.4 on newer servers. */
  private commentsVersion() {
    const major = Number.parseFloat(this.apiVersion);
    return major >= 7.1 ? `${this.apiVersion}-preview.4` : `${this.apiVersion}-preview.3`;
  }

  private async request(
    method: string,
    path: string,
    options: {
      query?: Record<string, string | number | undefined>;
      body?: unknown;
      text?: boolean;
      contentType?: string;
      apiVersion?: string;
    } = {},
  ): Promise<unknown> {
    let response: Response;
    try {
      response = await this.fetchImpl(this.url(path, options.query, options.apiVersion), {
        method,
        headers: {
          Authorization: this.authorization,
          Accept: options.text ? "text/plain" : "application/json",
          ...(options.body === undefined
            ? {}
            : { "Content-Type": options.contentType ?? "application/json" }),
        },
        body: options.body === undefined ? undefined : JSON.stringify(options.body),
        redirect: "manual",
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch (error) {
      const cause = obj(obj(error).cause);
      const code = str(cause.code) || (error instanceof Error ? error.name : "");
      throw new AzureDevOpsError(
        code === "TimeoutError"
          ? "Azure DevOps did not answer in time."
          : `Could not reach Azure DevOps (${code || (error instanceof Error ? error.message : "network error")}).`,
      );
    }
    const text = await response.text();
    // Azure DevOps answers an anonymous or expired session with a redirect to its sign-in page.
    if (response.status >= 300 && response.status < 400) throw failure(401, "");
    if (!response.ok) throw failure(response.status, text);
    if (options.text) return text;
    return text ? safeJson(text) : null;
  }

  async me(): Promise<WorkPerson> {
    if (this.meCache) return this.meCache;
    const data = obj(await this.request("GET", "/_apis/connectionData"));
    const user = obj(data.authenticatedUser);
    this.meCache = {
      id: str(user.id),
      name: str(user.providerDisplayName) || str(user.customDisplayName) || "You",
      me: true,
    };
    return this.meCache;
  }

  private person(value: unknown, me: WorkPerson | null): WorkPerson {
    const person = obj(value);
    const id = str(person.id);
    return {
      id,
      name: str(person.displayName) || str(person.uniqueName) || "Unknown",
      me: Boolean(me && id && id === me.id),
    };
  }

  private summary(raw: Json, me: WorkPerson | null): PullRequestSummary {
    const repository = obj(raw.repository);
    const project = obj(repository.project);
    const author = this.person(raw.createdBy, me);
    const reviewers = list(raw.reviewers).map((reviewer) => ({
      ...this.person(reviewer, me),
      vote: Number(reviewer.vote) || 0,
      required: reviewer.isRequired === true,
    }));
    const status = str(raw.status) as PullRequestSummary["status"];
    const myVote = reviewers.find((reviewer) => reviewer.me)?.vote;
    const group: PullRequestSummary["group"] =
      status !== "active"
        ? "done"
        : author.me
          ? "mine"
          : myVote === 0 || myVote === -5
            ? "review"
            : "others";
    const id = Number(raw.pullRequestId);
    const webBase = str(repository.webUrl);
    return {
      projectId: str(project.id),
      repositoryId: str(repository.id),
      id,
      project: str(project.name),
      repository: str(repository.name),
      title: str(raw.title),
      author,
      createdAt: str(raw.creationDate),
      closedAt: str(raw.closedDate) || null,
      sourceBranch: branch(raw.sourceRefName),
      targetBranch: branch(raw.targetRefName),
      isDraft: raw.isDraft === true,
      status: status === "completed" || status === "abandoned" ? status : "active",
      mergeStatus: str(raw.mergeStatus) || null,
      reviewers,
      checks: "none",
      group,
      webUrl: webBase ? `${webBase}/pullrequest/${id}` : null,
    };
  }

  private prPath(ref: PullRequestRef) {
    return `/${encodeURIComponent(ref.projectId)}/_apis/git/repositories/${encodeURIComponent(ref.repositoryId)}/pullRequests/${ref.id}`;
  }

  /** Pipeline statuses (Jenkins posts these) and branch policies, such as a build validation. */
  async checks(ref: PullRequestRef): Promise<PullRequestCheck[]> {
    const [statuses, policies] = await Promise.all([
      this.request("GET", `${this.prPath(ref)}/statuses`).catch(() => null),
      this.request("GET", `/${encodeURIComponent(ref.projectId)}/_apis/policy/evaluations`, {
        query: {
          artifactId: `vstfs:///CodeReview/CodeReviewId/${ref.projectId}/${ref.id}`,
        },
      }).catch(() => null),
    ]);
    // A status posted again for the same check replaces the older one.
    const latest = new Map<string, Json>();
    for (const status of list(statuses)) {
      const context = obj(status.context);
      const name = [str(context.genre), str(context.name)].filter(Boolean).join("/") || "status";
      const previous = latest.get(name);
      if (!previous || Number(status.id) > Number(previous.id)) latest.set(name, status);
    }
    const fromStatuses = [...latest.entries()].map(([name, status]) => ({
      name,
      state: checkState(str(status.state)),
      description: str(status.description) || null,
      url: str(status.targetUrl) || null,
    }));
    const fromPolicies = list(policies)
      .filter((evaluation) => obj(evaluation.configuration).isEnabled !== false)
      .map((evaluation) => {
        const configuration = obj(evaluation.configuration);
        const settings = obj(configuration.settings);
        return {
          name:
            str(settings.displayName) ||
            str(obj(configuration.type).displayName) ||
            "Branch policy",
          state: checkState(str(evaluation.status)),
          description: obj(configuration).isBlocking === false ? "Optional" : null,
          url: null,
        };
      })
      .filter((check) => check.state !== "none");
    return [...fromStatuses, ...fromPolicies];
  }

  /** Every active pull request in the collection, plus this person's recently closed ones. */
  async pullRequests(): Promise<PullRequestList> {
    const me = await this.me();
    const projects = list(
      await this.request("GET", "/_apis/projects", {
        query: { $top: 500, stateFilter: "wellFormed" },
      }),
    ).slice(0, MAX_PROJECTS);
    const perProject = await mapLimit(projects, 6, async (project) => {
      const path = `/${encodeURIComponent(str(project.id))}/_apis/git/pullrequests`;
      const [active, closed] = await Promise.all([
        this.request("GET", path, { query: { "searchCriteria.status": "active", $top: 300 } }),
        this.request("GET", path, {
          query: {
            "searchCriteria.status": "completed",
            "searchCriteria.creatorId": me.id,
            $top: 10,
          },
        }).catch(() => null),
      ]);
      return [...list(active), ...list(closed)];
    });
    const seen = new Set<string>();
    const pullRequests = perProject
      .flat()
      .map((raw) => this.summary(raw, me))
      .filter((pr) => {
        const key = `${pr.repositoryId}/${pr.id}`;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      });
    const checked = pullRequests.filter((pr) => CHECKED_GROUPS.has(pr.group)).slice(0, 60);
    await mapLimit(checked, 8, async (pr) => {
      pr.checks = overallCheckState(await this.checks(pr).catch(() => []));
    });
    pullRequests.sort((a, b) =>
      (b.closedAt ?? b.createdAt).localeCompare(a.closedAt ?? a.createdAt),
    );
    return { me, pullRequests, error: null };
  }

  private async lastIteration(ref: PullRequestRef) {
    const iterations = list(await this.request("GET", `${this.prPath(ref)}/iterations`));
    return iterations.reduce<Json | null>(
      (last, iteration) => (!last || Number(iteration.id) > Number(last.id) ? iteration : last),
      null,
    );
  }

  private async changeEntries(ref: PullRequestRef) {
    const iteration = await this.lastIteration(ref);
    if (!iteration) return [];
    const changes = obj(
      await this.request("GET", `${this.prPath(ref)}/iterations/${Number(iteration.id)}/changes`, {
        query: { $top: 2000, $compareTo: 0 },
      }),
    );
    return list(changes.changeEntries).filter((entry) => {
      const item = obj(entry.item);
      return !item.isFolder && str(item.gitObjectType) !== "tree";
    });
  }

  private file(entry: Json): PullRequestFile {
    const item = obj(entry.item);
    const type = str(entry.changeType).toLowerCase();
    const change: PullRequestFile["change"] = type.includes("delete")
      ? "delete"
      : type.includes("add")
        ? "add"
        : type.includes("rename")
          ? "rename"
          : "edit";
    return {
      path: str(item.path),
      originalPath: str(entry.originalPath) || null,
      change,
    };
  }

  async pullRequest(ref: PullRequestRef): Promise<PullRequestDetail> {
    const me = await this.me();
    const [raw, checkList, entries, threads] = await Promise.all([
      this.request("GET", this.prPath(ref)).then(obj),
      this.checks(ref).catch(() => []),
      this.changeEntries(ref).catch(() => []),
      this.request("GET", `${this.prPath(ref)}/threads`).catch(() => null),
    ]);
    const summary = this.summary(raw, me);
    return {
      ...summary,
      checks: overallCheckState(checkList),
      description: str(raw.description),
      checkList,
      files: entries.map((entry) => this.file(entry)),
      threads: list(threads).flatMap((thread): PullRequestThread[] => {
        if (thread.isDeleted === true) return [];
        const comments = list(thread.comments)
          .filter((comment) => str(comment.commentType) !== "system" && comment.isDeleted !== true)
          .map((comment) => ({
            id: Number(comment.id),
            author: str(obj(comment.author).displayName) || "Unknown",
            content: str(comment.content),
            createdAt: str(comment.publishedDate),
          }));
        if (comments.length === 0) return [];
        const context = obj(thread.threadContext);
        const line = Number(obj(context.rightFileStart).line ?? obj(context.leftFileStart).line);
        return [
          {
            id: Number(thread.id),
            status: str(thread.status) || null,
            filePath: str(context.filePath) || null,
            line: Number.isFinite(line) && line > 0 ? line : null,
            comments,
          },
        ];
      }),
      canComplete: summary.status === "active" && !summary.isDraft,
      autoComplete: Boolean(obj(raw.autoCompleteSetBy).id),
    };
  }

  private async blob(ref: PullRequestRef, objectId: string): Promise<string | null> {
    if (!objectId) return null;
    const text = (await this.request(
      "GET",
      `/${encodeURIComponent(ref.projectId)}/_apis/git/repositories/${encodeURIComponent(ref.repositoryId)}/blobs/${encodeURIComponent(objectId)}`,
      { query: { $format: "text" }, text: true },
    )) as string;
    if (text.length > MAX_FILE_BYTES) throw new AzureDevOpsError("This file is too large to show.");
    if (text.includes("\u0000")) throw new AzureDevOpsError("This is a binary file.");
    return text;
  }

  /** One file's diff from the target branch to the pull request's latest push. */
  async fileDiff(ref: PullRequestRef, path: string) {
    const entry = (await this.changeEntries(ref)).find(
      (change) => str(obj(change.item).path) === path,
    );
    if (!entry) throw new AzureDevOpsError("This file is not part of the pull request.", 404);
    const item = obj(entry.item);
    const file = this.file(entry);
    const before =
      file.change === "add"
        ? null
        : await this.blob(
            ref,
            str(item.originalObjectId) || (file.change === "delete" ? str(item.objectId) : ""),
          );
    const after = file.change === "delete" ? null : await this.blob(ref, str(item.objectId));
    return unifiedDiff(path, before, after);
  }

  async vote(ref: PullRequestRef, vote: number) {
    const me = await this.me();
    await this.request("PUT", `${this.prPath(ref)}/reviewers/${encodeURIComponent(me.id)}`, {
      body: { vote },
    });
  }

  async comment(ref: PullRequestRef, content: string, threadId?: number) {
    if (threadId) {
      await this.request("POST", `${this.prPath(ref)}/threads/${threadId}/comments`, {
        body: { content, parentCommentId: 1, commentType: 1 },
      });
      return;
    }
    await this.request("POST", `${this.prPath(ref)}/threads`, {
      body: { comments: [{ parentCommentId: 0, content, commentType: 1 }], status: 1 },
    });
  }

  /** Merges now, or sets auto-complete so Azure DevOps merges once its policies pass. */
  async complete(
    ref: PullRequestRef,
    options: { strategy: MergeStrategy; deleteSourceBranch: boolean; auto: boolean },
  ) {
    const me = await this.me();
    const raw = obj(await this.request("GET", this.prPath(ref)));
    const completionOptions = {
      mergeStrategy: options.strategy,
      deleteSourceBranch: options.deleteSourceBranch,
    };
    await this.request("PATCH", this.prPath(ref), {
      body: options.auto
        ? { autoCompleteSetBy: { id: me.id }, completionOptions }
        : {
            status: "completed",
            lastMergeSourceCommit: raw.lastMergeSourceCommit,
            completionOptions,
          },
    });
  }

  async publish(ref: PullRequestRef) {
    await this.request("PATCH", this.prPath(ref), { body: { isDraft: false } });
  }

  // Azure Boards ----------------------------------------------------------------------------

  private static WORK_ITEM_FIELDS = [
    "System.Id",
    "System.Title",
    "System.State",
    "System.WorkItemType",
    "System.AssignedTo",
    "System.ChangedDate",
    "System.Tags",
    "System.TeamProject",
    "Microsoft.VSTS.Common.Priority",
  ];

  private workItemSummary(raw: Json, me: WorkPerson | null): WorkItemSummary {
    const fields = obj(raw.fields);
    const assigned = obj(fields["System.AssignedTo"]);
    const project = str(fields["System.TeamProject"]);
    const id = Number(raw.id ?? fields["System.Id"]);
    const priority = Number(fields["Microsoft.VSTS.Common.Priority"]);
    return {
      id,
      project,
      type: str(fields["System.WorkItemType"]),
      title: str(fields["System.Title"]),
      state: str(fields["System.State"]),
      stateCategory: null,
      assignedTo: assigned.id || assigned.displayName ? this.person(assigned, me) : null,
      changedAt: str(fields["System.ChangedDate"]),
      priority: Number.isFinite(priority) && priority > 0 ? priority : null,
      tags: str(fields["System.Tags"])
        .split(";")
        .map((tag) => tag.trim())
        .filter(Boolean),
      webUrl: project
        ? `${this.collectionUrl.replace(/\/+$/, "")}/${encodeURIComponent(project)}/_workitems/edit/${id}`
        : null,
    };
  }

  /** The person's work items: assigned to them, created by them, mentioning them, or all open. */
  async workItems(view: WorkItemView): Promise<WorkItemSummary[]> {
    const me = await this.me();
    const open =
      "[System.State] NOT IN ('Closed', 'Done', 'Removed', 'Completed', 'Resolved', 'Cut')";
    const where = {
      assigned: `[System.AssignedTo] = @Me AND ${open}`,
      created: `[System.CreatedBy] = @Me AND [System.ChangedDate] >= @Today - 90`,
      mentioned: "[System.Id] IN (@RecentMentions)",
      open: `${open} AND [System.ChangedDate] >= @Today - 30`,
    }[view];
    const query = obj(
      await this.request("POST", "/_apis/wit/wiql", {
        query: { $top: 200 },
        body: {
          query: `SELECT [System.Id] FROM WorkItems WHERE ${where} ORDER BY [System.ChangedDate] DESC`,
        },
      }),
    );
    const ids = list(query.workItems)
      .map((item) => Number(item.id))
      .filter((id) => Number.isFinite(id))
      .slice(0, 200);
    if (ids.length === 0) return [];
    const items = list(
      await this.request("GET", "/_apis/wit/workitems", {
        query: {
          ids: ids.join(","),
          fields: AzureDevOpsClient.WORK_ITEM_FIELDS.join(","),
          errorPolicy: "omit",
        },
      }),
    ).filter((item) => item.id !== undefined && item.id !== null);
    const byId = new Map(items.map((item) => [Number(item.id), this.workItemSummary(item, me)]));
    return ids.flatMap((id) => {
      const item = byId.get(id);
      return item ? [item] : [];
    });
  }

  async workItem(id: number): Promise<WorkItemDetail> {
    const me = await this.me();
    const raw = obj(
      await this.request("GET", `/_apis/wit/workitems/${id}`, { query: { $expand: "all" } }),
    );
    const fields = obj(raw.fields);
    const summary = this.workItemSummary(raw, me);
    const project = encodeURIComponent(summary.project);
    const [states, comments] = await Promise.all([
      this.request(
        "GET",
        `/${project}/_apis/wit/workitemtypes/${encodeURIComponent(summary.type)}/states`,
      ).catch(() => null),
      this.request("GET", `/${project}/_apis/wit/workItems/${id}/comments`, {
        apiVersion: this.commentsVersion(),
        query: { $top: 100, order: "asc" },
      }).catch(() => null),
    ]);
    const stateList = list(states).map((state) => ({
      name: str(state.name),
      category: str(state.category) || null,
    }));
    const pullRequests = list(raw.relations).flatMap((relation) => {
      const match = /^vstfs:\/\/\/Git\/PullRequestId\/[^%]+%2F[^%]+%2F(\d+)$/i.exec(
        str(relation.url),
      );
      return match ? [{ id: Number(match[1]), url: str(relation.url) }] : [];
    });
    const createdBy = obj(fields["System.CreatedBy"]);
    return {
      ...summary,
      stateCategory: stateList.find((state) => state.name === summary.state)?.category ?? null,
      description: htmlToText(
        str(fields["System.Description"]) || str(fields["Microsoft.VSTS.TCM.ReproSteps"]),
      ),
      createdBy: str(createdBy.displayName) || null,
      createdAt: str(fields["System.CreatedDate"]) || null,
      areaPath: str(fields["System.AreaPath"]) || null,
      iterationPath: str(fields["System.IterationPath"]) || null,
      states: stateList,
      comments: list(obj(comments).comments).map((comment) => ({
        id: Number(comment.id),
        author: str(obj(comment.createdBy).displayName) || "Unknown",
        text: htmlToText(str(comment.text)),
        createdAt: str(comment.createdDate),
      })),
      pullRequests,
    };
  }

  async setWorkItemState(id: number, state: string) {
    await this.request("PATCH", `/_apis/wit/workitems/${id}`, {
      body: [{ op: "add", path: "/fields/System.State", value: state }],
      contentType: "application/json-patch+json",
    });
  }

  async commentOnWorkItem(id: number, text: string) {
    const raw = obj(
      await this.request("GET", `/_apis/wit/workitems/${id}`, {
        query: { fields: "System.TeamProject" },
      }),
    );
    const project = encodeURIComponent(str(obj(raw.fields)["System.TeamProject"]));
    await this.request("POST", `/${project}/_apis/wit/workItems/${id}/comments`, {
      apiVersion: this.commentsVersion(),
      body: { text: escapeHtml(text).replace(/\n/g, "<br>") },
    });
  }
}

function escapeHtml(text: string) {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/** Azure Boards stores rich text as HTML; the page and bots read it as plain text. */
export function htmlToText(html: string): string {
  return html
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|li|h[1-6]|tr)>/gi, "\n")
    .replace(/<li[^>]*>/gi, "- ")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}
