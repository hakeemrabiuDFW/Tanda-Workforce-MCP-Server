import { Tool } from './types';
import { ArgError, dateRange, idList, num, oneOf, S } from '../args';
import { guardResponse } from '../guard';
import { loadOrg, loadPeople, Org, People } from '../context';
import { Rec, TandaClient } from '../../tanda/client';
import { itemDate } from '../../tanda/normalize';
import { localToUnix, round2, toUnixSeconds, toZonedISO } from '../../utils/time';
import { clip, Interval, intersect, overlaps, subtract, totalSeconds, union } from './intervals';

export const MAX_SUGGESTIONS = 10;
const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;

interface Sched {
  id: unknown;
  user_id: number;
  location_id: number;
  date: string;
  span: Interval;
}

export interface CoverageData {
  org: Org;
  people: People;
  /** Shifts in Supervisor departments (assigned users only) */
  supervisor: Sched[];
  /** Shifts in all other departments (assigned users only) */
  work: Sched[];
  /** Every assigned schedule, used to check whether a supervisor is free */
  all: Sched[];
  supervisorPool: Set<number>;
}

/** Load schedules for the range and split them into supervisor vs work shifts, by LOCATION. */
export async function loadCoverageData(client: TandaClient, from: string, to: string, locIds?: number[]): Promise<CoverageData> {
  const [org, people] = await Promise.all([loadOrg(client), loadPeople(client)]);
  const schedules = await client.getSchedules({ from, to, include_names: true });
  const supervisor: Sched[] = [];
  const work: Sched[] = [];
  const all: Sched[] = [];
  const pool = new Set<number>();
  for (const id of org.supervisorDeptIds) for (const uid of (org.departmentById.get(id)?.staff as number[]) || []) pool.add(uid);

  for (const s of schedules as Rec[]) {
    const userId = s.user_id as number | null;
    const deptId = s.department_id as number | null;
    const start = toUnixSeconds(s.start);
    const finish = toUnixSeconds(s.finish);
    const date = itemDate(s);
    if (!userId || deptId === null || start === null || finish === null || finish <= start || !date) continue;
    const locId = org.deptLocation.get(deptId);
    if (locId === null || locId === undefined) continue;
    const sched: Sched = { id: s.id, user_id: userId, location_id: locId, date, span: [start, finish] };
    all.push(sched);
    if (date < from || date > to || org.isBookkeepingLocation(locId)) continue;
    if (locIds && !locIds.includes(locId)) continue;
    if (org.supervisorDeptIds.has(deptId)) {
      supervisor.push(sched);
      pool.add(userId);
    } else {
      work.push(sched);
    }
  }
  return { org, people, supervisor, work, all, supervisorPool: pool };
}

export interface Gap {
  location_id: number;
  date: string;
  span: Interval;
  staff: number;
}

export function findGaps(data: CoverageData, window: (date: string) => Interval | null, minGapSeconds: number): Gap[] {
  const key = (s: Sched) => `${s.location_id}|${s.date}`;
  const work = new Map<string, Sched[]>();
  const sup = new Map<string, Interval[]>();
  for (const s of data.work) (work.get(key(s)) || work.set(key(s), []).get(key(s))!).push(s);
  for (const s of data.supervisor) (sup.get(key(s)) || sup.set(key(s), []).get(key(s))!).push(s.span);

  const gaps: Gap[] = [];
  for (const [k, shifts] of work) {
    const [loc, date] = k.split('|');
    const staffed = clip(union(shifts.map((s) => s.span)), window(date));
    for (const span of subtract(staffed, sup.get(k) || [])) {
      if (span[1] - span[0] < minGapSeconds) continue;
      gaps.push({
        location_id: Number(loc),
        date,
        span,
        staff: new Set(shifts.filter((s) => overlaps(s.span, span)).map((s) => s.user_id)).size,
      });
    }
  }
  return gaps.sort((a, b) => b.span[1] - b.span[0] - (a.span[1] - a.span[0]));
}

