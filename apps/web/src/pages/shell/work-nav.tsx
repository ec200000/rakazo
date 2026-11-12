import { useLingui } from "@lingui/react/macro";
import { useQuery } from "@tanstack/react-query";
import type { LucideIcon } from "lucide-react";
import { CircleDot, GitPullRequest, Workflow } from "lucide-react";
import { IconTooltip } from "../../components/IconTooltip";
import { useSpaceQueries } from "../../lib/query";

type Item = {
  id: string;
  label: string;
  icon: LucideIcon;
  path: string;
  count: number;
  countLabel: string;
  tone: "primary" | "destructive";
};

/**
 * Work pages above the chats, as coding agent IDEs list them: pull requests (with how many wait
 * for the person's review), Azure Boards issues, and Jenkins automations (with how many jobs fail). Each shows only
 * when the server names that system.
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
  const pulls = useQuery({
    ...queries.work.pullRequests.queryOptions(),
    enabled: Boolean(status.data?.azureDevOps.connected),
    staleTime: 60_000,
    refetchInterval: 5 * 60_000,
  });
  const jobs = useQuery({
    ...queries.work.jenkinsJobs.queryOptions(),
    enabled: Boolean(status.data?.jenkins.connected),
    staleTime: 60_000,
    refetchInterval: 5 * 60_000,
  });
  const items: Item[] = [];
  if (status.data?.azureDevOps.configured) {
    items.push({
      id: "pulls",
      label: t`Pull requests`,
      icon: GitPullRequest,
      path: "/app/pulls",
      count: (pulls.data?.pullRequests ?? []).filter((pr) => pr.group === "review").length,
      countLabel: t`waiting for your review`,
      tone: "primary",
    });
  }
  if (status.data?.azureDevOps.configured) {
    items.push({
      id: "issues",
      label: t`Issues`,
      icon: CircleDot,
      path: "/app/issues",
      count: 0,
      countLabel: "",
      tone: "primary",
    });
  }
  if (status.data?.jenkins.configured) {
    items.push({
      id: "automations",
      label: t`Automations`,
      icon: Workflow,
      path: "/app/automations",
      count: (jobs.data?.jobs ?? []).filter((job) => job.status === "failed").length,
      countLabel: t`jobs failing`,
      tone: "destructive",
    });
  }
  if (items.length === 0) return null;
  const open = (path: string) => {
    onNavigate();
    navigate(path);
  };
  if (mini) {
    return (
      <div className="mb-2 flex flex-col items-center gap-0.5">
        {items.map((item) => (
          <IconTooltip key={item.id} label={item.label}>
            <button
              type="button"
              aria-label={item.label}
              data-testid={`work-nav-${item.id}`}
              onClick={() => open(item.path)}
              className="relative grid size-9 place-items-center rounded-xl text-muted-foreground hover:bg-accent hover:text-foreground"
            >
              <item.icon className="size-[18px]" strokeWidth={1.7} />
              {item.count ? (
                <span
                  aria-hidden
                  className={`absolute end-1 top-1 size-2 rounded-full ${item.tone === "primary" ? "bg-primary" : "bg-destructive"}`}
                />
              ) : null}
            </button>
          </IconTooltip>
        ))}
      </div>
    );
  }
  return (
    <nav aria-label={t`Work`} className="mx-2.5 mb-2 space-y-0.5">
      {items.map((item) => (
        <button
          key={item.id}
          type="button"
          data-testid={`work-nav-${item.id}`}
          onClick={() => open(item.path)}
          className="flex w-full items-center gap-2.5 rounded-xl px-2.5 py-1.5 text-body text-foreground/85 hover:bg-accent/70"
        >
          <item.icon className="size-[17px] text-muted-foreground" strokeWidth={1.7} />
          <span className="flex-1 text-start">{item.label}</span>
          {item.count ? (
            <span
              className={`rounded-full px-1.5 text-caption font-medium ${item.tone === "primary" ? "bg-primary text-primary-foreground" : "bg-destructive text-destructive-foreground"}`}
            >
              {item.count}
              <span className="sr-only"> {item.countLabel}</span>
            </span>
          ) : null}
        </button>
      ))}
    </nav>
  );
}
