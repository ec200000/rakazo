import { t } from "@lingui/core/macro";
import { Trans, useLingui } from "@lingui/react/macro";
import type { Bot, WorkItemDetail, WorkItemSummary, WorkItemView } from "@rakazo/contracts";
import {
  Button,
  buttonVariants,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
  Input,
  Spinner,
  Textarea,
} from "@rakazo/ui-web";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  ChevronDown,
  ChevronLeft,
  CircleDot,
  ExternalLink,
  GitPullRequest,
  MessageSquare,
  RefreshCw,
  Search,
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
import { WindowChrome } from "./WindowChrome";

const NO_BOTS: Bot[] = [];
const VIEWS: { view: WorkItemView; label: () => string }[] = [
  { view: "assigned", label: () => t`Assigned to me` },
  { view: "mentioned", label: () => t`Mentioned` },
  { view: "created", label: () => t`Created by me` },
  { view: "open", label: () => t`All open` },
];

/** Azure Boards' usual type colors, so a Bug reads as a bug at a glance. */
function typeTone(type: string) {
  const name = type.toLowerCase();
  if (name.includes("bug")) return "bg-destructive/12 text-destructive";
  if (name.includes("feature")) return "bg-violet-500/12 text-violet-600 dark:text-violet-300";
  if (name.includes("epic")) return "bg-orange-500/12 text-orange-600 dark:text-orange-300";
  if (name.includes("task")) return "bg-warning/15 text-warning";
  return "bg-sky-500/12 text-sky-700 dark:text-sky-300";
}

function TypeBadge({ type }: { type: string }) {
  return (
    <span className={`shrink-0 rounded-md px-1.5 py-px text-caption font-medium ${typeTone(type)}`}>
      {type}
    </span>
  );
}

function StatePill({ state }: { state: string }) {
  return (
    <span className="shrink-0 rounded-full bg-muted px-2 py-px text-caption text-muted-foreground">
      {state}
    </span>
  );
}

function IssueRow({ item, selected }: { item: WorkItemSummary; selected: boolean }) {
  return (
    <Link
      to={`/app/issues/${item.id}`}
      data-testid="issue-row"
      aria-current={selected ? "page" : undefined}
      className={`flex gap-2.5 rounded-xl px-3 py-2 text-start hover:bg-accent/60 ${selected ? "bg-accent" : ""}`}
    >
      <CircleDot className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
      <span className="min-w-0 flex-1">
        <span className="block truncate text-body font-medium text-foreground" dir="auto">
          {item.title}
        </span>
        <span className="mt-1 flex items-center gap-1.5 text-label text-muted-foreground">
          <TypeBadge type={item.type} />
          <span>#{item.id}</span>
          <StatePill state={item.state} />
          <span className="truncate">
            {item.assignedTo ? (item.assignedTo.me ? t`you` : item.assignedTo.name) : t`unassigned`}{" "}
            · {formatRelativeTime(item.changedAt)}
          </span>
        </span>
      </span>
    </Link>
  );
}