export interface Overlap {
  type: 'same_location' | 'double_booked';
  date: string;
  span: Interval;
  user_ids: number[];
  location_ids: number[];
}

export function findOverlaps(data: CoverageData, window: (date: string) => Interval | null, minSeconds: number): Overlap[] {
  const out: Overlap[] = [];
  const sup = data.supervisor;
  for (let i = 0; i < sup.length; i++) {
    for (let j = i + 1; j < sup.length; j++) {
      const a = sup[i];
      const b = sup[j];
      if (a.date !== b.date) continue;
      let span = intersect(a.span, b.span);
      const w = window(a.date);
      if (span && w) span = intersect(span, w);
      if (!span || span[1] - span[0] < minSeconds) continue;
      if (a.user_id !== b.user_id && a.location_id === b.location_id) {
        out.push({ type: 'same_location', date: a.date, span, user_ids: [a.user_id, b.user_id], location_ids: [a.location_id] });
      } else if (a.user_id === b.user_id && a.location_id !== b.location_id) {
        out.push({ type: 'double_booked', date: a.date, span, user_ids: [a.user_id], location_ids: [a.location_id, b.location_id] });
      }
    }
  }
  return out.sort((a, b) => b.span[1] - b.span[0] - (a.span[1] - a.span[0]));
}

function isFree(data: CoverageData, userId: number, span: Interval, taken: Array<{ user: number; span: Interval }>): boolean {
  if (data.all.some((s) => s.user_id === userId && overlaps(s.span, span))) return false;
  return !taken.some((t) => t.user === userId && overlaps(t.span, span));
}

/** Up to 10 concrete moves: reassign a redundant supervisor, else add a free supervisor. */
export function suggest(data: CoverageData, gaps: Gap[], overlapsList: Overlap[]): Rec[] {
  const out: Rec[] = [];
  const taken: Array<{ user: number; span: Interval }> = [];
  const loc = (id: number) => data.org.locationName(id);
  const name = (id: number) => data.people.name(id);

  // 1. Redundant supervisors (same site, same time) -> largest gap that day they could cover
  const usedGaps = new Set<Gap>();
  for (const o of overlapsList.filter((x) => x.type === 'same_location')) {
    if (out.length >= MAX_SUGGESTIONS) break;
    const mover = o.user_ids[1];
    const gap = gaps.find(
      (g) =>
        !usedGaps.has(g) && g.date === o.date && overlaps(g.span, o.span) && g.location_id !== o.location_ids[0] &&
        !taken.some((t) => t.user === mover && overlaps(t.span, g.span))
    );
    if (!gap) continue;
    usedGaps.add(gap);
    taken.push({ user: mover, span: gap.span });
    out.push({
      action: 'reassign',
      user_id: mover,
      user_name: name(mover),
      from_location: loc(o.location_ids[0]),
      to_location_id: gap.location_id,
      to_location: loc(gap.location_id),
      date: gap.date,
      start_iso: toZonedISO(gap.span[0]),
      finish_iso: toZonedISO(gap.span[1]),
      reason: `Overlaps ${name(o.user_ids[0]) ?? o.user_ids[0]} at ${loc(o.location_ids[0])}; ${loc(gap.location_id)} has ${round2((gap.span[1] - gap.span[0]) / 3600)}h without a supervisor.`,
    });
  }

  // 2. Remaining gaps -> any supervisor free for the whole gap
  for (const gap of gaps) {
    if (out.length >= MAX_SUGGESTIONS) break;
    if (usedGaps.has(gap)) continue;
    const candidate = [...data.supervisorPool].find((u) => isFree(data, u, gap.span, taken));
    usedGaps.add(gap);
    if (candidate !== undefined) taken.push({ user: candidate, span: gap.span });
    out.push({
      action: candidate !== undefined ? 'add_shift' : 'unfilled',
      ...(candidate !== undefined ? { user_id: candidate, user_name: name(candidate) } : {}),
      to_location_id: gap.location_id,
      to_location: loc(gap.location_id),
      date: gap.date,
      start_iso: toZonedISO(gap.span[0]),
      finish_iso: toZonedISO(gap.span[1]),
      reason: candidate !== undefined
        ? `${gap.staff} staff on site with no supervisor; supervisor is not rostered at that time.`
        : `${gap.staff} staff on site with no supervisor; no supervisor is free for the whole window.`,
    });
  }
  return out.slice(0, MAX_SUGGESTIONS);
}

