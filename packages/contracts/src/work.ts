import * as z from "zod";

/** Work pages beside the chats: pull requests, Jenkins automations and Azure Boards issues. */
export const WorkStatusSchema = z.object({
  azureDevOps: z.object({
    /** The deployment names an Azure DevOps Server collection. */
    configured: z.boolean(),
    /** The person connected it in Integrations with their own token. */
    connected: z.boolean(),
    url: z.string().nullable(),
  }),
  jenkins: z.object({
    configured: z.boolean(),
    connected: z.boolean(),
    url: z.string().nullable(),
  }),
});
export type WorkStatus = z.infer<typeof WorkStatusSchema>;

export const WorkPersonSchema = z.object({
  id: z.string(),
  name: z.string(),
  me: z.boolean(),
});
export type WorkPerson = z.infer<typeof WorkPersonSchema>;

export const CheckStateSchema = z.enum(["passing", "failing", "pending", "none"]);
export type CheckState = z.infer<typeof CheckStateSchema>;

export const PullRequestCheckSchema = z.object({
  name: z.string(),
  state: CheckStateSchema,
  description: z.string().nullable(),
  url: z.string().nullable(),
});
export type PullRequestCheck = z.infer<typeof PullRequestCheckSchema>;

export const PullRequestRefSchema = z.object({
  projectId: z.string().min(1).max(200),
  repositoryId: z.string().min(1).max(200),
  id: z.number().int().positive(),
});
export type PullRequestRef = z.infer<typeof PullRequestRefSchema>;

export const PullRequestSummarySchema = PullRequestRefSchema.extend({
  project: z.string(),
  repository: z.string(),
  title: z.string(),
  author: WorkPersonSchema,
  createdAt: z.string(),
  closedAt: z.string().nullable(),
  sourceBranch: z.string(),
  targetBranch: z.string(),
  isDraft: z.boolean(),
  status: z.enum(["active", "completed", "abandoned"]),
  /** conflicts, succeeded, queued, …; null before Azure DevOps checks the merge. */
  mergeStatus: z.string().nullable(),
  reviewers: z.array(
    WorkPersonSchema.extend({
      /** 10 approved, 5 approved with suggestions, 0 none, -5 waiting for author, -10 rejected. */
      vote: z.number().int(),
      required: z.boolean(),
    }),
  ),
  checks: CheckStateSchema,
  /** Where the PR belongs on the page. */
  group: z.enum(["review", "mine", "others", "done"]),
  webUrl: z.string().nullable(),
});
export type PullRequestSummary = z.infer<typeof PullRequestSummarySchema>;

export const PullRequestFileSchema = z.object({
  path: z.string(),
  originalPath: z.string().nullable(),
  change: z.enum(["add", "edit", "delete", "rename"]),
});
export type PullRequestFile = z.infer<typeof PullRequestFileSchema>;

export const PullRequestCommentSchema = z.object({
  id: z.number().int(),
  author: z.string(),
  content: z.string(),
  createdAt: z.string(),
});

export const PullRequestThreadSchema = z.object({
  id: z.number().int(),
  status: z.string().nullable(),
  filePath: z.string().nullable(),
  line: z.number().int().nullable(),
  comments: z.array(PullRequestCommentSchema),
});
export type PullRequestThread = z.infer<typeof PullRequestThreadSchema>;

export const PullRequestDetailSchema = PullRequestSummarySchema.extend({
  description: z.string(),
  checkList: z.array(PullRequestCheckSchema),
  files: z.array(PullRequestFileSchema),
  threads: z.array(PullRequestThreadSchema),
  /** Whether this person may complete it (Azure DevOps still enforces its policies). */
  canComplete: z.boolean(),
  autoComplete: z.boolean(),
});
export type PullRequestDetail = z.infer<typeof PullRequestDetailSchema>;

export const PullRequestListSchema = z.object({
  me: WorkPersonSchema.nullable(),
  pullRequests: z.array(PullRequestSummarySchema),
  /** Why the list is empty or partial: not connected, the server refused, … */
  error: z.string().nullable(),
});
export type PullRequestList = z.infer<typeof PullRequestListSchema>;

export const MergeStrategySchema = z.enum(["squash", "noFastForward", "rebase", "rebaseMerge"]);
export type MergeStrategy = z.infer<typeof MergeStrategySchema>;

