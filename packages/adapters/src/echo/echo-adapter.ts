/**
 * Echo, the self-hosted team chat: the bot is an ordinary Echo user holding an API token. Inbound
 * arrives over Echo's Socket.IO connection (no public endpoint needed), outbound goes through its
 * REST API. Direct messages always reach the bot; in channels it answers @mentions in a thread and
 * keeps answering in threads it has replied in.
 */
import { ATTACHMENT_MAX_BYTES, ATTACHMENT_MAX_COUNT } from "@rakazo/contracts";
import { getLogger } from "@rakazo/logging";
import type {
  Adapter,
  AdapterPostableMessage,
  Attachment,
  ChatInstance,
  EmojiValue,
  FormattedContent,
  WebhookOptions,
} from "chat";
import { Message, NotImplementedError, parseMarkdown, stringifyMarkdown } from "chat";
import { SocketIoConnection } from "./socket-io.js";

export interface EchoAdapterConfig {
  /** Echo's origin, e.g. https://echo.example.com. */
  url: string;
  /** The bot user's API token (Echo: profile → API token). */
  token: string;
  /** Hold the socket open for inbound messages; only the API process does. */
  pollInboundMessages: boolean;
  /** Test seams. */
  fetch?: typeof globalThis.fetch;
  createSocket?: (url: string) => WebSocket;
}

export interface EchoThreadId {
  channelId: string;
  /** The thread's root message, for a conversation inside an Echo thread. */
  rootId?: string;
}

export interface EchoUser {
  id: string;
  username?: string;
  displayName?: string;
}

export interface EchoMessage {
  id: string;
  channelId: string;
  body?: string;
  parentId?: string | null;
  kind?: string;
  createdAt?: string;
  editedAt?: string | null;
  mentionedUserIds?: string[];
  mentionsEveryone?: boolean;
  attachments?: Array<{ key: string; name?: string; size?: number; contentType?: string }>;
  author?: EchoUser;
  /** Added on receipt: the channel's name, for group conversations. */
  channelName?: string;
}

interface EchoChannel {
  id: string;
  type: "public" | "private" | "dm";
  name?: string;
  members?: string[];
}

/** An Echo API answer other than 2xx; 4xx ones are permanent. */
export class EchoApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(`Echo API error ${status}: ${message}`);
  }
}

const OBJECT_ID = /^[a-f0-9]{24}$/i;
const PREFIX = "echo:";
/** Echo rejects longer message bodies. */
export const ECHO_MAX_BODY = 4000;
const REQUEST_TIMEOUT_MS = 30_000;
/** Threads the bot replied in, kept so follow-ups without a mention still reach it. */
const MAX_TRACKED_THREADS = 5_000;
const EMOJI: Record<string, string> = {
  eyes: "👀",
  white_check_mark: "✅",
  heavy_check_mark: "✔️",
  thumbsup: "👍",
  "+1": "👍",
  x: "❌",
  warning: "⚠️",
  hourglass: "⏳",
  rocket: "🚀",
};

export function encodeEchoThreadId({ channelId, rootId }: EchoThreadId): string {
  return rootId ? `${PREFIX}${channelId}:${rootId}` : `${PREFIX}${channelId}`;
}

export function decodeEchoThreadId(threadId: string): EchoThreadId {
  if (!threadId.startsWith(PREFIX)) throw new Error(`Invalid Echo thread ID: ${threadId}`);
  const [channelId, rootId, extra] = threadId.slice(PREFIX.length).split(":");
  if (!channelId || !OBJECT_ID.test(channelId) || extra !== undefined)
    throw new Error(`Invalid Echo thread ID: ${threadId}`);
  if (rootId !== undefined && !OBJECT_ID.test(rootId))
    throw new Error(`Invalid Echo thread ID: ${threadId}`);
  return rootId ? { channelId, rootId } : { channelId };
}

/** Splits a body at paragraph, then line, then word boundaries to fit Echo's limit. */
export function splitEchoBody(text: string, limit = ECHO_MAX_BODY): string[] {
  const parts: string[] = [];
  let rest = text.trim();
  while (rest.length > limit) {
    const window = rest.slice(0, limit);
    // The latest paragraph break, else line break, else space past halfway; else a hard cut.
    const cut = ["\n\n", "\n", " "]
      .map((separator) => window.lastIndexOf(separator))
      .find((index) => index > limit / 2);
    const at = cut ?? limit;
    parts.push(rest.slice(0, at).trimEnd());
    rest = rest.slice(at).trimStart();
  }
  if (rest) parts.push(rest);
  return parts;
}

