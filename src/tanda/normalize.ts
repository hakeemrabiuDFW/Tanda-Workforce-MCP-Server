import { hoursBetween, round2, toUnixSeconds, toZonedDate, toZonedISO, DEFAULT_TIMEZONE } from '../utils/time';

type Rec = Record<string, unknown>;

/** Total break minutes on a shift/schedule. Tanda reports `length` in minutes. */
export function breakMinutes(item: Rec): number {
  const breaks = Array.isArray(item.breaks) ? (item.breaks as Rec[]) : [];
  let total = 0;
  for (const b of breaks) {
    if (typeof b.length === 'number') {
      total += b.length;
    } else {
      const s = toUnixSeconds(b.start);
      const f = toUnixSeconds(b.finish);
      if (s !== null && f !== null && f > s) total += (f - s) / 60;
    }
  }
  if (total === 0 && typeof item.automatic_break_length === 'number') total = item.automatic_break_length;
  if (total === 0 && typeof item.break_length === 'number') total = item.break_length;
  return total;
}

/** Worked/scheduled hours for a shift or schedule (finish - start - breaks), in decimal hours. */
export function itemHours(item: Rec): number {
  return round2(hoursBetween(item.start, item.finish, breakMinutes(item)));
}

/** Local date of a shift: Tanda's `date` field if present, else the start timestamp's local date. */
export function itemDate(item: Rec, timeZone = DEFAULT_TIMEZONE): string | null {
  if (typeof item.date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(item.date)) return item.date;
  return toZonedDate(item.start, timeZone);
}

/** Cost on a shift/schedule (Tanda uses `cost`; some payloads only have award line costs). */
export function itemCost(item: Rec): number {
  if (typeof item.cost === 'number') return item.cost;
  const ai = Array.isArray(item.award_interpretation) ? (item.award_interpretation as Rec[]) : [];
  return ai.reduce((sum, line) => sum + (typeof line.cost === 'number' ? line.cost : 0), 0);
}

/** Compact time fields: unix seconds + ISO in the configured zone + decimal hours. */
export function timeFields(item: Rec, timeZone = DEFAULT_TIMEZONE): Rec {
  const start = toUnixSeconds(item.start);
  const finish = toUnixSeconds(item.finish);
  return {
    start,
    start_iso: toZonedISO(start, timeZone),
    finish,
    finish_iso: toZonedISO(finish, timeZone),
    break_minutes: round2(breakMinutes(item)),
    hours: itemHours(item),
  };
}

/** Deduplicate records by `id`, keeping the first occurrence. */
export function dedupeById<T extends { id?: unknown }>(items: T[]): T[] {
  const seen = new Set<unknown>();
  const out: T[] = [];
  for (const item of items) {
    if (item.id === undefined || item.id === null) {
      out.push(item);
    } else if (!seen.has(item.id)) {
      seen.add(item.id);
      out.push(item);
    }
  }
  return out;
}
