/**
 * Where one answer's time went, built from what the run already records: its start and wait
 * events, each tool's start and end, and each model call's usage row (its end time and
 * duration). Every stretch of time counts once, by precedence: waiting for the person, then
 * the bot's model calls, then review calls, then tools. What is left is Rakazo's own work.
 */
import type { AnswerBreakdown } from "@rakazo/contracts";
import type { PrismaClient } from "@rakazo/db";

export const ANSWER_BREAKDOWN_EVENT_TYPES = [
  "run.started",
  "run.waiting_input",
  "run.completed",
  "run.failed",
  "run.cancelled",
  "agent.tool.called",
  "agent.tool.completed",
] as const;

const MAX_TOOLS = 8;

export type BreakdownEvent = { type: string; at: number; payload: unknown };

export type BreakdownUsage = {
  at: number;
  model: string;
  operationKind: string;
  operationId: string | null;
  agentId: string | null;
  inputTokens: number | null;
  outputTokens: number | null;
  cacheReadTokens: number | null;
  cacheWriteTokens: number | null;
  cacheWrite1hTokens: number | null;
  reasoningTokens: number | null;
  durationMs: number | null;
  firstTokenMs: number | null;
  contextWindow: number | null;
};

type Interval = [number, number];

/** Sorted, non-overlapping intervals covering the same time. */
function union(intervals: Interval[]): Interval[] {
  const sorted = intervals.filter(([from, to]) => to > from).sort((a, b) => a[0] - b[0]);
  const merged: Interval[] = [];
  for (const [from, to] of sorted) {
    const last = merged.at(-1);
    if (last && from <= last[1]) last[1] = Math.max(last[1], to);
    else merged.push([from, to]);
  }
  return merged;
}

/** The parts of `intervals` outside every interval in `taken`. */
function subtract(intervals: Interval[], taken: Interval[]): Interval[] {
  const blocked = union(taken);
  const result: Interval[] = [];
  for (const [from, to] of union(intervals)) {
    let cursor = from;
    for (const [blockFrom, blockTo] of blocked) {
      if (blockTo <= cursor) continue;
      if (blockFrom >= to) break;
      if (blockFrom > cursor) result.push([cursor, blockFrom]);
      cursor = Math.max(cursor, blockTo);
      if (cursor >= to) break;
    }
    if (cursor < to) result.push([cursor, to]);
  }
  return result;
}

function length(intervals: Interval[]): number {
  return intervals.reduce((sum, [from, to]) => sum + (to - from), 0);
}

function clip(intervals: Interval[], from: number, to: number): Interval[] {
  return intervals
    .map(([a, b]): Interval => [Math.max(a, from), Math.min(b, to)])
    .filter(([a, b]) => b > a);
}

function field(payload: unknown, name: string): string | null {
  if (!payload || typeof payload !== "object") return null;
  const value = (payload as Record<string, unknown>)[name];
  return typeof value === "string" && value ? value : null;
}

function sum(values: (number | null)[]): number | null {
  const known = values.filter((value): value is number => typeof value === "number");
  return known.length ? known.reduce((total, value) => total + value, 0) : null;
}

function promptTokens(call: BreakdownUsage): number | null {
  return sum([
    call.inputTokens,
    call.cacheReadTokens,
    call.cacheWriteTokens,
    call.cacheWrite1hTokens,
  ]);
}

function isReview(call: BreakdownUsage) {
  return call.operationKind === "setup" || Boolean(call.operationId?.startsWith("auto-review:"));
}

function isHelper(call: BreakdownUsage) {
  return call.agentId !== null || call.operationKind === "subagent";
}

function callInterval(call: BreakdownUsage): Interval | null {
  return call.durationMs === null ? null : [call.at - call.durationMs, call.at];
}

