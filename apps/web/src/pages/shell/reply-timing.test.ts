import type { ThreadMessage } from "@rakazo/contracts";
import { describe, expect, it } from "vitest";
import { formatDuration, replyTimings } from "./reply-timing";

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
});
