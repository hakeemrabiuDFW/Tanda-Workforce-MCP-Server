import { TandaApiError } from '../tanda/client';

/** One degraded check: reported in `warnings[]` instead of failing the whole tool. */
export interface Warning {
  check: string;
  reason: string;
}

/** Warning for a Tanda error that a single check can survive (a missing scope), else null. */
export function warningFor(check: string, error: unknown): Warning | null {
  if (!(error instanceof TandaApiError)) return null;
  if (error.statusCode === 403) return { check, reason: `missing scope: ${error.scope ?? 'unknown'}` };
  return null;
}

/**
 * Run one check's Tanda call. On a 403 (missing scope), record a warning
 * and return `fallback` so the other checks still run; any other error propagates.
 */
export async function soft<T>(warnings: Warning[], check: string, fallback: T, fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (error) {
    const w = warningFor(check, error);
    if (!w) throw error;
    warnings.push(w);
    return fallback;
  }
}

/** `{ warnings }` when there are any, else `{}`: spread into a response. */
export function withWarnings(warnings: Warning[]): { warnings?: Warning[] } {
  return warnings.length ? { warnings } : {};
}
