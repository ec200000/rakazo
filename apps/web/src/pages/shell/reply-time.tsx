import { Trans, useLingui } from "@lingui/react/macro";
import type { AnswerBreakdown } from "@rakazo/contracts";
import { Popover, PopoverContent, PopoverTrigger } from "@rakazo/ui-web/components/ui/popover";
import { cn } from "@rakazo/ui-web/lib/utils";
import { useQuery } from "@tanstack/react-query";
import { Timer } from "lucide-react";
import type { ReactNode } from "react";
import { useState } from "react";
import type { ArtifactTarget } from "../../lib/artifact-open";
import type { createSpaceRpc } from "../../lib/rpc";
import type { ReplyTiming } from "./reply-timing";
import { breakdownParts, contextShare, formatDuration, formatTokens } from "./reply-timing";

type SpaceRpc = ReturnType<typeof createSpaceRpc>;

/**
 * A small toggle under a bot's answer: how long it took. Hovering it (or tapping it) shows
 * where the time went and how full the model's context was on its last call.
 */
export function ReplyTime({
  timing,
  target,
  rpc,
}: {
  timing: ReplyTiming;
  target?: ArtifactTarget;
  rpc?: SpaceRpc;
}) {
  const { t } = useLingui();
  const [expanded, setExpanded] = useState(false);
  const [open, setOpen] = useState(false);
  const total = formatDuration(timing.lastReplyAt - timing.askedAt);
  const first = formatDuration(timing.firstReplyAt - timing.askedAt);
  const several = timing.lastReplyAt - timing.firstReplyAt >= 1000;
  const runId = timing.runId;
  const button = (
    <button
      type="button"
      data-testid="reply-time"
      aria-expanded={expanded}
      aria-label={t`Answered in ${total}`}
      onClick={() => setExpanded((value) => !value)}
      className="mt-1 inline-flex items-center gap-1 rounded-full px-1.5 py-0.5 text-caption text-muted-foreground/80 hover:bg-muted hover:text-muted-foreground"
    >
      <Timer aria-hidden className="size-3" strokeWidth={1.8} />
      {expanded ? (
        several ? (
          <Trans>
            Answered in {total} · first reply after {first}
          </Trans>
        ) : (
          <Trans>Answered in {total}</Trans>
        )
      ) : (
        total
      )}
    </button>
  );
  if (!runId || !target || !rpc) return button;
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger openOnHover delay={250} closeDelay={150} render={button} />
      <PopoverContent
        side="top"
        align="start"
        className="w-[22rem] max-w-[calc(100vw-2rem)] p-3"
        data-testid="reply-time-breakdown"
      >
        {open ? <BreakdownCard rpc={rpc} target={target} runId={runId} /> : null}
      </PopoverContent>
    </Popover>
  );
}

const PART_COLORS: Record<string, string> = {
  model: "bg-sky-500",
  tools: "bg-violet-500",
  review: "bg-amber-500",
  waiting: "bg-muted-foreground/35",
  queued: "bg-muted-foreground/20",
  other: "bg-muted-foreground/55",
};

