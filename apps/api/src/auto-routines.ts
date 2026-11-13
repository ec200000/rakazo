/**
 * Routines Rakazo keeps for a bot by itself, marked by autoKey:
 * - `jenkins-branch:<folder>`: for each repository with a Jenkins multibranch job, a watch on the
 *   last finished build of the working branch, checked every minute. It follows the branch the
 *   person picks and goes away with the job, the repository or the branch.
 * - `ado-pr:<repositoryId>:<id>`: a watch on review comments of a pull request the bot opened
 *   (created by the worker when the bot opens one).
 * Each runs as the bot's owner, with their Jenkins or Azure DevOps connection.
 */
import { routineWakeupJob } from "@rakazo/adapter-kit";
import { botRepositoryPlan, repositoryCredential } from "@rakazo/adapters";
import type { Actor, CreateRoutineInput } from "@rakazo/contracts";
import { CreateRoutineInput as CreateRoutineSchema } from "@rakazo/contracts";
import { Prisma } from "@rakazo/db";
import { getLogger } from "@rakazo/logging";
import type { RouterDeps } from "./router.js";
import { firstWatchCheck, routineRowData } from "./routines.js";

export const JENKINS_BRANCH_KEY = "jenkins-branch:";

/** A branch's job name in a Jenkins multibranch project: `/` becomes `%2F` (and `%` `%25`). */
export function jenkinsBranchJobName(branch: string) {
  return branch.replace(/%/g, "%25").replace(/\//g, "%2F");
}

export function jenkinsBranchPrompt(folder: string, branch: string, job: string) {
  return [
    `Jenkins finished a build of ${branch} for the repository in ${folder}.`,
    `Read it with jenkins_last_completed_build (job "${job}").`,
    "If it passed, reply with one short line: the build number and that it passed.",
    "If it failed or is unstable, read the end of its log with jenkins_console, explain in a few sentences what failed and why,",
    'then ask the person with ask_user whether to fix it on this branch, with the choices "Fix it" and "Not now".',
    "Do not change code, push, or start builds before they agree.",
  ].join(" ");
}

type Desired = { key: string; input: CreateRoutineInput };

function desiredBranchWatches(
  botId: string,
  bot: {
    repos?: unknown;
    repoUrl?: string | null;
    repoBaseBranch?: string | null;
    repoBranch?: string | null;
  },
): Desired[] {
  const { repositories, branch } = botRepositoryPlan(bot);
  if (!branch) return [];
  return repositories.flatMap((repo) => {
    if (!repo.jenkinsJob) return [];
    const job = `${repo.jenkinsJob}/job/${jenkinsBranchJobName(branch)}`;
    const name = `Jenkins: ${repo.folder.replace(/^repos\//, "")} on ${branch}`.slice(0, 80);
    return [
      {
        key: `${JENKINS_BRANCH_KEY}${repo.folder}`,
        input: CreateRoutineSchema.parse({
          botId,
          name,
          prompt: jenkinsBranchPrompt(repo.folder, branch, job),
          active: true,
          notify: true,
          watch: {
            kind: "tool",
            tool: "jenkins_last_completed_build",
            args: { job },
            track: ["number", "result"],
            everyMinutes: 1,
          },
        }),
      },
    ];
  });
}

/**
 * Brings a bot's branch build watches in line with its repositories, branch and the owner's
 * Jenkins connection. Without a Jenkins connection there is nothing to watch with, so none stay.
 */
export async function syncBranchBuildWatches(deps: RouterDeps, actor: Actor, botId: string) {
  try {
    const bot = await deps.prisma.bot.findFirst({
      where: { id: botId, spaceId: actor.spaceId, archivedAt: null },
      select: {
        id: true,
        userId: true,
        repos: true,
        repoUrl: true,
        repoBaseBranch: true,
        repoBranch: true,
      },
    });
    if (!bot) return;
    const jenkinsUrl = deps.env?.jenkinsUrl?.trim();
    // The watch runs with the bot owner's Jenkins connection.
    const owner: Actor = { ...actor, userId: bot.userId };
    const connected = Boolean(
      jenkinsUrl &&
        (await repositoryCredential(
          { prisma: deps.prisma, secretStore: deps.secrets },
          owner,
          jenkinsUrl,
          {
            serverFallback: false,
          },
        )),
    );
    const desired = connected ? desiredBranchWatches(bot.id, bot) : [];
    const existing = await deps.prisma.routine.findMany({
      where: { botId: bot.id, autoKey: { startsWith: JENKINS_BRANCH_KEY } },
      select: { id: true, autoKey: true, watch: true, name: true },
    });
    const wanted = new Map(desired.map((entry) => [entry.key, entry.input]));
    const stale = existing.filter((row) => !row.autoKey || !wanted.has(row.autoKey));
    if (stale.length) {
      await deps.prisma.routine.deleteMany({ where: { id: { in: stale.map((row) => row.id) } } });
    }
    for (const [key, input] of wanted) {
      const current = existing.find((row) => row.autoKey === key);
      if (current && JSON.stringify(current.watch) === JSON.stringify(input.watch)) continue;
      const nextRunAt = firstWatchCheck();
      const row = current
        ? await deps.prisma.routine.update({
            where: { id: current.id },
            data: {
              name: input.name,
              prompt: input.prompt,
              watch: input.watch as Prisma.InputJsonValue,
              // A new branch starts from its own first build, not the old branch's.
              watchState: Prisma.DbNull,
              active: true,
              nextRunAt,
            },
            select: { id: true, nextRunAt: true },
          })
        : await deps.prisma.routine.create({
            data: { ...routineRowData(owner, input, nextRunAt), autoKey: key },
            select: { id: true, nextRunAt: true },
          });
      if (row.nextRunAt) await deps.jobs.enqueue(routineWakeupJob(row.id, row.nextRunAt));
    }
  } catch (error) {
    getLogger().error("branch build watches", error);
  }
}

/** After someone connects Jenkins, their bots that have Jenkins jobs start watching. */
export async function syncAllBranchBuildWatches(deps: RouterDeps, actor: Actor) {
  const bots = await deps.prisma.bot.findMany({
    where: { userId: actor.userId, archivedAt: null, repoBranch: { not: null } },
    select: { id: true, spaceId: true },
  });
  for (const bot of bots) {
    await syncBranchBuildWatches(deps, { ...actor, spaceId: bot.spaceId }, bot.id);
  }
}
