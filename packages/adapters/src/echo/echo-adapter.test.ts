import type { IncomingMessage, Server } from "node:http";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import type { ChatInstance } from "chat";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { WebSocket as WsSocket } from "ws";
import { WebSocketServer } from "ws";
import {
  decodeEchoThreadId,
  EchoAdapter,
  EchoApiError,
  encodeEchoThreadId,
  isPermanentEchoError,
  splitEchoBody,
} from "./echo-adapter.js";

const BOT = "b0b0b0b0b0b0b0b0b0b0b0b0";
const ALICE = "a1a1a1a1a1a1a1a1a1a1a1a1";
const DM = "d0d0d0d0d0d0d0d0d0d0d0d0";
const GENERAL = "c0c0c0c0c0c0c0c0c0c0c0c0";
const TOKEN = "echo-api-token";

type Call = { method: string; path: string; auth?: string; body: string; type?: string };

/** A small stand-in for Echo: its REST API, and Socket.IO framing over a WebSocket. */
async function fakeEcho() {
  const calls: Call[] = [];
  const sockets: WsSocket[] = [];
  let sent = 0;
  const server: Server = createServer((req: IncomingMessage, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      const body = Buffer.concat(chunks).toString("latin1");
      const path = req.url ?? "";
      calls.push({
        method: req.method ?? "",
        path,
        auth: req.headers.authorization,
        body,
        type: req.headers["content-type"],
      });
      const json = (status: number, value: unknown) =>
        res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(value));
      if (req.headers.authorization !== `Bearer ${TOKEN}`) return json(401, { error: "no" });
      if (path === "/api/auth/me") return json(200, { user: { id: BOT, username: "rakazo" } });
      if (path === `/api/channels/${DM}`)
        return json(200, { channel: { id: DM, type: "dm", members: [BOT, ALICE] } });
      if (path === `/api/channels/${GENERAL}` && req.method === "GET")
        return json(200, { channel: { id: GENERAL, type: "public", members: [BOT, ALICE] } });
      if (path === "/api/uploads")
        return json(201, { attachments: [{ key: "k1", name: "report.txt", size: 5 }] });
      if (path === "/api/channels/ffffffffffffffffffffffff/messages") return json(403, {});
      if (/^\/api\/channels\/[a-f0-9]{24}\/messages$/.test(path) && req.method === "POST") {
        sent += 1;
        return json(201, { message: { id: `e${String(sent).padStart(23, "0")}` } });
      }
      if (path.endsWith("/reactions")) return json(200, { present: true });
      if (path === "/api/dms") return json(200, { channel: { id: DM, type: "dm" } });
      json(404, { error: "not found" });
    });
  });
  const wss = new WebSocketServer({ server, path: "/socket.io/" });
  wss.on("connection", (socket) => {
    sockets.push(socket);
    socket.send('0{"sid":"s1","pingInterval":25000,"pingTimeout":20000}');
    socket.on("message", (data) => {
      const text = data.toString();
      if (text.startsWith("40")) {
        const auth = JSON.parse(text.slice(2) || "{}") as { token?: string };
        socket.send(
          auth.token === TOKEN ? '40{"sid":"n1"}' : '44{"message":"Authentication failed"}',
        );
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return {
    url,
    calls,
    emit(event: string, data: unknown) {
      for (const socket of sockets) socket.send(`42${JSON.stringify([event, data])}`);
    },
    async close() {
      for (const socket of sockets) socket.terminate();
      wss.close();
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

function fakeChat() {
  const received: Array<{ threadId: string; text: string; author: string; isMention: boolean }> =
    [];
  const chat = {
    processMessage: vi.fn(
      async (_adapter: unknown, threadId: string, factory: () => Promise<unknown>) => {
        const message = (await factory()) as {
          text: string;
          author: { userName: string };
          isMention: boolean;
        };
        received.push({
          threadId,
          text: message.text,
          author: message.author.userName,
          isMention: message.isMention,
        });
      },
    ),
  } as unknown as ChatInstance;
  return { chat, received };
}

const echoServers: Array<{ close(): Promise<void> }> = [];
const adapters: EchoAdapter[] = [];
afterEach(async () => {
  for (const adapter of adapters.splice(0)) await adapter.disconnect();
  for (const server of echoServers.splice(0)) await server.close();
});

async function connected() {
  const echo = await fakeEcho();
  echoServers.push(echo);
  const adapter = new EchoAdapter({ url: echo.url, token: TOKEN, pollInboundMessages: true });
  adapters.push(adapter);
  const { chat, received } = fakeChat();
  await adapter.initialize(chat);
  await vi.waitFor(() => expect(echo.calls.length).toBeGreaterThan(0));
  // The socket connects asynchronously; wait until events would be read.
  await vi.waitFor(() =>
    expect((adapter as unknown as { socket: { isConnected: boolean } }).socket.isConnected).toBe(
      true,
    ),
  );
  return { echo, adapter, received };
}

const message = (fields: Record<string, unknown>) => ({
  id: "f0f0f0f0f0f0f0f0f0f0f0f1",
  kind: "user",
  createdAt: "2026-11-11T10:00:00.000Z",
  author: { id: ALICE, username: "alice", displayName: "Alice Cohen" },
  mentionedUserIds: [],
  ...fields,
});

describe("Echo thread ids", () => {
  it("round-trips channels and threads, and refuses anything else", () => {
    expect(decodeEchoThreadId(encodeEchoThreadId({ channelId: DM }))).toEqual({ channelId: DM });
    expect(decodeEchoThreadId(`echo:${GENERAL}:${DM}`)).toEqual({
      channelId: GENERAL,
      rootId: DM,
    });
    for (const bad of ["slack:C1", "echo:general", `echo:${GENERAL}:x`, `echo:${DM}:${DM}:${DM}`])
      expect(() => decodeEchoThreadId(bad)).toThrow();
  });

  it("splits long bodies under Echo's limit at natural breaks", () => {
    const parts = splitEchoBody(`${"a".repeat(30)}\n\n${"b".repeat(30)}`, 40);
    expect(parts).toEqual(["a".repeat(30), "b".repeat(30)]);
    expect(splitEchoBody("x".repeat(90), 40).map((part) => part.length)).toEqual([40, 40, 10]);
  });
});

describe("EchoAdapter inbound", () => {
  it("delivers direct messages and mentions, follows its threads, and ignores the rest", async () => {
    const { echo, received } = await connected();
    expect(echo.calls[0]).toMatchObject({ path: "/api/auth/me", auth: `Bearer ${TOKEN}` });

    echo.emit("message:new", message({ channelId: DM, body: "hello there" }));
    echo.emit(
      "message:new",
      message({ id: "f0f0f0f0f0f0f0f0f0f0f0f2", channelId: GENERAL, body: "no one asked" }),
    );
    echo.emit(
      "message:new",
      message({
        id: "f0f0f0f0f0f0f0f0f0f0f0f3",
        channelId: GENERAL,
        body: "@rakazo what broke?",
        mentionedUserIds: [BOT],
      }),
    );
    await vi.waitFor(() => expect(received).toHaveLength(2));
    // A reply in the thread it was pulled into needs no mention.
    echo.emit(
      "message:new",
      message({
        id: "f0f0f0f0f0f0f0f0f0f0f0f4",
        channelId: GENERAL,
        parentId: "f0f0f0f0f0f0f0f0f0f0f0f3",
        body: "and the logs?",
      }),
    );
    // Its own messages never come back in.
    echo.emit(
      "message:new",
      message({ channelId: DM, body: "mine", author: { id: BOT, username: "rakazo" } }),
    );
    await vi.waitFor(() => expect(received).toHaveLength(3));
    expect(received).toEqual([
      { threadId: `echo:${DM}`, text: "hello there", author: "alice", isMention: true },
      {
        threadId: `echo:${GENERAL}:f0f0f0f0f0f0f0f0f0f0f0f3`,
        text: "what broke?",
        author: "alice",
        isMention: true,
      },
      {
        threadId: `echo:${GENERAL}:f0f0f0f0f0f0f0f0f0f0f0f3`,
        text: "and the logs?",
        author: "alice",
        isMention: false,
      },
    ]);
  });

  it("does not connect the socket in processes that only send", async () => {
    const echo = await fakeEcho();
    echoServers.push(echo);
    const adapter = new EchoAdapter({ url: echo.url, token: TOKEN, pollInboundMessages: false });
    adapters.push(adapter);
    await adapter.initialize(fakeChat().chat);
    expect((adapter as unknown as { socket?: unknown }).socket).toBeUndefined();
  });
});

describe("EchoAdapter outbound", () => {
  it("replies in the thread, uploads files with the last part, and reacts", async () => {
    const { echo, adapter } = await connected();
    const threadId = `echo:${GENERAL}:f0f0f0f0f0f0f0f0f0f0f0f3`;
    const sent = await adapter.postMessage(threadId, {
      markdown: `${"x".repeat(3990)}\n\nsee the file`,
      files: [{ data: Buffer.from("hello"), filename: "report.txt", mimeType: "text/plain" }],
    });
    expect(sent.id).toMatch(/^e0+1$/);
    const posts = echo.calls.filter((call) => call.path === `/api/channels/${GENERAL}/messages`);
    expect(posts.map((call) => JSON.parse(call.body))).toEqual([
      { body: "x".repeat(3990), parentId: "f0f0f0f0f0f0f0f0f0f0f0f3" },
      {
        body: "see the file",
        parentId: "f0f0f0f0f0f0f0f0f0f0f0f3",
        attachments: [{ key: "k1", name: "report.txt", size: 5 }],
      },
    ]);
    const upload = echo.calls.find((call) => call.path === "/api/uploads")!;
    expect(upload.type).toMatch(/^multipart\/form-data/);
    expect(upload.body).toContain('filename="report.txt"');

    await adapter.addReaction(threadId, "f0f0f0f0f0f0f0f0f0f0f0f3", "eyes");
    const reaction = echo.calls.find((call) => call.path.endsWith("/reactions"))!;
    expect(reaction.path).toBe(
      `/api/channels/${GENERAL}/messages/f0f0f0f0f0f0f0f0f0f0f0f3/reactions`,
    );
    expect(JSON.parse(Buffer.from(reaction.body, "latin1").toString("utf8"))).toEqual({
      emoji: "👀",
      present: true,
    });
  });

  it("opens DMs and marks refusals as permanent", async () => {
    const { adapter } = await connected();
    expect(await adapter.openDM(ALICE)).toBe(`echo:${DM}`);
    expect(adapter.isDM(`echo:${DM}`)).toBe(true);
    const refused = await adapter
      .postMessage("echo:ffffffffffffffffffffffff", "hi")
      .catch((error: unknown) => error);
    expect(refused).toBeInstanceOf(EchoApiError);
    expect(isPermanentEchoError(refused)).toBe(true);
    expect(isPermanentEchoError(new EchoApiError(503, "busy"))).toBe(false);
  });
});
