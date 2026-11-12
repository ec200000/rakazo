/**
 * Azure DevOps Server as a ready-made API connector: the deployment names its collection URL,
 * each person installs it with their own personal access token, and their bots get these
 * operations (repositories, branches, pull requests, comments, votes) acting as that person.
 */
import type { McpSourcePreset } from "@rakazo/contracts";

export const AZURE_DEVOPS_PRESET_ID = "azure-devops";
/** Azure DevOps Server 2020 and later accept 6.0. */
export const DEFAULT_AZURE_DEVOPS_API_VERSION = "6.0";

type Operation = {
  id: string;
  name: string;
  description: string;
  method: "GET" | "POST" | "PUT" | "PATCH";
  path: string;
  readOnly: boolean;
  inputSchema: Record<string, unknown>;
  queryParameters?: string[];
  fixedQuery: Record<string, string>;
};

const project = { type: "string", description: "Project name or id." };
const repository = { type: "string", description: "Repository name or id." };
const pullRequestId = { type: "integer", description: "Pull request number." };

function object(properties: Record<string, unknown>, required: string[]) {
  return { type: "object", properties, required, additionalProperties: false };
}

/** The operations a person's bot gets once they connect Azure DevOps. */
export function azureDevOpsOperations(apiVersion = DEFAULT_AZURE_DEVOPS_API_VERSION): Operation[] {
  const v = { "api-version": apiVersion };
  const pr = "/{project}/_apis/git/repositories/{repository}/pullRequests/{pullRequestId}";
  return [
    {
      id: "ado_whoami",
      name: "ado_whoami",
      description:
        "Who am I in Azure DevOps. " +
        "The signed-in person: authenticatedUser.id is their id for pull request searches and votes.",
      method: "GET",
      path: "/_apis/connectionData",
      readOnly: true,
      inputSchema: object({}, []),
      fixedQuery: {},
    },
    {
      id: "ado_list_projects",
      name: "ado_list_projects",
      description: "List projects. " + "Projects in the collection.",
      method: "GET",
      path: "/_apis/projects",
      readOnly: true,
      inputSchema: object({ $top: { type: "integer" } }, []),
      fixedQuery: v,
    },
    {
      id: "ado_list_repositories",
      name: "ado_list_repositories",
      description:
        "List repositories. " +
        "Git repositories in a project, with their web URLs and default branches.",
      method: "GET",
      path: "/{project}/_apis/git/repositories",
      readOnly: true,
      inputSchema: object({ project }, ["project"]),
      fixedQuery: v,
    },
    {
      id: "ado_list_branches",
      name: "ado_list_branches",
      description: "List branches. " + "Branches of a repository (refs under refs/heads/).",
      method: "GET",
      path: "/{project}/_apis/git/repositories/{repository}/refs",
      readOnly: true,
      inputSchema: object(
        {
          project,
          repository,
          filterContains: { type: "string", description: "Only branches containing this text." },
        },
        ["project", "repository"],
      ),
      fixedQuery: { ...v, filter: "heads/" },
    },
    {
      id: "ado_list_pull_requests",
      name: "ado_list_pull_requests",
      description:
        "List pull requests. " +
        "Pull requests in a project. Filter by status (active, completed, abandoned, all), by " +
        "creator or reviewer id (from ado_whoami), by repository id, or by source branch.",
      method: "GET",
      path: "/{project}/_apis/git/pullrequests",
      readOnly: true,
      inputSchema: object(
        {
          project,
          "searchCriteria.status": {
            type: "string",
            enum: ["active", "completed", "abandoned", "all"],
          },
          "searchCriteria.creatorId": { type: "string" },
          "searchCriteria.reviewerId": { type: "string" },
          "searchCriteria.repositoryId": { type: "string" },
          "searchCriteria.sourceRefName": {
            type: "string",
            description: "Only pull requests from this full ref, e.g. refs/heads/feature-x.",
          },
          $top: { type: "integer", description: "At most this many (default 100)." },
        },
        ["project"],
      ),
      fixedQuery: v,
    },
    {
      id: "ado_get_pull_request",
      name: "ado_get_pull_request",
      description:
        "Get a pull request. " +
        "One pull request: title, description, branches, author, reviewers and votes.",
      method: "GET",
      path: pr,
      readOnly: true,
      inputSchema: object({ project, repository, pullRequestId }, [
        "project",
        "repository",
        "pullRequestId",
      ]),
      fixedQuery: v,
    },
    {
      id: "ado_list_pull_request_iterations",
      name: "ado_list_pull_request_iterations",
      description:
        "List pull request iterations. " +
        "The pushes (iterations) of a pull request; the last one is the current state. Each has " +
        "sourceRefCommit and targetRefCommit for reading files.",
      method: "GET",
      path: `${pr}/iterations`,
      readOnly: true,
      inputSchema: object({ project, repository, pullRequestId }, [
        "project",
        "repository",
        "pullRequestId",
      ]),
      fixedQuery: v,
    },
    {
      id: "ado_get_pull_request_changes",
      name: "ado_get_pull_request_changes",
      description:
        "Get pull request changes. " +
        "Files an iteration of a pull request adds, edits, renames or deletes.",
      method: "GET",
      path: `${pr}/iterations/{iterationId}/changes`,
      readOnly: true,
      inputSchema: object(
        { project, repository, pullRequestId, iterationId: { type: "integer" } },
        ["project", "repository", "pullRequestId", "iterationId"],
      ),
      fixedQuery: v,
    },
    {
      id: "ado_get_file",
      name: "ado_get_file",
      description:
        "Read a file. " +
        "A file's text at a branch or commit. Compare the source and target commits of a pull " +
        "request iteration to review its changes.",
      method: "GET",
      path: "/{project}/_apis/git/repositories/{repository}/items",
      readOnly: true,
      inputSchema: object(
        {
          project,
          repository,
          path: { type: "string", description: "File path, e.g. /src/app.ts" },
          "versionDescriptor.version": { type: "string", description: "Branch name or commit." },
          "versionDescriptor.versionType": { type: "string", enum: ["branch", "commit"] },
        },
        ["project", "repository", "path"],
      ),
      fixedQuery: { ...v, includeContent: "true", $format: "json" },
    },
    {
      id: "ado_list_pull_request_threads",
      name: "ado_list_pull_request_threads",
      description:
        "List pull request comments. " +
        "Comment threads on a pull request, with their status and replies.",
      method: "GET",
      path: `${pr}/threads`,
      readOnly: true,
      inputSchema: object({ project, repository, pullRequestId }, [
        "project",
        "repository",
        "pullRequestId",
      ]),
      fixedQuery: v,
    },
    {
      id: "ado_find_people",
      name: "ado_find_people",
      description:
        "Find people. " +
        "People and groups by name or account, to add as reviewers. Returns their ids.",
      method: "GET",
      path: "/_apis/identities",
      readOnly: true,
      inputSchema: object({ filterValue: { type: "string" } }, ["filterValue"]),
      fixedQuery: { ...v, searchFilter: "General" },
    },
    {
      id: "ado_create_pull_request",
      name: "ado_create_pull_request",
      description:
        "Create a pull request. " +
        "Opens a pull request from sourceRefName into targetRefName (full ref names, e.g. " +
        "refs/heads/feature-x). The branch names come from the person; never invent them.",
      method: "POST",
      path: "/{project}/_apis/git/repositories/{repository}/pullrequests",
      readOnly: false,
      inputSchema: object(
        {
          project,
          repository,
          sourceRefName: { type: "string" },
          targetRefName: { type: "string" },
          title: { type: "string" },
          description: { type: "string" },
          isDraft: { type: "boolean" },
          reviewers: {
            type: "array",
            items: object({ id: { type: "string" } }, ["id"]),
            description: "Reviewer ids from ado_find_people.",
          },
        },
        ["project", "repository", "sourceRefName", "targetRefName", "title"],
      ),
      fixedQuery: v,
    },
    {
      id: "ado_comment_on_pull_request",
      name: "ado_comment_on_pull_request",
      description:
        "Comment on a pull request. " +
        "Starts a comment thread. For a comment on a line, add threadContext with filePath and " +
        "rightFileStart/rightFileEnd ({line, offset}).",
      method: "POST",
      path: `${pr}/threads`,
      readOnly: false,
      inputSchema: object(
        {
          project,
          repository,
          pullRequestId,
          comments: {
            type: "array",
            items: object(
              {
                content: { type: "string" },
                commentType: { type: "integer", description: "1 for text." },
                parentCommentId: { type: "integer" },
              },
              ["content"],
            ),
          },
          status: { type: "integer", description: "1 for active." },
          threadContext: { type: "object" },
        },
        ["project", "repository", "pullRequestId", "comments"],
      ),
      fixedQuery: v,
    },
    {
      id: "ado_reply_to_comment",
      name: "ado_reply_to_comment",
      description:
        "Reply to a pull request comment. " + "Adds a reply to an existing comment thread.",
      method: "POST",
      path: `${pr}/threads/{threadId}/comments`,
      readOnly: false,
      inputSchema: object(
        {
          project,
          repository,
          pullRequestId,
          threadId: { type: "integer" },
          content: { type: "string" },
          parentCommentId: { type: "integer" },
          commentType: { type: "integer" },
        },
        ["project", "repository", "pullRequestId", "threadId", "content"],
      ),
      fixedQuery: v,
    },
    {
      id: "ado_vote_on_pull_request",
      name: "ado_vote_on_pull_request",
      description:
        "Vote on a pull request. " +
        "Sets a reviewer's vote: 10 approve, 5 approve with suggestions, 0 none, -5 wait for " +
        "author, -10 reject. reviewerId is the person's own id from ado_whoami.",
      method: "PUT",
      path: `${pr}/reviewers/{reviewerId}`,
      readOnly: false,
      inputSchema: object(
        {
          project,
          repository,
          pullRequestId,
          reviewerId: { type: "string" },
          vote: { type: "integer", enum: [10, 5, 0, -5, -10] },
        },
        ["project", "repository", "pullRequestId", "reviewerId", "vote"],
      ),
      fixedQuery: v,
    },
  ];
}

/** The Azure DevOps preset when the deployment names its collection. */
export function azureDevOpsPreset(url: string | undefined): McpSourcePreset | null {
  const collection = url?.trim().replace(/\/+$/, "");
  if (!collection) return null;
  return {
    id: AZURE_DEVOPS_PRESET_ID,
    name: "Azure DevOps",
    kind: "api",
    url: collection,
    credentialLabel: "Personal access token",
  };
}

/** The install config an Azure DevOps preset expands to. */
export function azureDevOpsInstallConfig(apiVersion?: string) {
  return {
    auth: { type: "basic" as const },
    headers: {},
    operations: azureDevOpsOperations(apiVersion?.trim() || DEFAULT_AZURE_DEVOPS_API_VERSION),
  };
}
