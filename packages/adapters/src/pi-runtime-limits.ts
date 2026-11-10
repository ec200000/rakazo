import type { Api, Model } from "@earendil-works/pi-ai";
import { DEFAULT_MODEL_MAX_TOKENS } from "@rakazo/contracts";
import { LOCAL_PROVIDER_ID } from "./pi-local-provider-id.js";

/** Per-attempt wait for response headers; this does not cap active streaming duration. */
export const MODEL_STREAM_TIMEOUT_MS = 120_000;
/** Bound connection establishment independently of response streaming. */
export const MODEL_CONNECT_TIMEOUT_MS = 30_000;
/**
 * `timeoutMs` bounds only time-to-headers; the SSE body that follows is
 * unbounded. Bound silence for every provider so a stalled stream can fail
 * and advance the configured fallback chain.
 */
export const MODEL_STREAM_IDLE_TIMEOUT_MS = 180_000;
export const DEFAULT_MODEL_STREAM_MAX_RETRIES = 1;

/** More retries extend the worst-case turn; the executor heartbeat renews its leases. */
export function modelStreamMaxRetries(): number {
  const value = process.env.MODEL_STREAM_MAX_RETRIES?.trim();
  const raw = Number(value || DEFAULT_MODEL_STREAM_MAX_RETRIES);
  return Number.isInteger(raw) && raw >= 0 && raw <= 5 ? raw : DEFAULT_MODEL_STREAM_MAX_RETRIES;
}

/**
 * Parse a configurable timeout in whole milliseconds. Invalid or blank values
 * retain the existing default. Node timers support delays up to 2^31 - 1 ms.
 * Provider HTTP transports may impose additional independent limits.
 */
function timeoutMsFromEnv(
  value: string | undefined,
  fallback: number,
  min: number = 1_000,
  max: number = 300_000,
): number {
  const raw = Number(value?.trim() || fallback);
  return Number.isInteger(raw) && raw >= min && raw <= max ? raw : fallback;
}

export function modelStreamTimeoutMs(): number {
  return timeoutMsFromEnv(
    process.env.MODEL_STREAM_TIMEOUT_MS,
    MODEL_STREAM_TIMEOUT_MS,
    1_000,
    2_147_483_647,
  );
}

export function modelConnectTimeoutMs(): number {
  return timeoutMsFromEnv(process.env.MODEL_CONNECT_TIMEOUT_MS, MODEL_CONNECT_TIMEOUT_MS);
}

export function modelStreamIdleTimeoutMs(): number {
  return timeoutMsFromEnv(
    process.env.MODEL_STREAM_IDLE_TIMEOUT_MS,
    MODEL_STREAM_IDLE_TIMEOUT_MS,
    0,
    2_147_483_647,
  );
}

/** Waits before the first same-model retries of a transient failure; later ones keep doubling. */
const MODEL_RETRY_DELAYS_MS = [2_000, 8_000, 20_000] as const;
const DEFAULT_MODEL_RETRY_ATTEMPTS = MODEL_RETRY_DELAYS_MS.length;
const DEFAULT_MODEL_RETRY_MAX_DELAY_MS = 20_000;
export const DEFAULT_MODEL_REPLY_RECOVERIES = 3;

export type ModelRetryPolicy = {
  /** Same-model retries of one call after a transient failure before any reply text. */
  attempts: number;
  /** Time those retries may take, from the call's first attempt; Infinity for no limit. */
  windowMs: number;
  /** Longest wait between two retries. */
  maxDelayMs: number;
  /** Retries after a stalled stream: once by default, otherwise as many as `attempts`. */
  idleAttempts: number;
};

function wholeNumberFromEnv(value: string | undefined, fallback: number, max: number): number {
  const raw = Number(value?.trim() || fallback);
  return Number.isInteger(raw) && raw >= 0 && raw <= max ? raw : fallback;
}

/**
 * How hard one model call retries a dropped connection, timeout, overload or stalled stream.
 * The defaults are the built-in schedule; a slow local model server can raise them so a run
 * waits for an answer instead of failing. MODEL_RETRY_WINDOW_MS=0 removes the time limit.
 */
export function modelRetryPolicy(): ModelRetryPolicy {
  const attempts = wholeNumberFromEnv(
    process.env.MODEL_RETRY_ATTEMPTS,
    DEFAULT_MODEL_RETRY_ATTEMPTS,
    10_000,
  );
  const window = process.env.MODEL_RETRY_WINDOW_MS?.trim();
  const windowMs = !window
    ? modelStreamTimeoutMs()
    : window === "0"
      ? Number.POSITIVE_INFINITY
      : timeoutMsFromEnv(window, modelStreamTimeoutMs(), 1_000, 2_147_483_647);
  return {
    attempts,
    windowMs,
    maxDelayMs: timeoutMsFromEnv(
      process.env.MODEL_RETRY_MAX_DELAY_MS,
      DEFAULT_MODEL_RETRY_MAX_DELAY_MS,
      1_000,
      3_600_000,
    ),
    idleAttempts: attempts > DEFAULT_MODEL_RETRY_ATTEMPTS ? attempts : 1,
  };
}

