import type { ModelApiProtocol, ModelConnectionTestResult } from "@rakazo/contracts";
import type { OpenAiCompatibleUrlPolicy } from "./openai-compatible-url.js";
import {
  assertAllowedOpenAiCompatibleUrl,
  assertHttpsForKeyedOpenAiCompatibleUrl,
} from "./openai-compatible-url.js";
import {
  ANTHROPIC_MESSAGES_VERSION,
  createOpenAiCompatibleFetch,
} from "./pi-openai-compatible-provider.js";

type Step = ModelConnectionTestResult["steps"][number];

export type OpenAiCompatibleConnectionTestInput = {
  baseUrl: string;
  apiKey?: string;
  headers?: Record<string, string>;
  apiProtocol?: ModelApiProtocol;
  modelId?: string;
};

export type OpenAiCompatibleConnectionTestOptions = OpenAiCompatibleUrlPolicy & {
  fetch?: typeof globalThis.fetch;
  signal?: AbortSignal;
  modelsTimeoutMs?: number;
  /** A slow local model can take a while to load before its first reply. */
  chatTimeoutMs?: number;
};

const MODELS_TIMEOUT_MS = 15_000;
const CHAT_TIMEOUT_MS = 180_000;
const PROMPT = "Reply with the single word OK.";
const MAX_ERROR_BODY_BYTES = 8_192;
const MAX_REPLY_CHARS = 200;
const LISTED_MODELS_SHOWN = 10;

const CERTIFICATE_CODES = new Set([
  "SELF_SIGNED_CERT_IN_CHAIN",
  "DEPTH_ZERO_SELF_SIGNED_CERT",
  "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
  "UNABLE_TO_GET_ISSUER_CERT",
  "UNABLE_TO_GET_ISSUER_CERT_LOCALLY",
  "CERT_HAS_EXPIRED",
  "CERT_NOT_YET_VALID",
  "CERT_UNTRUSTED",
  "ERR_TLS_CERT_ALTNAME_INVALID",
]);

/**
 * Checks a compatible model server the way a run uses it: lists its models, then asks the
 * chosen model for a one-word reply. Each step reports what failed in terms a person can act on
 * (unknown host, refused connection, untrusted certificate, rejected key, unknown model, timeout).
 */