/** Azure Boards work items the way a coding agent IDE lists issues: yours first, details beside. */
export function IssuesPage() {
  const { t } = useLingui();
  const params = useParams<{ id?: string }>();
  const queries = useSpaceQueries();
  const [view, setView] = useState<WorkItemView>("assigned");
  const [query, setQuery] = useState("");
  const list = useQuery({
    ...queries.work.workItems.queryOptions({ input: { view } }),
    refetchInterval: 120_000,
  });
  const selected = params.id ? Number(params.id) : null;
  const items = useMemo(() => {
    const words = query.trim().toLowerCase();
    return (list.data?.items ?? []).filter(
      (item) =>
        !words ||
        `${item.id} ${item.title} ${item.type} ${item.state} ${item.tags.join(" ")}`
          .toLowerCase()
          .includes(words),
    );
  }, [list.data, query]);

  return (
    <div
      className="flex h-full min-w-0 flex-col bg-background text-foreground/90"
      data-testid="issues-page"
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
        <CircleDot className="size-[18px] text-muted-foreground" />
        <h1 className="font-medium text-foreground">
          <Trans>Issues</Trans>
        </h1>
        <span className="text-body-sm text-muted-foreground">Azure Boards</span>
        <div className="app-no-drag ms-auto flex items-center gap-2">
          <div className="relative">
            <Search className="pointer-events-none absolute start-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder={t`Search work items`}
              aria-label={t`Search work items`}
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
          aria-label={t`Work items`}
          className={`rk-scroll flex min-h-0 w-full shrink-0 flex-col overflow-y-auto border-e border-border md:w-[420px] ${selected ? "hidden md:flex" : ""}`}
        >
          <div className="flex flex-wrap gap-1 border-b border-border p-2" role="tablist">
            {VIEWS.map((item) => (
              <button
                key={item.view}
                type="button"
                role="tab"
                aria-selected={view === item.view}
                onClick={() => setView(item.view)}
                className={`rounded-lg px-2.5 py-1 text-body-sm ${view === item.view ? "bg-accent font-medium text-foreground" : "text-muted-foreground hover:text-foreground"}`}
              >
                {item.label()}
              </button>
            ))}
          </div>
          <div className="p-2">
            {list.isPending ? (
              <div className="flex justify-center py-10">
                <Spinner className="size-5 text-muted-foreground" aria-label={t`Loading…`} />
              </div>
            ) : list.error ? (
              <p className="p-3 text-body-sm text-destructive">
                {errorText(list.error, t`Could not load work items`)}
              </p>
            ) : list.data?.error ? (
              <p className="p-3 text-body-sm text-muted-foreground">{list.data.error}</p>
            ) : items.length === 0 ? (
              <p className="p-3 text-body-sm text-muted-foreground">
                <Trans>Nothing here.</Trans>
              </p>
            ) : (
              items.map((item) => (
                <IssueRow key={item.id} item={item} selected={item.id === selected} />
              ))
            )}
          </div>
        </nav>
        <main className={`min-h-0 min-w-0 flex-1 ${selected ? "" : "hidden md:block"}`}>
          {selected ? (
            <IssuePane key={selected} id={selected} />
          ) : (
            <div className="grid h-full place-items-center p-6 text-center text-body text-muted-foreground">
              <div className="space-y-2">
                <CircleDot className="mx-auto size-8 text-muted-foreground/50" />
                <p>
                  <Trans>Pick a work item to read it, move it along, or start a bot on it.</Trans>
                </p>
              </div>
            </div>
          )}
        </main>
      </div>
    </div>
  );
}

