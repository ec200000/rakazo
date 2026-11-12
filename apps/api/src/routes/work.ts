import { ORPCError } from "@orpc/server";
import {
  AzureDevOpsClient,
  AzureDevOpsError,
  DEFAULT_AZURE_DEVOPS_API_VERSION,
  repositoryCredential,
} from "@rakazo/adapters";
import type { PullRequestRef } from "@rakazo/contracts";
import type { RouterContext } from "./context.js";

const NOT_CONNECTED =
  "Connect Azure DevOps in Integrations with your personal access token to see pull requests.";

/** Pull requests (and later automations and issues), always as the signed-in person. */
export function workRoutes(ctx: RouterContext) {
  const { deps, authed } = ctx;
  const adoUrl = deps.env.azureDevOpsUrl?.trim().replace(/\/+$/, "") || null;
  const jenkinsUrl = deps.env.jenkinsUrl?.trim().replace(/\/+$/, "") || null;

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
      deps.env.azureDevOpsApiVersion?.trim() || DEFAULT_AZURE_DEVOPS_API_VERSION,
    );
  }

  /** Azure DevOps' own explanation reaches the person; anything else stays a server error. */
  async function act<T>(run: () => Promise<T>): Promise<T> {
    try {
      return await run();
    } catch (error) {
      if (error instanceof AzureDevOpsError) {
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
    },
  };
}
