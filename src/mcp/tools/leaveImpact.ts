/**
 * WFM-104 (#63): for each pending leave request, the rostered shifts it would leave open,
 * whether anyone else is on site at that time, and a suggested fill ranked the same way as
 * tanda_propose_cover. Draft only: it only GETs /locations, /departments, /users, /schedules,
 * /leave and /unavailability.
 */
import { Tool } from './types';
import { ArgError, dateRange, idList, num, S } from '../args';
import { loadOrg, loadPeople } from '../context';
import { guardResponse } from '../guard';
import { Rec } from '../../tanda/client';
import { itemDate, itemHours } from '../../tanda/normalize';
import { addDays, daysBetween, round2, todayInZone, toUnixSeconds, toZonedISO } from '../../utils/time';
import { Interval, overlaps } from './intervals';
import { soft, Warning, withWarnings } from '../warnings';
import { workweek } from '../workweek';
import { candidateRow, CoverNeed, coverPool, familiarity, hoursByUser, rankCover } from './proposeCover';

const DEFAULT_DAYS = 14;
const MAX_DAYS = 28;
const DEFAULT_FILLS = 3;
const MAX_FILLS = 5;

type Impact = 'no_rostered_shifts' | 'shifts_to_cover' | 'site_left_empty';

/** Leave dates as YYYY-MM-DD; a missing finish means a single day. */
function leaveDates(l: Rec): [string, string] {
  const start = String(l.start).slice(0, 10);
  return [start, String(l.finish ?? l.start).slice(0, 10)];
}

/** Someone on any leave that has not been rejected (pending counts: it may be approved too). */
function onLeave(leave: Rec[], userId: unknown, date: string): boolean {
  return leave.some((l) => {
    if (l.user_id !== userId || l.status === 'rejected') return false;
    const [s, f] = leaveDates(l);
    return s <= date && f >= date;
  });
}