export class EchoAdapter implements Adapter<EchoThreadId, EchoMessage> {
  readonly name = "echo";
  private chat: ChatInstance | undefined;
  private me: EchoUser | undefined;
  private socket: SocketIoConnection | undefined;
  private readonly channels = new Map<string, Promise<EchoChannel | null>>();
  private readonly directChannels = new Set<string>();
  private readonly joinedThreads = new Set<string>();
  private readonly fetchImpl: typeof globalThis.fetch;
  private readonly base: string;

  constructor(readonly config: EchoAdapterConfig) {
    this.fetchImpl = config.fetch ?? globalThis.fetch;
    this.base = config.url.replace(/\/+$/, "");
  }

  get userName() {
    return this.me?.username ?? "echo";
  }
  get botUserId() {
    return this.me?.id;
  }

  async initialize(chat: ChatInstance) {
    this.chat = chat;
    const { user } = await this.api<{ user: EchoUser }>("GET", "/api/auth/me");
    this.me = user;
    if (!this.config.pollInboundMessages) return;
    this.socket = new SocketIoConnection({
      url: this.base,
      auth: { token: this.config.token },
      createSocket: this.config.createSocket,
      onEvent: (event, data) => this.onEvent(event, data),
      onConnect: () => getLogger().info("echo connected", { bot: this.me?.username }),
      onConnectError: (message) =>
        getLogger().error("echo refused the bot's connection", { message }),
    });
    this.socket.start();
  }

  async disconnect() {
    this.socket?.stop();
    this.socket = undefined;
  }

  /** Inbound comes over the socket; Echo has nothing to deliver to this route. */
  async handleWebhook(_request: Request, _options?: WebhookOptions): Promise<Response> {
    return new Response("Echo messages arrive over its socket", { status: 404 });
  }

  private onEvent(event: string, data: unknown) {
    if (event === "message:new") {
      void this.receive(data as EchoMessage).catch((error: unknown) =>
        getLogger().warn("echo inbound message failed", { error: String(error) }),
      );
    } else if (event === "channel:added") {
      // A channel the bot was added to after it connected: join its room.
      const id =
        (data as { channel?: { id?: string }; id?: string } | null)?.channel?.id ??
        (data as { id?: string } | null)?.id;
      if (id && OBJECT_ID.test(id)) this.socket?.emit("channel:join", id);
    }
  }

  /** Which Echo conversation a message belongs to, or null when the bot should stay quiet. */
  async route(raw: EchoMessage): Promise<{ threadId: string; isMention: boolean } | null> {
    const me = this.me?.id;
    if (!me || !raw?.id || !raw.channelId || raw.author?.id === me) return null;
    if (raw.kind && raw.kind !== "user") return null;
    const channel = await this.channel(raw.channelId);
    if (!channel) return null;
    if (channel.type === "dm") {
      if ((channel.members?.length ?? 2) <= 2) this.directChannels.add(channel.id);
      return {
        threadId: encodeEchoThreadId({
          channelId: channel.id,
          ...(raw.parentId ? { rootId: raw.parentId } : {}),
        }),
        isMention: true,
      };
    }
    const rootId = raw.parentId ?? raw.id;
    const mentioned = raw.mentionedUserIds?.includes(me) ?? false;
    const following = Boolean(raw.parentId && this.joinedThreads.has(raw.parentId));
    if (!mentioned && !following) return null;
    this.follow(rootId);
    return { threadId: encodeEchoThreadId({ channelId: channel.id, rootId }), isMention: true };
  }

  private async receive(raw: EchoMessage) {
    const route = await this.route(raw);
    if (!route || !this.chat) return;
    const channel = await this.channel(raw.channelId);
    const received: EchoMessage =
      channel?.type !== "dm" && channel?.name ? { ...raw, channelName: channel.name } : raw;
    this.chat.processMessage(
      this,
      route.threadId,
      async () => {
        const message = this.parseMessage(received);
        message.attachments = this.inboundAttachments(received);
        return message;
      },
      {
        waitUntil: (task) => {
          task.catch((error: unknown) =>
            getLogger().warn("echo inbound processing failed", { error: String(error) }),
          );
        },
      },
    );
  }

  private follow(rootId: string) {
    if (this.joinedThreads.size >= MAX_TRACKED_THREADS) {
      const oldest = this.joinedThreads.values().next().value;
      if (oldest) this.joinedThreads.delete(oldest);
    }
    this.joinedThreads.add(rootId);
  }