function BreakdownCard({
  rpc,
  target,
  runId,
}: {
  rpc: SpaceRpc;
  target: ArtifactTarget;
  runId: string;
}) {
  const { t } = useLingui();
  const query = useQuery({
    queryKey: ["answer-breakdown", runId],
    queryFn: () => rpc.threads.answerBreakdown({ ...target, runId }),
    staleTime: 60_000,
    retry: false,
  });
  if (query.isPending) {
    return (
      <p className="text-label text-muted-foreground">
        <Trans>Loading where the time went…</Trans>
      </p>
    );
  }
  if (query.isError || !query.data) {
    return (
      <p className="text-label text-muted-foreground">
        <Trans>This answer's breakdown isn't available.</Trans>
      </p>
    );
  }
  const data = query.data;
  const labels: Record<string, string> = {
    model: t`Model`,
    tools: t`Tools`,
    review: t`Safety review`,
    waiting: t`Waiting for you`,
    queued: t`Waiting to start`,
    other: t`Rakazo`,
  };
  const parts = breakdownParts(data);
  const calls = data.modelCalls;
  const firstWord =
    data.firstTokenMs === null ? null : formatDuration(data.firstTokenMs, { precise: true });
  const reviewCalls = data.reviewCalls;
  const helperCalls = data.helperCalls;
  const details: Record<string, string | null> = {
    model: firstWord
      ? t`${calls} calls · first word after ${firstWord} on average`
      : t`${calls} calls`,
    review: t`${reviewCalls} calls`,
    tools: helperCalls ? t`includes ${helperCalls} helper calls` : null,
    other: t`preparing each call, saving progress`,
  };
  return (
    <div className="flex flex-col gap-2.5 text-label">
      <div className="flex items-baseline justify-between gap-2">
        <span className="font-medium text-foreground">
          <Trans>Answered in {formatDuration(data.totalMs)}</Trans>
        </span>
        {data.model ? (
          <span className="truncate text-caption text-muted-foreground" title={data.model}>
            {data.model}
          </span>
        ) : null}
      </div>
      {data.totalMs > 0 ? (
        <div className="flex h-2 w-full overflow-hidden rounded-full bg-muted" aria-hidden>
          {parts.map((part) => (
            <div
              key={part.key}
              className={PART_COLORS[part.key]}
              style={{ width: `${(100 * part.ms) / data.totalMs}%` }}
            />
          ))}
        </div>
      ) : null}
      <ul className="flex flex-col gap-1">
        {parts.map((part) => (
          <li key={part.key} className="flex flex-col gap-0.5">
            <Row
              color={PART_COLORS[part.key]}
              label={labels[part.key]}
              value={part.unknown ? t`not measured` : formatDuration(part.ms)}
              detail={details[part.key] ?? null}
            />
            {part.key === "tools" && data.tools.length ? (
              <ul className="ml-4 flex flex-col gap-0.5 text-caption text-muted-foreground">
                {data.tools.map((tool) => (
                  <li key={tool.name} className="flex justify-between gap-2">
                    <span className="truncate font-mono">
                      {tool.name}
                      {tool.count > 1 ? ` ×${tool.count}` : ""}
                    </span>
                    <span className="shrink-0 tabular-nums">{formatDuration(tool.ms)}</span>
                  </li>
                ))}
              </ul>
            ) : null}
          </li>
        ))}
      </ul>
      <TokenLine data={data} />
      <ContextMeter data={data} />
    </div>
  );
}

function Row({
  color,
  label,
  value,
  detail,
}: {
  color?: string;
  label: ReactNode;
  value: ReactNode;
  detail?: string | null;
}) {
  return (
    <div className="flex items-start justify-between gap-2">
      <span className="flex min-w-0 items-start gap-1.5">
        {color ? <span className={cn("mt-1.5 size-2 shrink-0 rounded-full", color)} /> : null}
        <span className="min-w-0">
          <span className="text-foreground">{label}</span>
          {detail ? (
            <span className="block text-caption text-muted-foreground">{detail}</span>
          ) : null}
        </span>
      </span>
      <span className="shrink-0 text-foreground tabular-nums">{value}</span>
    </div>
  );
}

function TokenLine({ data }: { data: AnswerBreakdown }) {
  const { input, cached, output } = data.tokens;
  if (input === null && output === null) return null;
  const inText = input === null ? "—" : formatTokens(input);
  const outText = output === null ? "—" : formatTokens(output);
  const reused = input && cached !== null ? Math.round((100 * cached) / input) : null;
  return (
    <p className="border-t pt-2 text-caption text-muted-foreground">
      {reused === null ? (
        <Trans>
          Tokens: {inText} read · {outText} written
        </Trans>
      ) : (
        <Trans>
          Tokens: {inText} read ({reused}% reused from cache) · {outText} written
        </Trans>
      )}
    </p>
  );
}

function ContextMeter({ data }: { data: AnswerBreakdown }) {
  const context = data.context;
  if (!context) return null;
  const used = formatTokens(context.usedTokens);
  const share = contextShare(context);
  if (share === null) {
    return (
      <p className="text-caption text-muted-foreground">
        <Trans>Context on the last call: {used}</Trans>
      </p>
    );
  }
  const windowText = formatTokens(context.windowTokens ?? 0);
  return (
    <div className="flex flex-col gap-1" data-testid="reply-time-context">
      <div className="flex justify-between gap-2 text-caption text-muted-foreground">
        <span>
          <Trans>Context on the last call</Trans>
        </span>
        <span className="tabular-nums">
          {used} / {windowText} · {share}%
        </span>
      </div>
      <div className="h-1.5 w-full overflow-hidden rounded-full bg-muted" aria-hidden>
        <div
          className={cn(
            "h-full rounded-full",
            share >= 85 ? "bg-destructive" : share >= 60 ? "bg-amber-500" : "bg-emerald-500",
          )}
          style={{ width: `${Math.min(100, share)}%` }}
        />
      </div>
    </div>
  );
}
