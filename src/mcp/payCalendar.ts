import { addDays, daysBetween, isDate } from '../utils/time';

/**
 * Pay calendar: a list of segments, each "first period start:period length in days".
 * A segment applies until the next one starts; dates before the first segment extrapolate
 * backwards with its length. The default encodes the biweekly -> weekly cutover: the last
 * biweekly period is 2026-12-14..2026-12-27, the first weekly one 2026-12-28..2027-01-03.
 */
export const DEFAULT_PAY_CALENDAR = '2026-12-14:14,2026-12-28:7';

export interface Segment {
  start: string;
  days: number;
}

export interface Period {
  start: string;
  finish: string;
  days: number;
  /** Cadence of the segment the period belongs to ("weekly", "biweekly", or "<n>-day"). */
  cadence: string;
}

export function cadence(days: number): string {
  return days === 7 ? 'weekly' : days === 14 ? 'biweekly' : `${days}-day`;
}

/** Parse PAY_CALENDAR. Errors are returned (not thrown) so the tool can report them. */
export function parsePayCalendar(text: string = process.env.PAY_CALENDAR || DEFAULT_PAY_CALENDAR): { segments: Segment[]; errors: string[] } {
  const errors: string[] = [];
  const segments: Segment[] = [];
  for (const part of text.split(',').map((p) => p.trim()).filter(Boolean)) {
    const [start, len] = part.split(':').map((x) => x.trim());
    const days = Number(len);
    if (!isDate(start) || !Number.isInteger(days) || days < 1) {
      errors.push(`"${part}" is not "YYYY-MM-DD:days"`);
      continue;
    }
    segments.push({ start, days });
  }
  segments.sort((a, b) => a.start.localeCompare(b.start));
  for (let i = 1; i < segments.length; i++) {
    const prev = segments[i - 1];
    const gap = daysBetween(prev.start, segments[i].start);
    if (gap % prev.days !== 0) {
      errors.push(`${segments[i].start} is not a ${cadence(prev.days)} period boundary after ${prev.start}; the period before it is cut short`);
    }
  }
  if (segments.length === 0) {
    errors.push('no valid segments; using the default calendar');
    return { segments: parsePayCalendar(DEFAULT_PAY_CALENDAR).segments, errors };
  }
  return { segments, errors };
}

/** The pay period containing `date`. */
export function periodContaining(date: string, segments: Segment[]): Period {
  let i = 0;
  while (i + 1 < segments.length && segments[i + 1].start <= date) i++;
  const seg = segments[i];
  const k = Math.floor(daysBetween(seg.start, date) / seg.days);
  const start = addDays(seg.start, k * seg.days);
  let finish = addDays(start, seg.days - 1);
  const next = segments[i + 1];
  if (next && finish >= next.start) finish = addDays(next.start, -1);
  return { start, finish, days: daysBetween(start, finish) + 1, cadence: cadence(seg.days) };
}

/** The period immediately before `period` (no gap, no overlap). */
export function previousPeriod(period: Period, segments: Segment[]): Period {
  return periodContaining(addDays(period.start, -1), segments);
}
