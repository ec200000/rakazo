import { Trans, useLingui } from "@lingui/react/macro";
import type { Bot, RepoChange } from "@rakazo/contracts";
import { ACTIVE_RUN_STATUSES } from "@rakazo/core";
import {
  Button,
  Input,
  NativeSelect,
  NativeSelectOption,
  Spinner,
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from "@rakazo/ui-web";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  ChevronDown,
  ChevronRight,
  File,
  Folder,
  GitBranch,
  GitCommitHorizontal,
  RefreshCw,
} from "lucide-react";
import { useState } from "react";
import { useSpaceQueries } from "../../lib/query";
import { rpc } from "../../lib/rpc";
import { errorText } from "../../lib/user-error";
import { DiffView } from "./code-diff";

type CodeTab = "changes" | "files" | "terminal";

function working(bot: Pick<Bot, "status">) {
  return ACTIVE_RUN_STATUSES.some((status) => status === bot.status);
}

/**
 * The bot's code beside its chat: what its branch changes (with diffs), its repository's
 * files, and the commands it ran, with a box to run one of your own.
 */
export function CodePanel({ bot }: { bot: Pick<Bot, "id" | "status" | "repos" | "repoBranch"> }) {
  const { t } = useLingui();
  const [tab, setTab] = useState<CodeTab>("changes");
  const repositories = bot.repos ?? [];
  // Which repository the panel shows; the server names folders, so start with the first.
  const [folder, setFolder] = useState<string | undefined>(undefined);
  const queries = useSpaceQueries();
  const listing = useQuery({
    ...queries.computer.repoChanges.queryOptions({ input: { botId: bot.id } }),
    enabled: repositories.length > 1,
  });
  const choices = listing.data?.repositories ?? [];
  return (
    <div className="space-y-3">
      {choices.length > 1 ? (
        <NativeSelect
          aria-label={t`Repository`}
          data-testid="code-repository"
          value={folder ?? choices[0]?.folder ?? ""}
          onChange={(event) => setFolder(event.target.value)}
          className="w-full"
        >
          {choices.map((choice) => (
            <NativeSelectOption key={choice.folder} value={choice.folder}>
              {choice.folder.replace(/^repos\//, "")}
            </NativeSelectOption>
          ))}
        </NativeSelect>
      ) : null}
      <Tabs value={tab} onValueChange={(next) => setTab(next as CodeTab)} data-testid="code-panel">
        <TabsList className="w-full">
          <TabsTrigger value="changes">
            <Trans>Changes</Trans>
          </TabsTrigger>
          <TabsTrigger value="files">
            <Trans>Files</Trans>
          </TabsTrigger>
          <TabsTrigger value="terminal">
            <Trans>Terminal</Trans>
          </TabsTrigger>
        </TabsList>
        <TabsContent value="changes" className="pt-3">
          <ChangesTab key={folder ?? ""} bot={bot} folder={folder} />
        </TabsContent>
        <TabsContent value="files" className="pt-3">
          <FilesTab key={folder ?? ""} bot={bot} folder={folder} />
        </TabsContent>
        <TabsContent value="terminal" className="pt-3">
          <TerminalTab bot={bot} folder={folder} />
        </TabsContent>
      </Tabs>
    </div>
  );
}

function WakeHint({ botId }: { botId: string }) {
  const { t } = useLingui();
  const queries = useSpaceQueries();
  const queryClient = useQueryClient();
  const [waking, setWaking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  return (
    <div className="flex flex-col items-start gap-2 rounded-[14px] bg-muted/50 px-4 py-3">
      <p className="text-body-sm text-muted-foreground">
        <Trans>The bot's computer is asleep. Wake it to read its git changes.</Trans>
      </p>
      <Button
        size="sm"
        variant="secondary"
        disabled={waking}
        onClick={async () => {
          setWaking(true);
          setError(null);
          try {
            await rpc.computer.boot({ botId });
            await queryClient.invalidateQueries({ queryKey: queries.computer.key() });
          } catch (err) {
            setError(errorText(err, t`Could not wake the computer`));
          } finally {
            setWaking(false);
          }
        }}
      >
        {waking ? <Trans>Waking…</Trans> : <Trans>Wake</Trans>}
      </Button>
      {error ? <p className="text-body-sm text-destructive">{error}</p> : null}
    </div>
  );
}

const STATUS_LETTER: Record<RepoChange["status"], { letter: string; className: string }> = {
  added: { letter: "A", className: "text-success" },
  untracked: { letter: "U", className: "text-success" },
  modified: { letter: "M", className: "text-warning" },
  typechange: { letter: "T", className: "text-warning" },
  deleted: { letter: "D", className: "text-destructive" },
  conflict: { letter: "!", className: "text-destructive" },
};

function ChangesTab({
  bot,
  folder,
}: {
  bot: Pick<Bot, "id" | "status" | "repoBranch">;
  folder?: string;
}) {
  const { t } = useLingui();
  const queries = useSpaceQueries();
  const busy = working(bot);
  const changes = useQuery({
    ...queries.computer.repoChanges.queryOptions({ input: { botId: bot.id, folder } }),
    refetchInterval: busy ? 4_000 : 20_000,
  });
  const [openPath, setOpenPath] = useState<string | null>(null);
  const [showCommits, setShowCommits] = useState(false);
  const data = changes.data;

  if (changes.isPending) {
    return (
      <div className="flex justify-center py-6">
        <Spinner className="size-4 text-muted-foreground" aria-label={t`Loading…`} />
      </div>
    );
  }
  if (changes.error || !data) {
    return (
      <p className="text-body-sm text-destructive">
        {errorText(changes.error, t`Could not read the changes`)}
      </p>
    );
  }
  if (data.state === "no-repository") {
    return (
      <p className="text-body-sm text-muted-foreground">
        <Trans>Set a repository in this bot's settings to see its changes.</Trans>
      </p>
    );
  }
  if (data.state === "asleep") return <WakeHint botId={bot.id} />;
  if (data.state === "not-cloned") {
    return (
      <p className="text-body-sm text-muted-foreground">
        <Trans>
          The bot has not cloned {data.folder} yet. It does when it starts working on the code.
        </Trans>
      </p>
    );
  }
  const additions = data.files.reduce((sum, file) => sum + (file.additions ?? 0), 0);
  const deletions = data.files.reduce((sum, file) => sum + (file.deletions ?? 0), 0);
  const uncommitted = data.files.filter((file) => file.uncommitted).length;
  const otherBranch =
    data.workingBranch && data.branch && data.branch !== data.workingBranch ? data.branch : null;
  return (
    <div className="space-y-3" data-testid="code-changes">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0 space-y-0.5">
          <p className="flex items-center gap-1.5 text-body-sm font-medium">
            <GitBranch className="size-4 shrink-0" aria-hidden />
            <span className="truncate">{data.branch ?? t`No branch checked out`}</span>
            <span className="shrink-0 font-normal text-muted-foreground">
              <Trans>into {data.baseBranch}</Trans>
            </span>
          </p>
          <p className="text-body-sm text-muted-foreground" data-testid="code-changes-summary">
            {data.files.length === 1 ? (
              <Trans>1 file</Trans>
            ) : (
              <Trans>{data.files.length} files</Trans>
            )}{" "}
            <span className="text-success">+{additions}</span>{" "}
            <span className="text-destructive">−{deletions}</span>
            {uncommitted ? (
              <>
                {" · "}
                <Trans>{uncommitted} not committed</Trans>
              </>
            ) : null}
            {data.ahead ? (
              <>
                {" · "}
                <Trans>{data.ahead} commits not pushed</Trans>
              </>
            ) : null}
            {data.ahead === null && data.commits.length ? (
              <>
                {" · "}
                <Trans>branch not pushed yet</Trans>
              </>
            ) : null}
          </p>
        </div>
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label={t`Refresh`}
          disabled={changes.isFetching}
          onClick={() => void changes.refetch()}
        >
          <RefreshCw className={`size-4 ${changes.isFetching ? "animate-spin" : ""}`} />
        </Button>
      </div>
      {otherBranch ? (
        <p className="rounded-md bg-warning/10 px-3 py-2 text-body-sm">
          <Trans>
            The folder is on {otherBranch}, not on {data.workingBranch}. The bot switches when it
            next syncs.
          </Trans>
        </p>
      ) : null}
      {data.commits.length ? (
        <div>
          <button
            type="button"
            className="flex items-center gap-1 text-body-sm text-muted-foreground hover:text-foreground"
            onClick={() => setShowCommits((value) => !value)}
          >
            {showCommits ? <ChevronDown className="size-4" /> : <ChevronRight className="size-4" />}
            {data.commits.length === 1 ? (
              <Trans>1 commit on this branch</Trans>
            ) : (
              <Trans>{data.commits.length} commits on this branch</Trans>
            )}
          </button>
          {showCommits ? (
            <ul className="mt-1 space-y-1 ps-5">
              {data.commits.map((commit) => (
                <li key={commit.sha} className="flex gap-2 text-body-sm">
                  <GitCommitHorizontal className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
                  <code className="shrink-0 text-muted-foreground">{commit.sha}</code>
                  <span className="min-w-0 truncate" dir="auto">
                    {commit.subject}
                  </span>
                </li>
              ))}
            </ul>
          ) : null}
        </div>
      ) : null}
      {data.files.length === 0 ? (
        <p className="text-body-sm text-muted-foreground">
          <Trans>No changes against {data.baseBranch} yet.</Trans>
        </p>
      ) : (
        <ul className="divide-y divide-border rounded-[12px] border border-border">
          {data.files.map((file) => (
            <li key={file.path}>
              <button
                type="button"
                data-testid="code-change-row"
                aria-expanded={openPath === file.path}
                onClick={() => setOpenPath((current) => (current === file.path ? null : file.path))}
                className="flex w-full items-center gap-2 px-3 py-1.5 text-start text-body-sm hover:bg-accent/60"
              >
                <span
                  className={`w-3 shrink-0 font-mono font-semibold ${STATUS_LETTER[file.status].className}`}
                >
                  {STATUS_LETTER[file.status].letter}
                </span>
                <span className="min-w-0 flex-1 truncate font-mono text-label" dir="ltr">
                  {file.path}
                </span>
                {file.uncommitted ? (
                  <span
                    className="size-1.5 shrink-0 rounded-full bg-warning"
                    title={t`Not committed`}
                  />
                ) : null}
                <span className="shrink-0 font-mono text-label">
                  {file.additions === null ? (
                    <span className="text-muted-foreground">
                      <Trans>binary</Trans>
                    </span>
                  ) : (
                    <>
                      <span className="text-success">+{file.additions}</span>{" "}
                      <span className="text-destructive">−{file.deletions}</span>
                    </>
                  )}
                </span>
              </button>
              {openPath === file.path ? (
                <FileDiff botId={bot.id} path={file.path} folder={folder} />
              ) : null}
            </li>
          ))}
        </ul>
      )}
      {data.truncated ? (
        <p className="text-body-sm text-muted-foreground">
          <Trans>Only the first {data.files.length} files are shown.</Trans>
        </p>
      ) : null}
    </div>
  );
}

function FileDiff({ botId, path, folder }: { botId: string; path: string; folder?: string }) {
  const { t } = useLingui();
  const queries = useSpaceQueries();
  const diff = useQuery(queries.computer.repoDiff.queryOptions({ input: { botId, path, folder } }));
  if (diff.isPending) {
    return (
      <div className="flex justify-center border-t border-border py-3">
        <Spinner className="size-4 text-muted-foreground" aria-label={t`Loading…`} />
      </div>
    );
  }
  if (diff.error || !diff.data) {
    return (
      <p className="border-t border-border px-3 py-2 text-body-sm text-destructive">
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

function FilesTab({ bot, folder }: { bot: Pick<Bot, "id">; folder?: string }) {
  const { t } = useLingui();
  const queries = useSpaceQueries();
  // The server names the repository folder; the Changes tab shares this query.
  const changes = useQuery(
    queries.computer.repoChanges.queryOptions({ input: { botId: bot.id, folder } }),
  );
  const root = changes.data?.folder ?? "";
  const [picked, setDir] = useState<string | null>(null);
  const dir = picked ?? root;
  const [file, setFile] = useState<string | null>(null);
  const listing = useQuery({
    ...queries.computer.files.queryOptions({ input: { botId: bot.id, path: dir } }),
    enabled: !file && Boolean(dir),
  });
  const content = useQuery({
    ...queries.computer.readFile.queryOptions({ input: { botId: bot.id, path: file ?? "" } }),
    enabled: Boolean(file),
  });
  const crumbs = dir.split("/").filter(Boolean);

  if (file) {
    const lines = (content.data?.content ?? "").replace(/\n$/, "").split("\n");
    return (
      <div className="space-y-2" data-testid="code-file">
        <div className="flex items-center gap-2">
          <Button size="sm" variant="ghost" onClick={() => setFile(null)}>
            <Trans>Back</Trans>
          </Button>
          <span className="min-w-0 truncate font-mono text-label" dir="ltr">
            {file}
          </span>
        </div>
        {content.isPending ? (
          <div className="flex justify-center py-4">
            <Spinner className="size-4 text-muted-foreground" aria-label={t`Loading…`} />
          </div>
        ) : content.error ? (
          <p className="text-body-sm text-destructive">
            {errorText(content.error, t`Could not open the file`)}
          </p>
        ) : (
          <div className="overflow-x-auto rounded-[12px] border border-border font-mono text-label leading-[18px]">
            <table className="w-full border-collapse">
              <tbody>
                {lines.map((line, index) => (
                  <tr key={index}>
                    <td className="w-10 select-none pe-2 text-end align-top text-muted-foreground/70">
                      {index + 1}
                    </td>
                    <td className="whitespace-pre pe-3 align-top">{line}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    );
  }

  const entries = (listing.data ?? [])
    .filter((entry) => baseName(entry.path) !== ".git")
    .sort((a, b) =>
      a.kind === b.kind
        ? baseName(a.path).localeCompare(baseName(b.path))
        : a.kind === "dir"
          ? -1
          : 1,
    );
  return (
    <div className="space-y-2" data-testid="code-files">
      <nav className="flex flex-wrap items-center gap-1 text-body-sm" dir="ltr">
        {crumbs.map((part, index) => {
          const target = crumbs.slice(0, index + 1).join("/");
          const inside = target.length >= root.length;
          return (
            <span key={target} className="flex items-center gap-1">
              {index > 0 ? <span className="text-muted-foreground">/</span> : null}
              <button
                type="button"
                disabled={!inside || target === dir}
                onClick={() => setDir(target)}
                className="rounded px-1 font-mono text-label hover:bg-accent/60 disabled:hover:bg-transparent"
              >
                {part}
              </button>
            </span>
          );
        })}
      </nav>
      {changes.isPending || (listing.isPending && Boolean(dir)) ? (
        <div className="flex justify-center py-4">
          <Spinner className="size-4 text-muted-foreground" aria-label={t`Loading…`} />
        </div>
      ) : listing.error ? (
        <p className="text-body-sm text-destructive">
          {errorText(listing.error, t`Could not list the files`)}
        </p>
      ) : entries.length === 0 ? (
        <p className="text-body-sm text-muted-foreground">
          <Trans>Nothing here yet. The bot clones the repository when it starts on the code.</Trans>
        </p>
      ) : (
        <ul className="rounded-[12px] border border-border py-1">
          {entries.map((entry) => (
            <li key={entry.path}>
              <button
                type="button"
                onClick={() => (entry.kind === "dir" ? setDir(entry.path) : setFile(entry.path))}
                className="flex w-full items-center gap-2 px-3 py-1 text-start text-body-sm hover:bg-accent/60"
              >
                {entry.kind === "dir" ? (
                  <Folder className="size-4 shrink-0 text-muted-foreground" />
                ) : (
                  <File className="size-4 shrink-0 text-muted-foreground" />
                )}
                <span className="min-w-0 flex-1 truncate font-mono text-label" dir="ltr">
                  {baseName(entry.path)}
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function baseName(path: string) {
  const parts = path.split("/").filter(Boolean);
  return parts[parts.length - 1] ?? path;
}

type PersonCommand = {
  id: number;
  command: string;
  output: string;
  exitCode: number | null;
  running: boolean;
};

function TerminalTab({ bot, folder }: { bot: Pick<Bot, "id" | "status">; folder?: string }) {
  const { t } = useLingui();
  const queries = useSpaceQueries();
  const busy = working(bot);
  const history = useQuery({
    ...queries.computer.commands.queryOptions({ input: { botId: bot.id } }),
    refetchInterval: busy ? 3_000 : 15_000,
  });
  const [command, setCommand] = useState("");
  const [mine, setMine] = useState<PersonCommand[]>([]);
  const running = mine.some((item) => item.running);

  async function run() {
    const text = command.trim();
    if (!text || running) return;
    const id = Date.now();
    setCommand("");
    setMine((current) => [
      ...current,
      { id, command: text, output: "", exitCode: null, running: true },
    ]);
    try {
      const result = await rpc.computer.run({
        botId: bot.id,
        command: text,
        ...(folder ? { folder } : {}),
      });
      setMine((current) =>
        current.map((item) =>
          item.id === id
            ? {
                ...item,
                running: false,
                exitCode: result.exitCode,
                output: `${result.truncated ? "…\n" : ""}${result.output}`,
              }
            : item,
        ),
      );
    } catch (err) {
      setMine((current) =>
        current.map((item) =>
          item.id === id
            ? { ...item, running: false, output: errorText(err, t`Could not run the command`) }
            : item,
        ),
      );
    }
  }

  const commands = (history.data ?? []).slice(-60);
  return (
    <div className="space-y-3" data-testid="code-terminal">
      <p className="text-body-sm text-muted-foreground">
        <Trans>Commands the bot ran, newest last.</Trans>
      </p>
      {history.isPending ? (
        <div className="flex justify-center py-4">
          <Spinner className="size-4 text-muted-foreground" aria-label={t`Loading…`} />
        </div>
      ) : commands.length === 0 ? (
        <p className="text-body-sm text-muted-foreground">
          <Trans>No commands yet.</Trans>
        </p>
      ) : (
        <div className="space-y-2">
          {commands.map((item) => (
            <TerminalEntry
              key={item.executionId}
              command={item.command}
              output={item.output}
              exitCode={item.exitCode}
              running={item.status === "running"}
            />
          ))}
        </div>
      )}
      {mine.length ? (
        <div className="space-y-2">
          <p className="text-body-sm font-medium">
            <Trans>Your commands</Trans>
          </p>
          {mine.map((item) => (
            <TerminalEntry key={item.id} {...item} />
          ))}
        </div>
      ) : null}
      <form
        className="flex gap-2"
        onSubmit={(event) => {
          event.preventDefault();
          void run();
        }}
      >
        <Input
          value={command}
          onChange={(event) => setCommand(event.target.value)}
          placeholder={t`Run a command in the repository`}
          aria-label={t`Command`}
          spellCheck={false}
          autoComplete="off"
          className="font-mono"
          dir="ltr"
        />
        <Button type="submit" size="sm" disabled={!command.trim() || running}>
          {running ? <Spinner className="size-4" /> : <Trans>Run</Trans>}
        </Button>
      </form>
    </div>
  );
}

const OUTPUT_PREVIEW_LINES = 30;

function TerminalEntry({
  command,
  output,
  exitCode,
  running,
}: {
  command: string;
  output: string;
  exitCode: number | null;
  running: boolean;
}) {
  const [expanded, setExpanded] = useState(false);
  const lines = output.replace(/\n$/, "").split("\n");
  const long = lines.length > OUTPUT_PREVIEW_LINES;
  const shown = expanded || !long ? lines : lines.slice(-OUTPUT_PREVIEW_LINES);
  return (
    <div className="overflow-hidden rounded-[12px] bg-neutral-950 text-label leading-[18px] text-neutral-100">
      <div className="flex items-center gap-2 px-3 pt-2 font-mono" dir="ltr">
        <span className="text-neutral-500">$</span>
        <span className="min-w-0 flex-1 truncate">{command}</span>
        {running ? (
          <Spinner className="size-3.5 text-neutral-400" />
        ) : exitCode !== null && exitCode !== 0 ? (
          <span className="shrink-0 text-red-400">
            <Trans>exit {exitCode}</Trans>
          </span>
        ) : null}
      </div>
      {output ? (
        <>
          {long && !expanded ? (
            <button
              type="button"
              onClick={() => setExpanded(true)}
              className="px-3 pt-1 text-neutral-400 hover:text-neutral-200"
            >
              <Trans>Show all {lines.length} lines</Trans>
            </button>
          ) : null}
          <pre className="max-h-96 overflow-auto whitespace-pre px-3 pt-1 pb-2 font-mono" dir="ltr">
            {shown.join("\n")}
          </pre>
        </>
      ) : (
        <div className="pb-2" />
      )}
    </div>
  );
}
