/** Half-open [start, end) intervals in unix seconds. */
export type Interval = [number, number];

export function union(intervals: Interval[]): Interval[] {
  const sorted = intervals.filter(([s, e]) => e > s).sort((a, b) => a[0] - b[0]);
  const out: Interval[] = [];
  for (const [s, e] of sorted) {
    const last = out[out.length - 1];
    if (last && s <= last[1]) last[1] = Math.max(last[1], e);
    else out.push([s, e]);
  }
  return out;
}

/** a minus b (both unioned first). */
export function subtract(a: Interval[], b: Interval[]): Interval[] {
  const out: Interval[] = [];
  const bs = union(b);
  for (const [s0, e0] of union(a)) {
    let s = s0;
    for (const [bs1, be1] of bs) {
      if (be1 <= s || bs1 >= e0) continue;
      if (bs1 > s) out.push([s, bs1]);
      s = Math.max(s, be1);
      if (s >= e0) break;
    }
    if (s < e0) out.push([s, e0]);
  }
  return out;
}

export function intersect(a: Interval, b: Interval): Interval | null {
  const s = Math.max(a[0], b[0]);
  const e = Math.min(a[1], b[1]);
  return e > s ? [s, e] : null;
}

export function overlaps(a: Interval, b: Interval): boolean {
  return intersect(a, b) !== null;
}

export function clip(intervals: Interval[], window: Interval | null): Interval[] {
  if (!window) return intervals;
  return intervals.map((i) => intersect(i, window)).filter((i): i is Interval => i !== null);
}

export function totalSeconds(intervals: Interval[]): number {
  return intervals.reduce((n, [s, e]) => n + (e - s), 0);
}