export const leaveImpactTool: Tool = {
  name: 'tanda_leave_impact',
  description:
    'For each pending leave request: the rostered shifts it would leave open, whether the site would be left empty, and a suggested fill per shift ranked like tanda_propose_cover; nothing is approved or written to Tanda.',
  inputSchema: {
    type: 'object',
    properties: {
      from: { type: 'string', description: 'YYYY-MM-DD. Default today' },
      to: { type: 'string', description: `YYYY-MM-DD. Default ${DEFAULT_DAYS} days from \`from\`, at most ${MAX_DAYS} days` },
      user_ids: S.userIds,
      location_id: { type: 'number', description: 'Only shifts at this site' },
      max_candidates: { type: 'number', description: `Suggested fills per shift. Default ${DEFAULT_FILLS}, max ${MAX_FILLS}` },
      max_weekly_hours: { type: 'number', description: 'Nobody is suggested if the shift takes their workweek past this. Default 40' },
      workweek_start: { type: 'string', enum: ['SUN', 'MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT'], description: 'First day of the overtime week. Default WORKWEEK_START (MON)' },
      offset: S.offset,
      limit: S.limit,
    },
  },
  async run(client, args) {
    const { from, to } = dateRange(args, { defaultSpan: DEFAULT_DAYS });
    if (daysBetween(from, to) >= MAX_DAYS) throw new ArgError(`Range is ${daysBetween(from, to) + 1} days; the maximum is ${MAX_DAYS}. Narrow from/to.`);
    const userIds = idList(args.user_ids);
    const locationId = num(args.location_id) ?? null;
    const maxFills = Math.floor(num(args.max_candidates, DEFAULT_FILLS) as number);
    if (!(maxFills >= 1 && maxFills <= MAX_FILLS)) throw new ArgError(`max_candidates must be between 1 and ${MAX_FILLS}.`);
    const maxWeekly = num(args.max_weekly_hours, 40) as number;
    if (!(maxWeekly > 0 && maxWeekly <= 80)) throw new ArgError('max_weekly_hours must be above 0 and at most 80.');
    const week = workweek(args.workweek_start);

    const warnings: Warning[] = [];
    // One day past `to` so an overnight shift's finish day is checked for leave and unavailability too
    const span = { from, to: addDays(to, 1) };
    const leave = await client.getLeaveRequests(span);
    const pending = leave
      .filter((l) => l.status === 'pending' && (!userIds || userIds.includes(l.user_id as number)))
      .filter((l) => {
        const [s, f] = leaveDates(l);
        return s <= to && f >= from;
      });
    const base = { from, to, ...(locationId !== null ? { location_id: locationId } : {}) };
    if (!pending.length) {
      return guardResponse(
        { ...base, pending_requests: 0, note: 'No pending leave requests in this range. Nothing was written to Tanda.' },
        []
      );
    }

    // Whole workweeks, so each shift's weekly hours count every rostered shift that week
    const [org, people, schedules, unavailability] = await Promise.all([
      loadOrg(client),
      loadPeople(client),
      client.getSchedules({ from: week.start(from), to: week.end(to) }),
      soft(warnings, 'unavailability', [] as Rec[], () => client.getUnavailability(span)),
    ]);

    // The shifts each request would leave open, inside the range
    const absentIds = new Set(pending.map((l) => l.user_id as number));
    const needsByRequest = pending.map((l) => {
      const [s, f] = leaveDates(l);
      return schedules
        .filter((x) => x.user_id === l.user_id)
        .map((x) => ({ x, date: itemDate(x) as string }))
        .filter(({ date }) => date && date >= s && date <= f && date >= from && date <= to)
        .map(({ x, date }) => {
          const dept = (x.department_id as number | undefined) ?? null;
          const need: CoverNeed = {
            schedule_id: x.id,
            department_id: dept,
            location_id: dept !== null ? org.deptLocation.get(dept) ?? null : null,
            span: [toUnixSeconds(x.start), toUnixSeconds(x.finish)] as Interval,
            hours: itemHours(x),
          };
          return { need, date };
        })
        .filter(({ need }) => (locationId === null || need.location_id === locationId) &&
          need.span[0] !== null && need.span[1] !== null && need.span[1] > need.span[0]);
    });

    const fam = familiarity(org, schedules);
    const { pool, leftOut } = coverPool(people.users, org, fam, absentIds);
    // Shifts the people on leave would give up don't count as clashes for anyone else
    const covered = new Set<unknown>(needsByRequest.flat().map(({ need }) => need.schedule_id));
    const others = schedules.filter((x) => !covered.has(x.id));
    const hoursByWeek = new Map<string, Map<number, number>>();
    const weekHours = (date: string) => {
      const key = week.start(date);
      let m = hoursByWeek.get(key);
      if (!m) {
        const end = week.end(date);
        hoursByWeek.set(key, (m = hoursByUser(schedules.filter((x) => {
          const d = itemDate(x);
          return d !== null && d >= key && d <= end;
        }))));
      }
      return m;
    };
    const today = todayInZone();

    const byImpact: Record<Impact, number> = { no_rostered_shifts: 0, shifts_to_cover: 0, site_left_empty: 0 };
    let shiftsAffected = 0;
    let hoursAffected = 0;
    let noFill = 0;
    const rows = pending.map((l, i) => {
      const [start, finish] = leaveDates(l);
      const shifts = needsByRequest[i].map(({ need, date }) => {
        // Anyone else rostered at that site at that time who isn't off too
        const othersOnSite = need.location_id === null ? 0 : others.filter((x) => {
          const xs = toUnixSeconds(x.start);
          const xf = toUnixSeconds(x.finish);
          const dept = (x.department_id as number | undefined) ?? null;
          return x.user_id && x.user_id !== l.user_id && dept !== null && org.deptLocation.get(dept) === need.location_id &&
            xs !== null && xf !== null && overlaps(need.span, [xs, xf]) && !onLeave(leave, x.user_id, date);
        }).length;
        const ctx = { schedules: others, leave, unavailability, weekHours: weekHours(date), maxWeekly };
        const { ranked, excluded } = rankCover(need, pool, org, fam, ctx, today);
        if (!ranked.length) noFill++;
        return {
          schedule_id: need.schedule_id,
          date,
          location_id: need.location_id,
          location_name: org.locationName(need.location_id),
          department_name: org.departmentName(need.department_id),
          start_iso: toZonedISO(need.span[0]),
          finish_iso: toZonedISO(need.span[1]),
          hours: need.hours,
          others_on_site: othersOnSite,
          eligible: ranked.length,
          excluded,
          suggested_fill: ranked.slice(0, maxFills).map((c, rank) => ({ rank: rank + 1, ...candidateRow(c, need, maxWeekly, today) })),
        };
      });
      const hours = round2(shifts.reduce((n, s) => n + s.hours, 0));
      const impact: Impact = !shifts.length ? 'no_rostered_shifts'
        : shifts.some((s) => s.location_id !== null && s.others_on_site === 0) ? 'site_left_empty' : 'shifts_to_cover';
      byImpact[impact]++;
      shiftsAffected += shifts.length;
      hoursAffected += hours;
      return {
        leave_id: l.id,
        user_id: l.user_id,
        user_name: people.name(l.user_id),
        leave_type: l.leave_type ?? null,
        start,
        finish,
        ...(l.all_day === false ? { all_day: false } : {}),
        impact,
        shifts_affected: shifts.length,
        hours_affected: hours,
        shifts,
      };
    });
    // Worst first: an empty site, then the most hours to cover, then the soonest
    const order: Record<Impact, number> = { site_left_empty: 0, shifts_to_cover: 1, no_rostered_shifts: 2 };
    rows.sort((a, b) => order[a.impact] - order[b.impact] || b.hours_affected - a.hours_affected || a.start.localeCompare(b.start));

    return guardResponse(
      {
        ...base,
        pending_requests: pending.length,
        by_impact: byImpact,
        shifts_affected: shiftsAffected,
        hours_affected: round2(hoursAffected),
        shifts_with_no_fill: noFill,
        candidates_checked: pool.length,
        left_out: leftOut,
        week_basis: week.basis,
        ...(warnings.length ? { checks_skipped: [...new Set(warnings.map((w) => w.check))] } : {}),
        ranking: 'Works in that department, then works at that site, then fewest hours that week, then longest tenure. Each shift is ranked on its own, so one person may be suggested for several.',
        note: 'Draft only: no leave was approved or declined, nothing was written to Tanda and nobody was notified. A manager decides in Workforce.',
      },
      rows,
      { offset: args.offset, pageSize: args.limit, extra: withWarnings(warnings) }
    );
  },
};
