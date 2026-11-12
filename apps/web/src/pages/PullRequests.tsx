import { t } from "@lingui/core/macro";
import { Trans, useLingui } from "@lingui/react/macro";
import { ChatMarkdown } from "@rakazo/chat-ui/web";
import type {
  Bot,
  CheckState,
  MergeStrategy,
  PullRequestDetail,
  PullRequestRef,
  PullRequestSummary,
} from "@rakazo/contracts";
import {
  Button,
  buttonVariants,
  Checkbox,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
  Input,
  Spinner,
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
  Textarea,
} from "@rakazo/ui-web";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Check,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  Circle,
  CircleDot,
  ExternalLink,
  GitBranch,
  GitMerge,
  GitPullRequest,
  MessageSquare,
  RefreshCw,
  Search,
  X,
} from "lucide-react";
import type { ReactNode } from "react";
import { useMemo, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { IconTooltip } from "../components/IconTooltip";
import { takeInitialBootstrap } from "../lib/bootstrap";
import { replaceComposerDraft } from "../lib/composer-draft";
import { desktopBridge } from "../lib/desktop";
import { useSpaceQueries } from "../lib/query";
import { formatRelativeTime } from "../lib/relative-time";
import { rpc } from "../lib/rpc";
import { errorText } from "../lib/user-error";
import { DiffView } from "./shell/code-diff";
import { WindowChrome } from "./WindowChrome";

const NO_BOTS: Bot[] = [];

type Group = PullRequestSummary["group"];
const GROUP_ORDER: Group[] = ["review", "mine", "others", "done"];

function groupTitle(group: Group) {
  switch (group) {
    case "review":
      return t`Needs your review`;
    case "mine":
      return t`Yours`;
    case "others":
      return t`Everyone else`;
    case "done":
      return t`Recently closed`;
  }
}

function prPath(pr: PullRequestRef) {
  return `/app/pulls/${encodeURIComponent(pr.projectId)}/${encodeURIComponent(pr.repositoryId)}/${pr.id}`;
}

export function CheckIcon({ state, className = "" }: { state: CheckState; className?: string }) {
  const { t } = useLingui();
  if (state === "passing") {
    return (
      <Check
        aria-label={t`Checks passed`}
        className={`size-4 shrink-0 text-success ${className}`}
        strokeWidth={2.4}
      />
    );
  }
  if (state === "failing") {
    return (
      <X
        aria-label={t`Checks failed`}
        className={`size-4 shrink-0 text-destructive ${className}`}
        strokeWidth={2.4}
      />
    );
  }
  if (state === "pending") {
    return (
      <CircleDot
        aria-label={t`Checks running`}
        className={`size-4 shrink-0 text-warning motion-safe:animate-pulse ${className}`}
      />
    );
  }
  return (
    <Circle
      aria-label={t`No checks`}
      className={`size-4 shrink-0 text-muted-foreground/50 ${className}`}
    />
  );
}

function Badge({
  children,
  tone = "muted",
}: {
  children: ReactNode;
  tone?: "muted" | "warning" | "danger" | "success";
}) {
  const tones = {
    muted: "bg-muted text-muted-foreground",
    warning: "bg-warning/15 text-warning",
    danger: "bg-destructive/12 text-destructive",
    success: "bg-success/15 text-success",
  };
  return (
    <span className={`shrink-0 rounded-full px-1.5 py-px text-caption font-medium ${tones[tone]}`}>
      {children}
    </span>
  );
}

function voteSummary(pr: PullRequestSummary) {
  const approved = pr.reviewers.filter((reviewer) => reviewer.vote >= 5).length;
  const waiting = pr.reviewers.filter((reviewer) => reviewer.vote === -5).length;
  const rejected = pr.reviewers.filter((reviewer) => reviewer.vote === -10).length;
  return { approved, waiting, rejected };
}

function PullRequestRow({ pr, selected }: { pr: PullRequestSummary; selected: boolean }) {
  const votes = voteSummary(pr);
  return (
    <Link
      to={prPath(pr)}
      data-testid="pull-request-row"
      aria-current={selected ? "page" : undefined}
      className={`flex gap-2.5 rounded-xl px-3 py-2 text-start hover:bg-accent/60 ${selected ? "bg-accent" : ""}`}
    >
      <CheckIcon state={pr.checks} className="mt-0.5" />
      <span className="min-w-0 flex-1">
        <span className="flex items-center gap-1.5">
          <span className="min-w-0 truncate text-body font-medium text-foreground" dir="auto">
            {pr.title}
          </span>
          {pr.isDraft ? (
            <Badge>
              <Trans>Draft</Trans>
            </Badge>
          ) : null}
          {pr.mergeStatus === "conflicts" ? (
            <Badge tone="danger">
              <Trans>Conflicts</Trans>
            </Badge>
          ) : null}
          {pr.status === "completed" ? (
            <Badge tone="success">
              <Trans>Merged</Trans>
            </Badge>
          ) : null}
          {pr.status === "abandoned" ? (
            <Badge>
              <Trans>Abandoned</Trans>
            </Badge>
          ) : null}
        </span>
        <span className="mt-0.5 flex items-center gap-1.5 text-label text-muted-foreground">
          <span className="truncate">
            {pr.repository} !{pr.id} · {pr.author.me ? <Trans>you</Trans> : pr.author.name} ·{" "}
            {formatRelativeTime(pr.closedAt ?? pr.createdAt)}
          </span>
          {votes.approved ? (
            <span className="flex shrink-0 items-center gap-0.5 text-success">
              <Check className="size-3" strokeWidth={2.4} />
              {votes.approved}
            </span>
          ) : null}
          {votes.waiting + votes.rejected ? (
            <span className="flex shrink-0 items-center gap-0.5 text-destructive">
              <X className="size-3" strokeWidth={2.4} />
              {votes.waiting + votes.rejected}
            </span>
          ) : null}
        </span>
        <span
          className="mt-0.5 flex items-center gap-1 text-label text-muted-foreground/80"
          dir="ltr"
        >
          <GitBranch className="size-3 shrink-0" />
          <span className="truncate">
            {pr.sourceBranch} → {pr.targetBranch}
          </span>
        </span>
      </span>
    </Link>
  );
}

/** Pull requests the way a coding agent IDE shows them: grouped for you, details beside. */
export function PullRequestsPage() {
  const { t } = useLingui();
  const params = useParams<{ projectId?: string; repositoryId?: string; id?: string }>();
  const queries = useSpaceQueries();
  const [query, setQuery] = useState("");
  const [collapsed, setCollapsed] = useState<Set<Group>>(() => new Set(["done"]));
  const list = useQuery({ ...queries.work.pullRequests.queryOptions(), refetchInterval: 60_000 });
  const selected: PullRequestRef | null =
    params.projectId && params.repositoryId && params.id
      ? { projectId: params.projectId, repositoryId: params.repositoryId, id: Number(params.id) }
      : null;
  const filtered = useMemo(() => {
    const words = query.trim().toLowerCase();
    return (list.data?.pullRequests ?? []).filter(
      (pr) =>
        !words ||
        `${pr.title} ${pr.repository} ${pr.id} ${pr.sourceBranch} ${pr.author.name}`
          .toLowerCase()
          .includes(words),
    );
  }, [list.data, query]);

  return (
    <div
      className="flex h-full min-w-0 flex-col bg-background text-foreground/90"
      data-testid="pull-requests-page"
    >
      <header className="app-drag flex items-center gap-2 border-b border-border px-4 py-3">
        {desktopBridge() ? <WindowChrome /> : null}
        <IconTooltip label={t`Back`}>
          <Link
            to="/app"
            aria-label={t`Back`}
            className={buttonVariants({
              variant: "ghost",
              size: "icon",
              className: "app-no-drag text-muted-foreground",
            })}
          >
            <ChevronLeft />
          </Link>
        </IconTooltip>
        <GitPullRequest className="size-[18px] text-muted-foreground" />
        <h1 className="font-medium text-foreground">
          <Trans>Pull requests</Trans>
        </h1>
        <div className="app-no-drag ms-auto flex items-center gap-2">
          <div className="relative">
            <Search className="pointer-events-none absolute start-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder={t`Search pull requests`}
              aria-label={t`Search pull requests`}
              className="h-8 w-56 ps-8"
            />
          </div>
          <IconTooltip label={t`Refresh`}>
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label={t`Refresh`}
              disabled={list.isFetching}
              onClick={() => void list.refetch()}
            >
              <RefreshCw className={`size-4 ${list.isFetching ? "animate-spin" : ""}`} />
            </Button>
          </IconTooltip>
        </div>
      </header>
      <div className="flex min-h-0 flex-1">
        <nav
          aria-label={t`Pull requests`}
          className={`rk-scroll min-h-0 w-full shrink-0 overflow-y-auto border-e border-border p-2 md:w-[400px] ${selected ? "hidden md:block" : ""}`}
        >
          {list.isPending ? (
            <div className="flex justify-center py-10">
              <Spinner className="size-5 text-muted-foreground" aria-label={t`Loading…`} />
            </div>
          ) : list.error ? (
            <p className="p-3 text-body-sm text-destructive">
              {errorText(list.error, t`Could not load pull requests`)}
            </p>
          ) : list.data?.error ? (
            <div className="space-y-2 p-3">
              <p className="text-body-sm text-muted-foreground">{list.data.error}</p>
            </div>
          ) : filtered.length === 0 ? (
            <p className="p-3 text-body-sm text-muted-foreground">
              {query ? (
                <Trans>No pull requests match.</Trans>
              ) : (
                <Trans>No open pull requests.</Trans>
              )}
            </p>
          ) : (
            GROUP_ORDER.map((group) => {
              const items = filtered.filter((pr) => pr.group === group);
              if (items.length === 0) return null;
              const closed = collapsed.has(group) && !query;
              return (
                <section key={group} className="mb-2" data-testid={`pull-request-group-${group}`}>
                  <button
                    type="button"
                    aria-expanded={!closed}
                    onClick={() =>
                      setCollapsed((current) => {
                        const next = new Set(current);
                        if (next.has(group)) next.delete(group);
                        else next.add(group);
                        return next;
                      })
                    }
                    className="flex w-full items-center gap-1 px-2 py-1.5 text-label font-medium text-muted-foreground hover:text-foreground"
                  >
                    {closed ? (
                      <ChevronRight className="size-3.5" />
                    ) : (
                      <ChevronDown className="size-3.5" />
                    )}
                    {groupTitle(group)}
                    <span className="font-normal text-muted-foreground/70">{items.length}</span>
                  </button>
                  {closed
                    ? null
                    : items.map((pr) => (
                        <PullRequestRow
                          key={`${pr.repositoryId}/${pr.id}`}
                          pr={pr}
                          selected={Boolean(
                            selected &&
                              selected.id === pr.id &&
                              selected.repositoryId === pr.repositoryId,
                          )}
                        />
                      ))}
                </section>
              );
            })
          )}
        </nav>
        <main className={`min-h-0 min-w-0 flex-1 ${selected ? "" : "hidden md:block"}`}>
          {selected ? (
            <PullRequestPane key={`${selected.repositoryId}/${selected.id}`} pr={selected} />
          ) : (
            <div className="grid h-full place-items-center p-6 text-center text-body text-muted-foreground">
              <div className="space-y-2">
                <GitPullRequest className="mx-auto size-8 text-muted-foreground/50" />
                <p>
                  <Trans>Pick a pull request to see its checks, changes and comments.</Trans>
                </p>
              </div>
            </div>
          )}
        </main>
      </div>
    </div>
  );
}

const VOTES: { vote: 10 | 5 | 0 | -5 | -10; label: () => string }[] = [
  { vote: 10, label: () => t`Approve` },
  { vote: 5, label: () => t`Approve with suggestions` },
  { vote: -5, label: () => t`Wait for author` },
  { vote: -10, label: () => t`Reject` },
  { vote: 0, label: () => t`Reset vote` },
];

const STRATEGIES: { strategy: MergeStrategy; label: () => string }[] = [
  { strategy: "squash", label: () => t`Squash and merge` },
  { strategy: "noFastForward", label: () => t`Merge commit` },
  { strategy: "rebase", label: () => t`Rebase and fast-forward` },
  { strategy: "rebaseMerge", label: () => t`Rebase with merge commit` },
];

/** What a bot does when a watched pull request gets review comments: summarize, and ask first. */
export function reviewWatchPrompt(
  pr: Pick<PullRequestDetail, "id" | "title" | "projectId" | "repositoryId" | "sourceBranch">,
) {
  return [
    `Pull request !${pr.id} "${pr.title}" (branch ${pr.sourceBranch}) has new review activity.`,
    `Read its comment threads with ado_list_pull_request_threads (project "${pr.projectId}", repository "${pr.repositoryId}", pullRequestId ${pr.id}).`,
    "Summarize in a few sentences what reviewers asked for, quoting file and line where given.",
    'Then ask the person with ask_user whether to address it, with the choices "Fix it" and "Not now".',
    "Do not change code, reply on the pull request, or push before they agree. Branch names come only from the person.",
  ].join(" ");
}

function voteLabel(vote: number) {
  if (vote === 10) return t`Approved`;
  if (vote === 5) return t`Approved with suggestions`;
  if (vote === -5) return t`Waiting for author`;
  if (vote === -10) return t`Rejected`;
  return t`No vote`;
}

function PullRequestPane({ pr }: { pr: PullRequestRef }) {
  const { t } = useLingui();
  const queries = useSpaceQueries();
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const detail = useQuery({
    ...queries.work.pullRequest.queryOptions({ input: pr }),
    refetchInterval: 30_000,
  });
  const [tab, setTab] = useState("overview");
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [deleteBranch, setDeleteBranch] = useState(true);
  const bots =
    useQuery({
      queryKey: queries.bootstrap.queryKey({ input: {} }),
      queryFn: () => takeInitialBootstrap(),
      select: (bootstrap) => bootstrap.bots,
    }).data ?? NO_BOTS;

  async function run(name: string, action: () => Promise<unknown>) {
    setBusy(name);
    setError(null);
    try {
      await action();
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: queries.work.pullRequest.key() }),
        queryClient.invalidateQueries({ queryKey: queries.work.pullRequests.key() }),
      ]);
    } catch (err) {
      setError(errorText(err, t`Azure DevOps did not accept that`));
    } finally {
      setBusy(null);
    }
  }

  if (detail.isPending) {
    return (
      <div className="flex justify-center py-16">
        <Spinner className="size-5 text-muted-foreground" aria-label={t`Loading…`} />
      </div>
    );
  }
  if (detail.error || !detail.data) {
    return (
      <p className="p-6 text-body-sm text-destructive">
        {errorText(detail.error, t`Could not load the pull request`)}
      </p>
    );
  }
  const data: PullRequestDetail = detail.data;
  const me = data.reviewers.find((reviewer) => reviewer.me);

  function askBot(bot: Bot) {
    const link = data.webUrl ? ` (${data.webUrl})` : "";
    replaceComposerDraft(
      `bot:${bot.id}`,
      t`About pull request !${data.id} "${data.title}" in ${data.repository}${link}, ${data.sourceBranch} into ${data.targetBranch}: `,
      [],
    );
    navigate(`/app/${bot.id}`);
  }

  return (
    <div className="rk-scroll flex h-full flex-col overflow-y-auto" data-testid="pull-request-pane">
      <div className="space-y-3 border-b border-border px-6 pt-5 pb-4">
        <div className="flex items-start gap-3">
          <Link to="/app/pulls" className="mt-1 md:hidden" aria-label={t`Back`}>
            <ChevronLeft className="size-5" />
          </Link>
          <div className="min-w-0 flex-1">
            <h2 className="text-heading3 font-medium text-foreground" dir="auto">
              {data.title} <span className="font-normal text-muted-foreground">!{data.id}</span>
            </h2>
            <p className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-body-sm text-muted-foreground">
              {data.status === "completed" ? (
                <Badge tone="success">
                  <Trans>Merged</Trans>
                </Badge>
              ) : data.status === "abandoned" ? (
                <Badge>
                  <Trans>Abandoned</Trans>
                </Badge>
              ) : data.isDraft ? (
                <Badge>
                  <Trans>Draft</Trans>
                </Badge>
              ) : (
                <Badge tone="warning">
                  <Trans>Open</Trans>
                </Badge>
              )}
              <span>
                {data.author.me ? <Trans>You</Trans> : data.author.name} · {data.project}/
                {data.repository} · {formatRelativeTime(data.createdAt)}
              </span>
              <span
                className="inline-flex items-center gap-1 rounded-md bg-muted px-1.5 py-0.5 font-mono text-label"
                dir="ltr"
              >
                <GitBranch className="size-3" />
                {data.sourceBranch} → {data.targetBranch}
              </span>
              {data.autoComplete ? (
                <Badge tone="success">
                  <Trans>Merges when checks pass</Trans>
                </Badge>
              ) : null}
            </p>
          </div>
          {data.webUrl ? (
            <a
              href={data.webUrl}
              target="_blank"
              rel="noreferrer"
              className={buttonVariants({
                variant: "ghost",
                size: "sm",
                className: "shrink-0 text-muted-foreground",
              })}
            >
              <ExternalLink className="size-4" />
              <Trans>Azure DevOps</Trans>
            </a>
          ) : null}
        </div>
        {data.status === "active" ? (
          <div className="flex flex-wrap items-center gap-2">
            <DropdownMenu>
              <DropdownMenuTrigger
                render={<Button size="sm" variant="secondary" disabled={Boolean(busy)} />}
              >
                <Check className="size-4" />
                {me && me.vote !== 0 ? voteLabel(me.vote) : <Trans>Review</Trans>}
                <ChevronDown className="size-3.5" />
              </DropdownMenuTrigger>
              <DropdownMenuContent align="start" className="min-w-52">
                {VOTES.map((item) => (
                  <DropdownMenuItem
                    key={item.vote}
                    onClick={() =>
                      void run("vote", () => rpc.work.votePullRequest({ ...pr, vote: item.vote }))
                    }
                  >
                    {item.label()}
                  </DropdownMenuItem>
                ))}
              </DropdownMenuContent>
            </DropdownMenu>
            {data.isDraft ? (
              <Button
                size="sm"
                variant="secondary"
                disabled={Boolean(busy)}
                onClick={() => void run("publish", () => rpc.work.publishPullRequest(pr))}
              >
                <Trans>Ready for review</Trans>
              </Button>
            ) : (
              <DropdownMenu>
                <DropdownMenuTrigger
                  render={<Button size="sm" disabled={Boolean(busy)} data-testid="merge-menu" />}
                >
                  <GitMerge className="size-4" />
                  <Trans>Merge</Trans>
                  <ChevronDown className="size-3.5" />
                </DropdownMenuTrigger>
                <DropdownMenuContent align="start" className="min-w-60">
                  <DropdownMenuGroup>
                    <DropdownMenuLabel>
                      <Trans>Merge now</Trans>
                    </DropdownMenuLabel>
                    {STRATEGIES.map((item) => (
                      <DropdownMenuItem
                        key={item.strategy}
                        onClick={() =>
                          void run("merge", () =>
                            rpc.work.completePullRequest({
                              ...pr,
                              strategy: item.strategy,
                              deleteSourceBranch: deleteBranch,
                              auto: false,
                            }),
                          )
                        }
                      >
                        {item.label()}
                      </DropdownMenuItem>
                    ))}
                  </DropdownMenuGroup>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem
                    onClick={() =>
                      void run("merge", () =>
                        rpc.work.completePullRequest({
                          ...pr,
                          strategy: "squash",
                          deleteSourceBranch: deleteBranch,
                          auto: true,
                        }),
                      )
                    }
                  >
                    <Trans>Squash when checks pass</Trans>
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            )}
            {!data.isDraft ? (
              <label
                htmlFor="pr-delete-branch"
                className="flex items-center gap-1.5 text-body-sm text-muted-foreground"
              >
                <Checkbox
                  id="pr-delete-branch"
                  checked={deleteBranch}
                  onCheckedChange={(value) => setDeleteBranch(value === true)}
                />
                <Trans>Delete {data.sourceBranch} after merging</Trans>
              </label>
            ) : null}
            {bots.length ? (
              <DropdownMenu>
                <DropdownMenuTrigger
                  render={<Button size="sm" variant="ghost" className="ms-auto" />}
                >
                  <MessageSquare className="size-4" />
                  <Trans>Ask a bot</Trans>
                  <ChevronDown className="size-3.5" />
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end" className="min-w-56">
                  <DropdownMenuGroup>
                    <DropdownMenuLabel>
                      <Trans>Ask about this pull request</Trans>
                    </DropdownMenuLabel>
                    {bots.map((bot) => (
                      <DropdownMenuItem key={bot.id} onClick={() => askBot(bot)}>
                        {bot.name}
                      </DropdownMenuItem>
                    ))}
                  </DropdownMenuGroup>
                  <DropdownMenuSeparator />
                  <DropdownMenuGroup>
                    <DropdownMenuLabel>
                      <Trans>Tell me about new review comments</Trans>
                    </DropdownMenuLabel>
                    {bots.map((bot) => (
                      <DropdownMenuItem
                        key={`watch-${bot.id}`}
                        onClick={() =>
                          void run("watch", () =>
                            rpc.routines.create({
                              botId: bot.id,
                              name: `PR !${data.id}: ${data.title}`.slice(0, 80),
                              prompt: reviewWatchPrompt(data),
                              active: true,
                              notify: true,
                              watch: {
                                kind: "tool",
                                tool: "ado_list_pull_request_threads",
                                args: {
                                  project: data.projectId,
                                  repository: data.repositoryId,
                                  pullRequestId: data.id,
                                },
                                track: ["id", "lastUpdatedDate"],
                                everyMinutes: 5,
                              },
                            }),
                          )
                        }
                      >
                        {bot.name}
                      </DropdownMenuItem>
                    ))}
                  </DropdownMenuGroup>
                </DropdownMenuContent>
              </DropdownMenu>
            ) : null}
            {busy ? <Spinner className="size-4 text-muted-foreground" /> : null}
          </div>
        ) : null}
        {error ? (
          <p role="alert" className="text-body-sm text-destructive">
            {error}
          </p>
        ) : null}
      </div>
      <Tabs value={tab} onValueChange={(value) => setTab(String(value))} className="px-6 pt-3 pb-8">
        <TabsList>
          <TabsTrigger value="overview">
            <Trans>Overview</Trans>
          </TabsTrigger>
          <TabsTrigger value="files">
            <Trans>Files</Trans> <span className="text-muted-foreground">{data.files.length}</span>
          </TabsTrigger>
          <TabsTrigger value="comments">
            <Trans>Comments</Trans>{" "}
            <span className="text-muted-foreground">{data.threads.length}</span>
          </TabsTrigger>
        </TabsList>
        <TabsContent value="overview" className="space-y-5 pt-4">
          <Section title={t`Checks`}>
            {data.checkList.length === 0 ? (
              <p className="text-body-sm text-muted-foreground">
                <Trans>
                  No checks reported. Jenkins builds appear here when they post a status to the pull
                  request.
                </Trans>
              </p>
            ) : (
              <ul
                className="divide-y divide-border rounded-xl border border-border"
                data-testid="pull-request-checks"
              >
                {data.checkList.map((check) => (
                  <li key={check.name} className="flex items-center gap-2.5 px-3 py-2 text-body-sm">
                    <CheckIcon state={check.state} />
                    <span className="font-medium">{check.name}</span>
                    {check.description ? (
                      <span className="min-w-0 truncate text-muted-foreground">
                        {check.description}
                      </span>
                    ) : null}
                    {check.url ? (
                      <a
                        href={check.url}
                        target="_blank"
                        rel="noreferrer"
                        className="ms-auto shrink-0 text-muted-foreground hover:text-foreground"
                      >
                        <ExternalLink className="size-4" aria-label={t`Open`} />
                      </a>
                    ) : null}
                  </li>
                ))}
              </ul>
            )}
          </Section>
          <Section title={t`Reviewers`}>
            {data.reviewers.length === 0 ? (
              <p className="text-body-sm text-muted-foreground">
                <Trans>No reviewers yet.</Trans>
              </p>
            ) : (
              <ul className="space-y-1.5">
                {data.reviewers.map((reviewer) => (
                  <li key={reviewer.id} className="flex items-center gap-2 text-body-sm">
                    <span
                      className={`size-2 rounded-full ${reviewer.vote >= 5 ? "bg-success" : reviewer.vote < 0 ? "bg-destructive" : "bg-muted-foreground/40"}`}
                    />
                    <span>{reviewer.me ? <Trans>You</Trans> : reviewer.name}</span>
                    <span className="text-muted-foreground">{voteLabel(reviewer.vote)}</span>
                    {reviewer.required ? (
                      <Badge>
                        <Trans>Required</Trans>
                      </Badge>
                    ) : null}
                  </li>
                ))}
              </ul>
            )}
          </Section>
          <Section title={t`Description`}>
            {data.description ? (
              <div className="text-body">
                <ChatMarkdown>{data.description}</ChatMarkdown>
              </div>
            ) : (
              <p className="text-body-sm text-muted-foreground">
                <Trans>No description.</Trans>
              </p>
            )}
          </Section>
        </TabsContent>
        <TabsContent value="files" className="pt-4">
          <PullRequestFiles pr={pr} files={data.files} />
        </TabsContent>
        <TabsContent value="comments" className="pt-4">
          <PullRequestComments
            pr={pr}
            data={data}
            onChanged={() =>
              queryClient.invalidateQueries({ queryKey: queries.work.pullRequest.key() })
            }
          />
        </TabsContent>
      </Tabs>
    </div>
  );
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="space-y-2">
      <h3 className="text-label font-medium uppercase tracking-wide text-muted-foreground">
        {title}
      </h3>
      {children}
    </section>
  );
}

