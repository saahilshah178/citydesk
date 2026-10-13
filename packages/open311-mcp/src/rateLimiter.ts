/**
 * Sliding-window rate limiter: at most `limit` acquisitions in any `windowMs`.
 * Callers await `acquire()`; when the window is full it waits until the oldest call ages out.
 * State is per process, so on AWS Lambda the limit applies per warm instance.
 */
export interface RateLimiterOptions {
  limit: number;
  windowMs?: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

const defaultSleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

export class RateLimiter {
  private readonly limit: number;
  private readonly windowMs: number;
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly stamps: number[] = [];
  private tail: Promise<void> = Promise.resolve();

  constructor(opts: RateLimiterOptions) {
    if (!Number.isFinite(opts.limit) || opts.limit < 1) throw new RangeError('limit must be at least 1');
    this.limit = Math.floor(opts.limit);
    this.windowMs = opts.windowMs ?? 60_000;
    this.now = opts.now ?? Date.now;
    this.sleep = opts.sleep ?? defaultSleep;
  }

  /** Resolves when the caller may proceed. Calls are served in order. */
  acquire(): Promise<void> {
    const turn = this.tail.then(() => this.take());
    this.tail = turn.catch(() => undefined);
    return turn;
  }

  /** How long a call made now would wait, in milliseconds. */
  pendingDelayMs(): number {
    this.prune(this.now());
    if (this.stamps.length < this.limit) return 0;
    return Math.max(0, this.stamps[0]! + this.windowMs - this.now());
  }

  private prune(t: number): void {
    while (this.stamps.length > 0 && this.stamps[0]! <= t - this.windowMs) this.stamps.shift();
  }

  private async take(): Promise<void> {
    for (;;) {
      const t = this.now();
      this.prune(t);
      if (this.stamps.length < this.limit) {
        this.stamps.push(t);
        return;
      }
      await this.sleep(Math.max(1, this.stamps[0]! + this.windowMs - t));
    }
  }
}
