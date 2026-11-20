/**
 * Client-side limiter for Tanda API calls. Tanda allows 100 requests/minute shared
 * across password tokens, so every tool and token draws on one process-wide budget
 * (default 90/min, override with TANDA_RATE_LIMIT_PER_MIN).
 *
 * A sliding window rather than a refilling token bucket: a bucket that starts full can
 * send its whole burst and then a minute's refill inside one rolling minute (up to 2x
 * the limit), which would go over Tanda's 100. The window never sends more than
 * `limit` in any 60 seconds.
 */
export class SlidingWindowLimiter {
  private timestamps: number[] = [];
  private queue: Promise<void> = Promise.resolve();

  constructor(private readonly limit: number, private readonly windowMs = 60_000) {}

  /** Resolves when a request may be sent. Calls are serialised so ordering is fair. */
  acquire(): Promise<void> {
    const next = this.queue.then(() => this.waitForSlot());
    this.queue = next.catch(() => undefined);
    return next;
  }

  private async waitForSlot(): Promise<void> {
    for (;;) {
      const now = Date.now();
      this.timestamps = this.timestamps.filter((t) => now - t < this.windowMs);
      if (this.timestamps.length < this.limit) {
        this.timestamps.push(now);
        return;
      }
      const waitMs = this.windowMs - (now - this.timestamps[0]) + 5;
      await new Promise((resolve) => setTimeout(resolve, waitMs));
    }
  }

  get inFlightWindow(): number {
    const now = Date.now();
    return this.timestamps.filter((t) => now - t < this.windowMs).length;
  }
}

export const DEFAULT_TANDA_RATE_LIMIT_PER_MIN = 90;
const perMinute = Number(process.env.TANDA_RATE_LIMIT_PER_MIN) || DEFAULT_TANDA_RATE_LIMIT_PER_MIN;
export const tandaRateLimiter = new SlidingWindowLimiter(perMinute);
