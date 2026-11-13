import { t } from "@lingui/core/macro";
import { Trans, useLingui } from "@lingui/react/macro";
import type {
  Bot,
  JenkinsBuild,
  JenkinsJob,
  JenkinsJobDetail,
  JenkinsStatus,
} from "@rakazo/contracts";
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
  NativeSelect,
  NativeSelectOption,
  Spinner,
} from "@rakazo/ui-web";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Ban,
  Check,
  ChevronDown,
  ChevronLeft,
  Circle,
  CircleDot,
  ExternalLink,
  Eye,
  Folder,
  GitBranch,
  Play,
  RefreshCw,
  Search,
  TriangleAlert,
  Workflow,
  X,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { IconTooltip } from "../components/IconTooltip";
import { takeInitialBootstrap } from "../lib/bootstrap";
import { desktopBridge } from "../lib/desktop";
import { useSpaceQueries } from "../lib/query";
import { formatRelativeTime } from "../lib/relative-time";
import { rpc } from "../lib/rpc";
import { errorText } from "../lib/user-error";
import { WindowChrome } from "./WindowChrome";

const NO_BOTS: Bot[] = [];

export function JenkinsStatusIcon({
  status,
  className = "",
}: {
  status: JenkinsStatus;
  className?: string;
}) {
  const base = `size-4 shrink-0 ${className}`;
  switch (status) {
    case "passed":
      return <Check aria-label={t`Passed`} className={`${base} text-success`} strokeWidth={2.4} />;
    case "failed":
      return <X aria-label={t`Failed`} className={`${base} text-destructive`} strokeWidth={2.4} />;
    case "unstable":
      return <TriangleAlert aria-label={t`Unstable`} className={`${base} text-warning`} />;
    case "building":
      return (
        <CircleDot
          aria-label={t`Building`}
          className={`${base} text-warning motion-safe:animate-pulse`}
        />
      );
    case "aborted":
      return <Ban aria-label={t`Aborted`} className={`${base} text-muted-foreground`} />;
    default:
      return <Circle aria-label={t`Not built`} className={`${base} text-muted-foreground/50`} />;
  }
}

