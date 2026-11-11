import { Plural, Trans, useLingui } from "@lingui/react/macro";
import type { CapabilityInstall, PluginMarketplaceInspection } from "@rakazo/contracts";
import { Button, Field, FieldLabel, Input, SectionHeading, Spinner } from "@rakazo/ui-web";
import { useQuery } from "@tanstack/react-query";
import { Check, X } from "lucide-react";
import { useState } from "react";
import { useSpaceQueries } from "../../lib/query";
import type { SavedMarketplace } from "../../lib/skill-marketplaces-pref";
import { errorText } from "../../lib/user-error";
import type { PluginSelection } from "./plugin-marketplace";
import { PluginLogo, pluginSelection, ROW_HOVER } from "./plugin-marketplace";

type Plugin = PluginMarketplaceInspection["plugins"][number];
const SKILLS_SHOWN = 6;

/**
 * Reads any git repository the server allows and lists every plugin and skill in it. Opening
 * one goes to the usual preview, which installs it. Saved repositories stay in this browser.
 */
export function MarketplaceInspector({
  initialUrl,
  saved,
  installs,
  back,
  onOpen,
  onSave,
  onForget,
}: {
  initialUrl: string;
  saved: SavedMarketplace[];
  installs: CapabilityInstall[];
  back: React.ReactNode;
  onOpen: (selection: PluginSelection) => void;
  onSave: (entry: SavedMarketplace) => void;
  onForget: (url: string) => void;
}) {
  const { t } = useLingui();
  const queries = useSpaceQueries();
  const [draft, setDraft] = useState(initialUrl);
  const [url, setUrl] = useState(initialUrl);
  const [filter, setFilter] = useState("");
  const inspection = useQuery({
    ...queries.marketplace.inspect.queryOptions({ input: { url } }),
    enabled: Boolean(url),
    retry: false,
    staleTime: 5 * 60_000,
  });
  const data = inspection.data;
  const query = filter.trim().toLowerCase();
  const plugins = (data?.plugins ?? []).filter(
    (plugin) =>
      !query ||
      [plugin.displayName, plugin.description, ...(plugin.skills ?? []).map((s) => s.name)]
        .join(" ")
        .toLowerCase()
        .includes(query),
  );
  const skillTotal = (data?.plugins ?? []).reduce(
    (sum, plugin) => sum + (plugin.skills?.length ?? 0),
    0,
  );
  const isSaved = Boolean(data && saved.some((entry) => entry.url === data.url));

  return (
    <div data-testid="skills-marketplace" className="space-y-6">
      <div className="flex items-center gap-2">
        {back}
        <SectionHeading as="h2" variant="heading">
          <Trans>Add a marketplace</Trans>
        </SectionHeading>
      </div>
      <form
        className="max-w-xl space-y-3"
        onSubmit={(event) => {
          event.preventDefault();
          const next = draft.trim().replace(/\/$/, "");
          if (next === url) void inspection.refetch();
          else setUrl(next);
        }}
      >
        <Field>
          <FieldLabel htmlFor="skills-marketplace-url">
            <Trans>Git repository URL</Trans>
          </FieldLabel>
          <Input
            id="skills-marketplace-url"
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            placeholder="https://git.example.com/team/skills"
            maxLength={2048}
            autoFocus
          />
          <p className="text-body-sm text-muted-foreground">
            <Trans>
              Any git server: Azure DevOps, GitLab, Gitea, GitHub and others. Add @branch to read a
              branch, or #folder to read one folder.
            </Trans>
          </p>
        </Field>
        <Button type="submit" disabled={!draft.trim() || inspection.isFetching}>
          {inspection.isFetching ? <Trans>Loading…</Trans> : <Trans>Load skills</Trans>}
        </Button>
      </form>

      {saved.length ? (
        <div className="space-y-2">
          <h3 className="text-body font-medium text-muted-foreground">
            <Trans>Saved marketplaces</Trans>
          </h3>
          <div className="flex flex-wrap gap-2">
            {saved.map((entry) => (
              <span
                key={entry.url}
                className="flex items-center rounded-full border border-border ps-3 text-body-sm"
              >
                <button
                  type="button"
                  className="max-w-64 truncate py-1 text-start hover:underline"
                  title={entry.url}
                  onClick={() => {
                    setDraft(entry.url);
                    setUrl(entry.url);
                  }}
                >
                  {entry.name}
                </button>
                <Button
                  variant="ghost"
                  size="icon-sm"
                  aria-label={t`Forget ${entry.name}`}
                  onClick={() => onForget(entry.url)}
                >
                  <X />
                </Button>
              </span>
            ))}
          </div>
        </div>
      ) : null}

      {inspection.isFetching && !data ? (
        <div className="flex items-center gap-3 py-6 text-body text-muted-foreground">
          <Spinner className="size-5" aria-hidden />
          <Trans>Reading the repository…</Trans>
        </div>
      ) : null}
      {inspection.error ? (
        <p role="alert" className="text-body text-destructive">
          {errorText(inspection.error, t`Could not read the repository`)}
        </p>
      ) : null}

      {data ? (
        <section className="space-y-4" data-testid="marketplace-results">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div className="min-w-0">
              <h3 className="truncate text-heading font-medium">{data.name}</h3>
              <p className="truncate text-body-sm text-muted-foreground" title={data.url}>
                {data.url}
              </p>
              <p className="text-body-sm text-muted-foreground">
                <Plural value={data.plugins.length} one="# plugin" other="# plugins" />
                {" · "}
                <Plural value={skillTotal} one="# skill" other="# skills" />
                {data.indexed ? null : (
                  <>
                    {" · "}
                    <Trans>found in its folders</Trans>
                  </>
                )}
              </p>
            </div>
            <Button
              variant="outline"
              size="sm"
              disabled={isSaved}
              onClick={() => onSave({ url: data.url, name: data.name })}
            >
              {isSaved ? (
                <>
                  <Check />
                  <Trans>Saved</Trans>
                </>
              ) : (
                <Trans>Save marketplace</Trans>
              )}
            </Button>
          </div>
          {data.plugins.length > 4 ? (
            <Input
              value={filter}
              onChange={(event) => setFilter(event.target.value)}
              aria-label={t`Search this marketplace`}
              placeholder={t`Search this marketplace`}
              maxLength={200}
              className="h-10 max-w-xl rounded-xl"
            />
          ) : null}
          {!data.plugins.length ? (
            <p className="text-body text-muted-foreground">
              <Trans>
                No skills found. A skill is a folder with a SKILL.md file; plugins keep theirs in a
                skills/ folder.
              </Trans>
            </p>
          ) : null}
          <div className="grid gap-2 md:grid-cols-2">
            {plugins.map((plugin) => (
              <MarketplacePlugin
                key={plugin.id}
                plugin={plugin}
                installed={installs.some((row) => row.source === plugin.installedSource)}
                onOpen={() => onOpen(pluginSelection(plugin))}
              />
            ))}
          </div>
        </section>
      ) : null}
    </div>
  );
}

