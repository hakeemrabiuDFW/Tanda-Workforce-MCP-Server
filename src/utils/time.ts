/**
 * Time helpers. Tanda returns most timestamps as unix SECONDS; JavaScript Dates use
 * MILLISECONDS. Every conversion goes through toUnixSeconds/toMillis so the two are
 * never mixed up.
 */

export const DEFAULT_TIMEZONE = process.env.TANDA_TIMEZONE || 'America/New_York';

/** Normalise a Tanda timestamp (unix seconds, unix ms, numeric string or ISO string) to unix seconds. */
export function toUnixSeconds(value: unknown): number | null {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) return null;
    // Values above ~year 33658 in seconds are certainly milliseconds
    return value > 1e12 ? Math.floor(value / 1000) : value;
  }
  if (typeof value === 'string') {
    if (/^\d+(\.\d+)?$/.test(value)) return toUnixSeconds(Number(value));
    const ms = Date.parse(value);
    return Number.isNaN(ms) ? null : Math.floor(ms / 1000);
  }
  return null;
}

/** Hours between two Tanda timestamps, minus break minutes. Returns 0 for open/invalid ranges. */
export function hoursBetween(start: unknown, finish: unknown, breakMinutes = 0): number {
  const s = toUnixSeconds(start);
  const f = toUnixSeconds(finish);
  if (s === null || f === null || f <= s) return 0;
  return Math.max(0, (f - s) / 3600 - breakMinutes / 60);
}

export function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

const formatterCache = new Map<string, Intl.DateTimeFormat>();
function formatter(timeZone: string): Intl.DateTimeFormat {
  let f = formatterCache.get(timeZone);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
    formatterCache.set(timeZone, f);
  }
  return f;
}

function zonedParts(unixSeconds: number, timeZone: string): Record<string, number> {
  const parts: Record<string, number> = {};
  for (const p of formatter(timeZone).formatToParts(new Date(unixSeconds * 1000))) {
    if (p.type !== 'literal') parts[p.type] = Number(p.value);
  }
  return parts;
}

/** ISO 8601 string with the zone's UTC offset, e.g. 2026-10-21T09:00:00-04:00. */
export function toZonedISO(value: unknown, timeZone = DEFAULT_TIMEZONE): string | null {
  const secs = toUnixSeconds(value);
  if (secs === null) return null;
  const p = zonedParts(secs, timeZone);
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second) / 1000;
  const offsetMin = Math.round((asUtc - Math.floor(secs)) / 60);
  const sign = offsetMin >= 0 ? '+' : '-';
  const abs = Math.abs(offsetMin);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${p.year}-${pad(p.month)}-${pad(p.day)}T${pad(p.hour)}:${pad(p.minute)}:${pad(p.second)}${sign}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`;
}

/** Local calendar date (YYYY-MM-DD) of a timestamp in the given zone. */
export function toZonedDate(value: unknown, timeZone = DEFAULT_TIMEZONE): string | null {
  const iso = toZonedISO(value, timeZone);
  return iso ? iso.slice(0, 10) : null;
}

/** Local hour-of-day (0-23, fractional) of a timestamp in the given zone. */
export function toZonedHour(value: unknown, timeZone = DEFAULT_TIMEZONE): number | null {
  const secs = toUnixSeconds(value);
  if (secs === null) return null;
  const p = zonedParts(secs, timeZone);
  return p.hour + p.minute / 60;
}

/** Today's date (YYYY-MM-DD) in the given zone. */
export function todayInZone(timeZone = DEFAULT_TIMEZONE): string {
  return toZonedDate(Math.floor(Date.now() / 1000), timeZone) as string;
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export function isDate(value: unknown): value is string {
  return typeof value === 'string' && DATE_RE.test(value) && !Number.isNaN(Date.parse(`${value}T00:00:00Z`));
}

export function addDays(date: string, days: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

export function daysBetween(from: string, to: string): number {
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86400000);
}

/** Every date from..to inclusive. */
export function eachDate(from: string, to: string): string[] {
  const out: string[] = [];
  for (let d = from; d <= to; d = addDays(d, 1)) out.push(d);
  return out;
}

/** Split an inclusive from..to range into windows of at most `maxDays` days (Tanda rejects > 7). */
export function chunkDateRange(from: string, to: string, maxDays = 7): Array<{ from: string; to: string }> {
  const chunks: Array<{ from: string; to: string }> = [];
  for (let start = from; start <= to; start = addDays(start, maxDays)) {
    const end = addDays(start, maxDays - 1);
    chunks.push({ from: start, to: end < to ? end : to });
  }
  return chunks;
}

/** Monday (YYYY-MM-DD) of the ISO week containing `date`. */
export function weekStart(date: string): string {
  return weekStartOn(date, 1);
}

export const WEEKDAYS = ['SUN', 'MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT'] as const;
export type Weekday = (typeof WEEKDAYS)[number];

/** First day (YYYY-MM-DD) of the week containing `date`, for weeks starting on `startDay` (0 = Sunday). */
export function weekStartOn(date: string, startDay: number): string {
  const day = new Date(`${date}T00:00:00Z`).getUTCDay(); // 0 = Sunday
  return addDays(date, -((day - startDay + 7) % 7));
}

/** Parse a weekday name ("MON", "monday", "Sun") to 0-6, or null. */
export function parseWeekday(value: unknown): number | null {
  if (typeof value !== 'string') return null;
  const i = WEEKDAYS.indexOf(value.trim().slice(0, 3).toUpperCase() as Weekday);
  return i >= 0 ? i : null;
}

/** Add `<field>_iso` next to each unix timestamp field present on a row. */
export function withIsoTimes<T extends Record<string, unknown>>(
  row: T,
  fields: string[],
  timeZone = DEFAULT_TIMEZONE
): T & Record<string, unknown> {
  const out: Record<string, unknown> = { ...row };
  for (const f of fields) {
    if (row[f] !== undefined && row[f] !== null) out[`${f}_iso`] = toZonedISO(row[f], timeZone);
  }
  return out as T & Record<string, unknown>;
}

/** Unix seconds for a local wall-clock date + "HH:MM" in the given zone (DST-aware). */
export function localToUnix(date: string, time: string, timeZone = DEFAULT_TIMEZONE): number {
  const [h, m] = time.split(':').map(Number);
  const naive = Date.parse(`${date}T00:00:00Z`) / 1000 + (h || 0) * 3600 + (m || 0) * 60;
  // Guess with the zone offset at the naive instant, then correct once for DST transitions.
  let guess = naive;
  for (let i = 0; i < 2; i++) {
    const iso = toZonedISO(guess, timeZone) as string;
    const sign = iso.slice(-6, -5) === '-' ? -1 : 1;
    const offset = sign * (Number(iso.slice(-5, -3)) * 3600 + Number(iso.slice(-2)) * 60);
    guess = naive - offset;
  }
  return guess;
}

/**
 * Parse a user-supplied time: unix seconds/ms, ISO with offset, or a local
 * "YYYY-MM-DD HH:MM" / "YYYY-MM-DDTHH:MM" (interpreted in the configured zone).
 */
export function parseLocalDateTime(value: unknown, timeZone = DEFAULT_TIMEZONE): number | null {
  if (typeof value === 'string') {
    const m = value.trim().match(/^(\d{4}-\d{2}-\d{2})[T ](\d{2}:\d{2})(:\d{2})?$/);
    if (m) return localToUnix(m[1], m[2], timeZone);
  }
  return toUnixSeconds(value);
}
