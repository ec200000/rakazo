/**
 * When a bot opens an Azure DevOps pull request (after the person agreed), Rakazo watches that
 * pull request's review comments for it: a routine (autoKey `ado-pr:<repository>:<id>`) checks
 * the comment threads and, on new activity, has the bot sum them up and ask the person whether
 * to address them. The routine cancels itself once the pull request is completed or abandoned.
 */

import type { JobPublisher } from "@rakazo/adapter-kit";
import { routineWakeupJob } from "@rakazo/adapter-kit";
import type { PrismaClient } from "@rakazo/db";
import { getLogger } from "@rakazo/logging";

export const ADO_PR_KEY = "ado-pr:";
const CREATE_TOOL = "ado_create_pull_request";

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

/** The pull request a successful ado_create_pull_request call made, called directly or through a catalog. */
export function createdPullRequest(
  name: string,
  args: Record<string, unknown>,
  result: unknown,
): {
  projectId: string;
  repositoryId: string;
  id: number;
  title: string;
  sourceBranch: string;
} | null {
  const viaCatalog = record(args).id === CREATE_TOOL;
  if (name !== CREATE_TOOL && !viaCatalog) return null;
  const outcome = record(result);
  if (outcome.error) return null;
  const data = record(outcome.data);
  const id = Number(data.pullRequestId);
  const repository = record(data.repository);
  const project = record(repository.project);
  if (!Number.isInteger(id) || id <= 0 || typeof repository.id !== "string") return null;
  return {
    projectId:
      typeof project.id === "string"
        ? project.id
        : String(record(viaCatalog ? args.arguments : args).project ?? ""),
    repositoryId: repository.id,
    id,
    title: typeof data.title === "string" ? data.title : `!${id}`,
    sourceBranch:
      typeof data.sourceRefName === "string"
        ? data.sourceRefName.replace(/^refs\/heads\//, "")
        : "",
  };
}

export function pullRequestWatchPrompt(pr: {
  projectId: string;
  repositoryId: string;
  id: number;
  title: string;
}) {
  return [
    `Your pull request !${pr.id} "${pr.title}" has new review activity.`,
    `First read it with ado_get_pull_request (project "${pr.projectId}", repository "${pr.repositoryId}", pullRequestId ${pr.id}).`,
    "If it is completed or abandoned, cancel this routine with schedule_cancel and reply in one line that the pull request is closed.",
    `Otherwise read its comment threads with ado_list_pull_request_threads and sum up in a few sentences what reviewers asked for, quoting file and line where given.`,
    'Then ask the person with ask_user whether to address it, with the choices "Fix it" and "Not now".',
    "Do not change code, reply on the pull request, or push before they agree.",
  ].join(" ");
}

/** Starts watching review comments on a pull request the bot just opened. Never throws. */
export async function watchCreatedPullRequest(
  deps: { prisma: PrismaClient; jobs: JobPublisher },
  run: { spaceId: string; userId: string },
  botId: string,
  pr: { projectId: string; repositoryId: string; id: number; title: string },
) {
  try {
    const autoKey = `${ADO_PR_KEY}${pr.repositoryId}:${pr.id}`;
    const nextRunAt = new Date(Date.now() + 2_000);
    const watch = {
      kind: "tool",
      tool: "ado_list_pull_request_threads",
      args: { project: pr.projectId, repository: pr.repositoryId, pullRequestId: pr.id },
      track: ["id", "lastUpdatedDate"],
      everyMinutes: 5,
      loud: false,
    };
    const row = await deps.prisma.routine.upsert({
      where: { botId_autoKey: { botId, autoKey } },
      create: {
        spaceId: run.spaceId,
        botId,
        userId: run.userId,
        name: `PR !${pr.id}: ${pr.title}`.slice(0, 80),
        prompt: pullRequestWatchPrompt(pr),
        crons: [],
        timezone: "UTC",
        notify: true,
        active: true,
        webhookEnabled: false,
        githubEnabled: false,
        watch,
        autoKey,
        nextRunAt,
      },
      update: {},
      select: { id: true, nextRunAt: true },
    });
    if (row.nextRunAt) await deps.jobs.enqueue(routineWakeupJob(row.id, row.nextRunAt));
  } catch (error) {
    getLogger().error("pull request watch", error);
  }
}
