import { Trans, useLingui } from "@lingui/react/macro";
import type { Bot } from "@rakazo/contracts";
import { GitBranchNameSchema } from "@rakazo/contracts";
import { Button, Input, Popover, PopoverContent, PopoverTrigger, Spinner } from "@rakazo/ui-web";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Check, GitBranch, Plus } from "lucide-react";
import { useRef, useState } from "react";
import { useSpaceQueries } from "../../lib/query";
import { rpc } from "../../lib/rpc";
import { errorText } from "../../lib/user-error";

const SHOWN = 50;

/**
 * The branch this bot works on, above its chat. The person picks an existing branch or types a
 * new name; the bot never names branches itself, and creates a new one from the base branch
 * the next time it syncs.
 */
export function BranchBox({
  bot,
}: {
  bot: Pick<Bot, "id" | "repoUrl" | "repoBranch" | "repoBaseBranch">;
}) {
  const { t } = useLingui();
  const queries = useSpaceQueries();
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const branches = useQuery({
    ...queries.bots.repositoryBranches.queryOptions({ input: { botId: bot.id } }),
    enabled: open,
    staleTime: 30_000,
  });
  const typed = query.trim();
  const list = (branches.data?.branches ?? []).filter((name) =>
    name.toLowerCase().includes(typed.toLowerCase()),
  );
  const exists = (branches.data?.branches ?? []).includes(typed);
  const typedValid = typed !== "" && GitBranchNameSchema.safeParse(typed).success;

  async function choose(branch: string) {
    setSaving(true);
    setError(null);
    try {
      await rpc.bots.update({ botId: bot.id, repoBranch: branch });
      await queryClient.invalidateQueries({ queryKey: queries.bots.key() });
      setOpen(false);
      setQuery("");
    } catch (err) {
      setError(errorText(err, t`Could not set the branch`));
    } finally {
      setSaving(false);
    }
  }

  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (!next) {
          setQuery("");
          setError(null);
        }
      }}
    >
      <PopoverTrigger
        render={
          <Button
            variant="floating"
            data-testid="branch-box"
            className="app-no-drag h-9 max-w-56 gap-1.5 px-3"
            aria-label={t`Working branch`}
          />
        }
      >
        <GitBranch strokeWidth={1.7} className="size-[15px] shrink-0" />
        <span className="truncate text-body-sm">
          {bot.repoBranch ?? <Trans>Choose branch</Trans>}
        </span>
      </PopoverTrigger>
      <PopoverContent initialFocus={inputRef} className="w-80 gap-2 p-3" align="end">
        <p className="text-body-sm text-muted-foreground">
          <Trans>
            Pick a branch, or type a new name to create it from {bot.repoBaseBranch ?? "main"}.
          </Trans>
        </p>
        <Input
          ref={inputRef}
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && typedValid && !saving) void choose(typed);
          }}
          placeholder={t`Branch name`}
          aria-label={t`Branch name`}
          spellCheck={false}
          autoComplete="off"
        />
        {typed && !typedValid ? (
          <p className="text-body-sm text-destructive">
            <Trans>That is not a valid branch name.</Trans>
          </p>
        ) : null}
        {typedValid && !exists ? (
          <Button
            size="sm"
            variant="secondary"
            disabled={saving}
            onClick={() => void choose(typed)}
            className="justify-start"
          >
            <Plus className="size-4" />
            <span className="truncate">
              <Trans>New branch "{typed}"</Trans>
            </span>
          </Button>
        ) : null}
        <div className="max-h-64 overflow-y-auto" data-testid="branch-list">
          {branches.isPending ? (
            <div className="flex justify-center py-4">
              <Spinner className="size-4 text-muted-foreground" aria-label={t`Loading…`} />
            </div>
          ) : null}
          {branches.data?.error ? (
            <p className="py-2 text-body-sm text-destructive">{branches.data.error}</p>
          ) : null}
          {list.slice(0, SHOWN).map((name) => (
            <button
              key={name}
              type="button"
              disabled={saving}
              onClick={() => void choose(name)}
              className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-start text-body-sm hover:bg-accent/60"
            >
              <span className="w-4 shrink-0">
                {name === bot.repoBranch ? <Check className="size-4" /> : null}
              </span>
              <span className="truncate">{name}</span>
            </button>
          ))}
          {list.length > SHOWN ? (
            <p className="px-2 py-1 text-body-sm text-muted-foreground">
              <Trans>Type to find more branches.</Trans>
            </p>
          ) : null}
        </div>
        {error ? (
          <p role="alert" className="text-body-sm text-destructive">
            {error}
          </p>
        ) : null}
      </PopoverContent>
    </Popover>
  );
}