export function computeAnswerBreakdown(input: {
  createdAt: number;
  completedAt: number | null;
  modelId: string | null;
  events: BreakdownEvent[];
  usage: BreakdownUsage[];
  now?: number;
}): AnswerBreakdown {
  const events = [...input.events].sort((a, b) => a.at - b.at);
  const start = input.createdAt;
  const end = Math.max(start, input.completedAt ?? events.at(-1)?.at ?? input.now ?? Date.now());
  const starts = events.filter((event) => event.type === "run.started").map((event) => event.at);
  const firstStart = starts[0] ?? end;
  const queuedMs = Math.max(0, Math.min(firstStart, end) - start);

  const waiting: Interval[] = [];
  for (const event of events) {
    if (event.type !== "run.waiting_input") continue;
    const resumed = starts.find((at) => at >= event.at) ?? end;
    waiting.push([event.at, resumed]);
  }

  const toolStarts = new Map<string, { name: string; at: number }>();
  const toolRuns: { name: string; interval: Interval }[] = [];
  for (const event of events) {
    const executionId = field(event.payload, "executionId");
    if (!executionId) continue;
    if (event.type === "agent.tool.called") {
      toolStarts.set(executionId, { name: field(event.payload, "name") ?? "tool", at: event.at });
    } else if (event.type === "agent.tool.completed") {
      const started = toolStarts.get(executionId);
      if (!started) continue;
      toolStarts.delete(executionId);
      toolRuns.push({ name: started.name, interval: [started.at, event.at] });
    }
  }
  // A tool still running when the run paused or ended counts until then.
  for (const started of toolStarts.values()) {
    const stop = waiting.find(([from]) => from >= started.at)?.[0] ?? end;
    toolRuns.push({ name: started.name, interval: [started.at, stop] });
  }

  const usage = [...input.usage].sort((a, b) => a.at - b.at);
  const helpers = usage.filter(isHelper);
  const reviews = usage.filter((call) => !isHelper(call) && isReview(call));
  const calls = usage.filter((call) => !isHelper(call) && !isReview(call));

  const span = (intervals: Interval[]) => clip(union(intervals), start, end);
  const waitingSpan = span(waiting);
  const callIntervals = calls.map(callInterval).filter((value) => value !== null);
  const reviewIntervals = reviews.map(callInterval).filter((value) => value !== null);
  const modelSpan = subtract(span(callIntervals), waitingSpan);
  const reviewSpan = subtract(span(reviewIntervals), [...waitingSpan, ...modelSpan]);
  const toolTaken = [...waitingSpan, ...modelSpan, ...reviewSpan];
  const toolSpan = subtract(span(toolRuns.map((run) => run.interval)), toolTaken);

  const waitingMs = length(waitingSpan);
  const modelMs = callIntervals.length ? length(modelSpan) : null;
  const reviewMs = reviewIntervals.length ? length(reviewSpan) : null;
  const toolsMs = length(toolSpan);
  const totalMs = end - start;
  const otherMs = Math.max(
    0,
    totalMs - queuedMs - waitingMs - (modelMs ?? 0) - (reviewMs ?? 0) - toolsMs,
  );

  const byTool = new Map<string, { count: number; ms: number }>();
  for (const run of toolRuns) {
    const entry = byTool.get(run.name) ?? { count: 0, ms: 0 };
    entry.count += 1;
    entry.ms += length(subtract(clip([run.interval], start, end), toolTaken));
    byTool.set(run.name, entry);
  }
  const tools = [...byTool.entries()]
    .map(([name, entry]) => ({ name, count: entry.count, ms: Math.round(entry.ms) }))
    .sort((a, b) => b.ms - a.ms || b.count - a.count)
    .slice(0, MAX_TOOLS);

  const firstTokens = calls
    .map((call) => call.firstTokenMs)
    .filter((value): value is number => typeof value === "number");
  const last = calls.at(-1);
  const lastPrompt = last ? promptTokens(last) : null;

  return {
    totalMs: Math.round(totalMs),
    queuedMs: Math.round(queuedMs),
    waitingMs: Math.round(waitingMs),
    modelMs: modelMs === null ? null : Math.round(modelMs),
    toolsMs: Math.round(toolsMs),
    otherMs: Math.round(otherMs),
    model: last?.model ?? input.modelId,
    modelCalls: calls.length,
    firstTokenMs: firstTokens.length
      ? Math.round(firstTokens.reduce((total, value) => total + value, 0) / firstTokens.length)
      : null,
    reviewCalls: reviews.length,
    reviewMs: reviewMs === null ? null : Math.round(reviewMs),
    helperCalls: helpers.length,
    tokens: {
      input: sum(calls.map(promptTokens)),
      cached: sum(calls.map((call) => call.cacheReadTokens)),
      output: sum(calls.map((call) => call.outputTokens)),
      reasoning: sum(calls.map((call) => call.reasoningTokens)),
    },
    tools,
    context:
      lastPrompt === null
        ? null
        : {
            usedTokens: lastPrompt,
            windowTokens: last?.contextWindow && last.contextWindow > 0 ? last.contextWindow : null,
          },
  };
}

/** Loads a run of this thread and its breakdown, or null when the thread has no such run. */
export async function loadAnswerBreakdown(
  prisma: PrismaClient,
  scope: { spaceId: string; threadId: string; runId: string },
): Promise<AnswerBreakdown | null> {
  const run = await prisma.run.findFirst({
    where: { id: scope.runId, spaceId: scope.spaceId, threadId: scope.threadId },
    select: { createdAt: true, completedAt: true, modelId: true },
  });
  if (!run) return null;
  const [events, usage] = await Promise.all([
    prisma.event.findMany({
      where: {
        spaceId: scope.spaceId,
        runId: scope.runId,
        type: { in: [...ANSWER_BREAKDOWN_EVENT_TYPES] },
      },
      orderBy: { seq: "asc" },
      select: { type: true, payload: true, createdAt: true },
    }),
    prisma.usageRecord.findMany({
      where: { spaceId: scope.spaceId, runId: scope.runId },
      orderBy: { createdAt: "asc" },
      select: {
        createdAt: true,
        model: true,
        operationKind: true,
        operationId: true,
        agentId: true,
        inputTokens: true,
        outputTokens: true,
        cacheReadTokens: true,
        cacheWriteTokens: true,
        cacheWrite1hTokens: true,
        reasoningTokens: true,
        durationMs: true,
        firstTokenMs: true,
        contextWindow: true,
      },
    }),
  ]);
  return computeAnswerBreakdown({
    createdAt: run.createdAt.getTime(),
    completedAt: run.completedAt?.getTime() ?? null,
    modelId: run.modelId,
    events: events.map((event) => ({
      type: event.type,
      at: event.createdAt.getTime(),
      payload: event.payload,
    })),
    usage: usage.map(({ createdAt, ...call }) => ({ ...call, at: createdAt.getTime() })),
  });
}
