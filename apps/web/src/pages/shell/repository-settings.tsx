import { Trans, useLingui } from "@lingui/react/macro";
import type { Bot } from "@rakazo/contracts";
import { GitBranchNameSchema, GitRepositoryUrlSchema } from "@rakazo/contracts";
import { Button, Input } from "@rakazo/ui-web";
import { useEffect, useState } from "react";
import { errorText } from "../../lib/user-error";
import { BotPanelGroup } from "./bot-settings-sections";

/**
 * The git repository this bot works on and its base branch. The working branch is chosen in
 * the Branch box above the chat; git signs in with the person's Azure DevOps connection.
 */
export function RepositoryGroup({
  ids,
  bot,
  onSave,
}: {
  ids: string;
  bot: Pick<Bot, "repoUrl" | "repoBaseBranch">;
  onSave: (patch: { repoUrl?: string | null; repoBaseBranch?: string | null }) => Promise<void>;
}) {
  const { t } = useLingui();
  const [url, setUrl] = useState(bot.repoUrl ?? "");
  const [base, setBase] = useState(bot.repoBaseBranch ?? "");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    setUrl(bot.repoUrl ?? "");
    setBase(bot.repoBaseBranch ?? "");
  }, [bot.repoUrl, bot.repoBaseBranch]);
  const dirty = url.trim() !== (bot.repoUrl ?? "") || base.trim() !== (bot.repoBaseBranch ?? "");

  async function save() {
    const repoUrl = url.trim() || null;
    const repoBaseBranch = base.trim() || null;
    if (repoUrl && !GitRepositoryUrlSchema.safeParse(repoUrl).success) {
      setError(t`Use the repository's https clone URL, without a user name or token.`);
      return;
    }
    if (repoBaseBranch && !GitBranchNameSchema.safeParse(repoBaseBranch).success) {
      setError(t`That is not a valid branch name.`);
      return;
    }
    setError(null);
    setSaving(true);
    try {
      await onSave({ repoUrl, repoBaseBranch: repoUrl ? repoBaseBranch : null });
    } catch (err) {
      setError(errorText(err, t`Could not save the repository`));
    } finally {
      setSaving(false);
    }
  }

  return (
    <BotPanelGroup label={t`Repository`} plain>
      <section data-testid="bot-settings-repository" className="space-y-3">
        <p className="text-body-sm text-muted-foreground">
          <Trans>
            The git repository this bot works on. Choose the branch above the chat; git signs in
            with your Azure DevOps connection from Integrations.
          </Trans>
        </p>
        <label className="block text-body-sm text-muted-foreground" htmlFor={`${ids}-repo-url`}>
          <Trans>Clone URL</Trans>
          <Input
            id={`${ids}-repo-url`}
            value={url}
            onChange={(event) => setUrl(event.target.value)}
            placeholder="https://ado.example/tfs/DefaultCollection/Project/_git/repo"
            spellCheck={false}
            autoComplete="off"
            className="mt-1"
          />
        </label>
        <label className="block text-body-sm text-muted-foreground" htmlFor={`${ids}-repo-base`}>
          <Trans>Base branch</Trans>
          <Input
            id={`${ids}-repo-base`}
            value={base}
            onChange={(event) => setBase(event.target.value)}
            placeholder="main"
            spellCheck={false}
            autoComplete="off"
            className="mt-1"
          />
        </label>
        {error ? (
          <p role="alert" className="text-body-sm text-destructive">
            {error}
          </p>
        ) : null}
        <Button
          size="sm"
          variant="secondary"
          disabled={!dirty || saving}
          onClick={() => void save()}
        >
          {saving ? <Trans>Saving…</Trans> : <Trans>Save repository</Trans>}
        </Button>
      </section>
    </BotPanelGroup>
  );
}
