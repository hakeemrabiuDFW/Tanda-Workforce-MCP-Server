import { Tool } from './types';
import { ArgError, dateRange, idList, num, S } from '../args';
import { guardResponse } from '../guard';
import { departmentsForLocations, loadOrg, loadPeople } from '../context';
import { Rec } from '../../tanda/client';
import { itemDate, itemHours } from '../../tanda/normalize';
import { addDays, round2, todayInZone, toUnixSeconds, toZonedISO } from '../../utils/time';
import { OPEN_SHIFT_FLAG_HOURS } from './live';
import { workweek } from '../workweek';

export const CHECKS = [
  'open_shift_over_12h',
  'zero_length_shift',
  'stale_pending_leave',
  'unapproved_timesheet_cost',
  'missing_award_template',
  'weekly_hours_over_40',
  'projected_over_40',
] as const;
type Check = (typeof CHECKS)[number];

const WEEKLY_LIMIT = 40;

/** Default lookback for pending timesheets in earlier pay periods (OPEN_PERIOD_LOOKBACK_DAYS). */
export const OPEN_PERIOD_LOOKBACK_DAYS = Number(process.env.OPEN_PERIOD_LOOKBACK_DAYS) || 42;

/** Anything not yet approved or exported is unapproved exposure. */
export function isUnapproved(status: unknown): boolean {
  const s = String(status || '').toLowerCase();
  return s !== 'approved' && s !== 'exported';
}

const period = (ts: Rec) => ({ start: String(ts.start ?? '').slice(0, 10), finish: String(ts.finish ?? '').slice(0, 10) });

interface Exposure {
  cost: number;
  hours: number;
  timesheets: number;
  period_ranges: string[];
}

/** Unapproved $ / hours / timesheet count, plus the distinct pay-period ranges they fall in. */
function exposure(sheets: Array<{ ts: Rec; cost: number; hours: number }>): Exposure {
  const ranges = new Set<string>();
  let cost = 0;
  let hours = 0;
  for (const { ts, cost: c, hours: h } of sheets) {
    const p = period(ts);
    if (p.start) ranges.add(`${p.start}..${p.finish}`);
    cost += c;
    hours += h;
  }
  return { cost: round2(cost), hours: round2(hours), timesheets: sheets.length, period_ranges: [...ranges].sort() };
}

