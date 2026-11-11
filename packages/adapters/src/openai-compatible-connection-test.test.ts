import type { IncomingMessage, Server, ServerResponse } from "node:http";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { testOpenAiCompatibleConnection } from "./openai-compatible-connection-test.js";

type Handler = (req: IncomingMessage, res: ServerResponse, body: string) => void;
const servers: Server[] = [];

async function serve(handler: Handler): Promise<string> {
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => handler(req, res, body));
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`;
}

afterEach(async () => {
  for (const server of servers.splice(0)) {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
});

const json = (res: ServerResponse, status: number, body: unknown) =>
  res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(body));

const healthy: Handler = (req, res, body) => {
  if (req.url === "/v1/models") return json(res, 200, { data: [{ id: "llama" }, { id: "qwen" }] });
  if (req.url === "/v1/chat/completions") {
    const { model } = JSON.parse(body) as { model: string };
    if (model !== "llama" && model !== "hidden") {
      return json(res, 400, { error: { message: `Invalid model name ${model}` } });
    }
    return json(res, 200, { choices: [{ message: { role: "assistant", content: " OK " } }] });
  }
  json(res, 404, {});
};

const policy = { allowPrivate: true };

describe("testOpenAiCompatibleConnection", () => {
  it("passes when the model is listed and replies", async () => {
    const baseUrl = await serve(healthy);
    const result = await testOpenAiCompatibleConnection({ baseUrl, modelId: "llama" }, policy);
    expect(result).toMatchObject({
      ok: true,
      reply: "OK",
      steps: [
        { step: "models", ok: true, message: "The server lists 2 models." },
        { step: "chat", ok: true, message: '"llama" replied.' },
      ],
    });
  });

  it("names the listed models when the chosen one is missing, and still tries it", async () => {
    const baseUrl = await serve(healthy);
    const missing = await testOpenAiCompatibleConnection({ baseUrl, modelId: "mistral" }, policy);
    expect(missing.ok).toBe(false);
    expect(missing.steps[0]!.message).toBe(
      'The server lists 2 models, but not "mistral": llama, qwen.',
    );
    expect(missing.steps[1]!.message).toBe(
      "The server answered 400 Bad Request: Invalid model name mistral",
    );
    const unlisted = await testOpenAiCompatibleConnection({ baseUrl, modelId: "hidden" }, policy);
    expect(unlisted.ok).toBe(true);
  });

  it("explains a rejected key without echoing it", async () => {
    let auth: string | undefined;
    const baseUrl = await serve((req, res) => {
      auth = req.headers.authorization;
      json(res, 401, {
        error: {
          message: "Authentication Error, Invalid proxy server token passed. sk-secret-value",
        },
      });
    });
    const result = await testOpenAiCompatibleConnection(
      { baseUrl, apiKey: "sk-secret-value", modelId: "llama" },
      policy,
    );
    expect(auth).toBe("Bearer sk-secret-value");
    expect(result.ok).toBe(false);
    for (const step of result.steps) {
      expect(step.message).toMatch(/^The server rejected the API key \(401 Unauthorized\)/);
      expect(step.message).not.toContain("secret-value");
    }
  });

  it("reports a refused connection and skips the reply", async () => {
    const baseUrl = await serve(healthy);
    const closed = servers.pop()!;
    await new Promise((resolve) => closed.close(resolve));
    const result = await testOpenAiCompatibleConnection({ baseUrl, modelId: "llama" }, policy);
    expect(result.ok).toBe(false);
    expect(result.steps[0]!.message).toMatch(/refused the connection/);
    expect(result.steps[1]).toMatchObject({ skipped: true, ok: false });
  });

  it("gives up on a model that never answers", async () => {
    const baseUrl = await serve((req, res) => {
      if (req.url === "/v1/models") return json(res, 200, { data: [{ id: "llama" }] });
      res.writeHead(200, { "content-type": "application/json" });
      res.flushHeaders();
    });
    const result = await testOpenAiCompatibleConnection(
      { baseUrl, modelId: "llama" },
      { ...policy, chatTimeoutMs: 200 },
    );
    expect(result.ok).toBe(false);
    expect(result.steps[1]!.message).toMatch(/^The model did not answer within 0 seconds/);
  });

  it("stops when the model list does not answer", async () => {
    const baseUrl = await serve((_req, res) => {
      res.flushHeaders();
    });
    const result = await testOpenAiCompatibleConnection(
      { baseUrl, modelId: "llama" },
      { ...policy, modelsTimeoutMs: 200 },
    );
    expect(result.steps[0]!.message).toMatch(/^127\.0\.0\.1:\d+ did not answer within 0 seconds/);
    expect(result.steps[1]).toMatchObject({ skipped: true });
  });

  it("reads a reply streamed despite stream: false", async () => {
    const baseUrl = await serve((req, res) => {
      if (req.url === "/v1/models") return json(res, 200, { data: [{ id: "llama" }] });
      res.writeHead(200, { "content-type": "text/event-stream" });
      for (const content of ["", "O", "K"]) {
        res.write(`data: ${JSON.stringify({ choices: [{ delta: { content } }] })}\n\n`);
      }
      res.end("data: [DONE]\n\n");
    });
    const result = await testOpenAiCompatibleConnection({ baseUrl, modelId: "llama" }, policy);
    expect(result).toMatchObject({ ok: true, reply: "OK" });
  });

  it("refuses hosts the server does not allow", async () => {
    const result = await testOpenAiCompatibleConnection(
      { baseUrl: "https://models.example.test/v1", modelId: "llama" },
      { allowPublic: false, allowPrivate: true },
    );
    expect(result).toEqual({
      ok: false,
      steps: [
        {
          step: "models",
          ok: false,
          durationMs: 0,
          message:
            "This host is not on this server's list of allowed model servers. Ask your administrator to add it.",
        },
      ],
    });
  });

  it("checks only the list when no model is chosen", async () => {
    const baseUrl = await serve(healthy);
    const result = await testOpenAiCompatibleConnection({ baseUrl }, policy);
    expect(result.ok).toBe(true);
    expect(result.steps[1]).toMatchObject({
      skipped: true,
      message: "Choose a model to test a reply.",
    });
  });

  it("reads Responses and Messages replies", async () => {
    const baseUrl = await serve((req, res) => {
      if (req.url === "/v1/models") return json(res, 200, { data: [{ id: "m" }] });
      if (req.url === "/v1/responses")
        return json(res, 200, { output: [{ content: [{ text: "OK" }] }] });
      if (req.url === "/v1/messages")
        return json(res, 200, { content: [{ type: "text", text: "OK" }] });
      json(res, 404, {});
    });
    for (const apiProtocol of ["responses", "anthropic-messages"] as const) {
      const result = await testOpenAiCompatibleConnection(
        { baseUrl, modelId: "m", apiProtocol },
        policy,
      );
      expect(result).toMatchObject({ ok: true, reply: "OK" });
    }
  });
});
