/**
 * Demo limits for a backend that is public for a month: a per-IP rate limit and a daily request
 * cap. Both fail closed: when a limit is hit, misconfigured, or cannot be checked, the request is
 * refused with a JSON error and no AWS call is made.
 *
 * Counters live behind `CounterStore`. The in-memory store is exact for one process (the local dev
 * server) but in Lambda each execution environment has its own memory, so there the cap is per
 * warm instance, not global. For a strict global cap, back the store with an atomic counter in a
 * shared database, or pin the function's reserved concurrency to 1.
 */

export interface CounterStore {
  /** Adds `by` (default one) to `key` and returns the new count. The counter may be forgotten after `ttlSeconds`. */
  increment(key: string, ttlSeconds: number, by?: number): Promise<number>;
}

export class MemoryCounterStore implements CounterStore {
  private readonly counters = new Map<string, { count: number; expiresAt: number }>();

  constructor(
    private readonly now: () => number = Date.now,
    /** Upper bound on tracked keys, so a flood of distinct IPs cannot grow memory without limit. */
    private readonly maxKeys: number = 20_000,
  ) {}

  async increment(key: string, ttlSeconds: number, by: number = 1): Promise<number> {
    const time = this.now();
    const existing = this.counters.get(key);
    if (existing && existing.expiresAt > time) {
      existing.count += by;
      return existing.count;
    }
    if (this.counters.size >= this.maxKeys) this.prune(time);
    if (this.counters.size >= this.maxKeys) {
      throw new Error('rate limit table is full');
    }
    this.counters.set(key, { count: by, expiresAt: time + ttlSeconds * 1000 });
    return by;
  }

  private prune(time: number): void {
    for (const [key, entry] of this.counters) {
      if (entry.expiresAt <= time) this.counters.delete(key);
    }
  }
}

export type LimitCode = 'rate_limited' | 'daily_cap_reached' | 'limits_misconfigured' | 'limits_unavailable';

export type LimitDecision =
  | { ok: true }
  | { ok: false; status: 429 | 503; code: LimitCode; message: string; retryAfterSeconds: number };

export interface LimiterSettings {
  /** Requests per minute per IP. `null` (present but invalid) refuses every request. */
  perMinute: number | null;
  /** Requests per UTC day across all IPs. `0` closes the endpoint. `null` refuses every request. */
  dailyCap: number | null;
}

export interface LimitRequest {
  ip: string;
  /** Whether this request spends money (Bedrock, Polly) and so counts toward the daily cap. */
  metered: boolean;
  /**
   * Which half of the check to run. "rate" is the per-address limit, applied to every request as it
   * arrives. "spend" is the daily cap, applied only once a request has been validated and is about
   * to cost money, so junk requests cannot use up the day. Default: both.
   */
  phase?: 'rate' | 'spend';
  /** How much of the daily cap this request uses. A long conversation costs more than a short one. Default 1. */
  units?: number;
}

export interface Limiter {
  check(request: LimitRequest, settings: LimiterSettings): Promise<LimitDecision>;
}

function secondsUntilNextUtcDay(time: number): number {
  const next = new Date(time);
  next.setUTCHours(24, 0, 0, 0);
  return Math.max(1, Math.ceil((next.getTime() - time) / 1000));
}

export function createLimiter(store: CounterStore = new MemoryCounterStore(), now: () => number = Date.now): Limiter {
  return {
    async check({ ip, metered, phase, units = 1 }, { perMinute, dailyCap }) {
      if (perMinute === null || dailyCap === null) {
        return {
          ok: false,
          status: 503,
          code: 'limits_misconfigured',
          message:
            'The demo limits are misconfigured (DEMO_DAILY_REQUEST_CAP and DEMO_RATE_LIMIT_PER_MINUTE must be whole numbers), so requests are refused.',
          retryAfterSeconds: 300,
        };
      }

      const time = now();
      const minute = Math.floor(time / 60_000);
      const day = new Date(time).toISOString().slice(0, 10);

      try {
        const perIp = phase === 'spend' ? 0 : await store.increment(`ip:${ip}:${minute}`, 120);
        if (perIp > perMinute) {
          return {
            ok: false,
            status: 429,
            code: 'rate_limited',
            message: `Too many requests from this address. The limit is ${perMinute} per minute.`,
            retryAfterSeconds: Math.max(1, 60 - Math.floor((time % 60_000) / 1000)),
          };
        }
        if (metered && phase !== 'rate') {
          // A cap of zero must refuse without counting, so it works as an off switch.
          const total = dailyCap === 0 ? 1 : await store.increment(`day:${day}`, 2 * 86_400, Math.max(1, Math.ceil(units)));
          if (total > dailyCap) {
            return {
              ok: false,
              status: 429,
              code: 'daily_cap_reached',
              message: `This demo has reached its daily limit of ${dailyCap} requests. It resets at midnight UTC.`,
              retryAfterSeconds: secondsUntilNextUtcDay(time),
            };
          }
        }
        return { ok: true };
      } catch {
        return {
          ok: false,
          status: 503,
          code: 'limits_unavailable',
          message: 'The demo limits could not be checked, so the request was refused.',
          retryAfterSeconds: 30,
        };
      }
    },
  };
}