export const JenkinsStatusSchema = z.enum([
  "passed",
  "failed",
  "unstable",
  "aborted",
  "building",
  "disabled",
  "notbuilt",
  "unknown",
]);
export type JenkinsStatus = z.infer<typeof JenkinsStatusSchema>;

export const JenkinsBuildSchema = z.object({
  number: z.number().int(),
  status: JenkinsStatusSchema,
  startedAt: z.string().nullable(),
  durationMs: z.number().nullable(),
  url: z.string().nullable(),
});
export type JenkinsBuild = z.infer<typeof JenkinsBuildSchema>;

/** A job path as in its URL after the first /job/, e.g. `team/job/app`. */
export const JenkinsJobPathSchema = z
  .string()
  .min(1)
  .max(1000)
  .refine(
    (value) => value.split("/").every((part) => part !== "" && part !== "." && part !== ".."),
    "Not a Jenkins job path",
  );

export const JenkinsJobSchema = z.object({
  path: JenkinsJobPathSchema,
  /** Folders and name as Jenkins shows them, e.g. team/app. */
  fullName: z.string(),
  name: z.string(),
  folder: z.string().nullable(),
  kind: z.enum(["job", "folder", "multibranch", "branch"]),
  status: JenkinsStatusSchema,
  lastBuild: JenkinsBuildSchema.nullable(),
  url: z.string().nullable(),
});
export type JenkinsJob = z.infer<typeof JenkinsJobSchema>;

export const JenkinsParameterSchema = z.object({
  name: z.string(),
  type: z.enum(["string", "boolean", "choice", "text", "password", "other"]),
  description: z.string().nullable(),
  defaultValue: z.string().nullable(),
  choices: z.array(z.string()),
});
export type JenkinsParameter = z.infer<typeof JenkinsParameterSchema>;

export const JenkinsWatcherSchema = z.object({
  routineId: z.string(),
  botId: z.string(),
  botName: z.string(),
  active: z.boolean(),
});

export const JenkinsJobDetailSchema = JenkinsJobSchema.extend({
  description: z.string(),
  buildable: z.boolean(),
  parameters: z.array(JenkinsParameterSchema),
  builds: z.array(JenkinsBuildSchema),
  /** Sub-jobs of a folder or multibranch job. */
  jobs: z.array(JenkinsJobSchema),
  /** The person's routines that watch this job. */
  watchers: z.array(JenkinsWatcherSchema),
});
export type JenkinsJobDetail = z.infer<typeof JenkinsJobDetailSchema>;

export const JenkinsJobListSchema = z.object({
  jobs: z.array(JenkinsJobSchema),
  error: z.string().nullable(),
});

export const WorkItemViewSchema = z.enum(["assigned", "created", "mentioned", "open"]);
export type WorkItemView = z.infer<typeof WorkItemViewSchema>;

export const WorkItemSummarySchema = z.object({
  id: z.number().int(),
  project: z.string(),
  type: z.string(),
  title: z.string(),
  state: z.string(),
  /** Proposed, InProgress, Resolved, Completed, Removed: the state's place in the workflow. */
  stateCategory: z.string().nullable(),
  assignedTo: WorkPersonSchema.nullable(),
  changedAt: z.string(),
  priority: z.number().int().nullable(),
  tags: z.array(z.string()),
  webUrl: z.string().nullable(),
});
export type WorkItemSummary = z.infer<typeof WorkItemSummarySchema>;

export const WorkItemDetailSchema = WorkItemSummarySchema.extend({
  /** The description (or a bug's repro steps) as plain text. */
  description: z.string(),
  createdBy: z.string().nullable(),
  createdAt: z.string().nullable(),
  areaPath: z.string().nullable(),
  iterationPath: z.string().nullable(),
  states: z.array(z.object({ name: z.string(), category: z.string().nullable() })),
  comments: z.array(
    z.object({ id: z.number().int(), author: z.string(), text: z.string(), createdAt: z.string() }),
  ),
  pullRequests: z.array(z.object({ id: z.number().int(), url: z.string() })),
});
export type WorkItemDetail = z.infer<typeof WorkItemDetailSchema>;

export const WorkItemListSchema = z.object({
  items: z.array(WorkItemSummarySchema),
  error: z.string().nullable(),
});
