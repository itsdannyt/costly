import type { RequestLog } from "./types.js";

export class LogBatcher {
  private queue: RequestLog[] = [];
  private timer: ReturnType<typeof setTimeout> | null = null;
  private pendingSends: Promise<void>[] = [];
  private endpoint: string;
  private apiKey: string;
  private flushInterval: number;
  private flushBatchSize: number;
  private debug: boolean;

  constructor(opts: {
    endpoint: string;
    apiKey: string;
    flushInterval: number;
    flushBatchSize: number;
    debug: boolean;
  }) {
    this.endpoint = opts.endpoint;
    this.apiKey = opts.apiKey;
    this.flushInterval = opts.flushInterval;
    this.flushBatchSize = opts.flushBatchSize;
    this.debug = opts.debug;

    if (typeof process !== "undefined") {
      process.on("beforeExit", () => {
        this.flush();
      });
    }
  }

  add(log: RequestLog): void {
    this.queue.push(log);

    if (this.queue.length >= this.flushBatchSize) {
      this.flush();
    } else if (!this.timer) {
      this.timer = setTimeout(() => this.flush(), this.flushInterval);
      // Don't keep the Node process alive just for logging
      if (this.timer && typeof this.timer === "object" && "unref" in this.timer) {
        this.timer.unref();
      }
    }
  }

  flush(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }

    if (this.queue.length === 0) return;

    const batch = this.queue.splice(0);

    const sendPromise = this.send(batch).catch((err) => {
      if (this.debug) {
        console.warn("[costly] Failed to send logs:", err.message);
      }
    });

    this.pendingSends.push(sendPromise);
    sendPromise.finally(() => {
      const idx = this.pendingSends.indexOf(sendPromise);
      if (idx !== -1) this.pendingSends.splice(idx, 1);
    });
  }

  async flushAsync(): Promise<void> {
    this.flush();
    await Promise.all(this.pendingSends);
  }

  async shutdown(): Promise<void> {
    await this.flushAsync();
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  private async send(batch: RequestLog[]): Promise<void> {
    const res = await fetch(this.endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify({ logs: batch }),
    });

    if (!res.ok && this.debug) {
      console.warn(`[costly] Ingest responded ${res.status}: ${res.statusText}`);
    }
  }
}
