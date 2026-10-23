import { Tool } from './types';
import { ArgError, dateRange, idList, num, oneOf, S } from '../args';
import { guardResponse } from '../guard';
import { coverageExcludedUserIds, hasLevel, loadOrg, loadPeople, Org, People } from '../context';
import { Rec, TandaClient } from '../../tanda/client';
import { itemDate } from '../../tanda/normalize';
import { localToUnix, round2, toUnixSeconds, toZonedISO } from '../../utils/time';
import { clip, Interval, intersect, overlaps, subtract, totalSeconds, union } from './intervals';
import { soft, Warning, withWarnings } from '../warnings';

export const MAX_SUGGESTIONS = 10;
export const MODELS = ['site', 'roving'] as const;
export type SupervisionModel = (typeof MODELS)[number];
/** Sites one roving supervisor can cover at once (COVERAGE_ROVING_SITES, default 5). */
export const DEFAULT_ROVING_SITES = Number(process.env.COVERAGE_ROVING_SITES) || 5;
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
  /** Supervisor shifts at any site (ignores location_ids), for the roving model */
  rovers: Sched[];
  supervisorPool: Set<number>;
  /** COVERAGE_EXCLUDE_USER_IDS: never a supervisor, never suggested */
  excluded: Set<number>;
  /** Filled by loadAvailability; null = could not be checked */
  leave: Rec[] | null;
  unavailability: Rec[] | null;
}

/** Load schedules for the range and split them into supervisor vs work shifts, by LOCATION. */
export async function loadCoverageData(client: TandaClient, from: string, to: string, locIds?: number[]): Promise<CoverageData> {
  const [org, people] = await Promise.all([loadOrg(client), loadPeople(client)]);
  const schedules = await client.getSchedules({ from, to, include_names: true });
  const supervisor: Sched[] = [];
  const work: Sched[] = [];
  const all: Sched[] = [];
  const rovers: Sched[] = [];
  const pool = new Set<number>();
  const excluded = coverageExcludedUserIds();
  for (const id of org.supervisorDeptIds) for (const uid of (org.departmentById.get(id)?.staff as number[]) || []) if (!excluded.has(uid)) pool.add(uid);

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
    // An excluded user's shift in a Supervisor department is neither supervision nor site work
    if (org.supervisorDeptIds.has(deptId) && excluded.has(userId)) continue;
    if (org.supervisorDeptIds.has(deptId)) rovers.push(sched);
    if (locIds && !locIds.includes(locId)) continue;
    if (org.supervisorDeptIds.has(deptId)) {
      supervisor.push(sched);
      pool.add(userId);
    } else {
      work.push(sched);
    }
  }
  return { org, people, supervisor, work, all, rovers, supervisorPool: pool, excluded, leave: null, unavailability: null };
}

/** Leave + unavailability for the pool, so suggestions only name people who are available. Fails soft. */
export async function loadAvailability(client: TandaClient, data: CoverageData, from: string, to: string, warnings: Warning[]): Promise<void> {
  const userIds = [...data.supervisorPool];
  if (!userIds.length) return;
  [data.leave, data.unavailability] = await Promise.all([
    soft(warnings, 'suggestions.leave', null as Rec[] | null, () => client.getLeaveRequests({ from, to, user_ids: userIds })),
    soft(warnings, 'suggestions.unavailability', null as Rec[] | null, () => client.getUnavailability({ from, to, user_ids: userIds })),
  ]);
}

/**
 * May this user be suggested for `span` on `date`? They must hold the employee level, not be
 * excluded, and be rostered somewhere that day or confirmed available (no leave, no unavailability).
 */
