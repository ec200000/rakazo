import { ORPCError } from "@orpc/server";
import {
  AzureDevOpsClient,
  AzureDevOpsError,
  DEFAULT_AZURE_DEVOPS_API_VERSION,
  JenkinsClient,
  JenkinsError,
  repositoryCredential,
} from "@rakazo/adapters";
import type { PullRequestRef } from "@rakazo/contracts";
import { RoutineWatchSchema } from "@rakazo/contracts";
import { Prisma } from "@rakazo/db";
import type { RouterContext } from "./context.js";

const JENKINS_NOT_CONNECTED =
  "Connect Jenkins in Integrations with your user name and API token (user:token) to see jobs.";
const NOT_CONNECTED =
  "Connect Azure DevOps in Integrations with your personal access token to see pull requests.";

/** Pull requests (and later automations and issues), always as the signed-in person. */
export function workRoutes(ctx: RouterContext) {
  const { deps, authed } = ctx;
  // Some test routers are built without an environment.
  const adoUrl = deps.env?.azureDevOpsUrl?.trim().replace(/\/+$/, "") || null;
  const jenkinsUrl = deps.env?.jenkinsUrl?.trim().replace(/\/+$/, "") || null;

  async function credential(actor: { spaceId: string; userId: string }, url: string | null) {
    if (!url) return null;
    return repositoryCredential({ prisma: deps.prisma, secretStore: deps.secrets }, actor, url, {
      serverFallback: false,
    });
  }

  async function client(actor: { spaceId: string; userId: string }) {
    if (!adoUrl)
      throw new ORPCError("PRECONDITION_FAILED", {
        message: "Azure DevOps is not set up on this server.",
      });
    const found = await credential(actor, adoUrl);
    if (!found) throw new ORPCError("PRECONDITION_FAILED", { message: NOT_CONNECTED });
    return new AzureDevOpsClient(
      adoUrl,
      found.header,
      deps.env?.azureDevOpsApiVersion?.trim() || DEFAULT_AZURE_DEVOPS_API_VERSION,
    );
  }

  async function jenkins(actor: { spaceId: string; userId: string }) {
    if (!jenkinsUrl) {
      throw new ORPCError("PRECONDITION_FAILED", {
        message: "Jenkins is not set up on this server.",
      });
    }
    const found = await credential(actor, jenkinsUrl);
    if (!found) throw new ORPCError("PRECONDITION_FAILED", { message: JENKINS_NOT_CONNECTED });
    return new JenkinsClient(jenkinsUrl, found.header);
  }

  /** Azure DevOps' and Jenkins' own explanations reach the person; anything else stays a server error. */
  async function act<T>(run: () => Promise<T>): Promise<T> {
    try {
      return await run();
    } catch (error) {
      if (error instanceof AzureDevOpsError || error instanceof JenkinsError) {
        throw new ORPCError(error.status === 404 ? "NOT_FOUND" : "BAD_REQUEST", {
          message: error.message,
        });
      }
      throw error;
    }
  }

  const ref = (input: PullRequestRef): PullRequestRef => ({
    projectId: input.projectId,
    repositoryId: input.repositoryId,
    id: input.id,
  });

  return {
    work: {
      status: authed.work.status.handler(async ({ context }) => {
        const [ado, jenkins] = await Promise.all([
          credential(context.actor, adoUrl),
          credential(context.actor, jenkinsUrl),
        ]);
        return {
          azureDevOps: { configured: Boolean(adoUrl), connected: Boolean(ado), url: adoUrl },
          jenkins: {
            configured: Boolean(jenkinsUrl),
            connected: Boolean(jenkins),
            url: jenkinsUrl,
          },
        };
      }),
      pullRequests: authed.work.pullRequests.handler(async ({ context }) => {
        if (!adoUrl) {
          return {
            me: null,
            pullRequests: [],
            error: "Azure DevOps is not set up on this server.",
          };
        }
        if (!(await credential(context.actor, adoUrl))) {
          return { me: null, pullRequests: [], error: NOT_CONNECTED };
        }
        try {
          return await (await client(context.actor)).pullRequests();
        } catch (error) {
          if (error instanceof AzureDevOpsError) {
            return { me: null, pullRequests: [], error: error.message };
          }
          throw error;
        }
      }),
      pullRequest: authed.work.pullRequest.handler(async ({ context, input }) =>
        act(async () => (await client(context.actor)).pullRequest(ref(input))),
      ),
      pullRequestDiff: authed.work.pullRequestDiff.handler(async ({ context, input }) =>
        act(async () => (await client(context.actor)).fileDiff(ref(input), input.path)),
      ),
      votePullRequest: authed.work.votePullRequest.handler(async ({ context, input }) =>
        act(async () => {
          await (await client(context.actor)).vote(ref(input), input.vote);
          return { ok: true as const };
        }),
      ),
      commentPullRequest: authed.work.commentPullRequest.handler(async ({ context, input }) =>
        act(async () => {
          await (await client(context.actor)).comment(ref(input), input.content, input.threadId);
          return { ok: true as const };
        }),
      ),
      completePullRequest: authed.work.completePullRequest.handler(async ({ context, input }) =>
        act(async () => {
          await (await client(context.actor)).complete(ref(input), {
            strategy: input.strategy,
            deleteSourceBranch: input.deleteSourceBranch,
            auto: input.auto,
          });
          return { ok: true as const };
        }),
      ),
      publishPullRequest: authed.work.publishPullRequest.handler(async ({ context, input }) =>
        act(async () => {
          await (await client(context.actor)).publish(ref(input));
          return { ok: true as const };
        }),
      ),
      workItems: authed.work.workItems.handler(async ({ context, input }) => {
        if (!adoUrl) return { items: [], error: "Azure DevOps is not set up on this server." };
        if (!(await credential(context.actor, adoUrl))) {
          return {
            items: [],
            error:
              "Connect Azure DevOps in Integrations with your personal access token to see work items.",
          };
        }
        try {
          return { items: await (await client(context.actor)).workItems(input.view), error: null };
        } catch (error) {
          if (error instanceof AzureDevOpsError) return { items: [], error: error.message };
          throw error;
        }
      }),
      workItem: authed.work.workItem.handler(async ({ context, input }) =>
        act(async () => (await client(context.actor)).workItem(input.id)),
      ),
      setWorkItemState: authed.work.setWorkItemState.handler(async ({ context, input }) =>
        act(async () => {
          await (await client(context.actor)).setWorkItemState(input.id, input.state);
          return { ok: true as const };
        }),
      ),
      commentWorkItem: authed.work.commentWorkItem.handler(async ({ context, input }) =>
        act(async () => {
          await (await client(context.actor)).commentOnWorkItem(input.id, input.text);
          return { ok: true as const };
        }),
      ),
      jenkinsJobs: authed.work.jenkinsJobs.handler(async ({ context }) => {
        if (!jenkinsUrl) return { jobs: [], error: "Jenkins is not set up on this server." };
        if (!(await credential(context.actor, jenkinsUrl))) {
          return { jobs: [], error: JENKINS_NOT_CONNECTED };
        }
        try {
          return { jobs: await (await jenkins(context.actor)).jobs(), error: null };
        } catch (error) {
          if (error instanceof JenkinsError) return { jobs: [], error: error.message };
          throw error;
        }
      }),
      jenkinsJob: authed.work.jenkinsJob.handler(async ({ context, input }) =>
        act(async () => {
          const detail = await (await jenkins(context.actor)).jobDetail(input.path);
          // The person's routines whose change trigger watches this job.
          const routines = await deps.prisma.routine.findMany({
            where: {
              spaceId: context.actor.spaceId,
              userId: context.actor.userId,
              bot: { archivedAt: null },
              NOT: { watch: { equals: Prisma.DbNull } },
            },
            select: {
              id: true,
              active: true,
              watch: true,
              bot: { select: { id: true, name: true } },
            },
          });
          const watchers = routines.flatMap((routine) => {
            const watch = RoutineWatchSchema.safeParse(routine.watch);
            if (!watch.success || watch.data.kind !== "tool") return [];
            if (!watch.data.tool?.startsWith("jenkins_") || watch.data.args?.job !== input.path)
              return [];
            return [
              {
                routineId: routine.id,
                botId: routine.bot.id,
                botName: routine.bot.name,
                active: routine.active,
              },
            ];
          });
          return { ...detail, watchers };
        }),
      ),
      jenkinsConsole: authed.work.jenkinsConsole.handler(async ({ context, input }) =>
        act(async () => (await jenkins(context.actor)).consoleTail(input.path, input.number)),
      ),
      jenkinsBuild: authed.work.jenkinsBuild.handler(async ({ context, input }) =>
        act(async () => {
          await (await jenkins(context.actor)).build(input.path, input.parameters);
          return { ok: true as const };
        }),
      ),
    },
  };
}
