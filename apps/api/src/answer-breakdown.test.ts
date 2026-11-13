import { describe, expect, it } from "vitest";
import type { BreakdownUsage } from "./answer-breakdown.js";
import { computeAnswerBreakdown } from "./answer-breakdown.js";

const call = (overrides: Partial<BreakdownUsage> & { at: number }): BreakdownUsage => ({
  model: "llama-70b",
  operationKind: "answer",
  operationId: null,
  agentId: null,
  inputTokens: 1000,
  outputTokens: 100,
  cacheReadTokens: null,
  cacheWriteTokens: null,
  cacheWrite1hTokens: null,
  reasoningTokens: null,
  durationMs: null,
  firstTokenMs: null,
  contextWindow: null,
  ...overrides,
});

describe("computeAnswerBreakdown", () => {
  it("splits an answer into queue, model, tools, waiting and the rest", () => {
    const breakdown = computeAnswerBreakdown({
      createdAt: 0,
      completedAt: 30_000,
      modelId: "llama-70b",
      events: [
        { type: "run.started", at: 500, payload: {} },
        // shell: 4s, then an approval wait of 10s, then cluster_change for 2s.
        { type: "agent.tool.called", at: 3_000, payload: { name: "shell", executionId: "a" } },
        { type: "agent.tool.completed", at: 7_000, payload: { name: "shell", executionId: "a" } },
        {
          type: "agent.tool.called",
          at: 10_000,
          payload: { name: "cluster_change", executionId: "b" },
        },
        { type: "run.waiting_input", at: 10_100, payload: {} },
        { type: "run.started", at: 20_100, payload: {} },
        {
          type: "agent.tool.completed",
          at: 22_100,
          payload: { name: "cluster_change", executionId: "b" },
        },
        { type: "run.completed", at: 30_000, payload: {} },
      ],
      usage: [
        call({ at: 3_000, durationMs: 2_000, firstTokenMs: 800, cacheReadTokens: 0 }),
        call({ at: 10_000, durationMs: 2_500, firstTokenMs: 1_200, cacheReadTokens: 900 }),
        call({
          at: 29_000,
          durationMs: 6_000,
          firstTokenMs: 1_000,
          inputTokens: 2_000,
          cacheReadTokens: 30_000,
          contextWindow: 128_000,
          reasoningTokens: 40,
        }),
        call({ at: 20_500, durationMs: 300, operationKind: "setup", operationId: "auto-review:r" }),
        call({ at: 6_000, durationMs: 900, agentId: "helper-1" }),
      ],
    });
    expect(breakdown.totalMs).toBe(30_000);
    expect(breakdown.queuedMs).toBe(500);
    expect(breakdown.waitingMs).toBe(10_000);
    expect(breakdown.modelMs).toBe(10_500);
    expect(breakdown.reviewMs).toBe(300);
    expect(breakdown.reviewCalls).toBe(1);
    expect(breakdown.helperCalls).toBe(1);
    // shell 4s; cluster_change 10_000-10_100 and 20_100-22_100 less the 300ms review.
    expect(breakdown.toolsMs).toBe(4_000 + 100 + 1_700);
    expect(breakdown.tools).toEqual([
      { name: "shell", count: 1, ms: 4_000 },
      { name: "cluster_change", count: 1, ms: 1_800 },
    ]);
    expect(breakdown.otherMs).toBe(30_000 - 500 - 10_000 - 10_500 - 300 - 5_800);
    expect(breakdown.modelCalls).toBe(3);
    expect(breakdown.firstTokenMs).toBe(1_000);
    expect(breakdown.tokens).toEqual({
      input: 1_000 + 1_900 + 32_000,
      cached: 30_900,
      output: 300,
      reasoning: 40,
    });
    expect(breakdown.context).toEqual({ usedTokens: 32_000, windowTokens: 128_000 });
  });

  it("leaves model time unknown for calls recorded before timing existed", () => {
    const breakdown = computeAnswerBreakdown({
      createdAt: 0,
      completedAt: 5_000,
      modelId: "m",
      events: [{ type: "run.started", at: 0, payload: {} }],
      usage: [call({ at: 4_000 })],
    });
    expect(breakdown.modelMs).toBeNull();
    expect(breakdown.otherMs).toBe(5_000);
    expect(breakdown.context).toEqual({ usedTokens: 1_000, windowTokens: null });
  });

  it("counts a tool that never finished until the run paused", () => {
    const breakdown = computeAnswerBreakdown({
      createdAt: 0,
      completedAt: 9_000,
      modelId: null,
      events: [
        { type: "run.started", at: 0, payload: {} },
        { type: "agent.tool.called", at: 1_000, payload: { name: "ask_user", executionId: "q" } },
        { type: "run.waiting_input", at: 1_500, payload: {} },
        { type: "run.started", at: 8_000, payload: {} },
      ],
      usage: [],
    });
    expect(breakdown.waitingMs).toBe(6_500);
    expect(breakdown.toolsMs).toBe(500);
    expect(breakdown.model).toBeNull();
    expect(breakdown.context).toBeNull();
  });
});
