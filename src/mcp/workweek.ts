import { ArgError } from './args';
import { addDays, parseWeekday, WEEKDAYS, weekStartOn } from '../utils/time';

/**
 * Overtime workweek. Weekly-hour checks always use whole calendar workweeks, never the
 * rolling query window. WORKWEEK_START sets the first day (default MON); a tool argument
 * can override it per call.
 */
export function workweekStartDay(arg?: unknown): number {
  if (arg !== undefined && arg !== null && arg !== '') {
    const day = parseWeekday(arg);
    if (day === null) throw new ArgError(`workweek_start must be one of: ${WEEKDAYS.join(', ')}.`);
    return day;
  }
  return parseWeekday(process.env.WORKWEEK_START) ?? 1;
}

export interface Workweek {
  startDay: number;
  start(date: string): string;
  end(date: string): string;
  /** e.g. "calendar workweek MON-SUN (WORKWEEK_START=MON)"; names the argument when one overrides the env */
  basis: string;
}

export function workweek(arg?: unknown): Workweek {
  const startDay = workweekStartDay(arg);
  const first = WEEKDAYS[startDay];
  const last = WEEKDAYS[(startDay + 6) % 7];
  return {
    startDay,
    start: (date) => weekStartOn(date, startDay),
    end: (date) => addDays(weekStartOn(date, startDay), 6),
    basis: `calendar workweek ${first}-${last} (${arg !== undefined && arg !== null && arg !== '' ? 'workweek_start' : 'WORKWEEK_START'}=${first})`,
  };
}
