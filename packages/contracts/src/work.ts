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
