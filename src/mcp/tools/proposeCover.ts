/**
 * WFM-103 (#62): "X is out at site Y on date Z" -> ranked people who could take X's shift
 * without a clash, leave, unavailability or going over the weekly hour limit. Draft only:
 * it only GETs /locations, /departments, /users, /schedules, /leave and /unavailability.
 */
import { Tool } from './types';
import { ArgError, num } from '../args';
import { coverageExcludedUserIds, hasLevel, loadOrg, loadPeople, Org } from '../context';
import { guardResponse } from '../guard';
import { Rec } from '../../tanda/client';
import { itemDate, itemHours } from '../../tanda/normalize';
import { isDate, localToUnix, parseLocalDateTime, round2, todayInZone, toUnixSeconds, toZonedDate, toZonedISO } from '../../utils/time';
import { Interval, overlaps } from './intervals';
import { soft, Warning, withWarnings } from '../warnings';
import { workweek } from '../workweek';
import { isOfficeOnly, isTestOrNoStartDate, officeAllowedIds, userSitesFrom } from '../apps/staffing';
import { tenureFrom } from '../apps/tenure';

const DEFAULT_CANDIDATES = 5;
const MAX_CANDIDATES = 10;
const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;

/** A shift that needs someone: the absent person's rostered shift, or one described in the arguments. */
export interface CoverNeed {
  schedule_id: unknown;
  location_id: number | null;
  department_id: number | null;
  span: Interval;
  hours: number;
}

export type Exclusion = 'on_leave' | 'unavailable' | 'rostered_at_that_time' | 'over_weekly_hours';

/** Parse "HH:MM" (on `date`) or a full date-time; finish at or before start rolls to the next day. */
function parseSpan(date: string, start: unknown, finish: unknown): Interval {
  const at = (v: unknown, name: string): number => {
    const t = typeof v === 'string' && HHMM.test(v.trim()) ? localToUnix(date, v.trim()) : parseLocalDateTime(v);
    if (t === null) throw new ArgError(`${name} must be "HH:MM" or a date-time like "${date} 17:00".`);
    return t;
  };
  const s = at(start, 'start');
  let f = at(finish, 'finish');
  if (f <= s) f += 24 * 3600;
  if (f - s > 16 * 3600) throw new ArgError('start to finish must be at most 16 hours.');
  return [s, f];
}

/** Why `userId` can't take `need`, or null when they can. Checks run in the order listed in the summary. */
export function exclusionFor(
  userId: number,
  need: CoverNeed,
  ctx: { schedules: Rec[]; leave: Rec[]; unavailability: Rec[]; weekHours: Map<number, number>; maxWeekly: number }
): Exclusion | null {
  const startDate = toZonedDate(need.span[0]) as string;
  const finishDate = toZonedDate(need.span[1] - 1) as string;
  const onLeave = ctx.leave.some((l) => l.user_id === userId && l.status !== 'rejected' &&
    String(l.start).slice(0, 10) <= finishDate && String(l.finish ?? l.start).slice(0, 10) >= startDate);
  if (onLeave) return 'on_leave';
  const unavailable = ctx.unavailability.some((u) => {
    const us = toUnixSeconds(u.start);
    const uf = toUnixSeconds(u.finish);
    return u.user_id === userId && us !== null && uf !== null && overlaps(need.span, [us, uf]);
  });
  if (unavailable) return 'unavailable';
  const clash = ctx.schedules.some((s) => {
    const ss = toUnixSeconds(s.start);
    const sf = toUnixSeconds(s.finish);
    return s.user_id === userId && ss !== null && sf !== null && overlaps(need.span, [ss, sf]);
  });
  if (clash) return 'rostered_at_that_time';
  if ((ctx.weekHours.get(userId) || 0) + need.hours > ctx.maxWeekly) return 'over_weekly_hours';
  return null;
}

export type Familiarity = { depts: Map<number, Set<number>>; sites: Map<number, Set<number>> };