/** The wait before retry number `retry` (0-based), or undefined once the policy allows no more. */
export function modelRetryDelayMs(retry: number, policy: ModelRetryPolicy): number | undefined {
  if (retry >= policy.attempts) return undefined;
  const scheduled =
    MODEL_RETRY_DELAYS_MS[retry] ??
    MODEL_RETRY_DELAYS_MS.at(-1)! * 2 ** (retry - MODEL_RETRY_DELAYS_MS.length + 1);
  return Math.min(scheduled, policy.maxDelayMs);
}

/** Times per run a reply cut short (dropped connection, output limit) is repeated or continued. */
export function modelReplyRecoveries(): number {
  return wholeNumberFromEnv(
    process.env.MODEL_REPLY_RECOVERIES,
    DEFAULT_MODEL_REPLY_RECOVERIES,
    1_000,
  );
}

export const TOOL_RESULT_TEXT_LIMIT = 12_000;

export function clipToolResultText(text: string, limit: number = TOOL_RESULT_TEXT_LIMIT): string {
  return text.length > limit ? `${text.slice(0, limit)}…` : text;
}

/**
 * Share one remaining character budget across all text parts.
 * Later text is omitted once the aggregate limit is exhausted; non-text parts stay.
 */
export function clipToolResultContent<T>(
  content: T[],
  limit: number = TOOL_RESULT_TEXT_LIMIT,
): T[] {
  let remaining = limit;
  const clipped: T[] = [];
  for (const part of content) {
    if (
      !part ||
      typeof part !== "object" ||
      !("type" in part) ||
      (part as { type?: unknown }).type !== "text" ||
      !("text" in part)
    ) {
      clipped.push(part);
      continue;
    }
    if (remaining <= 0) continue;
    const text = String((part as { text: unknown }).text);
    if (text.length <= remaining) {
      clipped.push(part);
      remaining -= text.length;
      continue;
    }
    clipped.push({ ...part, text: clipToolResultText(text, remaining) });
    remaining = 0;
  }
  return clipped;
}

/**
 * Prompt tokens providers bill, including cache read/write rather than the uncached remainder.
 * The cache halves are reported alongside so downstream views can show what a cache hit saved.
 */
export function billedPromptTokens(usage: {
  input?: number;
  output?: number;
  cacheRead?: number;
  cacheWrite?: number;
}): {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
} {
  const cacheReadTokens = nonNegativeCount(usage.cacheRead);
  const cacheWriteTokens = nonNegativeCount(usage.cacheWrite);
  return {
    inputTokens: nonNegativeCount(usage.input) + cacheReadTokens + cacheWriteTokens,
    outputTokens: nonNegativeCount(usage.output),
    cacheReadTokens,
    cacheWriteTokens,
  };
}

/**
 * A reasoning model spends this same budget on its thinking, so the modest default
 * can be consumed before the reply starts. Wide enough for thinking plus an answer,
 * still far below a model card's 128k ceiling.
 */
export const REASONING_MODEL_MAX_TOKENS = 32_768;

/** Leave at least three quarters of the window for input; token limits are positive integers. */
export function effectiveOutputReserve(contextWindow: number, maxTokens: number): number {
  return Math.min(maxTokens, Math.max(1, Math.floor(contextWindow / 4)));
}

/**
 * The output cap the operator chose for a model that has no per-connection field: the local
 * model server's own limit, when RAKAZO_LOCAL_MAX_TOKENS is set. Unset, and for other providers,
 * the defaults apply.
 */
export function operatorMaxTokens(
  model: Pick<Model<Api>, "provider" | "maxTokens">,
): number | undefined {
  return model.provider === LOCAL_PROVIDER_ID && process.env.RAKAZO_LOCAL_MAX_TOKENS?.trim()
    ? model.maxTokens
    : undefined;
}

/**
 * Completions default to a modest output cap so OpenRouter-style providers do not
 * hold credit for a model card's 128k ceiling. A configured maxTokens overrides this
 * default, still bounded to a quarter of the context window when it is supplied.
 * Reasoning models get the wider default because their thinking is billed against
 * the same ceiling: at 4k a hard question can leave no room for the reply at all.
 * An operator-set limit (operatorMaxTokens) replaces both defaults.
 */
export function resolveCompletionMaxTokens(
  modelMaxTokens?: number,
  configuredMaxTokens?: number,
  optionsMaxTokens?: number,
  reasoning?: boolean,
  contextWindow?: number,
  operatorDefault?: number,
): number {
  const userCap =
    typeof configuredMaxTokens === "number" && configuredMaxTokens >= 1
      ? configuredMaxTokens
      : operatorDefault !== undefined && operatorDefault >= 1
        ? operatorDefault
        : reasoning
          ? REASONING_MODEL_MAX_TOKENS
          : DEFAULT_MODEL_MAX_TOKENS;
  const optionCap =
    typeof optionsMaxTokens === "number" && optionsMaxTokens >= 1
      ? Math.min(optionsMaxTokens, userCap)
      : userCap;
  const maxTokens =
    typeof modelMaxTokens === "number" && modelMaxTokens >= 1
      ? Math.min(modelMaxTokens, optionCap)
      : optionCap;
  return contextWindow === undefined ? maxTokens : effectiveOutputReserve(contextWindow, maxTokens);
}

function nonNegativeCount(value: number | undefined): number {
  return typeof value === "number" && Number.isFinite(value) ? Math.max(0, value) : 0;
}
