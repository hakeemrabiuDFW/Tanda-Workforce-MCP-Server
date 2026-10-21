import { addDays, daysBetween, isDate, todayInZone, toUnixSeconds } from '../utils/time';

export type Args = Record<string, unknown>;

/** Longest from..to range accepted. Ranges are split into 7-day Tanda calls internally. */
export const MAX_RANGE_DAYS = 62;

export class ArgError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ArgError';
  }
}

export function idList(value: unknown): number[] | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  const raw = Array.isArray(value) ? value : String(value).split(',');
  const ids = raw.map((v) => Number(v)).filter((n) => Number.isFinite(n) && n > 0);
  return ids.length ? ids : undefined;
}

export function num(value: unknown, fallback?: number): number | undefined {
  if (value === undefined || value === null || value === '') return fallback;
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

export function bool(value: unknown, fallback = false): boolean {
  if (value === undefined || value === null) return fallback;
  if (typeof value === 'boolean') return value;
  return String(value).toLowerCase() === 'true';
}

export function oneOf<T extends string>(value: unknown, allowed: readonly T[], fallback: T, name: string): T {
  if (value === undefined || value === null || value === '') return fallback;
  if (!allowed.includes(value as T)) {
    throw new ArgError(`${name} must be one of: ${allowed.join(', ')} (got "${String(value)}").`);
  }
  return value as T;
}

/**
 * Resolve from/to. Defaults: from = today (or `defaultBackDays` ago), to = from + defaultSpan - 1.
 * Accepts `date` as shorthand for a single day.
 */
export function dateRange(args: Args, opts: { defaultSpan?: number; defaultBackDays?: number } = {}): { from: string; to: string } {
  const today = todayInZone();
  const single = args.date;
  let from = (args.from ?? single) as unknown;
  let to = (args.to ?? single) as unknown;
  if (from === undefined || from === null || from === '') {
    from = opts.defaultBackDays ? addDays(today, -opts.defaultBackDays) : today;
  }
  if (!isDate(from)) throw new ArgError('`from` must be a date in YYYY-MM-DD format.');
  if (to === undefined || to === null || to === '') {
    to = opts.defaultBackDays ? today : addDays(from, (opts.defaultSpan ?? 7) - 1);
  }
  if (!isDate(to)) throw new ArgError('`to` must be a date in YYYY-MM-DD format.');
  const days = daysBetween(from, to);
  if (days < 0) throw new ArgError('`to` must be on or after `from`.');
  if (days >= MAX_RANGE_DAYS) {
    throw new ArgError(`Range is ${days + 1} days; the maximum is ${MAX_RANGE_DAYS}. Narrow from/to.`);
  }
  return { from, to };
}

export function requireId(value: unknown, name: string): number {
  const n = num(value);
  if (!n || n <= 0) throw new ArgError(`${name} is required (a positive number).`);
  return n;
}

/** Shared JSON-schema fragments. */
export const S = {
  from: { type: 'string', description: 'Start date YYYY-MM-DD (any length up to 62 days; split into 7-day calls internally)' },
  to: { type: 'string', description: 'End date YYYY-MM-DD (inclusive)' },
  locationIds: { type: 'array', items: { type: 'number' }, description: 'Filter by location (site) ids' },
  departmentIds: { type: 'array', items: { type: 'number' }, description: 'Filter by department ids' },
  userIds: { type: 'array', items: { type: 'number' }, description: 'Filter by user ids' },
  offset: { type: 'number', description: 'Row offset for paging (use page.next_offset from the previous response)' },
  limit: { type: 'number', description: 'Rows per page (max 50)' },
  updatedAfter: { type: 'string', description: 'Only records updated after this time (unix seconds or ISO)' },
} as const;

/** updated_after as unix seconds (Tanda's format); accepts unix seconds/ms or ISO. */
export function updatedAfter(value: unknown): string | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  const secs = toUnixSeconds(value);
  if (secs === null) throw new ArgError('updated_after must be unix seconds or an ISO date/time.');
  return String(secs);
}