export async function testOpenAiCompatibleConnection(
  input: OpenAiCompatibleConnectionTestInput,
  options: OpenAiCompatibleConnectionTestOptions = {},
): Promise<ModelConnectionTestResult> {
  const steps: Step[] = [];
  let base: URL;
  try {
    base = assertAllowedOpenAiCompatibleUrl(input.baseUrl, options);
    assertHttpsForKeyedOpenAiCompatibleUrl(
      base,
      input.apiKey,
      Object.keys(input.headers ?? {}).length > 0,
    );
  } catch (error) {
    steps.push({ step: "models", ok: false, durationMs: 0, message: policyMessage(error) });
    return { ok: false, steps };
  }

  const protocol = input.apiProtocol ?? "chat-completions";
  const auth = authHeaders(protocol, input.apiKey);
  const safeFetch = createOpenAiCompatibleFetch(options.fetch, undefined, {
    allowPublic: options.allowPublic,
    allowPrivate: options.allowPrivate,
    headers: input.headers,
  });
  const modelId = input.modelId?.trim() || undefined;
  const host = base.host;

  const models = await timed(async () => {
    const timeoutMs = options.modelsTimeoutMs ?? MODELS_TIMEOUT_MS;
    const { response, json } = await send(
      safeFetch,
      endpoint(base, "models"),
      { headers: { Accept: "application/json", ...auth } },
      timeoutMs,
      options.signal,
      "models",
    );
    if (!response.ok) return { ok: false, message: await statusMessage(response, "models") };
    const ids = modelIds(await json());
    if (!ids) return { ok: false, message: "The server's /models answer is not a model list." };
    if (modelId && !ids.includes(modelId)) {
      const shown = ids.slice(0, LISTED_MODELS_SHOWN).join(", ");
      const more = ids.length > LISTED_MODELS_SHOWN ? ", …" : "";
      return {
        ok: false,
        message: ids.length
          ? `The server lists ${ids.length} model${ids.length === 1 ? "" : "s"}, but not "${modelId}": ${shown}${more}.`
          : `The server lists no models, so "${modelId}" may not exist.`,
      };
    }
    return {
      ok: true,
      message: `The server lists ${ids.length} model${ids.length === 1 ? "" : "s"}.`,
    };
  }, host);
  steps.push({ step: "models", ...models.step });

  let reply: string | undefined;
  if (!modelId) {
    steps.push({
      step: "chat",
      ok: false,
      skipped: true,
      durationMs: 0,
      message: "Choose a model to test a reply.",
    });
  } else if (models.unreachable) {
    steps.push({
      step: "chat",
      ok: false,
      skipped: true,
      durationMs: 0,
      message: "Skipped: the server cannot be reached.",
    });
  } else {
    const chatTimeoutMs = options.chatTimeoutMs ?? CHAT_TIMEOUT_MS;
    const chat = await timed(async () => {
      const { response, json } = await send(
        safeFetch,
        endpoint(base, chatPath(protocol)),
        {
          method: "POST",
          headers: { "Content-Type": "application/json", Accept: "application/json", ...auth },
          body: JSON.stringify(chatBody(protocol, modelId)),
        },
        chatTimeoutMs,
        options.signal,
        "chat",
      );
      if (!response.ok) return { ok: false, message: await statusMessage(response, "chat") };
      const text = replyText(protocol, await json());
      if (text === undefined) return { ok: false, message: "The model's answer has no reply." };
      reply = clip(text.trim(), MAX_REPLY_CHARS);
      return { ok: true, message: `"${modelId}" replied.` };
    }, host);
    steps.push({ step: "chat", ...chat.step });
  }

  const chatStep = steps.find((step) => step.step === "chat");
  const ok = chatStep && !chatStep.skipped ? chatStep.ok : steps[0]!.ok && !modelId;
  return { ok, steps, ...(reply !== undefined ? { reply } : {}) };
}

async function timed(
  run: () => Promise<{ ok: boolean; message: string }>,
  host: string,
): Promise<{ step: Omit<Step, "step">; unreachable: boolean }> {
  const started = Date.now();
  try {
    const result = await run();
    return { step: { ...result, durationMs: Date.now() - started }, unreachable: false };
  } catch (error) {
    if (error instanceof CallerAbort) throw error.cause;
    const failure = networkMessage(error, host);
    return {
      step: { ok: false, durationMs: Date.now() - started, message: failure.message },
      unreachable: failure.unreachable,
    };
  }
}

class CallerAbort extends Error {}
class StepTimeout extends Error {
  constructor(
    readonly timeoutMs: number,
    readonly step: "models" | "chat",
  ) {
    super("timeout");
  }
}

/** The timeout covers the whole answer: a server can send headers and then stall. */
async function send(
  safeFetch: typeof globalThis.fetch,
  url: string,
  init: RequestInit,
  timeoutMs: number,
  signal: AbortSignal | undefined,
  step: "models" | "chat",
): Promise<{ response: Response; json: () => Promise<unknown> }> {
  const timeout = AbortSignal.timeout(timeoutMs);
  const failed = (error: unknown): never => {
    if (signal?.aborted) throw new CallerAbort("aborted", { cause: error });
    if (timeout.aborted) throw new StepTimeout(timeoutMs, step);
    throw error;
  };
  const response = await safeFetch(url, {
    ...init,
    redirect: "error",
    signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
  }).catch(failed);
  return {
    response,
    json: () =>
      response
        .text()
        .then(parseBody)
        .catch((error: unknown) => {
          if (signal?.aborted || timeout.aborted) failed(error);
          return null;
        }),
  };
}

function endpoint(base: URL, path: string): string {
  return new URL(path, `${base.href}/`).href;
}

function authHeaders(
  protocol: ModelApiProtocol,
  apiKey: string | undefined,
): Record<string, string> {
  const key = apiKey?.trim();
  if (protocol === "anthropic-messages") {
    return {
      "anthropic-version": ANTHROPIC_MESSAGES_VERSION,
      ...(key ? { "x-api-key": key } : {}),
    };
  }
  return key ? { Authorization: `Bearer ${key}` } : {};
}

