import { Trans, useLingui } from "@lingui/react/macro";
import { Timer } from "lucide-react";
import { useState } from "react";
import type { ReplyTiming } from "./reply-timing";
import { formatDuration } from "./reply-timing";

/** A small toggle under a bot's answer: how long it took, and when it first replied. */
export function ReplyTime({ timing }: { timing: ReplyTiming }) {
  const { t } = useLingui();
  const [open, setOpen] = useState(false);
  const total = formatDuration(timing.lastReplyAt - timing.askedAt);
  const first = formatDuration(timing.firstReplyAt - timing.askedAt);
  const several = timing.lastReplyAt - timing.firstReplyAt >= 1000;
  return (
    <button
      type="button"
      data-testid="reply-time"
      aria-expanded={open}
      aria-label={t`Answered in ${total}`}
      onClick={() => setOpen((value) => !value)}
      className="mt-1 inline-flex items-center gap-1 rounded-full px-1.5 py-0.5 text-caption text-muted-foreground/80 hover:bg-muted hover:text-muted-foreground"
    >
      <Timer aria-hidden className="size-3" strokeWidth={1.8} />
      {open ? (
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
}