  private channel(id: string): Promise<EchoChannel | null> {
    let cached = this.channels.get(id);
    if (!cached) {
      cached = this.api<{ channel: EchoChannel }>("GET", `/api/channels/${id}`)
        .then(({ channel }) => channel)
        .catch((error: unknown) => {
          this.channels.delete(id);
          getLogger().warn("echo channel lookup failed", { error: String(error) });
          return null;
        });
      this.channels.set(id, cached);
    }
    return cached;
  }

  parseMessage(raw: EchoMessage) {
    const me = this.me?.id;
    const author = raw.author ?? { id: "unknown" };
    // The bot's own @name is how people address it, not part of the request.
    const text = (raw.body ?? "")
      .replace(new RegExp(`(^|\\s)@${escapeRegExp(this.userName)}\\b`, "gi"), "$1")
      .trim();
    const name = author.displayName || author.username || author.id;
    return new Message<EchoMessage>({
      id: raw.id,
      threadId: encodeEchoThreadId({
        channelId: raw.channelId,
        ...(raw.parentId ? { rootId: raw.parentId } : {}),
      }),
      text,
      formatted: parseMarkdown(text),
      raw,
      author: {
        userId: author.id ?? "unknown",
        userName: author.username ?? name,
        fullName: name,
        isBot: false,
        isMe: author.id === me,
      },
      attachments: [],
      isMention:
        this.directChannels.has(raw.channelId) ||
        (me ? raw.mentionedUserIds?.includes(me) : false) ||
        false,
      metadata: {
        dateSent: raw.createdAt ? new Date(raw.createdAt) : new Date(),
        edited: Boolean(raw.editedAt),
      },
    });
  }

  private inboundAttachments(raw: EchoMessage): Attachment[] {
    return (raw.attachments ?? []).slice(0, ATTACHMENT_MAX_COUNT).map((file) => ({
      type: file.contentType?.startsWith("image/") ? ("image" as const) : ("file" as const),
      name: file.name || "file",
      ...(file.contentType ? { mimeType: file.contentType } : {}),
      ...(file.size ? { size: file.size } : {}),
      fetchData: () => this.download(file.key),
    }));
  }

  private async download(key: string): Promise<Buffer> {
    if (!/^[\w./-]+$/.test(key) || key.includes("..")) throw new Error("Invalid Echo file key");
    const response = await this.request("GET", `/api/files/${key}`);
    const declared = Number(response.headers.get("content-length") ?? 0);
    if (declared > ATTACHMENT_MAX_BYTES) {
      await response.body?.cancel();
      throw new Error("Echo file exceeds the attachment size limit");
    }
    const bytes = Buffer.from(await response.arrayBuffer());
    if (bytes.byteLength > ATTACHMENT_MAX_BYTES)
      throw new Error("Echo file exceeds the attachment size limit");
    return bytes;
  }

  isDM(threadId: string) {
    return this.directChannels.has(decodeEchoThreadId(threadId).channelId);
  }

  async openDM(userId: string) {
    if (!OBJECT_ID.test(userId)) throw new EchoApiError(400, "Echo user ids are 24 hex characters");
    const { channel } = await this.api<{ channel: EchoChannel }>("POST", "/api/dms", { userId });
    this.directChannels.add(channel.id);
    return encodeEchoThreadId({ channelId: channel.id });
  }

  private text(message: AdapterPostableMessage): string {
    if (typeof message === "string") return message;
    if ("markdown" in message) return message.markdown;
    if ("raw" in message) return message.raw;
    if ("ast" in message) return this.renderFormatted(message.ast);
    throw new NotImplementedError("Echo messages are text, Markdown or files");
  }

  private async upload(message: AdapterPostableMessage) {
    if (typeof message === "string" || !("files" in message) || !message.files?.length) return [];
    const form = new FormData();
    for (const file of message.files) {
      const data =
        file.data instanceof Blob
          ? file.data
          : new Blob([
              file.data instanceof ArrayBuffer ? file.data : Uint8Array.from(file.data as Buffer),
            ]);
      form.append("files", new Blob([data], { type: file.mimeType ?? "" }), file.filename);
    }
    const { attachments } = await this.api<{ attachments: unknown[] }>(
      "POST",
      "/api/uploads",
      form,
    );
    return attachments;
  }

