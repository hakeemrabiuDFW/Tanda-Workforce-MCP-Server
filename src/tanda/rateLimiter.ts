/**
 * Client-side limiter for Tanda API calls. Tanda allows 100 requests/minute shared
 * across password tokens, so we stay under that with a single process-wide budget
 * (default 80/min, override with TANDA_RATE_LIMIT_PER_MIN).
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

const perMinute = Number(process.env.TANDA_RATE_LIMIT_PER_MIN) || 80;
export const tandaRateLimiter = new SlidingWindowLimiter(perMinute);
