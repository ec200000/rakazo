import type { AnswerBreakdown, ThreadMessage } from "@rakazo/contracts";
import { isPeerReceiptBlocks } from "@rakazo/core";

export type ReplyTiming = {
  /** When the person's latest message before the answer arrived. */
  askedAt: number;
  firstReplyAt: number;
  lastReplyAt: number;
  /** The run that wrote the answer, when it came from one: its breakdown is fetched by it. */
  runId?: string;
};

function isBotReply(message: ThreadMessage) {
  return (
    message.role === "bot" &&
    !message.id.startsWith("progress:") &&
    !message.id.startsWith("subagent:") &&
    !isPeerReceiptBlocks(message.blocks)
  );
}

/**
 * How long each bot took to answer, keyed by its answer's last message. An answer is one run's
 * messages (or a bot's consecutive messages without a run); it is timed from the person's first
 * message since that bot last spoke. Answers nobody asked for, like routines, get no time, and
 * neither does an answer still being written.
 */
export function replyTimings(
  messages: ThreadMessage[],
  stillRunning: boolean,
): Map<string, ReplyTiming> {
  const answers: { key: string; botId: string; first: ThreadMessage; last: ThreadMessage }[] = [];
  const open = new Map<string, (typeof answers)[number]>();
  for (const message of messages) {
    if (message.role === "user") {
      open.clear();
      continue;
    }
    if (!isBotReply(message)) continue;
    const botId = message.botId ?? "";
    const key = message.runId ?? `bot:${botId}`;
    const current = open.get(key);
    if (current) current.last = message;
    else {
      const answer = { key, botId, first: message, last: message };
      answers.push(answer);
      open.set(key, answer);
    }
  }
  const timings = new Map<string, ReplyTiming>();
  const lastAnswer = answers.at(-1);
  for (const answer of answers) {
    if (stillRunning && answer === lastAnswer) continue;
    const firstAt = Date.parse(answer.first.createdAt);
    let askedAt: number | null = null;
    for (const message of messages) {
      const at = Date.parse(message.createdAt);
      if (at > firstAt || message === answer.first) break;
      if (message.role === "user") askedAt = at;
      else if (isBotReply(message) && (message.botId ?? "") === answer.botId) askedAt = null;
    }
    if (askedAt === null) continue;
    timings.set(answer.last.id, {
      askedAt,
      firstReplyAt: firstAt,
      lastReplyAt: Date.parse(answer.last.createdAt),
      ...(answer.first.runId ? { runId: answer.first.runId } : {}),
    });
  }
  return timings;
}

/** 4s, 1m 05s, 1h 02m; with `precise`, under ten seconds keeps a tenth (1.2s) or shows ms. */
export function formatDuration(ms: number, options: { precise?: boolean } = {}): string {
  if (options.precise && ms < 10_000) {
    if (ms < 1000) return `${Math.max(0, Math.round(ms))}ms`;
    return `${(Math.round(ms / 100) / 10).toFixed(1)}s`;
  }
  const seconds = Math.max(0, Math.round(ms / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${String(seconds % 60).padStart(2, "0")}s`;
  return `${Math.floor(minutes / 60)}h ${String(minutes % 60).padStart(2, "0")}m`;
}

/** 950, 12.4k, 128k, 1.2M. */
export function formatTokens(tokens: number): string {
  if (tokens < 1000) return String(Math.max(0, Math.round(tokens)));
  if (tokens < 100_000) return `${Math.round(tokens / 100) / 10}k`;
  if (tokens < 1_000_000) return `${Math.round(tokens / 1000)}k`;
  return `${Math.round(tokens / 100_000) / 10}M`;
}

export type BreakdownPartKey = "model" | "tools" | "review" | "waiting" | "queued" | "other";

/** The answer's time in display order, leaving out parts that took almost no time. */
export function breakdownParts(
  data: AnswerBreakdown,
): { key: BreakdownPartKey; ms: number; unknown: boolean }[] {
  const parts: { key: BreakdownPartKey; ms: number; unknown: boolean }[] = [
    { key: "model", ms: data.modelMs ?? 0, unknown: data.modelMs === null && data.modelCalls > 0 },
    { key: "tools", ms: data.toolsMs, unknown: false },
    { key: "review", ms: data.reviewMs ?? 0, unknown: false },
    { key: "waiting", ms: data.waitingMs, unknown: false },
    { key: "queued", ms: data.queuedMs, unknown: false },
    { key: "other", ms: data.otherMs, unknown: false },
  ];
  // Under half a second rounds to "0s", which only adds noise.
  return parts.filter(
    (part) => part.unknown || part.ms >= 500 || (part.key === "model" && data.modelCalls > 0),
  );
}

/** The share of the context window in use, as a whole percent; null without a known window. */
export function contextShare(context: NonNullable<AnswerBreakdown["context"]>): number | null {
  if (!context.windowTokens) return null;
  return Math.round((100 * context.usedTokens) / context.windowTokens);
}