function MarketplacePlugin({
  plugin,
  installed,
  onOpen,
}: {
  plugin: Plugin;
  installed: boolean;
  onOpen: () => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const skills = plugin.skills ?? [];
  const shown = expanded ? skills : skills.slice(0, SKILLS_SHOWN);
  return (
    <div
      data-testid="marketplace-plugin"
      className={`flex min-w-0 flex-col gap-2 rounded-xl border border-border p-3 ${ROW_HOVER}`}
    >
      <button
        type="button"
        className="flex min-w-0 items-center gap-3 text-start focus-visible:outline-none"
        onClick={onOpen}
      >
        <PluginLogo name={plugin.displayName} logo={plugin.logo} />
        <span className="min-w-0 flex-1">
          <span className="block truncate text-body-lg font-medium">{plugin.displayName}</span>
          <span className="block truncate text-body-sm text-muted-foreground">
            {plugin.skills === null ? (
              <Trans>Hosted in another repository</Trans>
            ) : (
              <Plural value={skills.length} one="# skill" other="# skills" />
            )}
            {installed ? (
              <>
                {" · "}
                <Trans>Installed</Trans>
              </>
            ) : null}
          </span>
        </span>
        <span className="shrink-0 text-body-sm text-foreground underline-offset-2 hover:underline">
          {installed ? <Trans>Manage</Trans> : <Trans>Preview</Trans>}
        </span>
      </button>
      {plugin.description ? (
        <p className="line-clamp-2 text-body-sm text-muted-foreground">{plugin.description}</p>
      ) : null}
      {shown.length ? (
        <ul className="space-y-1 border-t border-border pt-2 text-body-sm">
          {shown.map((skill) => (
            <li key={skill.name} className="min-w-0">
              <span className="font-medium text-foreground">{skill.name}</span>
              {skill.problem ? (
                <span className="block text-destructive">{skill.problem}</span>
              ) : skill.description ? (
                <span className="block line-clamp-2 text-muted-foreground">
                  {skill.description}
                </span>
              ) : null}
            </li>
          ))}
        </ul>
      ) : null}
      {skills.length > SKILLS_SHOWN ? (
        <button
          type="button"
          className="self-start text-body-sm text-muted-foreground hover:underline"
          onClick={() => setExpanded((value) => !value)}
        >
          {expanded ? <Trans>Show fewer</Trans> : <Trans>Show all {skills.length}</Trans>}
        </button>
      ) : null}
    </div>
  );
}