function IssuePane({ id }: { id: number }) {
  const { t } = useLingui();
  const queries = useSpaceQueries();
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const detail = useQuery(queries.work.workItem.queryOptions({ input: { id } }));
  const [text, setText] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
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
        queryClient.invalidateQueries({ queryKey: queries.work.workItem.key() }),
        queryClient.invalidateQueries({ queryKey: queries.work.workItems.key() }),
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
        {errorText(detail.error, t`Could not load the work item`)}
      </p>
    );
  }
  const item: WorkItemDetail = detail.data;

  function startBot(bot: Bot) {
    const description = item.description ? `\n\n${item.description.slice(0, 3000)}` : "";
    replaceComposerDraft(
      `bot:${bot.id}`,
      t`Please work on ${item.type} #${item.id} "${item.title}" (${item.webUrl ?? ""}).` +
        description +
        `\n\n${t`I'll choose the branch in the Branch box. When it's done, ask me before opening a pull request, and link it to #${item.id}.`}`,
      [],
    );
    navigate(`/app/${bot.id}`);
  }

  return (
    <div className="rk-scroll flex h-full flex-col overflow-y-auto" data-testid="issue-pane">
      <div className="space-y-3 border-b border-border px-6 pt-5 pb-4">
        <div className="flex items-start gap-3">
          <Link to="/app/issues" className="mt-1 md:hidden" aria-label={t`Back`}>
            <ChevronLeft className="size-5" />
          </Link>
          <div className="min-w-0 flex-1">
            <h2 className="text-heading3 font-medium text-foreground" dir="auto">
              {item.title} <span className="font-normal text-muted-foreground">#{item.id}</span>
            </h2>
            <p className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-body-sm text-muted-foreground">
              <TypeBadge type={item.type} />
              <StatePill state={item.state} />
              <span>
                {item.project}
                {item.assignedTo
                  ? ` · ${item.assignedTo.me ? t`assigned to you` : item.assignedTo.name}`
                  : ""}
                {item.createdBy ? ` · ${t`opened by ${item.createdBy}`}` : ""}
                {item.createdAt ? ` ${formatRelativeTime(item.createdAt)}` : ""}
              </span>
            </p>
          </div>
          {item.webUrl ? (
            <a
              href={item.webUrl}
              target="_blank"
              rel="noreferrer"
              className={buttonVariants({
                variant: "ghost",
                size: "sm",
                className: "shrink-0 text-muted-foreground",
              })}
            >
              <ExternalLink className="size-4" />
              <Trans>Azure Boards</Trans>
            </a>
          ) : null}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {item.states.length ? (
            <DropdownMenu>
              <DropdownMenuTrigger
                render={
                  <Button
                    size="sm"
                    variant="secondary"
                    disabled={Boolean(busy)}
                    data-testid="issue-state"
                  />
                }
              >
                {item.state}
                <ChevronDown className="size-3.5" />
              </DropdownMenuTrigger>
              <DropdownMenuContent align="start" className="min-w-44">
                <DropdownMenuGroup>
                  <DropdownMenuLabel>
                    <Trans>Move to</Trans>
                  </DropdownMenuLabel>
                  {item.states
                    .filter((state) => state.name !== item.state)
                    .map((state) => (
                      <DropdownMenuItem
                        key={state.name}
                        onClick={() =>
                          void run("state", () =>
                            rpc.work.setWorkItemState({ id, state: state.name }),
                          )
                        }
                      >
                        {state.name}
                      </DropdownMenuItem>
                    ))}
                </DropdownMenuGroup>
              </DropdownMenuContent>
            </DropdownMenu>
          ) : null}
          {bots.length ? (
            <DropdownMenu>
              <DropdownMenuTrigger
                render={<Button size="sm" disabled={Boolean(busy)} data-testid="issue-start-bot" />}
              >
                <MessageSquare className="size-4" />
                <Trans>Start a bot on this</Trans>
                <ChevronDown className="size-3.5" />
              </DropdownMenuTrigger>
              <DropdownMenuContent align="start" className="min-w-48">
                {bots.map((bot) => (
                  <DropdownMenuItem key={bot.id} onClick={() => startBot(bot)}>
                    {bot.name}
                  </DropdownMenuItem>
                ))}
              </DropdownMenuContent>
            </DropdownMenu>
          ) : null}
          {busy ? <Spinner className="size-4 text-muted-foreground" /> : null}
        </div>
        {error ? (
          <p role="alert" className="text-body-sm text-destructive">
            {error}
          </p>
        ) : null}
      </div>
      <div className="space-y-5 px-6 pt-4 pb-8">
        <Section title={t`Description`}>
          {item.description ? (
            <p className="whitespace-pre-wrap text-body" dir="auto">
              {item.description}
            </p>
          ) : (
            <p className="text-body-sm text-muted-foreground">
              <Trans>No description.</Trans>
            </p>
          )}
        </Section>
        {item.areaPath || item.iterationPath || item.tags.length ? (
          <Section title={t`Details`}>
            <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-body-sm">
              {item.areaPath ? (
                <>
                  <dt className="text-muted-foreground">
                    <Trans>Area</Trans>
                  </dt>
                  <dd>{item.areaPath}</dd>
                </>
              ) : null}
              {item.iterationPath ? (
                <>
                  <dt className="text-muted-foreground">
                    <Trans>Iteration</Trans>
                  </dt>
                  <dd>{item.iterationPath}</dd>
                </>
              ) : null}
              {item.tags.length ? (
                <>
                  <dt className="text-muted-foreground">
                    <Trans>Tags</Trans>
                  </dt>
                  <dd className="flex flex-wrap gap-1">
                    {item.tags.map((tag) => (
                      <span key={tag} className="rounded-full bg-muted px-2 py-px text-caption">
                        {tag}
                      </span>
                    ))}
                  </dd>
                </>
              ) : null}
            </dl>
          </Section>
        ) : null}
        {item.pullRequests.length ? (
          <Section title={t`Pull requests`}>
            <ul className="space-y-1 text-body-sm">
              {item.pullRequests.map((pr) => (
                <li key={pr.id} className="flex items-center gap-2">
                  <GitPullRequest className="size-4 text-muted-foreground" />!{pr.id}
                </li>
              ))}
            </ul>
          </Section>
        ) : null}
        <Section title={t`Discussion`}>
          <div className="space-y-2" data-testid="issue-comments">
            {item.comments.length === 0 ? (
              <p className="text-body-sm text-muted-foreground">
                <Trans>No comments yet.</Trans>
              </p>
            ) : (
              item.comments.map((comment) => (
                <article key={comment.id} className="rounded-xl border border-border px-3 py-2">
                  <p className="text-label text-muted-foreground">
                    <span className="font-medium text-foreground">{comment.author}</span> ·{" "}
                    {formatRelativeTime(comment.createdAt)}
                  </p>
                  <p className="mt-0.5 whitespace-pre-wrap text-body" dir="auto">
                    {comment.text}
                  </p>
                </article>
              ))
            )}
            <form
              className="space-y-2"
              onSubmit={(event) => {
                event.preventDefault();
                const value = text.trim();
                if (value)
                  void run("comment", async () => {
                    await rpc.work.commentWorkItem({ id, text: value });
                    setText("");
                  });
              }}
            >
              <Textarea
                value={text}
                onChange={(event) => setText(event.target.value)}
                placeholder={t`Add a comment`}
                aria-label={t`Add a comment`}
                rows={3}
              />
              <Button type="submit" size="sm" disabled={Boolean(busy) || !text.trim()}>
                <Trans>Comment</Trans>
              </Button>
            </form>
          </div>
        </Section>
      </div>
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