export const coverageTool: Tool = {
  name: 'tanda_coverage',
  description:
    'Returns supervisor coverage problems by site: gaps (staff rostered at a location with no Supervisor-department shift there) or overlaps (two supervisors at one site, or one supervisor double-booked), plus up to 10 suggested moves.',
  inputSchema: {
    type: 'object',
    properties: {
      mode: { type: 'string', enum: ['gaps', 'overlaps'], description: 'Default gaps' },
      from: S.from,
      to: S.to,
      location_ids: S.locationIds,
      window_start: { type: 'string', description: 'Only consider this local time window each day, e.g. "17:00"' },
      window_end: { type: 'string', description: 'e.g. "22:00"' },
      min_minutes: { type: 'number', description: 'Ignore gaps/overlaps shorter than this. Default 30' },
      offset: S.offset,
      limit: S.limit,
    },
  },
  async run(client, args) {
    const mode = oneOf(args.mode, ['gaps', 'overlaps'] as const, 'gaps', 'mode');
    const { from, to } = dateRange(args);
    const ws = args.window_start as string | undefined;
    const we = args.window_end as string | undefined;
    if ((ws && !HHMM.test(ws)) || (we && !HHMM.test(we))) throw new ArgError('window_start/window_end must be HH:MM (24h).');
    const window = (date: string): Interval | null =>
      ws || we ? [localToUnix(date, ws || '00:00'), localToUnix(date, we || '23:59') + (we ? 0 : 60)] : null;
    const minSeconds = (num(args.min_minutes, 30) as number) * 60;

    const data = await loadCoverageData(client, from, to, idList(args.location_ids));
    if (data.org.supervisorDeptIds.size === 0) {
      return guardResponse({ from, to, mode, note: 'No department named "Supervisor(s)" found; nothing to evaluate.' }, []);
    }
    const gaps = findGaps(data, window, minSeconds);
    const overlapsList = findOverlaps(data, window, minSeconds);
    const suggestions = suggest(data, gaps, overlapsList);
    const loc = (id: number) => data.org.locationName(id);

    const rows = mode === 'gaps'
      ? gaps.map((g) => ({
          location_id: g.location_id,
          location_name: loc(g.location_id),
          date: g.date,
          start_iso: toZonedISO(g.span[0]),
          finish_iso: toZonedISO(g.span[1]),
          hours: round2((g.span[1] - g.span[0]) / 3600),
          staff_on_site: g.staff,
        }))
      : overlapsList.map((o) => ({
          type: o.type,
          date: o.date,
          supervisors: o.user_ids.map((id) => ({ id, name: data.people.name(id) })),
          locations: o.location_ids.map((id) => ({ id, name: loc(id) })),
          start_iso: toZonedISO(o.span[0]),
          finish_iso: toZonedISO(o.span[1]),
          hours: round2((o.span[1] - o.span[0]) / 3600),
        }));

    const sitesWithWork = new Set(data.work.map((w) => w.location_id));
    return guardResponse(
      {
        from,
        to,
        mode,
        ...(ws || we ? { window: `${ws || '00:00'}-${we || '24:00'}` } : {}),
        sites_with_staff: sitesWithWork.size,
        supervisors_rostered: new Set(data.supervisor.map((s) => s.user_id)).size,
        gaps: gaps.length,
        gap_hours: round2(totalSeconds(gaps.map((g) => g.span)) / 3600),
        sites_with_gaps: new Set(gaps.map((g) => g.location_id)).size,
        overlaps: overlapsList.length,
        double_booked: overlapsList.filter((o) => o.type === 'double_booked').length,
      },
      rows,
      { offset: args.offset, pageSize: args.limit, extra: { suggestions } }
    );
  },
};