export function isEligible(data: CoverageData, userId: number, date: string, span: Interval): boolean {
  if (data.excluded.has(userId) || !hasLevel(data.people.byId.get(userId), 'employee')) return false;
  const onLeave = (data.leave || []).some((l) => l.user_id === userId && l.status !== 'rejected' &&
    String(l.start).slice(0, 10) <= date && String(l.finish ?? l.start).slice(0, 10) >= date);
  if (onLeave) return false;
  const unavailable = (data.unavailability || []).some((u) => {
    const us = toUnixSeconds(u.start);
    const uf = toUnixSeconds(u.finish);
    return u.user_id === userId && us !== null && uf !== null && overlaps(span, [us, uf]);
  });
  if (unavailable) return false;
  if (data.all.some((s) => s.user_id === userId && s.date === date)) return true;
  return data.leave !== null && data.unavailability !== null;
}

export interface Gap {
  /** null in the roving model (the gap is not tied to one site) */
  location_id: number | null;
  date: string;
  span: Interval;
  staff: number;
  /** Roving model only: peak staffed sites, supervisors on duty and sites left uncovered */
  sites?: number;
  supervisors?: number;
  uncovered_sites?: number;
}

const groupBy = <T>(items: T[], key: (t: T) => string): Map<string, T[]> => {
  const m = new Map<string, T[]>();
  for (const it of items) (m.get(key(it)) || m.set(key(it), []).get(key(it))!).push(it);
  return m;
};

