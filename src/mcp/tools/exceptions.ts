import { Tool } from './types';
import { ArgError, dateRange, idList, S } from '../args';
import { guardResponse } from '../guard';
import { departmentsForLocations, loadOrg, loadPeople } from '../context';
import { Rec } from '../../tanda/client';
import { itemDate, itemHours } from '../../tanda/normalize';
import { addDays, round2, todayInZone, toUnixSeconds, toZonedISO, weekStart } from '../../utils/time';
import { OPEN_SHIFT_FLAG_HOURS } from './live';

export const CHECKS = [
  'open_shift_over_12h',
  'zero_length_shift',
  'stale_pending_leave',
  'unapproved_timesheet_cost',
  'missing_award_template',
  'weekly_hours_over_40',
] as const;
type Check = (typeof CHECKS)[number];

export const exceptionsTool: Tool = {
  name: 'tanda_exceptions',
  description:
    'Returns payroll/compliance exceptions: shifts open > 12h, zero-length shifts, pending leave already in the past, unapproved timesheet $ by site, active staff with no award template, and > 40h weeks; use it as a daily/weekly audit.',
  inputSchema: {
    type: 'object',
    properties: {
      from: { ...S.from, description: 'Start date YYYY-MM-DD. Default 6 days ago' },
      to: { ...S.to, description: 'End date YYYY-MM-DD. Default today' },
      checks: { type: 'array', items: { type: 'string', enum: [...CHECKS] }, description: 'Subset of checks to run. Default all' },
      location_ids: S.locationIds,
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

    if (want('zero_length_shift') || want('weekly_hours_over_40')) {
      // Weekly totals need whole weeks
      const shifts = await client.getShifts({ from: weekStart(from), to: addDays(weekStart(to), 6) });
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
      if (want('weekly_hours_over_40')) {
        const weeks = new Map<string, number>();
        for (const s of shifts) {
          const d = itemDate(s);
          if (!d || toUnixSeconds(s.finish) === null) continue;
          const k = `${s.user_id}|${weekStart(d)}`;
          weeks.set(k, (weeks.get(k) || 0) + itemHours(s));
        }
        for (const [k, hours] of weeks) {
          const [uid, week] = k.split('|');
          if (hours > 40 && addDays(week, 6) >= from && week <= to) {
            add('weekly_hours_over_40', { user_id: Number(uid), user_name: name(Number(uid)), week_of: week, hours: round2(hours), over_by: round2(hours - 40) });
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
      for (const ts of sheets) {
        if (String(ts.status || '').toLowerCase() !== 'pending') continue;
        for (const s of ts.shifts as Rec[]) {
          if (!inScope(s.department_id)) continue;
          const loc = site(s.department_id).location_id;
          const b = bySite.get(loc) || { cost: 0, hours: 0, timesheets: new Set() };
          b.cost += typeof s.cost === 'number' ? s.cost : 0;
          b.hours += itemHours(s);
          b.timesheets.add(ts.id);
          bySite.set(loc, b);
        }
      }
      const list = [...bySite.entries()]
        .map(([loc, b]) => ({ location_id: loc, location_name: org.locationName(loc), unapproved_cost: round2(b.cost), hours: round2(b.hours), timesheets: b.timesheets.size }))
        .sort((a, b) => b.unapproved_cost - a.unapproved_cost);
      for (const r of list) add('unapproved_timesheet_cost', r);
      extra.unapproved_cost_total = round2(list.reduce((n, r) => n + r.unapproved_cost, 0));
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