const CHANGE_LETTER = {
  add: { letter: "A", className: "text-success" },
  edit: { letter: "M", className: "text-warning" },
  rename: { letter: "R", className: "text-warning" },
  delete: { letter: "D", className: "text-destructive" },
} as const;

function PullRequestFiles({
  pr,
  files,
}: {
  pr: PullRequestRef;
  files: PullRequestDetail["files"];
}) {
  const [open, setOpen] = useState<string | null>(
    files.length === 1 ? (files[0]?.path ?? null) : null,
  );
  if (files.length === 0) {
    return (
      <p className="text-body-sm text-muted-foreground">
        <Trans>No file changes.</Trans>
      </p>
    );
  }
  return (
    <ul
      className="divide-y divide-border rounded-xl border border-border"
      data-testid="pull-request-files"
    >
      {files.map((file) => (
        <li key={file.path}>
          <button
            type="button"
            aria-expanded={open === file.path}
            onClick={() => setOpen((current) => (current === file.path ? null : file.path))}
            className="flex w-full items-center gap-2 px-3 py-1.5 text-start text-body-sm hover:bg-accent/60"
          >
            <span
              className={`w-3 shrink-0 font-mono font-semibold ${CHANGE_LETTER[file.change].className}`}
            >
              {CHANGE_LETTER[file.change].letter}
            </span>
            <span className="min-w-0 flex-1 truncate font-mono text-label" dir="ltr">
              {file.originalPath && file.originalPath !== file.path
                ? `${file.originalPath} → `
                : ""}
              {file.path}
            </span>
          </button>
          {open === file.path ? <PullRequestFileDiff pr={pr} path={file.path} /> : null}
        </li>
      ))}
    </ul>
  );
}