/** Sites and departments each person is on staff at or rostered to, for ranking. */
export function familiarity(org: Org, schedules: Rec[]): Familiarity {
  const depts = new Map<number, Set<number>>();
  const add = (uid: number, dept: number) => {
    let set = depts.get(uid);
    if (!set) depts.set(uid, (set = new Set()));
    set.add(dept);
  };
  for (const d of org.departments) for (const uid of Array.isArray(d.staff) ? (d.staff as number[]) : []) add(uid, d.id as number);
  for (const s of schedules) if (s.user_id && s.department_id) add(s.user_id as number, s.department_id as number);
  return { depts, sites: userSitesFrom(org, schedules) };
}

export interface LeftOut { office: number; test_or_no_start_date: number; not_employee_level: number }

/** Who may be proposed: active employee-level field staff, not test users, not `absentIds`; `left_out` counts the rest. */
export function coverPool(users: Rec[], org: Org, fam: Familiarity, absentIds: Set<number>): { pool: Rec[]; leftOut: LeftOut } {
  const excluded = coverageExcludedUserIds();
  const officeAllowed = officeAllowedIds();
  const leftOut: LeftOut = { office: 0, test_or_no_start_date: 0, not_employee_level: 0 };
  const pool: Rec[] = [];
  for (const u of users) {
    const id = u.id as number;
    if (absentIds.has(id) || u.active === false || excluded.has(id)) continue;
    if (isTestOrNoStartDate(u)) leftOut.test_or_no_start_date++;
    else if (!hasLevel(u, 'employee')) leftOut.not_employee_level++;
    else if (!officeAllowed.has(id) && isOfficeOnly(org, fam.sites.get(id))) leftOut.office++;
    else pool.push(u);
  }
  return { pool, leftOut };
}

export interface CoverCtx { schedules: Rec[]; leave: Rec[]; unavailability: Rec[]; weekHours: Map<number, number>; maxWeekly: number }

export interface RankedCandidate { u: Rec; knowsSite: boolean; sameDept: boolean; hours: number; months: number }

/**
 * Everyone in `pool` who can take `need`, best first: works in that department, then at that site,
 * then fewest hours this week, then longest tenure. `excluded` counts why the others can't.
 */
export function rankCover(need: CoverNeed, pool: Rec[], org: Org, fam: Familiarity, ctx: CoverCtx, today: string): { ranked: RankedCandidate[]; excluded: Record<string, number> } {
  // A Supervisor-department shift is only offered to people on a Supervisor department's staff
  const supervisorShift = need.department_id !== null && org.supervisorDeptIds.has(need.department_id);
  const counts: Record<Exclusion, number> = { on_leave: 0, unavailable: 0, rostered_at_that_time: 0, over_weekly_hours: 0 };
  let notSupervisor = 0;
  const ranked: RankedCandidate[] = [];
  for (const u of pool) {
    const id = u.id as number;
    const depts = fam.depts.get(id) || new Set<number>();
    if (supervisorShift && ![...depts].some((d) => org.supervisorDeptIds.has(d))) {
      notSupervisor++;
      continue;
    }
    const why = exclusionFor(id, need, ctx);
    if (why) {
      counts[why]++;
      continue;
    }
    ranked.push({
      u,
      knowsSite: need.location_id !== null && (fam.sites.get(id)?.has(need.location_id) ?? false),
      sameDept: need.department_id !== null && depts.has(need.department_id),
      hours: ctx.weekHours.get(id) || 0,
      months: tenureFrom(u.employment_start_date, today)?.total_months ?? -1,
    });
  }
  ranked.sort((a, b) =>
    Number(b.sameDept) - Number(a.sameDept) || Number(b.knowsSite) - Number(a.knowsSite) ||
    a.hours - b.hours || b.months - a.months || String(a.u.name).localeCompare(String(b.u.name)));
  return { ranked, excluded: { ...counts, ...(supervisorShift ? { not_a_supervisor: notSupervisor } : {}) } };
}

