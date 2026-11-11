/**
 * Just enough of a Socket.IO v4 client for one long-lived bot connection, over Node's built-in
 * WebSocket: the Engine.IO handshake, Socket.IO auth on connect, ping replies, events in, events
 * out, and reconnecting with backoff. No acknowledgements or binary payloads, which the Echo
 * adapter does not use.
 */
import { getLogger } from "@rakazo/logging";

export type SocketIoEventHandler = (event: string, data: unknown) => void;

const RECONNECT_DELAYS_MS = [1_000, 2_000, 5_000, 10_000, 30_000];

export class SocketIoConnection {
  private socket: WebSocket | undefined;
  private connected = false;
  private stopped = false;
  private attempt = 0;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private watchdog: ReturnType<typeof setTimeout> | undefined;
  private pingTimeoutMs = 45_000;

  constructor(
    private readonly options: {
      /** The server's origin, e.g. https://echo.example.com. */
      url: string;
      /** Socket.IO's `auth` payload, sent with the namespace connect. */
      auth: Record<string, unknown>;
      onEvent: SocketIoEventHandler;
      /** Called each time the namespace connects, including after a reconnect. */
      onConnect?: () => void;
      /** A connect refused by the server, such as a rejected token. */
      onConnectError?: (message: string) => void;
      /** Test seam. */
      createSocket?: (url: string) => WebSocket;
    },
  ) {}

  get isConnected(): boolean {
    return this.connected;
  }

  start(): void {
    this.stopped = false;
    this.open();
  }

  stop(): void {
    this.stopped = true;
    clearTimeout(this.timer);
    clearTimeout(this.watchdog);
    this.connected = false;
    this.socket?.close();
    this.socket = undefined;
  }

  /** Sends an event; false when not connected. */
  emit(event: string, data: unknown): boolean {
    if (!this.connected || !this.socket) return false;
    this.socket.send(`42${JSON.stringify([event, data])}`);
    return true;
  }

  private open(): void {
    const base = new URL(this.options.url);
    base.protocol = base.protocol === "http:" ? "ws:" : "wss:";
    base.pathname = `${base.pathname.replace(/\/+$/, "")}/socket.io/`;
    base.search = "?EIO=4&transport=websocket";
    const socket = this.options.createSocket?.(base.href) ?? new WebSocket(base.href);
    this.socket = socket;
    socket.addEventListener("message", (event) => {
      if (typeof event.data === "string") this.onPacket(event.data);
    });
    socket.addEventListener("close", () => this.onClose(socket));
    socket.addEventListener("error", () => {
      // A close event always follows; reconnecting happens there.
    });
  }

  private onPacket(packet: string): void {
    this.armWatchdog();
    const type = packet[0];
    if (type === "0") {
      // Engine.IO open: learn the ping timing, then connect the default namespace.
      try {
        const open = JSON.parse(packet.slice(1)) as { pingInterval?: number; pingTimeout?: number };
        this.pingTimeoutMs = (open.pingInterval ?? 25_000) + (open.pingTimeout ?? 20_000);
      } catch {
        // Keep the defaults.
      }
      this.socket?.send(`40${JSON.stringify(this.options.auth)}`);
      return;
    }
    if (type === "2") {
      this.socket?.send("3");
      return;
    }
    if (type !== "4") return;
    const kind = packet[1];
    const body = packet.slice(2);
    if (kind === "0") {
      this.connected = true;
      this.attempt = 0;
      this.options.onConnect?.();
    } else if (kind === "4") {
      let message = "connection refused";
      try {
        message = (JSON.parse(body) as { message?: string }).message ?? message;
      } catch {
        // Keep the generic message.
      }
      this.options.onConnectError?.(message);
      this.socket?.close();
    } else if (kind === "2") {
      try {
        const [event, data] = JSON.parse(body) as [string, unknown];
        if (typeof event === "string") this.options.onEvent(event, data);
      } catch (error) {
        getLogger().warn("socket.io event could not be read", { error: String(error) });
      }
    } else if (kind === "1") {
      this.socket?.close();
    }
  }

  /** A server that stops pinging is gone; close so the reconnect starts. */
  private armWatchdog(): void {
    clearTimeout(this.watchdog);
    this.watchdog = setTimeout(() => this.socket?.close(), this.pingTimeoutMs);
    this.watchdog.unref?.();
  }

  private onClose(socket: WebSocket): void {
    if (socket !== this.socket) return;
    clearTimeout(this.watchdog);
    this.connected = false;
    this.socket = undefined;
    if (this.stopped) return;
    const delay = RECONNECT_DELAYS_MS[Math.min(this.attempt, RECONNECT_DELAYS_MS.length - 1)]!;
    this.attempt += 1;
    this.timer = setTimeout(() => this.open(), delay);
    this.timer.unref?.();
  }
}
