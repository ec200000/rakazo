import { useLingui } from "@lingui/react/macro";
import { useQuery } from "@tanstack/react-query";
import { GitPullRequest } from "lucide-react";
import { IconTooltip } from "../../components/IconTooltip";
import { useSpaceQueries } from "../../lib/query";

/**
 * Work pages above the chats, as coding agent IDEs list them: pull requests now, with how many
 * wait for the person's review. Shown only when the server names an Azure DevOps collection.
 */
export function WorkNav({
  mini,
  navigate,
  onNavigate,
}: {
  mini: boolean;
  navigate: (path: string) => void;
  onNavigate: () => void;
}) {
  const { t } = useLingui();
  const queries = useSpaceQueries();
  const status = useQuery({ ...queries.work.status.queryOptions(), staleTime: 5 * 60_000 });
  const connected = Boolean(status.data?.azureDevOps.connected);
  const pulls = useQuery({
    ...queries.work.pullRequests.queryOptions(),
    enabled: connected,
    staleTime: 60_000,
    refetchInterval: 5 * 60_000,
  });
  if (!status.data?.azureDevOps.configured) return null;
  const waiting = (pulls.data?.pullRequests ?? []).filter((pr) => pr.group === "review").length;
  const open = () => {
    onNavigate();
    navigate("/app/pulls");
  };
  if (mini) {
    return (
      <IconTooltip label={t`Pull requests`}>
        <button
          type="button"
          aria-label={t`Pull requests`}
          data-testid="work-nav-pulls"
          onClick={open}
          className="relative mx-auto mb-2 grid size-9 place-items-center rounded-xl text-muted-foreground hover:bg-accent hover:text-foreground"
        >
          <GitPullRequest className="size-[18px]" strokeWidth={1.7} />
          {waiting ? (
            <span className="absolute end-1 top-1 size-2 rounded-full bg-primary" aria-hidden />
          ) : null}
        </button>
      </IconTooltip>
    );
  }
  return (
    <nav aria-label={t`Work`} className="mx-2.5 mb-2">
      <button
        type="button"
        data-testid="work-nav-pulls"
        onClick={open}
        className="flex w-full items-center gap-2.5 rounded-xl px-2.5 py-1.5 text-body text-foreground/85 hover:bg-accent/70"
      >
        <GitPullRequest className="size-[17px] text-muted-foreground" strokeWidth={1.7} />
        <span className="flex-1 text-start">{t`Pull requests`}</span>
        {waiting ? (
          <span className="rounded-full bg-primary px-1.5 text-caption font-medium text-primary-foreground">
            {waiting}
            <span className="sr-only"> {t`waiting for your review`}</span>
          </span>
        ) : null}
      </button>
    </nav>
  );
}