/** One proposed person, with the reason in plain words. */
export function candidateRow(c: RankedCandidate, need: CoverNeed, maxWeekly: number, today: string): Rec {
  const after = round2(c.hours + need.hours);
  return {
    user_id: c.u.id,
    user_name: c.u.name ?? null,
    knows_site: c.knowsSite,
    same_department: c.sameDept,
    week_hours: round2(c.hours),
    week_hours_after: after,
    tenure_label: tenureFrom(c.u.employment_start_date, today)?.label ?? null,
    why: [
      c.sameDept ? 'works in this department' : c.knowsSite ? 'works at this site' : 'new to this site',
      `${after}h of ${maxWeekly}h this week with the shift`,
    ].join('; '),
  };
}

/** Hours each person is rostered in `schedules` (callers pass one workweek). */
export function hoursByUser(schedules: Rec[]): Map<number, number> {
  const weekHours = new Map<number, number>();
  for (const s of schedules) {
    const uid = s.user_id as number | null | undefined;
    if (uid) weekHours.set(uid, (weekHours.get(uid) || 0) + itemHours(s));
  }
  return weekHours;
}

export const proposeCoverTool: Tool = {
  name: 'tanda_propose_cover',
  description:
    'Draft cover for an absence: given who is out and the date (or a site and start/finish), ranks people who could take each shift with no clash, leave, unavailability or overtime, preferring people who know the site; nothing is written to Tanda.',
  inputSchema: {
    type: 'object',
    properties: {
      user_id: { type: 'number', description: 'Who is out. Their rostered shifts that day are the shifts to cover' },
      date: { type: 'string', description: 'YYYY-MM-DD. Default today' },
      location_id: { type: 'number', description: 'Only cover the shift at this site; with start/finish, the site of the shift to cover' },
      department_id: { type: 'number', description: 'With start/finish: the department of the shift to cover' },
      start: { type: 'string', description: 'With finish: the shift to cover when nobody is rostered, "HH:MM" or "YYYY-MM-DD HH:MM"' },
      finish: { type: 'string', description: '"HH:MM" or "YYYY-MM-DD HH:MM"; at or before start means the next day' },
      max_candidates: { type: 'number', description: `People listed per shift. Default ${DEFAULT_CANDIDATES}, max ${MAX_CANDIDATES}` },
      max_weekly_hours: { type: 'number', description: 'Nobody is proposed if the shift takes their workweek past this. Default 40' },
      workweek_start: { type: 'string', enum: ['SUN', 'MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT'], description: 'First day of the overtime week. Default WORKWEEK_START (MON)' },
    },
  },
  async run(client, args) {
    const absent = num(args.user_id) ?? null;
    if (absent !== null && !(absent > 0)) throw new ArgError('user_id must be a positive number.');
    const date = (args.date ?? todayInZone()) as unknown;
    if (!isDate(date)) throw new ArgError('`date` must be a date in YYYY-MM-DD format.');
    const locationId = num(args.location_id) ?? null;
    const deptArg = num(args.department_id) ?? null;
    const hasTimes = args.start !== undefined && args.start !== '' && args.finish !== undefined && args.finish !== '';
    if (absent === null && !hasTimes) throw new ArgError('Give user_id (who is out), or start and finish with location_id or department_id.');
    const given = hasTimes ? parseSpan(date, args.start, args.finish) : null;
    const maxCandidates = Math.floor(num(args.max_candidates, DEFAULT_CANDIDATES) as number);
    if (!(maxCandidates >= 1 && maxCandidates <= MAX_CANDIDATES)) throw new ArgError(`max_candidates must be between 1 and ${MAX_CANDIDATES}.`);
    const maxWeekly = num(args.max_weekly_hours, 40) as number;
    if (!(maxWeekly > 0 && maxWeekly <= 80)) throw new ArgError('max_weekly_hours must be above 0 and at most 80.');
    const week = workweek(args.workweek_start);

    const warnings: Warning[] = [];
    const from = week.start(date);
    const to = week.end(date);
    const [org, people, schedules] = await Promise.all([
      loadOrg(client),
      loadPeople(client),
      // Whole workweek, so weekly hours count every rostered shift; one 7-day call
      client.getSchedules({ from, to }),
    ]);

    // The shifts to cover
    let needs: CoverNeed[] = [];
    if (absent !== null) {
      needs = schedules
        .filter((s) => s.user_id === absent && itemDate(s) === date)
        .map((s) => {
          const dept = (s.department_id as number | undefined) ?? null;
          return { schedule_id: s.id, department_id: dept, location_id: dept !== null ? org.deptLocation.get(dept) ?? null : null, s };
        })
        .filter((n) => locationId === null || n.location_id === locationId)
        .map(({ s, ...n }) => ({ ...n, span: [toUnixSeconds(s.start), toUnixSeconds(s.finish)] as Interval, hours: itemHours(s) }))
        .filter((n) => n.span[0] !== null && n.span[1] !== null && n.span[1] > n.span[0]);
    }
    if (!needs.length && given) {
      const loc = locationId ?? (deptArg !== null ? org.deptLocation.get(deptArg) ?? null : null);
      if (loc === null) throw new ArgError('With start/finish, give location_id or department_id for the shift to cover.');
      needs = [{ schedule_id: null, location_id: loc, department_id: deptArg, span: given, hours: round2((given[1] - given[0]) / 3600) }];
    }
    const absentName = absent !== null ? people.name(absent) : null;
    if (!needs.length) {
      return guardResponse(
        {
          date,
          absent_user: absent !== null ? { id: absent, name: absentName } : null,
          shifts: [],
          note: `No rostered shift found for user ${absent} on ${date}${locationId !== null ? ` at site ${locationId}` : ''}. Pass start, finish and location_id to describe the shift to cover. Nothing was written to Tanda.`,
        },
        []
      );
    }

    // Candidate pool: active employees who are field staff, not test users, not the absent person
    const fam = familiarity(org, schedules);
    const { pool, leftOut } = coverPool(people.users, org, fam, new Set(absent !== null ? [absent] : []));

    // Leave and unavailability over the shifts' dates (an overnight shift runs into the next day). Each fails soft.
    const poolIds = pool.map((u) => u.id as number);
    const lastDate = needs.map((n) => toZonedDate(n.span[1] - 1) as string).sort().pop() as string;
    const range = { from: date, to: lastDate > date ? lastDate : date, user_ids: poolIds };
    const [leave, unavailability] = poolIds.length
      ? await Promise.all([
          soft(warnings, 'leave', [] as Rec[], () => client.getLeaveRequests(range)),
          soft(warnings, 'unavailability', [] as Rec[], () => client.getUnavailability(range)),
        ])
      : [[], []];

    const weekHours = hoursByUser(schedules);
    // Shifts the absent person is giving up don't count against anyone
    const coveredIds = new Set<unknown>(needs.map((n) => n.schedule_id).filter((id) => id !== null));
    const others = schedules.filter((s) => !coveredIds.has(s.id));
    const ctx = { schedules: others, leave, unavailability, weekHours, maxWeekly };
    const today = todayInZone();

    const rows: Rec[] = [];
    const shifts = needs.map((need, index) => {
      const { ranked, excluded } = rankCover(need, pool, org, fam, ctx, today);
      ranked.slice(0, maxCandidates).forEach((c, i) => rows.push({ shift: index, rank: i + 1, ...candidateRow(c, need, maxWeekly, today) }));
      return {
        shift: index,
        schedule_id: need.schedule_id,
        location_id: need.location_id,
        location_name: org.locationName(need.location_id),
        department_name: org.departmentName(need.department_id),
        start_iso: toZonedISO(need.span[0]),
        finish_iso: toZonedISO(need.span[1]),
        hours: need.hours,
        eligible: ranked.length,
        excluded,
      };
    });

    return guardResponse(
      {
        date,
        absent_user: absent !== null ? { id: absent, name: absentName } : null,
        shifts,
        candidates_checked: pool.length,
        left_out: leftOut,
        week_basis: `${week.basis}, ${from}..${to}`,
        ...(warnings.length ? { checks_skipped: [...new Set(warnings.map((w) => w.check))] } : {}),
        ranking: 'Works in that department, then works at that site, then fewest hours this week, then longest tenure.',
        note: 'Draft only: nothing was written to Tanda and nobody was notified. A manager makes any change in Workforce.',
      },
      rows,
      { extra: withWarnings(warnings) }
    );
  },
};
