import { Tool } from './types';
import { ArgError, num } from '../args';
import { guardResponse } from '../guard';
import { Rec } from '../../tanda/client';
import { itemHours } from '../../tanda/normalize';
import { isDate, round2, todayInZone, addDays } from '../../utils/time';
import { cadence, parsePayCalendar, Period, periodContaining, previousPeriod } from '../payCalendar';
import { soft, Warning, withWarnings } from '../warnings';

const MAX_PRIOR = 4;

interface StatusTotals {
  timesheets: number;
  hours: number;
  cost: number;
}

export const payPeriodsTool: Tool = {
  name: 'tanda_pay_periods',
  description:
    'Returns the current and prior pay period boundaries (from PAY_CALENDAR, including the biweekly-to-weekly cutover) with a timesheet status rollup (pending / approved / exported) and $ by status for each; use it to see what is still open before payroll.',
  inputSchema: {
    type: 'object',
    properties: {
      date: { type: 'string', description: 'As-of date YYYY-MM-DD. Default today' },
      prior_periods: { type: 'number', description: `Prior periods to include. Default 1, max ${MAX_PRIOR}` },
    },
  },
  async run(client, args) {
    const asOf = (args.date as string | undefined) || todayInZone();
    if (!isDate(asOf)) throw new ArgError('date must be YYYY-MM-DD.');
    const prior = Math.min(Math.max(Math.floor(num(args.prior_periods, 1) as number), 0), MAX_PRIOR);
    const warnings: Warning[] = [];
    const { segments, errors } = parsePayCalendar();
    for (const e of errors) warnings.push({ check: 'pay_calendar', reason: e });

    const periods: Array<{ label: string; p: Period }> = [];
    let p = periodContaining(asOf, segments);
    periods.push({ label: 'current', p });
    for (let i = 1; i <= prior; i++) {
      p = previousPeriod(p, segments);
      periods.push({ label: `prior_${i}`, p });
    }

    const rows: Rec[] = [];
    for (const { label, p: period } of periods) {
      const sheets = await soft(warnings, `timesheets:${label}`, null as Rec[] | null, () =>
        client.getTimesheets({ from: period.start, to: period.finish, award_interpretation: false }));
      const byStatus: Record<string, StatusTotals> = {};
      const tandaRanges = new Set<string>();
      for (const ts of sheets || []) {
        const status = String(ts.status || 'unknown').toLowerCase();
        const b = (byStatus[status] ||= { timesheets: 0, hours: 0, cost: 0 });
        b.timesheets += 1;
        b.hours = round2(b.hours + ((ts.shifts as Rec[]) || []).reduce((n, s) => n + itemHours(s), 0));
        b.cost = round2(b.cost + ((ts.total_cost as number) || 0));
        if (typeof ts.start === 'string' && typeof ts.finish === 'string') tandaRanges.add(`${ts.start.slice(0, 10)}..${ts.finish.slice(0, 10)}`);
      }
      for (const s of ['pending', 'approved', 'exported']) byStatus[s] ||= { timesheets: 0, hours: 0, cost: 0 };
      const expected = `${period.start}..${period.finish}`;
      const mismatched = [...tandaRanges].filter((r) => r !== expected);
      if (mismatched.length) {
        warnings.push({ check: 'tanda_period_alignment', reason: `Tanda timesheets for ${label} cover ${mismatched.join(', ')}, not PAY_CALENDAR's ${expected}; totals count only shifts dated inside ${expected}` });
      }
      const totals = Object.values(byStatus);
      rows.push({
        period: label,
        start: period.start,
        finish: period.finish,
        days: period.days,
        cadence: period.cadence,
        state: period.finish < asOf ? 'ended' : 'open',
        ...(sheets === null ? { note: 'Timesheets could not be read; see warnings.' } : {}),
        by_status: byStatus,
        timesheets: totals.reduce((n, t) => n + t.timesheets, 0),
        cost: round2(totals.reduce((n, t) => n + t.cost, 0)),
        unapproved_cost: round2(Object.entries(byStatus).filter(([s]) => s !== 'approved' && s !== 'exported').reduce((n, [, t]) => n + t.cost, 0)),
      });
    }

    const current = periods[0].p;
    const next = periodContaining(addDays(current.finish, 1), segments);
    const changes = segments.slice(1).map((s, i) => ({ date: s.start, from: cadence(segments[i].days), to: cadence(s.days) }));
    return guardResponse(
      {
        as_of: asOf,
        current_period: { start: current.start, finish: current.finish, days: current.days, cadence: current.cadence },
        next_period: { start: next.start, finish: next.finish, days: next.days, cadence: next.cadence },
        ...(changes.length ? { cadence_changes: changes } : {}),
        calendar: segments.map((s) => `${s.start}:${s.days}`).join(','),
      },
      rows,
      { extra: withWarnings(warnings) }
    );
  },
};