function duration(ms: number | null) {
  if (!ms) return "";
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  return minutes < 60
    ? `${minutes}m ${String(seconds % 60).padStart(2, "0")}s`
    : `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

/** What a bot does when a watched job finishes a build: say how it went, and ask before fixing. */
export function jenkinsWatchPrompt(job: Pick<JenkinsJob, "fullName" | "path">) {
  return [
    `The Jenkins job ${job.fullName} finished a build.`,
    `Read it with jenkins_last_completed_build (job "${job.path}").`,
    "If it passed, reply with one short line: the build number and that it passed.",
    "If it failed or is unstable, read the end of its log with jenkins_console, explain in a few sentences what failed and why,",
    'then ask the person with ask_user whether to fix it, with the choices "Fix it" and "Not now".',
    "Do not change code, push, or start builds before they agree. Branch names come only from the person.",
  ].join(" ");
}

function JobRow({ job, depth, selected }: { job: JenkinsJob; depth: number; selected: boolean }) {
  const container = job.kind === "folder" || job.kind === "multibranch";
  return (
    <Link
      to={`/app/automations?job=${encodeURIComponent(job.path)}`}
      data-testid="jenkins-job-row"
      aria-current={selected ? "page" : undefined}
      style={{ paddingInlineStart: `${12 + depth * 16}px` }}
      className={`flex items-center gap-2.5 rounded-xl py-1.5 pe-3 text-start hover:bg-accent/60 ${selected ? "bg-accent" : ""}`}
    >
      {container ? (
        job.kind === "multibranch" ? (
          <GitBranch className="size-4 shrink-0 text-muted-foreground" />
        ) : (
          <Folder className="size-4 shrink-0 text-muted-foreground" />
        )
      ) : (
        <JenkinsStatusIcon status={job.status} />
      )}
      <span className="min-w-0 flex-1 truncate text-body" dir="auto">
        {decodeURIComponent(job.name)}
      </span>
      {job.lastBuild ? (
        <span className="shrink-0 text-label text-muted-foreground">
          #{job.lastBuild.number}
          {job.lastBuild.startedAt ? ` · ${formatRelativeTime(job.lastBuild.startedAt)}` : ""}
        </span>
      ) : null}
    </Link>
  );
}

/** Jenkins jobs the way a coding agent IDE shows automations: list, builds, logs, and watches. */
export function AutomationsPage() {
  const { t } = useLingui();
  const queries = useSpaceQueries();
  const [params] = useSearchParams();
  const selected = params.get("job");
  const [query, setQuery] = useState("");
  const list = useQuery({ ...queries.work.jenkinsJobs.queryOptions(), refetchInterval: 30_000 });
  const jobs = list.data?.jobs ?? [];
  const failing = jobs.filter((job) => job.status === "failed" || job.status === "unstable");
  const shown = useMemo(() => {
    const words = query.trim().toLowerCase();
    return words ? jobs.filter((job) => job.fullName.toLowerCase().includes(words)) : jobs;
  }, [jobs, query]);

  return (
    <div
      className="flex h-full min-w-0 flex-col bg-background text-foreground/90"
      data-testid="automations-page"
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
        <Workflow className="size-[18px] text-muted-foreground" />
        <h1 className="font-medium text-foreground">
          <Trans>Automations</Trans>
        </h1>
        <span className="text-body-sm text-muted-foreground">Jenkins</span>
        <div className="app-no-drag ms-auto flex items-center gap-2">
          <div className="relative">
            <Search className="pointer-events-none absolute start-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder={t`Search jobs`}
              aria-label={t`Search jobs`}
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
          aria-label={t`Jenkins jobs`}
          className={`rk-scroll min-h-0 w-full shrink-0 overflow-y-auto border-e border-border p-2 md:w-[380px] ${selected ? "hidden md:block" : ""}`}
        >
          {list.isPending ? (
            <div className="flex justify-center py-10">
              <Spinner className="size-5 text-muted-foreground" aria-label={t`Loading…`} />
            </div>
          ) : list.error ? (
            <p className="p-3 text-body-sm text-destructive">
              {errorText(list.error, t`Could not load Jenkins jobs`)}
            </p>
          ) : list.data?.error ? (
            <p className="p-3 text-body-sm text-muted-foreground">{list.data.error}</p>
          ) : (
            <>
              {failing.length && !query ? (
                <section className="mb-2" data-testid="jenkins-failing">
                  <p className="px-2 py-1.5 text-label font-medium text-destructive">
                    <Trans>Failing now</Trans> <span className="font-normal">{failing.length}</span>
                  </p>
                  {failing.map((job) => (
                    <JobRow key={`failing-${job.path}`} job={job} depth={0} selected={false} />
                  ))}
                </section>
              ) : null}
              <p className="px-2 py-1.5 text-label font-medium text-muted-foreground">
                <Trans>All jobs</Trans>{" "}
                <span className="font-normal">
                  {jobs.filter((job) => job.kind !== "folder" && job.kind !== "multibranch").length}
                </span>
              </p>
              {shown.map((job) => (
                <JobRow
                  key={job.path}
                  job={job}
                  depth={query ? 0 : job.path.split("/job/").length - 1}
                  selected={job.path === selected}
                />
              ))}
            </>
          )}
        </nav>
        <main className={`min-h-0 min-w-0 flex-1 ${selected ? "" : "hidden md:block"}`}>
          {selected ? (
            <JobPane key={selected} path={selected} />
          ) : (
            <div className="grid h-full place-items-center p-6 text-center text-body text-muted-foreground">
              <div className="space-y-2">
                <Workflow className="mx-auto size-8 text-muted-foreground/50" />
                <p>
                  <Trans>
                    Pick a job to see its builds and logs, start a build, or have a bot watch it.
                  </Trans>
                </p>
              </div>
            </div>
          )}
        </main>
      </div>
    </div>
  );
}

function JobPane({ path }: { path: string }) {
  const { t } = useLingui();
  const queries = useSpaceQueries();
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const detail = useQuery({
    ...queries.work.jenkinsJob.queryOptions({ input: { path } }),
    refetchInterval: 10_000,
  });
  const [build, setBuild] = useState<number | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [values, setValues] = useState<Record<string, string>>({});
  const [askParams, setAskParams] = useState(false);
  const bots =
    useQuery({
      queryKey: queries.bootstrap.queryKey({ input: {} }),
      queryFn: () => takeInitialBootstrap(),
      select: (bootstrap) => bootstrap.bots,
    }).data ?? NO_BOTS;

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
        {errorText(detail.error, t`Could not load the job`)}
      </p>
    );
  }
  const job: JenkinsJobDetail = detail.data;
  const container = job.kind === "folder" || job.kind === "multibranch";
  const shownBuild = build ?? job.builds[0]?.number ?? null;

  async function run(name: string, action: () => Promise<unknown>, done?: string) {
    setBusy(name);
    setError(null);
    setNotice(null);
    try {
      await action();
      if (done) setNotice(done);
      await queryClient.invalidateQueries({ queryKey: queries.work.jenkinsJob.key() });
    } catch (err) {
      setError(errorText(err, t`Jenkins did not accept that`));
    } finally {
      setBusy(null);
    }
  }

  function buildNow() {
    if (job.parameters.length && !askParams) {
      setValues(
        Object.fromEntries(
          job.parameters.map((parameter) => [parameter.name, parameter.defaultValue ?? ""]),
        ),
      );
      setAskParams(true);
      return;
    }
    const parameters = job.parameters.length ? values : undefined;
    setAskParams(false);
    void run(
      "build",
      () => rpc.work.jenkinsBuild({ path, ...(parameters ? { parameters } : {}) }),
      t`Build queued.`,
    );
  }

  function watch(bot: Bot) {
    void run(
      "watch",
      () =>
        rpc.routines.create({
          botId: bot.id,
          name: `Jenkins: ${decodeURIComponent(job.fullName)}`.slice(0, 80),
          prompt: jenkinsWatchPrompt(job),
          active: true,
          notify: true,
          watch: {
            kind: "tool",
            tool: "jenkins_last_completed_build",
            args: { job: path },
            track: ["number", "result"],
            everyMinutes: 1,
          },
        }),
      t`${bot.name} now watches this job and tells you about each finished build.`,
    );
  }

  return (
    <div className="rk-scroll flex h-full flex-col overflow-y-auto" data-testid="jenkins-job-pane">
      <div className="space-y-3 border-b border-border px-6 pt-5 pb-4">
        <div className="flex items-start gap-3">
          <Link to="/app/automations" className="mt-1 md:hidden" aria-label={t`Back`}>
            <ChevronLeft className="size-5" />
          </Link>
          <div className="min-w-0 flex-1">
            <h2 className="flex items-center gap-2 text-heading3 font-medium text-foreground">
              {container ? null : <JenkinsStatusIcon status={job.status} />}
              <span className="truncate">{decodeURIComponent(job.name)}</span>
            </h2>
            <p className="mt-1 text-body-sm text-muted-foreground">
              {job.folder ? `${decodeURIComponent(job.folder)} · ` : ""}
              {job.kind === "multibranch" ? (
                <Trans>Multibranch pipeline</Trans>
              ) : job.kind === "folder" ? (
                <Trans>Folder</Trans>
              ) : (
                <Trans>Job</Trans>
              )}
            </p>
          </div>
          {job.url ? (
            <a
              href={job.url}
              target="_blank"
              rel="noreferrer"
              className={buttonVariants({
                variant: "ghost",
                size: "sm",
                className: "shrink-0 text-muted-foreground",
              })}
            >
              <ExternalLink className="size-4" />
              Jenkins
            </a>
          ) : null}
        </div>
        {container ? null : (
          <div className="flex flex-wrap items-center gap-2">
            <Button
              size="sm"
              disabled={Boolean(busy) || !job.buildable}
              onClick={buildNow}
              data-testid="jenkins-build-now"
            >
              <Play className="size-4" />
              {job.parameters.length ? (
                <Trans>Build with parameters</Trans>
              ) : (
                <Trans>Build now</Trans>
              )}
            </Button>
            {bots.length ? (
              <DropdownMenu>
                <DropdownMenuTrigger
                  render={
                    <Button
                      size="sm"
                      variant="secondary"
                      disabled={Boolean(busy)}
                      data-testid="jenkins-watch"
                    />
                  }
                >
                  <Eye className="size-4" />
                  <Trans>Watch with a bot</Trans>
                  <ChevronDown className="size-3.5" />
                </DropdownMenuTrigger>
                <DropdownMenuContent align="start" className="min-w-56">
                  <DropdownMenuGroup>
                    <DropdownMenuLabel>
                      <Trans>Tell me about each finished build</Trans>
                    </DropdownMenuLabel>
                    {bots.map((bot) => (
                      <DropdownMenuItem key={bot.id} onClick={() => watch(bot)}>
                        {bot.name}
                      </DropdownMenuItem>
                    ))}
                  </DropdownMenuGroup>
                </DropdownMenuContent>
              </DropdownMenu>
            ) : null}
            {busy ? <Spinner className="size-4 text-muted-foreground" /> : null}
          </div>
        )}
        {askParams ? (
          <form
            className="space-y-2 rounded-xl border border-border p-3"
            onSubmit={(event) => {
              event.preventDefault();
              buildNow();
            }}
          >
            {job.parameters.map((parameter) => (
              <div key={parameter.name} className="block text-body-sm">
                <label htmlFor={`jenkins-param-${parameter.name}`} className="font-medium">
                  {parameter.name}
                </label>
                {parameter.description ? (
                  <span className="ms-2 text-muted-foreground">{parameter.description}</span>
                ) : null}
                {parameter.type === "choice" ? (
                  <NativeSelect
                    id={`jenkins-param-${parameter.name}`}
                    className="mt-1"
                    value={values[parameter.name] ?? ""}
                    onChange={(event) =>
                      setValues((current) => ({ ...current, [parameter.name]: event.target.value }))
                    }
                  >
                    {parameter.choices.map((choice) => (
                      <NativeSelectOption key={choice} value={choice}>
                        {choice}
                      </NativeSelectOption>
                    ))}
                  </NativeSelect>
                ) : parameter.type === "boolean" ? (
                  <NativeSelect
                    id={`jenkins-param-${parameter.name}`}
                    className="mt-1"
                    value={values[parameter.name] ?? "false"}
                    onChange={(event) =>
                      setValues((current) => ({ ...current, [parameter.name]: event.target.value }))
                    }
                  >
                    <NativeSelectOption value="true">true</NativeSelectOption>
                    <NativeSelectOption value="false">false</NativeSelectOption>
                  </NativeSelect>
                ) : (
                  <Input
                    id={`jenkins-param-${parameter.name}`}
                    className="mt-1"
                    type={parameter.type === "password" ? "password" : "text"}
                    value={values[parameter.name] ?? ""}
                    onChange={(event) =>
                      setValues((current) => ({ ...current, [parameter.name]: event.target.value }))
                    }
                  />
                )}
              </div>
            ))}
            <div className="flex gap-2">
              <Button type="submit" size="sm" disabled={Boolean(busy)}>
                <Play className="size-4" />
                <Trans>Build</Trans>
              </Button>
              <Button type="button" size="sm" variant="ghost" onClick={() => setAskParams(false)}>
                <Trans>Cancel</Trans>
              </Button>
            </div>
          </form>
        ) : null}
        {notice ? <p className="text-body-sm text-success">{notice}</p> : null}
        {error ? (
          <p role="alert" className="text-body-sm text-destructive">
            {error}
          </p>
        ) : null}
        {job.watchers.length ? (
          <p
            className="flex flex-wrap items-center gap-1.5 text-body-sm text-muted-foreground"
            data-testid="jenkins-watchers"
          >
            <Eye className="size-4" />
            <Trans>Watched by</Trans>
            {job.watchers.map((watcher) => (
              <button
                key={watcher.routineId}
                type="button"
                onClick={() => navigate(`/app/${watcher.botId}?routine=${watcher.routineId}`)}
                className="rounded-full bg-muted px-2 py-0.5 text-foreground hover:bg-accent"
              >
                {watcher.botName}
                {watcher.active ? "" : ` (${t`paused`})`}
              </button>
            ))}
          </p>
        ) : null}
      </div>
      {container ? (
        <ul className="space-y-0.5 p-4">
          {job.jobs.map((child) => (
            <li key={child.path}>
              <JobRow job={child} depth={0} selected={false} />
            </li>
          ))}
        </ul>
      ) : (
        <div className="flex min-h-0 flex-1 flex-col gap-4 p-6 lg:flex-row">
          <section className="w-full shrink-0 lg:w-64">
            <h3 className="mb-2 text-label font-medium uppercase tracking-wide text-muted-foreground">
              <Trans>Builds</Trans>
            </h3>
            {job.builds.length === 0 ? (
              <p className="text-body-sm text-muted-foreground">
                <Trans>No builds yet.</Trans>
              </p>
            ) : (
              <ul className="space-y-0.5" data-testid="jenkins-builds">
                {job.builds.map((item: JenkinsBuild) => (
                  <li key={item.number}>
                    <button
                      type="button"
                      onClick={() => setBuild(item.number)}
                      aria-current={item.number === shownBuild ? "true" : undefined}
                      className={`flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-start text-body-sm hover:bg-accent/60 ${item.number === shownBuild ? "bg-accent" : ""}`}
                    >
                      <JenkinsStatusIcon status={item.status} />
                      <span className="font-medium">#{item.number}</span>
                      <span className="min-w-0 flex-1 truncate text-muted-foreground">
                        {item.startedAt ? formatRelativeTime(item.startedAt) : ""}
                      </span>
                      <span className="shrink-0 text-label text-muted-foreground">
                        {duration(item.durationMs)}
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </section>
          {shownBuild ? <ConsolePane path={path} number={shownBuild} /> : null}
        </div>
      )}
    </div>
  );
}

function ConsolePane({ path, number }: { path: string; number: number }) {
  const { t } = useLingui();
  const queries = useSpaceQueries();
  const log = useQuery({
    ...queries.work.jenkinsConsole.queryOptions({ input: { path, number } }),
    refetchInterval: (query) => (query.state.data?.building ? 3_000 : false),
  });
  const pre = useRef<HTMLPreElement>(null);
  const text = log.data?.text;
  // Failures are at the end of a log, so it opens there and follows a running build.
  useEffect(() => {
    if (text !== undefined && pre.current) pre.current.scrollTop = pre.current.scrollHeight;
  }, [text]);
  return (
    <section className="flex min-h-0 min-w-0 flex-1 flex-col">
      <h3 className="mb-2 text-label font-medium uppercase tracking-wide text-muted-foreground">
        <Trans>Console of #{number}</Trans>
      </h3>
      <div
        className="min-h-64 flex-1 overflow-hidden rounded-xl bg-neutral-950 text-neutral-100"
        data-testid="jenkins-console"
      >
        {log.isPending ? (
          <div className="flex justify-center py-6">
            <Spinner className="size-4 text-neutral-400" aria-label={t`Loading…`} />
          </div>
        ) : log.error ? (
          <p className="p-3 text-body-sm text-red-300">
            {errorText(log.error, t`Could not read the log`)}
          </p>
        ) : (
          <pre
            ref={pre}
            className="rk-scroll h-full max-h-[70vh] overflow-auto whitespace-pre-wrap break-all p-3 font-mono text-label"
            dir="ltr"
          >
            {log.data?.truncated ? `${t`… earlier lines not shown`}\n` : ""}
            {log.data?.text}
          </pre>
        )}
      </div>
    </section>
  );
}
