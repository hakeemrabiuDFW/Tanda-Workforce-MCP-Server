/**
 * Client-side limiter for Tanda API calls. Tanda allows 100 requests/minute per requester,
 * so every tool shares one process-wide token bucket refilled at 90/min
 * (override with TANDA_RATE_LIMIT_PER_MIN).
 *
 * The burst size is kept small on purpose: a bucket of capacity C refilled at r/min can
 * send at most C + r requests in any 60s window, so 90/min with a burst of 5 never
 * exceeds 95 in a minute.
 */
export class TokenBucketLimiter {
  private tokens: number;
  private last: number;
  private queue: Promise<void> = Promise.resolve();
  private readonly perMs: number;

  constructor(private readonly perMinute: number, private readonly burst = 5) {
    this.tokens = burst;
    this.last = Date.now();
    this.perMs = perMinute / 60_000;
  }

  /** Resolves when a request may be sent. Calls are serialised so ordering is fair. */
  acquire(): Promise<void> {
    const next = this.queue.then(() => this.take());
    this.queue = next.catch(() => undefined);
    return next;
  }

  private refill(): void {
    const now = Date.now();
    this.tokens = Math.min(this.burst, this.tokens + (now - this.last) * this.perMs);
    this.last = now;
  }

  private async take(): Promise<void> {
    for (;;) {
      this.refill();
      if (this.tokens >= 1) {
        this.tokens -= 1;
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, Math.ceil((1 - this.tokens) / this.perMs)));
    }
  }

  /** Tokens available right now (for /stats and tests). */
  get available(): number {
    this.refill();
    return Math.floor(this.tokens);
  }
}

export const DEFAULT_RATE_LIMIT_PER_MIN = 90;
const perMinute = Number(process.env.TANDA_RATE_LIMIT_PER_MIN) || DEFAULT_RATE_LIMIT_PER_MIN;
export const tandaRateLimiter = new TokenBucketLimiter(perMinute);