/** Site model: every staffed site needs a Supervisor-department shift at that same site. */
export function findGaps(data: CoverageData, window: (date: string) => Interval | null, minGapSeconds: number): Gap[] {
  const key = (s: Sched) => `${s.location_id}|${s.date}`;
  const work = groupBy(data.work, key);
  const sup = new Map([...groupBy(data.supervisor, key)].map(([k, v]) => [k, v.map((s) => s.span)]));

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

/**
 * Roving model: one supervisor on duty anywhere covers up to `sitesPerSupervisor` staffed sites
 * at a time. A gap is a stretch where staffed sites exceed supervisors on duty x sitesPerSupervisor.
 */
export function findRovingGaps(data: CoverageData, window: (date: string) => Interval | null, minGapSeconds: number, sitesPerSupervisor: number): Gap[] {
  const work = groupBy(data.work, (s) => s.date);
  const sups = groupBy(data.rovers, (s) => s.date);
  const gaps: Gap[] = [];
  for (const [date, shifts] of work) {
    const w = window(date);
    const onDuty = sups.get(date) || [];
    const points = [...new Set([...shifts, ...onDuty].flatMap((s) => (w ? clip([s.span], w) : [s.span]).flat()))].sort((a, b) => a - b);
    let open: Gap | null = null;
    const close = () => {
      if (open && open.span[1] - open.span[0] >= minGapSeconds) gaps.push(open);
      open = null;
    };
    for (let i = 0; i + 1 < points.length; i++) {
      const seg: Interval = [points[i], points[i + 1]];
      const here = shifts.filter((s) => overlaps(s.span, seg));
      const sites = new Set(here.map((s) => s.location_id)).size;
      const supervisors = new Set(onDuty.filter((s) => overlaps(s.span, seg)).map((s) => s.user_id)).size;
      const uncovered = Math.max(0, sites - supervisors * sitesPerSupervisor);
      if (uncovered === 0) {
        close();
        continue;
      }
      const staff = new Set(here.map((s) => s.user_id)).size;
      const cur = open as Gap | null;
      if (cur && cur.span[1] === seg[0]) {
        cur.span = [cur.span[0], seg[1]];
        cur.sites = Math.max(cur.sites as number, sites);
        cur.supervisors = Math.min(cur.supervisors as number, supervisors);
        cur.uncovered_sites = Math.max(cur.uncovered_sites as number, uncovered);
        cur.staff = Math.max(cur.staff, staff);
      } else {
        close();
        open = { location_id: null, date, span: seg, staff, sites, supervisors, uncovered_sites: uncovered };
      }
    }
    close();
  }
  return gaps.sort((a, b) =>
    (b.uncovered_sites as number) * (b.span[1] - b.span[0]) - (a.uncovered_sites as number) * (a.span[1] - a.span[0]));
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

/**
 * Up to 10 concrete moves: reassign a redundant supervisor, else add an eligible free supervisor.
 * Only users who pass isEligible are ever named.
 */
export function suggest(data: CoverageData, gaps: Gap[], overlapsList: Overlap[], sitesPerSupervisor = DEFAULT_ROVING_SITES): Rec[] {
  const out: Rec[] = [];
  const taken: Array<{ user: number; span: Interval }> = [];
  const loc = (id: number | null) => (id === null ? 'roving (any site)' : data.org.locationName(id));
  const name = (id: number) => data.people.name(id);

  // 1. Redundant supervisors (same site, same time) -> largest gap that day they could cover
  const usedGaps = new Set<Gap>();
  for (const o of overlapsList.filter((x) => x.type === 'same_location')) {
    if (out.length >= MAX_SUGGESTIONS) break;
    const mover = o.user_ids[1];
    const gap = gaps.find(
      (g) =>
        !usedGaps.has(g) && g.date === o.date && overlaps(g.span, o.span) && g.location_id !== o.location_ids[0] &&
        isEligible(data, mover, g.date, g.span) &&
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
      reason: `Overlaps ${name(o.user_ids[0]) ?? o.user_ids[0]} at ${loc(o.location_ids[0])}; ${gap.location_id === null ? `${gap.uncovered_sites} staffed sites` : loc(gap.location_id)} ha${gap.location_id === null ? 've' : 's'} ${round2((gap.span[1] - gap.span[0]) / 3600)}h without a supervisor.`,
    });
  }

  // 2. Remaining gaps -> any eligible supervisor free for the whole gap
  for (const gap of gaps) {
    if (out.length >= MAX_SUGGESTIONS) break;
    if (usedGaps.has(gap)) continue;
    const candidate = [...data.supervisorPool].find((u) => isEligible(data, u, gap.date, gap.span) && isFree(data, u, gap.span, taken));
    usedGaps.add(gap);
    if (candidate !== undefined) taken.push({ user: candidate, span: gap.span });
    const what = gap.location_id === null
      ? `${gap.uncovered_sites} of ${gap.sites} staffed sites are beyond what ${gap.supervisors} supervisor(s) on duty can cover (${sitesPerSupervisor} sites each)`
      : `${gap.staff} staff on site with no supervisor`;
    out.push({
      action: candidate !== undefined ? 'add_shift' : 'unfilled',
      ...(candidate !== undefined ? { user_id: candidate, user_name: name(candidate) } : {}),
      to_location_id: gap.location_id,
      to_location: loc(gap.location_id),
      date: gap.date,
      start_iso: toZonedISO(gap.span[0]),
      finish_iso: toZonedISO(gap.span[1]),
      reason: candidate !== undefined
        ? `${what}; this supervisor is eligible and not rostered at that time.`
        : `${what}; no eligible supervisor is free for the whole window.`,
    });
  }
  return out.slice(0, MAX_SUGGESTIONS);
}

/** Plain-language statement of how the gaps were computed, returned with every response. */
export function assumptions(data: CoverageData, model: SupervisionModel, sitesPerSupervisor: number): string[] {
  const out = [
    model === 'site'
      ? 'Supervision model "site": every site with staff on shift needs a Supervisor-department shift at that same site.'
      : `Supervision model "roving": one supervisor on duty anywhere covers up to ${sitesPerSupervisor} staffed sites at a time; a gap is when staffed sites exceed ${sitesPerSupervisor} x supervisors on duty.`,
    'Supervisors are users rostered to, or on the staff of, a department named "Supervisor" or "Supervisors".',
    'Bookkeeping sites are left out.',
    data.excluded.size
      ? `${data.excluded.size} user(s) in COVERAGE_EXCLUDE_USER_IDS are never counted as supervisors or suggested.`
      : 'COVERAGE_EXCLUDE_USER_IDS is not set, so no users are excluded from supervisor coverage.',
    'Suggestions only name users with the "employee" level who are rostered that day or confirmed available (no leave or unavailability).',
  ];
  if (data.leave === null || data.unavailability === null) {
    out.push('Availability could not be confirmed (see warnings), so only supervisors already rostered that day are suggested.');
  }
  return out;
}

export const coverageTool: Tool = {
  name: 'tanda_coverage',
  description:
    'Returns supervisor coverage problems: gaps (staffed sites with no supervisor, per site or under a roving model) or overlaps (two supervisors at one site, or one double-booked), plus up to 10 suggested moves and the assumptions used.',
  inputSchema: {
    type: 'object',
    properties: {
      mode: { type: 'string', enum: ['gaps', 'overlaps'], description: 'Default gaps' },
      supervision_model: { type: 'string', enum: [...MODELS], description: 'site = a supervisor at every staffed site (default); roving = one supervisor covers several sites' },
      sites_per_supervisor: { type: 'number', description: `Roving model: sites one supervisor covers at once. Default ${DEFAULT_ROVING_SITES}` },
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
    const envModel = (MODELS as readonly string[]).includes(String(process.env.COVERAGE_SUPERVISION_MODEL)) ? (process.env.COVERAGE_SUPERVISION_MODEL as SupervisionModel) : 'site';
    const model = oneOf(args.supervision_model, MODELS, envModel, 'supervision_model');
    const perSup = num(args.sites_per_supervisor, DEFAULT_ROVING_SITES) as number;
    if (!(perSup >= 1)) throw new ArgError('sites_per_supervisor must be at least 1.');
    const { from, to } = dateRange(args);
    const ws = args.window_start as string | undefined;
    const we = args.window_end as string | undefined;
    if ((ws && !HHMM.test(ws)) || (we && !HHMM.test(we))) throw new ArgError('window_start/window_end must be HH:MM (24h).');
    const window = (date: string): Interval | null =>
      ws || we ? [localToUnix(date, ws || '00:00'), localToUnix(date, we || '23:59') + (we ? 0 : 60)] : null;
    const minSeconds = (num(args.min_minutes, 30) as number) * 60;

    const warnings: Warning[] = [];
    const data = await loadCoverageData(client, from, to, idList(args.location_ids));
    if (data.org.supervisorDeptIds.size === 0) {
      return guardResponse({ from, to, mode, note: 'No department named "Supervisor(s)" found; nothing to evaluate.' }, []);
    }
    const gaps = model === 'roving' ? findRovingGaps(data, window, minSeconds, perSup) : findGaps(data, window, minSeconds);
    const overlapsList = findOverlaps(data, window, minSeconds);
    if (gaps.length) await loadAvailability(client, data, from, to, warnings);
    const suggestions = suggest(data, gaps, overlapsList, perSup);
    const loc = (id: number) => data.org.locationName(id);

    const rows = mode === 'gaps'
      ? gaps.map((g) => ({
          ...(g.location_id === null
            ? { sites_with_staff: g.sites, supervisors_on_duty: g.supervisors, capacity_sites: (g.supervisors as number) * perSup, uncovered_sites: g.uncovered_sites }
            : { location_id: g.location_id, location_name: loc(g.location_id) }),
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
        supervision_model: model,
        ...(model === 'roving' ? { sites_per_supervisor: perSup } : {}),
        ...(ws || we ? { window: `${ws || '00:00'}-${we || '24:00'}` } : {}),
        sites_with_staff: sitesWithWork.size,
        supervisors_rostered: new Set((model === 'roving' ? data.rovers : data.supervisor).map((s) => s.user_id)).size,
        gaps: gaps.length,
        gap_hours: round2(totalSeconds(gaps.map((g) => g.span)) / 3600),
        ...(model === 'roving'
          ? { uncovered_site_hours: round2(gaps.reduce((n, g) => n + (g.uncovered_sites as number) * (g.span[1] - g.span[0]), 0) / 3600) }
          : { sites_with_gaps: new Set(gaps.map((g) => g.location_id)).size }),
        overlaps: overlapsList.length,
        double_booked: overlapsList.filter((o) => o.type === 'double_booked').length,
      },
      rows,
      { offset: args.offset, pageSize: args.limit, extra: { assumptions: assumptions(data, model, perSup), suggestions, ...withWarnings(warnings) } }
    );
  },
};
