import { Trans, useLingui } from "@lingui/react/macro";
import type { Bot, BotRepositoryInput } from "@rakazo/contracts";
import { BotRepositoryInput as BotRepositorySchema, MAX_BOT_REPOSITORIES } from "@rakazo/contracts";
import { Button, Input } from "@rakazo/ui-web";
import { Plus, Trash2 } from "lucide-react";
import { useEffect, useState } from "react";
import { errorText } from "../../lib/user-error";
import { BotPanelGroup } from "./bot-settings-sections";

type Row = { url: string; baseBranch: string; jenkinsJob: string };

function rowsOf(bot: Pick<Bot, "repos">): Row[] {
  return (bot.repos ?? []).map((repo) => ({
    url: repo.url,
    baseBranch: repo.baseBranch ?? "",
    jenkinsJob: repo.jenkinsJob ?? "",
  }));
}

const EMPTY_ROW: Row = { url: "", baseBranch: "", jenkinsJob: "" };

/**
 * The git repositories this bot works on, each with its base branch and the Jenkins multibranch
 * job that builds it. The one working branch is chosen in the Branch box above the chat; git
 * signs in with the person's Azure DevOps connection.
 */
export function RepositoryGroup({
  ids,
  bot,
  onSave,
}: {
  ids: string;
  bot: Pick<Bot, "repos">;
  onSave: (patch: { repos: BotRepositoryInput[] }) => Promise<void>;
}) {
  const { t } = useLingui();
  const [rows, setRows] = useState<Row[]>(() => rowsOf(bot));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const saved = JSON.stringify(rowsOf(bot));
  useEffect(() => {
    setRows(JSON.parse(saved) as Row[]);
  }, [saved]);
  const dirty = JSON.stringify(rows.filter((row) => row.url.trim())) !== saved;

  function change(index: number, patch: Partial<Row>) {
    setRows((current) => current.map((row, i) => (i === index ? { ...row, ...patch } : row)));
  }

  async function save() {
    const repos: BotRepositoryInput[] = [];
    for (const row of rows) {
      if (!row.url.trim()) continue;
      const parsed = BotRepositorySchema.safeParse({
        url: row.url.trim(),
        baseBranch: row.baseBranch.trim() || null,
        jenkinsJob: row.jenkinsJob.trim() || null,
      });
      if (!parsed.success) {
        const field = parsed.error.issues[0]?.path[0];
        setError(
          field === "url"
            ? t`Use each repository's https clone URL, without a user name or token.`
            : field === "baseBranch"
              ? t`That is not a valid branch name.`
              : t`Use the Jenkins job's path as in its URL after /job/, e.g. team/job/app.`,
        );
        return;
      }
      repos.push(parsed.data);
    }
    setError(null);
    setSaving(true);
    try {
      await onSave({ repos });
    } catch (err) {
      setError(errorText(err, t`Could not save the repositories`));
    } finally {
      setSaving(false);
    }
  }

  return (
    <BotPanelGroup label={t`Repositories`} plain>
      <section data-testid="bot-settings-repository" className="space-y-3">
        <p className="text-body-sm text-muted-foreground">
          <Trans>
            The git repositories this bot works on. Choose one branch for all of them above the
            chat; git signs in with your Azure DevOps connection from Integrations. With a Jenkins
            job, the bot watches its branch's builds and asks you before fixing a failure.
          </Trans>
        </p>
        {rows.map((row, index) => (
          <div
            // biome-ignore lint/suspicious/noArrayIndexKey: rows have no identity until saved.
            key={index}
            className="space-y-2 rounded-xl border border-border p-3"
            data-testid="bot-repository-row"
          >
            <div className="flex items-end gap-2">
              <label
                className="block min-w-0 flex-1 text-body-sm text-muted-foreground"
                htmlFor={`${ids}-repo-url-${index}`}
              >
                <Trans>Clone URL</Trans>
                <Input
                  id={`${ids}-repo-url-${index}`}
                  value={row.url}
                  onChange={(event) => change(index, { url: event.target.value })}
                  placeholder="https://ado.example/tfs/DefaultCollection/Project/_git/repo"
                  spellCheck={false}
                  autoComplete="off"
                  className="mt-1"
                />
              </label>
              <Button
                variant="ghost"
                size="icon-sm"
                aria-label={t`Remove repository`}
                onClick={() => setRows((current) => current.filter((_, i) => i !== index))}
              >
                <Trash2 className="size-4" />
              </Button>
            </div>
            <div className="grid grid-cols-2 gap-2">
              <label
                className="block text-body-sm text-muted-foreground"
                htmlFor={`${ids}-repo-base-${index}`}
              >
                <Trans>Base branch</Trans>
                <Input
                  id={`${ids}-repo-base-${index}`}
                  value={row.baseBranch}
                  onChange={(event) => change(index, { baseBranch: event.target.value })}
                  placeholder="main"
                  spellCheck={false}
                  autoComplete="off"
                  className="mt-1"
                />
              </label>
              <label
                className="block text-body-sm text-muted-foreground"
                htmlFor={`${ids}-repo-jenkins-${index}`}
              >
                <Trans>Jenkins multibranch job</Trans>
                <Input
                  id={`${ids}-repo-jenkins-${index}`}
                  value={row.jenkinsJob}
                  onChange={(event) => change(index, { jenkinsJob: event.target.value })}
                  placeholder="team/job/app"
                  spellCheck={false}
                  autoComplete="off"
                  className="mt-1"
                />
              </label>
            </div>
          </div>
        ))}
        {error ? (
          <p role="alert" className="text-body-sm text-destructive">
            {error}
          </p>
        ) : null}
        <div className="flex flex-wrap gap-2">
          <Button
            size="sm"
            variant="ghost"
            disabled={rows.length >= MAX_BOT_REPOSITORIES}
            onClick={() => setRows((current) => [...current, { ...EMPTY_ROW }])}
            data-testid="bot-repository-add"
          >
            <Plus className="size-4" />
            <Trans>Add repository</Trans>
          </Button>
          <Button
            size="sm"
            variant="secondary"
            disabled={!dirty || saving}
            onClick={() => void save()}
          >
            {saving ? <Trans>Saving…</Trans> : <Trans>Save repositories</Trans>}
          </Button>
        </div>
      </section>
    </BotPanelGroup>
  );
}