function chatPath(protocol: ModelApiProtocol): string {
  if (protocol === "responses") return "responses";
  if (protocol === "anthropic-messages") return "messages";
  return "chat/completions";
}

function chatBody(protocol: ModelApiProtocol, model: string) {
  if (protocol === "responses") return { model, input: PROMPT, max_output_tokens: 32 };
  return {
    model,
    max_tokens: 32,
    messages: [{ role: "user", content: PROMPT }],
    ...(protocol === "anthropic-messages" ? {} : { stream: false }),
  };
}

type Json = Record<string, unknown> | null;

function modelIds(body: unknown): string[] | undefined {
  const record = (body ?? {}) as Record<string, unknown>;
  const entries = Array.isArray(record.data)
    ? record.data
    : Array.isArray(record.models)
      ? record.models
      : undefined;
  if (!entries) return undefined;
  return entries
    .map((entry) =>
      typeof entry === "string"
        ? entry
        : String((entry as Json)?.id ?? (entry as Json)?.name ?? (entry as Json)?.model ?? ""),
    )
    .filter(Boolean);
}

/** JSON, or the events of a server that streams even when asked not to. */
function parseBody(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    const events = text
      .split("\n")
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).trim())
      .filter((data) => data && data !== "[DONE]")
      .flatMap((data) => {
        try {
          return [JSON.parse(data) as Json];
        } catch {
          return [];
        }
      });
    return events.length ? { events } : null;
  }
}

/** Joins the text pieces of streamed chat, Responses or Messages events. */
function streamedText(events: Json[]): string {
  return events
    .map((event) => {
      const choice = Array.isArray(event?.choices) ? (event.choices[0] as Json) : undefined;
      const delta = (choice?.delta ?? event?.delta) as Json | string | undefined;
      if (typeof delta === "string") return delta;
      return String(delta?.content ?? delta?.text ?? delta?.reasoning_content ?? "");
    })
    .join("");
}

function replyText(protocol: ModelApiProtocol, body: unknown): string | undefined {
  const record = (body ?? {}) as Record<string, unknown>;
  if (Array.isArray(record.events)) return streamedText(record.events as Json[]);
  if (protocol === "responses") {
    if (typeof record.output_text === "string") return record.output_text;
    if (!Array.isArray(record.output)) return undefined;
    return record.output
      .flatMap((item) => ((item as Json)?.content as Json[] | undefined) ?? [])
      .map((part) => (typeof part?.text === "string" ? part.text : ""))
      .join("");
  }
  if (protocol === "anthropic-messages") {
    if (!Array.isArray(record.content)) return undefined;
    return record.content.map((part) => String((part as Json)?.text ?? "")).join("");
  }
  const choice = Array.isArray(record.choices) ? (record.choices[0] as Json) : undefined;
  if (!choice) return undefined;
  const message = (choice.message ?? {}) as Record<string, unknown>;
  // A reasoning model can spend the small test budget thinking; that still proves it answered.
  const content = message.content ?? message.reasoning_content ?? message.reasoning ?? choice.text;
  return typeof content === "string" ? content : "";
}

async function statusMessage(response: Response, step: "models" | "chat"): Promise<string> {
  const detail = await errorDetail(response);
  const status = `${response.status}${response.statusText ? ` ${response.statusText}` : ""}`;
  const said = detail ? `: ${detail}` : ".";
  if (response.status === 401 || response.status === 403) {
    return `The server rejected the API key (${status})${said}`;
  }
  if (response.status === 404) {
    return step === "models"
      ? `The server has no model list at this URL (${status}). Check that the URL ends in /v1.`
      : `Not found (${status})${said} Check the model name and that the URL ends in /v1.`;
  }
  if (response.status === 429) return `The server is rate-limiting requests (${status})${said}`;
  if (response.status >= 500) return `The server failed (${status})${said}`;
  return `The server answered ${status}${said}`;
}