  async postMessage(threadId: string, message: AdapterPostableMessage) {
    const { channelId, rootId } = decodeEchoThreadId(threadId);
    const attachments = await this.upload(message);
    const parts = splitEchoBody(this.text(message));
    if (!parts.length && !attachments.length) throw new EchoApiError(400, "Message is empty");
    let first: EchoMessage | undefined;
    const bodies = parts.length ? parts : [""];
    for (const [index, body] of bodies.entries()) {
      const sent = await this.api<{ message: EchoMessage }>(
        "POST",
        `/api/channels/${channelId}/messages`,
        {
          body,
          ...(rootId ? { parentId: rootId } : {}),
          // Files go with the last part, after the text that introduces them.
          ...(index === bodies.length - 1 && attachments.length ? { attachments } : {}),
        },
      );
      first ??= sent.message;
    }
    if (rootId) this.follow(rootId);
    return { id: first!.id, threadId, raw: first! };
  }

  async editMessage(threadId: string, messageId: string, message: AdapterPostableMessage) {
    const { channelId } = decodeEchoThreadId(threadId);
    const [body = ""] = splitEchoBody(this.text(message));
    const { message: edited } = await this.api<{ message: EchoMessage }>(
      "PATCH",
      `/api/channels/${channelId}/messages/${messageId}`,
      { body },
    );
    return { id: messageId, threadId, raw: edited };
  }

  /** Echo deletes only over its socket. */
  async deleteMessage(_threadId: string, messageId: string) {
    if (!this.socket?.emit("message:delete", { messageId }))
      throw new NotImplementedError("Echo deletes messages only while the bot is connected");
  }

  private async react(
    threadId: string,
    messageId: string,
    emoji: EmojiValue | string,
    present: boolean,
  ) {
    const { channelId } = decodeEchoThreadId(threadId);
    const name = typeof emoji === "string" ? emoji : emoji.name;
    await this.api("POST", `/api/channels/${channelId}/messages/${messageId}/reactions`, {
      emoji: EMOJI[name] ?? (/^[\w+-]+$/.test(name) ? `:${name}:` : name),
      present,
    });
  }
  addReaction(threadId: string, messageId: string, emoji: EmojiValue | string) {
    return this.react(threadId, messageId, emoji, true);
  }
  removeReaction(threadId: string, messageId: string, emoji: EmojiValue | string) {
    return this.react(threadId, messageId, emoji, false);
  }

  async startTyping() {}
  async fetchMessages(): Promise<never> {
    throw new NotImplementedError("Echo message history is not supported");
  }
  async fetchThread(): Promise<never> {
    throw new NotImplementedError("Echo thread metadata is not supported");
  }
  renderFormatted(content: FormattedContent) {
    return stringifyMarkdown(content);
  }
  encodeThreadId(data: EchoThreadId) {
    return encodeEchoThreadId(data);
  }
  decodeThreadId(threadId: string) {
    return decodeEchoThreadId(threadId);
  }
  channelIdFromThreadId(threadId: string) {
    return encodeEchoThreadId({ channelId: decodeEchoThreadId(threadId).channelId });
  }

  private async request(method: string, path: string, body?: unknown): Promise<Response> {
    const headers: Record<string, string> = { Authorization: `Bearer ${this.config.token}` };
    let payload: BodyInit | undefined;
    if (body instanceof FormData) payload = body;
    else if (body !== undefined) {
      headers["Content-Type"] = "application/json";
      payload = JSON.stringify(body);
    }
    const response = await this.fetchImpl(`${this.base}${path}`, {
      method,
      headers,
      ...(payload ? { body: payload } : {}),
      redirect: "error",
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (!response.ok) {
      const detail = await response
        .json()
        .then((json: { error?: string }) => json?.error)
        .catch(() => undefined);
      throw new EchoApiError(response.status, detail ?? response.statusText);
    }
    return response;
  }

  private async api<T = unknown>(method: string, path: string, body?: unknown): Promise<T> {
    return (await (await this.request(method, path, body)).json()) as T;
  }
}

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** An Echo thread's channel, as `#name`, for group conversations. */
export function echoChannelName(raw: unknown): string | null {
  const name = (raw as EchoMessage | null)?.channelName;
  return name ? `#${name}` : null;
}

/** Errors no retry can fix: bad input, no access, unknown channel, revoked token. */
export function isPermanentEchoError(error: unknown): boolean {
  return (
    error instanceof EchoApiError &&
    error.status >= 400 &&
    error.status < 500 &&
    error.status !== 429
  );
}
