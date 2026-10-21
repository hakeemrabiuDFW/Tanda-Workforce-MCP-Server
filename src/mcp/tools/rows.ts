import { Rec } from '../../tanda/client';
import { Org, People } from '../context';
import { breakMinutes, itemCost, itemDate, itemHours } from '../../tanda/normalize';
import { round2, toUnixSeconds, toZonedISO } from '../../utils/time';

/** Compact schedule/shift row: unix + ISO (America/New_York) times, decimal hours, site. */
export function workRow(item: Rec, org: Org, people?: People, opts: { cost?: boolean } = {}): Rec {
  const deptId = (item.department_id as number | undefined) ?? null;
  const locId = deptId !== null ? org.deptLocation.get(deptId) ?? null : null;
  const start = toUnixSeconds(item.start);
  const finish = toUnixSeconds(item.finish);
  const row: Rec = {
    id: item.id,
    user_id: item.user_id ?? null,
    user_name: (item.user_name as string) ?? people?.name(item.user_id) ?? null,
    department_id: deptId,
    location_id: locId,
    location_name: org.locationName(locId),
    date: itemDate(item),
    start,
    start_iso: toZonedISO(start),
    finish,
    finish_iso: toZonedISO(finish),
    hours: itemHours(item),
  };
  const brk = breakMinutes(item);
  if (brk) row.break_minutes = round2(brk);
  if (opts.cost) row.cost = round2(itemCost(item));
  return row;
}

export interface Totals {
  shifts: number;
  hours: number;
  cost: number;
}

export function emptyTotals(): Totals {
  return { shifts: 0, hours: 0, cost: 0 };
}

export function addTo(t: Totals, hours: number, cost: number): void {
  t.shifts += 1;
  t.hours += hours;
  t.cost += cost;
}

export function roundTotals<T extends Totals>(t: T): T {
  return { ...t, hours: round2(t.hours), cost: round2(t.cost) };
}

/** Group rows into totals keyed by `keyFn`, rounded and sorted by hours desc. */
export function groupTotals(rows: Rec[], keyFn: (r: Rec) => string | number | null, labelFn?: (key: string | number | null) => Rec): Rec[] {
  const map = new Map<string | number | null, Totals>();
  for (const r of rows) {
    const key = keyFn(r);
    if (!map.has(key)) map.set(key, emptyTotals());
    addTo(map.get(key)!, (r.hours as number) || 0, (r.cost as number) || 0);
  }
  return [...map.entries()]
    .map(([key, t]) => ({ ...(labelFn ? labelFn(key) : { key }), ...roundTotals(t) }))
    .sort((a, b) => (b.hours as number) - (a.hours as number));
}

/** Keep the first n entries of a summary list and say how many were left out. */
export function topN<T>(list: T[], n: number, label: string): Record<string, unknown> {
  return list.length > n
    ? { [label]: list.slice(0, n), [`${label}_omitted`]: list.length - n }
    : { [label]: list };
}
