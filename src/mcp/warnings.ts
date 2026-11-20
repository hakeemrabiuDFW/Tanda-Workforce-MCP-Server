import { TandaApiError } from '../tanda/client';

/** One degraded check: reported in `warnings[]` instead of failing the whole tool. */
export interface Warning {
  check: string;
  reason: string;
  /** Set when Tanda kept returning 429 after our retries: try again in a minute. */
  rate_limited?: true;
}

export interface SoftOptions {
  /** Also survive a 404, for optional enrichment from endpoints an account may not have. */
  notFoundOk?: boolean;
}

/** Warning for a Tanda error that a single check can survive (a missing scope, a rate limit), else null. */
export function warningFor(check: string, error: unknown, opts: SoftOptions = {}): Warning | null {
  if (!(error instanceof TandaApiError)) return null;
  if (error.statusCode === 429) return { check, reason: 'Tanda rate limit reached; retry in a minute', rate_limited: true };
  if (error.statusCode === 403) return { check, reason: `missing scope: ${error.scope ?? 'unknown'}` };
  if (error.statusCode === 404 && opts.notFoundOk) return { check, reason: 'not available from Tanda (404)' };
  return null;
}

/**
 * Run one check's Tanda call. On a 403 (missing scope) or a 429 that outlasted the client's
 * retries, record a warning
 * and return `fallback` so the other checks still run; any other error propagates.
 */
export async function soft<T>(warnings: Warning[], check: string, fallback: T, fn: () => Promise<T>, opts: SoftOptions = {}): Promise<T> {
  try {
    return await fn();
  } catch (error) {
    const w = warningFor(check, error, opts);
    if (!w) throw error;
    warnings.push(w);
    return fallback;
  }
}

/** A short client-facing reason for a failed write: HTTP status and our hint, never Tanda's response text. */
export function writeFailureReason(error: unknown, fallback: string): string {
  if (!(error instanceof TandaApiError)) return fallback;
  return `Tanda returned HTTP ${error.statusCode}${error.hint ? `. ${error.hint}` : ''}`;
}

/** `{ warnings }` when there are any, else `{}`: spread into a response. */
export function withWarnings(warnings: Warning[]): { warnings?: Warning[] } {
  return warnings.length ? { warnings } : {};
}