export const exceptionsTool: Tool = {
  name: 'tanda_exceptions',
  description:
    'Returns payroll/compliance exceptions: shifts open > 12h, zero-length shifts, pending leave already in the past, unapproved timesheet $ by site, active staff with no award template, and > 40h calendar workweeks (worked, and projected for the current week); use it as a daily/weekly audit.',
  inputSchema: {
    type: 'object',
    properties: {
      from: { ...S.from, description: 'Start date YYYY-MM-DD. Default 6 days ago' },
      to: { ...S.to, description: 'End date YYYY-MM-DD. Default today' },
      checks: { type: 'array', items: { type: 'string', enum: [...CHECKS] }, description: 'Subset of checks to run. Default all' },
      location_ids: S.locationIds,
      workweek_start: { type: 'string', enum: ['SUN', 'MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT'], description: 'First day of the overtime workweek. Default WORKWEEK_START (MON)' },
      open_period_lookback_days: { type: 'number', description: `How far back unapproved_timesheet_cost looks for still-pending pay periods. Default ${OPEN_PERIOD_LOOKBACK_DAYS}, max 90` },
      offset: S.offset,
      limit: S.limit,
    },
  },
  async run(client, args) {
    const { from, to } = dateRange(args, { defaultBackDays: 6 });
    let checks: Check[] = [...CHECKS];
    if (args.checks !== undefined) {
      const requested = (Array.isArray(args.checks) ? args.checks : String(args.checks).split(',')).map((c) => String(c).trim());
      const bad = requested.filter((c) => !CHECKS.includes(c as Check));
      if (bad.length) throw new ArgError(`Unknown checks: ${bad.join(', ')}. Valid: ${CHECKS.join(', ')}.`);
      checks = requested as Check[];
    }
    const want = (c: Check) => checks.includes(c);
    const week = workweek(args.workweek_start);

    const [org, people] = await Promise.all([loadOrg(client), loadPeople(client)]);
    const locIds = idList(args.location_ids);
    const deptFilter = locIds ? new Set(departmentsForLocations(org, locIds)) : null;
    const inScope = (deptId: unknown) => !deptFilter || deptFilter.has(deptId as number);
    const site = (deptId: unknown) => {
      const loc = deptId !== null && deptId !== undefined ? org.deptLocation.get(deptId as number) ?? null : null;
      return { location_id: loc, location_name: org.locationName(loc) };
    };
    const name = (id: unknown) => people.name(id);
    const rows: Rec[] = [];
    const counts: Record<string, number> = {};
    const add = (type: Check, row: Rec) => {
      counts[type] = (counts[type] || 0) + 1;
      rows.push({ type, ...row });
    };
    const extra: Rec = {};

    if (want('open_shift_over_12h')) {
      const now = Math.floor(Date.now() / 1000);
      for (const s of await client.getActiveShifts()) {
        const start = toUnixSeconds(s.start);
        if (start === null || !inScope(s.department_id)) continue;
        const hours = (now - start) / 3600;
        if (hours > OPEN_SHIFT_FLAG_HOURS) {
          add('open_shift_over_12h', { shift_id: s.id, user_id: s.user_id, user_name: name(s.user_id), ...site(s.department_id), start_iso: toZonedISO(start), open_hours: round2(hours) });
        }
      }
    }

    const weeklyChecks = want('weekly_hours_over_40') || want('projected_over_40');
    if (want('zero_length_shift') || weeklyChecks) {
      // Weekly totals use whole calendar workweeks, never the rolling window
      const today = todayInZone();
      const shiftTo = want('projected_over_40') && week.end(today) > week.end(to) ? week.end(today) : week.end(to);
      const shifts = await client.getShifts({ from: week.start(from), to: shiftTo });
      if (want('zero_length_shift')) {
        for (const s of shifts) {
          const d = itemDate(s);
          const st = toUnixSeconds(s.start);
          if (!d || d < from || d > to || !inScope(s.department_id)) continue;
          if (st !== null && st === toUnixSeconds(s.finish)) {
            add('zero_length_shift', { shift_id: s.id, user_id: s.user_id, user_name: name(s.user_id), date: d, ...site(s.department_id), start_iso: toZonedISO(st) });
          }
        }
      }
      if (weeklyChecks) {
        extra.week_basis = week.basis;
        const worked = new Map<string, number>();
        for (const s of shifts) {
          const d = itemDate(s);
          if (!d || toUnixSeconds(s.finish) === null) continue;
          const k = `${s.user_id}|${week.start(d)}`;
          worked.set(k, (worked.get(k) || 0) + itemHours(s));
        }

        if (want('weekly_hours_over_40')) {
          const weeks = new Set<string>();
          for (let d = week.start(from); d <= to; d = addDays(d, 7)) weeks.add(d);
          extra.weeks = [...weeks].map((w) => ({ week_start: w, week_end: addDays(w, 6), ...(w <= today && today <= addDays(w, 6) ? { partial: true } : {}) }));
          for (const [k, hours] of worked) {
            const [uid, ws] = k.split('|');
            if (hours > WEEKLY_LIMIT && weeks.has(ws)) {
              add('weekly_hours_over_40', { user_id: Number(uid), user_name: name(Number(uid)), week_start: ws, week_end: addDays(ws, 6), week_of: ws, hours: round2(hours), over_by: round2(hours - WEEKLY_LIMIT) });
            }
          }
        }

        if (want('projected_over_40')) {
          const cur = week.start(today);
          const curEnd = addDays(cur, 6);
          if (curEnd < from || cur > to) {
            extra.projected_note = `The current workweek (${cur}..${curEnd}) is outside ${from}..${to}; projected_over_40 not evaluated.`;
          } else {
            // Worked so far = finished shifts + elapsed time on open shifts; remaining = rostered time after now
            const now = Math.floor(Date.now() / 1000);
            const done = new Map<number, number>();
            for (const s of shifts) {
              const d = itemDate(s);
              if (!d || week.start(d) !== cur) continue;
              const st = toUnixSeconds(s.start);
              const fi = toUnixSeconds(s.finish);
              const h = fi !== null ? itemHours(s) : st !== null && st < now ? (now - st) / 3600 : 0;
              done.set(s.user_id as number, (done.get(s.user_id as number) || 0) + h);
            }
            const remaining = new Map<number, number>();
            for (const sc of await client.getSchedules({ from: today, to: curEnd })) {
              const st = toUnixSeconds(sc.start);
              const fi = toUnixSeconds(sc.finish);
              const uid = sc.user_id as number;
              const d = itemDate(sc);
              if (!uid || st === null || fi === null || fi <= now || !d || d > curEnd) continue;
              remaining.set(uid, (remaining.get(uid) || 0) + (st >= now ? itemHours(sc) : (fi - now) / 3600));
            }
            for (const uid of new Set([...done.keys(), ...remaining.keys()])) {
              const w = done.get(uid) || 0;
              const r = remaining.get(uid) || 0;
              if (w + r > WEEKLY_LIMIT) {
                add('projected_over_40', {
                  user_id: uid, user_name: name(uid), week_start: cur, week_end: curEnd,
                  worked_hours: round2(w), rostered_remaining_hours: round2(r), projected_hours: round2(w + r), over_by: round2(w + r - WEEKLY_LIMIT),
                });
              }
            }
          }
        }
      }
    }

    if (want('stale_pending_leave')) {
      const today = todayInZone();
      const leaveTo = to < today ? to : addDays(today, -1);
      if (from <= leaveTo) {
        for (const l of await client.getLeaveRequests({ from, to: leaveTo, status: 'pending' })) {
          const finish = String(l.finish || l.start || '').slice(0, 10);
          if (finish && finish < today) {
            add('stale_pending_leave', { leave_id: l.id, user_id: l.user_id, user_name: name(l.user_id), leave_type: l.leave_type ?? null, start: l.start, finish: l.finish });
          }
        }
      }
    }

    if (want('unapproved_timesheet_cost')) {
      const sheets = await client.getTimesheets({ from, to, award_interpretation: false });
      const bySite = new Map<number | null, { cost: number; hours: number; timesheets: Set<unknown> }>();
      const windowSheets: Array<{ ts: Rec; cost: number; hours: number }> = [];
      for (const ts of sheets) {
        if (!isUnapproved(ts.status)) continue;
        let tsCost = 0;
        let tsHours = 0;
        for (const s of ts.shifts as Rec[]) {
          if (!inScope(s.department_id)) continue;
          const loc = site(s.department_id).location_id;
          const b = bySite.get(loc) || { cost: 0, hours: 0, timesheets: new Set() };
          const c = typeof s.cost === 'number' ? s.cost : 0;
          b.cost += c;
          b.hours += itemHours(s);
          b.timesheets.add(ts.id);
          bySite.set(loc, b);
          tsCost += c;
          tsHours += itemHours(s);
        }
        if (tsCost || tsHours) windowSheets.push({ ts, cost: tsCost, hours: tsHours });
      }
      const list = [...bySite.entries()]
        .map(([loc, b]) => ({ location_id: loc, location_name: org.locationName(loc), unapproved_cost: round2(b.cost), hours: round2(b.hours), timesheets: b.timesheets.size }))
        .sort((a, b) => b.unapproved_cost - a.unapproved_cost);
      for (const r of list) add('unapproved_timesheet_cost', r);
      extra.unapproved_cost_total = round2(list.reduce((n, r) => n + r.unapproved_cost, 0));
      extra.window_unapproved_cost = { ...exposure(windowSheets), basis: `shifts dated ${from}..${to}` };

      // Every unapproved timesheet in a pay period that has ended or is current, whatever the window
      const today = todayInZone();
      const lookback = Math.min(Math.max(num(args.open_period_lookback_days, OPEN_PERIOD_LOOKBACK_DAYS) as number, 1), 90);
      const openSheets: Array<{ ts: Rec; cost: number; hours: number }> = [];
      for (const ts of await client.getOpenPeriodTimesheets({ asOf: today, lookbackDays: lookback })) {
        if (!isUnapproved(ts.status) || period(ts).start > today) continue;
        const kept = ((Array.isArray(ts.shifts) ? ts.shifts : []) as Rec[]).filter((s) => inScope(s.department_id));
        const cost = kept.length || deptFilter
          ? kept.reduce((n, s) => n + (typeof s.cost === 'number' ? s.cost : 0), 0)
          : typeof ts.cost === 'number' ? ts.cost : 0;
        const hours = kept.reduce((n, s) => n + itemHours(s), 0);
        if (cost || hours) openSheets.push({ ts, cost, hours });
      }
      const byPeriod = new Map<string, Array<{ ts: Rec; cost: number; hours: number }>>();
      for (const o of openSheets) {
        const p = period(o.ts);
        const k = `${p.start}..${p.finish}`;
        (byPeriod.get(k) || byPeriod.set(k, []).get(k)!).push(o);
      }
      extra.all_open_periods_unapproved_cost = { ...exposure(openSheets), as_of: today, lookback_days: lookback };
      extra.pending_open_periods = [...byPeriod.entries()]
        .map(([k, group]) => {
          const [start, finish] = k.split('..');
          const e = exposure(group);
          return { period_start: start, period_finish: finish, period_status: finish < today ? 'ended' : 'current', timesheets: e.timesheets, hours: e.hours, cost: e.cost };
        })
        .sort((a, b) => a.period_start.localeCompare(b.period_start));
    }

    if (want('missing_award_template')) {
      for (const u of people.users) {
        if (u.active === false || (u.award_template_id !== null && u.award_template_id !== undefined)) continue;
        if (deptFilter && !((u.department_ids as number[]) || []).some((d) => deptFilter.has(d))) continue;
        add('missing_award_template', { user_id: u.id, user_name: u.name, department_ids: u.department_ids ?? [] });
      }
    }

    return guardResponse({ from, to, checks, total: rows.length, by_type: counts, ...extra }, rows, {
      offset: args.offset,
      pageSize: args.limit,
    });
  },
};