function PullRequestFileDiff({ pr, path }: { pr: PullRequestRef; path: string }) {
  const { t } = useLingui();
  const queries = useSpaceQueries();
  const diff = useQuery(queries.work.pullRequestDiff.queryOptions({ input: { ...pr, path } }));
  if (diff.isPending) {
    return (
      <div className="flex justify-center border-t border-border py-3">
        <Spinner className="size-4 text-muted-foreground" aria-label={t`Loading…`} />
      </div>
    );
  }
  if (diff.error || !diff.data) {
    return (
      <p className="border-t border-border px-3 py-2 text-body-sm text-muted-foreground">
        {errorText(diff.error, t`Could not load the diff`)}
      </p>
    );
  }
  return (
    <div className="border-t border-border">
      <DiffView diff={diff.data.diff} truncated={diff.data.truncated} />
    </div>
  );
}

function PullRequestComments({
  pr,
  data,
  onChanged,
}: {
  pr: PullRequestRef;
  data: PullRequestDetail;
  onChanged: () => Promise<unknown>;
}) {
  const { t } = useLingui();
  const [text, setText] = useState("");
  const [replyTo, setReplyTo] = useState<number | null>(null);
  const [reply, setReply] = useState("");
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function send(content: string, threadId?: number) {
    setSending(true);
    setError(null);
    try {
      await rpc.work.commentPullRequest({ ...pr, content, ...(threadId ? { threadId } : {}) });
      await onChanged();
      if (threadId) {
        setReply("");
        setReplyTo(null);
      } else setText("");
    } catch (err) {
      setError(errorText(err, t`Could not post the comment`));
    } finally {
      setSending(false);
    }
  }

  return (
    <div className="space-y-3" data-testid="pull-request-comments">
      {data.threads.length === 0 ? (
        <p className="text-body-sm text-muted-foreground">
          <Trans>No comments yet.</Trans>
        </p>
      ) : (
        data.threads.map((thread) => (
          <article key={thread.id} className="rounded-xl border border-border">
            {thread.filePath ? (
              <p
                className="border-b border-border px-3 py-1.5 font-mono text-label text-muted-foreground"
                dir="ltr"
              >
                {thread.filePath}
                {thread.line ? `:${thread.line}` : ""}
                {thread.status && thread.status !== "active" ? (
                  <span className="ms-2 font-sans">
                    <Badge
                      tone={
                        thread.status === "fixed" || thread.status === "closed"
                          ? "success"
                          : "muted"
                      }
                    >
                      {thread.status}
                    </Badge>
                  </span>
                ) : null}
              </p>
            ) : null}
            <ul className="divide-y divide-border">
              {thread.comments.map((comment) => (
                <li key={comment.id} className="px-3 py-2">
                  <p className="text-label text-muted-foreground">
                    <span className="font-medium text-foreground">{comment.author}</span> ·{" "}
                    {formatRelativeTime(comment.createdAt)}
                  </p>
                  <div className="mt-0.5 text-body">
                    <ChatMarkdown>{comment.content}</ChatMarkdown>
                  </div>
                </li>
              ))}
            </ul>
            {replyTo === thread.id ? (
              <form
                className="space-y-2 border-t border-border p-2"
                onSubmit={(event) => {
                  event.preventDefault();
                  if (reply.trim()) void send(reply.trim(), thread.id);
                }}
              >
                <Textarea
                  value={reply}
                  onChange={(event) => setReply(event.target.value)}
                  placeholder={t`Reply`}
                  aria-label={t`Reply`}
                  rows={2}
                />
                <div className="flex gap-2">
                  <Button type="submit" size="sm" disabled={sending || !reply.trim()}>
                    <Trans>Reply</Trans>
                  </Button>
                  <Button type="button" size="sm" variant="ghost" onClick={() => setReplyTo(null)}>
                    <Trans>Cancel</Trans>
                  </Button>
                </div>
              </form>
            ) : data.status === "active" ? (
              <button
                type="button"
                className="w-full border-t border-border px-3 py-1.5 text-start text-body-sm text-muted-foreground hover:text-foreground"
                onClick={() => {
                  setReplyTo(thread.id);
                  setReply("");
                }}
              >
                <Trans>Reply…</Trans>
              </button>
            ) : null}
          </article>
        ))
      )}
      {data.status === "active" ? (
        <form
          className="space-y-2"
          onSubmit={(event) => {
            event.preventDefault();
            if (text.trim()) void send(text.trim());
          }}
        >
          <Textarea
            value={text}
            onChange={(event) => setText(event.target.value)}
            placeholder={t`Add a comment`}
            aria-label={t`Add a comment`}
            rows={3}
          />
          <Button type="submit" size="sm" disabled={sending || !text.trim()}>
            <Trans>Comment</Trans>
          </Button>
        </form>
      ) : null}
      {error ? (
        <p role="alert" className="text-body-sm text-destructive">
          {error}
        </p>
      ) : null}
    </div>
  );
}
