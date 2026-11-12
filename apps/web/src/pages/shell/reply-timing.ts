import type { ThreadMessage } from "@rakazo/contracts";
import { isPeerReceiptBlocks } from "@rakazo/core";

export type ReplyTiming = {
  /** When the person's latest message before the answer arrived. */
  askedAt: number;
  firstReplyAt: number;
  lastReplyAt: number;
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
    });
  }
  return timings;
}

/** 4s, 1m 05s, 1h 02m. */
export function formatDuration(ms: number): string {
  const seconds = Math.max(0, Math.round(ms / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${String(seconds % 60).padStart(2, "0")}s`;
  return `${Math.floor(minutes / 60)}h ${String(minutes % 60).padStart(2, "0")}m`;
}
