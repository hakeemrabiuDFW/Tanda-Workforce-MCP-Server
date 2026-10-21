import { Tool } from './types';
import { bool, dateRange, idList, oneOf, S } from '../args';
import { guardResponse } from '../guard';
import { departmentsForLocations, loadOrg, loadPeople } from '../context';
import { groupTotals, topN, workRow } from './rows';
import { Rec } from '../../tanda/client';
import { round2 } from '../../utils/time';

/** Collapse Tanda award interpretation lines into hours/cost per export name. */
export function awardSummary(shift: Rec): Rec[] {
  const lines = Array.isArray(shift.award_interpretation) ? (shift.award_interpretation as Rec[]) : [];
  const map = new Map<string, { hours: number; cost: number }>();
  for (const l of lines) {
    const name = String(l.export_name || l.name || l.tag || 'unknown');
    const entry = map.get(name) || { hours: 0, cost: 0 };
    entry.hours += typeof l.units === 'number' ? l.units : typeof l.ordinary_hours === 'number' ? l.ordinary_hours : 0;
    entry.cost += typeof l.cost === 'number' ? l.cost : 0;
    map.set(name, entry);
  }
  return [...map.entries()].map(([pay_code, v]) => ({ pay_code, hours: round2(v.hours), cost: round2(v.cost) }));
}

export const timesheetsTool: Tool = {
  name: 'tanda_timesheets',
  description:
    'Returns worked time from timesheets (shifts embedded, with costs and award pay-code breakdown) for a date range, de-duplicated, with totals by status and site; use it for actual hours/cost and approval status.',
  inputSchema: {
    type: 'object',
    properties: {
      from: S.from,
      to: S.to,
      view: { type: 'string', enum: ['timesheets', 'shifts'], description: 'rows = one per timesheet (default) or one per shift with pay codes' },
      status: { type: 'string', enum: ['pending', 'approved', 'exported'], description: 'Filter by timesheet status' },
      user_ids: S.userIds,
      location_ids: S.locationIds,
      include_empty: { type: 'boolean', description: 'Keep timesheets with no shifts and $0 cost. Default false' },
      offset: S.offset,
      limit: S.limit,
    },
  },
  async run(client, args) {
    const { from, to } = dateRange(args, { defaultBackDays: 6 });
    const view = oneOf(args.view, ['timesheets', 'shifts'] as const, 'timesheets', 'view');
    const status = args.status ? oneOf(args.status, ['pending', 'approved', 'exported'] as const, 'pending', 'status') : null;
    const [org, people, sheets] = await Promise.all([
      loadOrg(client),
      loadPeople(client),
      client.getTimesheets({ from, to, user_ids: idList(args.user_ids), include_empty: bool(args.include_empty) }),
    ]);
    const locIds = idList(args.location_ids);
    const deptFilter = locIds ? new Set(departmentsForLocations(org, locIds)) : null;

    const shiftRows: Rec[] = [];
    const sheetRows: Rec[] = [];
    for (const ts of sheets) {
      const tsStatus = String(ts.status || '').toLowerCase();
      if (status && tsStatus !== status) continue;
      let shifts = ts.shifts as Rec[];
      if (deptFilter) {
        shifts = shifts.filter((s) => deptFilter.has(s.department_id as number));
        if (shifts.length === 0) continue;
      }
      const rows: Rec[] = shifts.map((s) => ({
        ...workRow(s, org, people, { cost: true }),
        timesheet_id: ts.id,
        status: s.status ?? tsStatus,
        pay_codes: awardSummary(s),
      }));
      shiftRows.push(...rows);
      sheetRows.push({
        id: ts.id,
        user_id: ts.user_id,
        user_name: people.name(ts.user_id),
        status: tsStatus,
        period_start: ts.start ?? null,
        period_finish: ts.finish ?? null,
        shifts: rows.length,
        hours: round2(rows.reduce((n, r) => n + (r.hours as number), 0)),
        cost: deptFilter ? round2(rows.reduce((n, r) => n + (r.cost as number), 0)) : ts.total_cost,
      });
    }

    const byStatus: Record<string, { timesheets: number; hours: number; cost: number }> = {};
    for (const r of sheetRows) {
      const b = (byStatus[r.status as string] ||= { timesheets: 0, hours: 0, cost: 0 });
      b.timesheets += 1;
      b.hours = round2(b.hours + (r.hours as number));
      b.cost = round2(b.cost + ((r.cost as number) || 0));
    }
    const byLocation = groupTotals(shiftRows, (r) => r.location_id as number | null, (k) => ({ location_id: k, name: org.locationName(k as number) }));

    const summary = {
      from,
      to,
      timesheets: sheetRows.length,
      shifts: shiftRows.length,
      hours: round2(shiftRows.reduce((n, r) => n + (r.hours as number), 0)),
      cost: round2(sheetRows.reduce((n, r) => n + ((r.cost as number) || 0), 0)),
      by_status: byStatus,
      ...topN(byLocation, 30, 'by_location'),
    };
    const rows = view === 'shifts'
      ? shiftRows.sort((a, b) => ((a.start as number) || 0) - ((b.start as number) || 0))
      : sheetRows.sort((a, b) => (b.hours as number) - (a.hours as number));
    return guardResponse(summary, rows, { offset: args.offset, pageSize: args.limit });
  },
};