async function errorDetail(response: Response): Promise<string> {
  let text = "";
  try {
    const reader = response.body?.getReader();
    if (reader) {
      const chunks: Uint8Array[] = [];
      let size = 0;
      while (size < MAX_ERROR_BODY_BYTES) {
        const { done, value } = await reader.read();
        if (done) break;
        chunks.push(value);
        size += value.byteLength;
      }
      await reader.cancel().catch(() => undefined);
      text = new TextDecoder().decode(Buffer.concat(chunks)).slice(0, MAX_ERROR_BODY_BYTES);
    }
  } catch {
    return "";
  }
  let detail = text;
  try {
    const body = JSON.parse(text) as Record<string, unknown>;
    const error = body.error as Record<string, unknown> | string | undefined;
    detail = String(
      (typeof error === "object" ? error?.message : error) ?? body.message ?? body.detail ?? text,
    );
  } catch {
    // Not JSON: keep the text.
  }
  return clip(redact(detail.replace(/\s+/g, " ").trim()), 300);
}

/** Node's fetch keeps the reason in `cause`, sometimes in each address's error of an AggregateError. */
function errorCode(error: unknown, depth = 0): string | undefined {
  if (depth > 5 || !error || typeof error !== "object") return undefined;
  const code = (error as { code?: unknown }).code;
  if (typeof code === "string" && code !== "UND_ERR_SOCKET") return code;
  if (error instanceof AggregateError) {
    for (const inner of error.errors) {
      const found = errorCode(inner, depth + 1);
      if (found) return found;
    }
  }
  return errorCode((error as { cause?: unknown }).cause, depth + 1);
}

function innermostMessage(error: unknown): string {
  let current: unknown = error;
  let message = error instanceof Error ? error.message : String(error);
  for (let depth = 0; depth < 5 && current instanceof Error; depth += 1) {
    if (current.message) message = current.message;
    current = current.cause;
  }
  return message;
}

function networkMessage(error: unknown, host: string): { message: string; unreachable: boolean } {
  if (error instanceof StepTimeout) {
    const seconds = Math.round(error.timeoutMs / 1000);
    return error.step === "models"
      ? {
          message: `${host} did not answer within ${seconds} seconds. The server may be down, or a firewall or network policy may be blocking it.`,
          unreachable: true,
        }
      : {
          message: `The model did not answer within ${seconds} seconds. It may be overloaded or still loading; try again.`,
          unreachable: false,
        };
  }
  const code = errorCode(error);
  const reach = (message: string) => ({ message, unreachable: true });
  if (code === "ENOTFOUND" || code === "EAI_AGAIN") {
    return reach(`Could not find the host ${host} (DNS lookup failed). Check the server URL.`);
  }
  if (code === "ECONNREFUSED") {
    return reach(`${host} refused the connection. Check the port and that the server is running.`);
  }
  if (code === "ETIMEDOUT" || code === "UND_ERR_CONNECT_TIMEOUT" || code === "ENETUNREACH") {
    return reach(
      `Could not connect to ${host} (${code}). A firewall or network policy may be blocking it.`,
    );
  }
  if (
    code &&
    (CERTIFICATE_CODES.has(code) || code.startsWith("ERR_TLS") || code.includes("CERT"))
  ) {
    return reach(
      `${host}'s certificate is not trusted (${code}). Ask your administrator to add its CA to Rakazo's trusted CAs.`,
    );
  }
  if (code === "ECONNRESET" || code === "UND_ERR_CLOSED" || code === "EPIPE") {
    return {
      message: `${host} closed the connection (${code}). The server or a proxy in between may have dropped it.`,
      unreachable: false,
    };
  }
  const message = policyMessage(error);
  const detail = innermostMessage(error);
  return {
    message: detail && detail !== message ? `${message} (${redact(detail)})` : message,
    unreachable: code !== undefined,
  };
}

function policyMessage(error: unknown): string {
  const message = redact(error instanceof Error ? error.message : String(error));
  if (message.startsWith("Public model endpoints are disabled")) {
    return "This host is not on this server's list of allowed model servers. Ask your administrator to add it.";
  }
  return message;
}

function redact(text: string): string {
  return text
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer •••")
    .replace(/\bsk-[A-Za-z0-9_-]{6,}/g, "sk-•••");
}

function clip(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}
