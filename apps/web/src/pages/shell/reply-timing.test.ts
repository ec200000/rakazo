import type { ThreadMessage } from "@rakazo/contracts";
import { describe, expect, it } from "vitest";
import {
  breakdownParts,
  contextShare,
  formatDuration,
  formatTokens,
  replyTimings,
} from "./reply-timing";

let seq = 0;
function msg(role: ThreadMessage["role"], second: number, extra: Partial<ThreadMessage> = {}) {
  seq += 1;
  return {
    id: `m${seq}`,
    threadId: "t",
    seq,
    role,
    blocks: [{ kind: "text", text: "x" }],
    createdAt: new Date(Date.UTC(2026, 0, 1, 10, 0, second)).toISOString(),
    ...(role === "bot" ? { botId: "b1" } : {}),
    ...extra,
  } as ThreadMessage;
}

describe("reply timings", () => {
  it("times an answer from the person's latest message to its last message", () => {
    const ask1 = msg("user", 0);
    const ask2 = msg("user", 2);
    const a = msg("bot", 5, { runId: "r1" });
    const b = msg("bot", 14, { runId: "r1" });
    const timings = replyTimings([ask1, ask2, a, b], false);
    expect(timings.has(a.id)).toBe(false);
    expect(timings.get(b.id)).toEqual({
      askedAt: Date.parse(ask2.createdAt),
      firstReplyAt: Date.parse(a.createdAt),
      lastReplyAt: Date.parse(b.createdAt),
      runId: "r1",
    });
  });

  it("skips the answer still being written and answers nobody asked for", () => {
    const routine = msg("bot", 0, { runId: "r0" });
    const ask = msg("user", 10);
    const reply = msg("bot", 12, { runId: "r1" });
    expect([...replyTimings([routine, ask, reply], false).keys()]).toEqual([reply.id]);
    expect(replyTimings([routine, ask, reply], true).size).toBe(0);
  });

  it("times each bot in a group from the same question", () => {
    const ask = msg("user", 0);
    const one = msg("bot", 3, { runId: "r1", botId: "b1" });
    const two = msg("bot", 8, { runId: "r2", botId: "b2" });
    const timings = replyTimings([ask, one, two], false);
    expect(timings.get(one.id)?.askedAt).toBe(Date.parse(ask.createdAt));
    expect(timings.get(two.id)?.askedAt).toBe(Date.parse(ask.createdAt));
  });

  it("formats durations", () => {
    expect(formatDuration(4_200)).toBe("4s");
    expect(formatDuration(65_000)).toBe("1m 05s");
    expect(formatDuration(3_720_000)).toBe("1h 02m");
  });

  it("formats short durations precisely and token counts compactly", () => {
    expect(formatDuration(450, { precise: true })).toBe("450ms");
    expect(formatDuration(1_240, { precise: true })).toBe("1.2s");
    expect(formatDuration(12_400, { precise: true })).toBe("12s");
    expect(formatTokens(950)).toBe("950");
    expect(formatTokens(12_400)).toBe("12.4k");
    expect(formatTokens(128_000)).toBe("128k");
    expect(formatTokens(1_250_000)).toBe("1.3M");
  });

  it("lists the parts that took time and the context share", () => {
    const data = {
      totalMs: 10_000,
      queuedMs: 0,
      waitingMs: 0,
      modelMs: null,
      toolsMs: 3_000,
      otherMs: 7_000,
      model: "m",
      modelCalls: 2,
      firstTokenMs: null,
      reviewCalls: 0,
      reviewMs: null,
      helperCalls: 0,
      tokens: { input: null, cached: null, output: null, reasoning: null },
      tools: [],
      context: { usedTokens: 32_000, windowTokens: 128_000 },
    };
    expect(breakdownParts(data).map((part) => [part.key, part.unknown])).toEqual([
      ["model", true],
      ["tools", false],
      ["other", false],
    ]);
    expect(contextShare(data.context)).toBe(25);
    expect(contextShare({ usedTokens: 5, windowTokens: null })).toBeNull();
  });
});
