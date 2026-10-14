/**
 * The gateway's DyNet TCP port held open, read as it comes.
 *
 * Connects again by itself when the connection drops, waiting longer each time
 * it fails (up to a minute). Reading only: nothing is ever written to it.
 */

import net from 'node:net';

import { type DynetEvent, DynetStreamDecoder } from './dynet.js';

export interface LiveOptions {
  host: string;
  port: number;
  /** Milliseconds to wait for a connection before giving up on that try. */
  connectTimeoutMs?: number;
  /** The longest wait between tries, in milliseconds. */
  maxRetryMs?: number;
  onEvent: (event: DynetEvent) => void;
  onConnected?: (connected: boolean) => void;
  onError?: (message: string) => void;
}

export class DynetLive {
  private socket?: net.Socket;
  private timer?: NodeJS.Timeout;
  private retryMs = 1000;
  private stopped = true;
  connected = false;

  constructor(private readonly options: LiveOptions) {}

  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    this.connect();
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    this.socket?.destroy();
    this.socket = undefined;
    this.setConnected(false);
  }

  private connect(): void {
    if (this.stopped) return;
    const { host, port } = this.options;
    const decoder = new DynetStreamDecoder(); // a new connection starts clean
    const socket = net.connect({ host, port });
    this.socket = socket;
    socket.setTimeout(this.options.connectTimeoutMs ?? 5000);

    socket.on('connect', () => {
      socket.setTimeout(0); // the bus may be quiet for a long time; that is not a fault
      socket.setKeepAlive(true, 30_000);
      this.retryMs = 1000;
      this.setConnected(true);
    });
    socket.on('timeout', () => socket.destroy(new Error('no connection in time')));
    socket.on('data', (data: Buffer) => {
      for (const event of decoder.feed(data)) {
        try {
          this.options.onEvent(event);
        } catch (err) {
          this.options.onError?.(`handling ${event.kind}: ${(err as Error).message}`);
        }
      }
    });
    socket.on('error', (err) => this.options.onError?.(`${host}:${port}: ${err.message}`));
    socket.on('close', () => {
      if (this.socket !== socket) return;
      this.socket = undefined;
      this.setConnected(false);
      if (this.stopped) return;
      const wait = this.retryMs;
      this.retryMs = Math.min(this.retryMs * 2, this.options.maxRetryMs ?? 60_000);
      this.timer = setTimeout(() => this.connect(), wait);
    });
  }

  private setConnected(up: boolean): void {
    if (up === this.connected) return;
    this.connected = up;
    this.options.onConnected?.(up);
  }
}
