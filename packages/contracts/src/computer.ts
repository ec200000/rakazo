import * as z from "zod";
import { Id, SandboxKind } from "./ids.js";

export const ComputerModeSchema = z.enum(["team", "dedicated"]);
export type ComputerMode = z.infer<typeof ComputerModeSchema>;

/** How big a machine a cloud computer runs on. Providers without sizes ignore it. */
export const ComputerSizeSchema = z.enum(["standard", "large", "xlarge"]);
export type ComputerSize = z.infer<typeof ComputerSizeSchema>;

export const COMPUTER_UPDATE_STAGES = [
  "preparing",
  "saving",
  "recreating",
  "restoring",
  "reconnecting",
] as const;
export const ComputerUpdateSchema = z.object({
  canReleaseReservation: z.boolean().optional(),
  action: z.enum(["update", "recover"]),
  id: Id,
  botId: Id,
  name: z.string(),
  mode: ComputerModeSchema,
  status: z.enum(["queued", "running", "interrupted", "completed", "failed"]),
  stage: z.enum(COMPUTER_UPDATE_STAGES),
});
export type ComputerUpdate = z.infer<typeof ComputerUpdateSchema>;

export const ComputerStatusSchema = z.object({
  botId: Id,
  mode: ComputerModeSchema,
  kind: SandboxKind,
  state: z.enum(["stopped", "booting", "running", "suspended", "error"]),
  controlHolder: z.enum(["bot", "user", "none"]),
  controlBotId: Id.nullable(),
  takeoverRequested: z.boolean(),
  screenAvailable: z.boolean(),
  screenWidth: z.number().int().positive(),
  screenHeight: z.number().int().positive(),
  homeRevision: z.string().nullable(),
  busyBotName: z.string().nullable(),
  canUpdate: z.boolean(),
  terminalAvailable: z.boolean(),
  /** Set only while the user should see that the disk is nearly full. */
  diskFullPercent: z.number().int().min(0).max(100).optional(),
  /** True when other people share the Space, and with it this computer and its browser sign-ins. */
  shared: z.boolean().optional(),
  /** True when another person in the Space has control, so this viewer only watches. */
  controlledByOther: z.boolean().optional(),
});
export type ComputerStatus = z.infer<typeof ComputerStatusSchema>;

export const ComputerReleaseReasonSchema = z.enum(["done", "skipped"]);
export type ComputerReleaseReason = z.infer<typeof ComputerReleaseReasonSchema>;

/** Public metadata only; adapter validation and constructor options stay server-side. */
export const ComputerProviderFieldSchema = z.object({
  key: z.string(),
  label: z.string(),
  kind: z.enum(["text", "secret", "url", "select"]),
  required: z.boolean(),
  options: z.array(z.object({ value: z.string(), label: z.string() })).optional(),
  validation: z.enum(["public-https"]).optional(),
  /** A saved credential must be re-entered when its destination changes. */
  destination: z.string().optional(),
});
export type ComputerProviderField = z.infer<typeof ComputerProviderFieldSchema>;
export const ComputerProviderDescriptorSchema = z.object({
  id: z.string(),
  displayName: z.string(),
  fields: z.array(ComputerProviderFieldSchema),
  capabilities: z.object({ perAccount: z.boolean() }),
});
export type ComputerProviderDescriptor = z.infer<typeof ComputerProviderDescriptorSchema>;
export const ComputerProviderSettingsSchema = z.object({
  provider: z.string(),
  defaultProvider: z.string(),
  providers: z.array(ComputerProviderDescriptorSchema),
  values: z.record(z.string(), z.string()),
  savedSecrets: z.record(z.string(), z.boolean()),
});
export type ComputerProviderSettings = z.infer<typeof ComputerProviderSettingsSchema>;
export const ComputerProviderUpdateSchema = z.object({
  provider: z.string().trim().min(1).max(64),
  values: z.record(z.string().max(64), z.string().trim().max(4096)).default({}),
});
export type ComputerProviderUpdate = z.infer<typeof ComputerProviderUpdateSchema>;

/** The vCPUs and memory each computer size provides. */
export const COMPUTER_SIZE_SPECS: Record<ComputerSize, { vcpus: number; memoryGb: number }> = {
  standard: { vcpus: 4, memoryGb: 8 },
  large: { vcpus: 8, memoryGb: 16 },
  xlarge: { vcpus: 16, memoryGb: 32 },
};

/** A file the bot's working branch changes against the base branch, for the Changes panel. */
export const RepoChangeSchema = z.object({
  path: z.string(),
  status: z.enum(["added", "modified", "deleted", "typechange", "untracked", "conflict"]),
  additions: z.number().int().nullable(),
  deletions: z.number().int().nullable(),
  uncommitted: z.boolean(),
});
export type RepoChange = z.infer<typeof RepoChangeSchema>;

export const RepoChangesSchema = z.object({
  /** asleep: the computer is not running, so git cannot be read until it wakes. */
  state: z.enum(["no-repository", "asleep", "not-cloned", "ready"]),
  /** The repository folder, relative to the bot's workspace (as the Files tab lists it). */
  folder: z.string().nullable(),
  baseBranch: z.string(),
  /** The branch checked out in the folder, and the one the person chose above the chat. */
  branch: z.string().nullable(),
  workingBranch: z.string().nullable(),
  behind: z.number().int().nullable(),
  ahead: z.number().int().nullable(),
  commits: z.array(z.object({ sha: z.string(), subject: z.string() })),
  files: z.array(RepoChangeSchema),
  truncated: z.boolean(),
});
export type RepoChanges = z.infer<typeof RepoChangesSchema>;

/** A command the person ran in the bot's computer from the Terminal tab. */
export const ComputerRunResultSchema = z.object({
  exitCode: z.number().int().nullable(),
  output: z.string(),
  truncated: z.boolean(),
  cwd: z.string(),
});
export type ComputerRunResult = z.infer<typeof ComputerRunResultSchema>;
