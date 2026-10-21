import { Tool } from './types';
import { bool, dateRange, idList, oneOf, S } from '../args';
import { guardResponse } from '../guard';
import { departmentsForLocations, loadOrg, loadPeople } from '../context';
import { workRow } from './rows';
import { Rec } from '../../tanda/client';
import { round2, toUnixSeconds } from '../../utils/time';

const GROUPS = ['location', 'day', 'department', 'user'] as const;

interface Bucket {
  scheduled_hours: number;
  scheduled_cost: number;
  actual_hours: number;
  actual_cost: number;
  shifts: number;
}

export const laborSummaryTool: Tool = {
  name: 'tanda_labor_summary',
  description:
    'Returns scheduled vs actual hours and cost (with variance) grouped by site, day, department or user for a date range; use it for labor-cost and daily-stats reporting.',
  inputSchema: {
    type: 'object',
    properties: {
      from: S.from,
      to: S.to,
      group_by: { type: 'string', enum: [...GROUPS], description: 'Default location' },
      location_ids: S.locationIds,
      department_ids: S.departmentIds,
      include_bookkeeping: { type: 'boolean', description: 'Include bookkeeping sites. Default false' },
      offset: S.offset,
      limit: S.limit,
    },
  },
  async run(client, args) {
    const { from, to } = dateRange(args, { defaultBackDays: 6 });
    const groupBy = oneOf(args.group_by, GROUPS, 'location', 'group_by');
    const org = await loadOrg(client);
    const locIds = idList(args.location_ids);
    const deptIds = [...(idList(args.department_ids) || []), ...(locIds ? departmentsForLocations(org, locIds) : [])];
    const deptFilter = deptIds.length ? new Set(deptIds) : null;

    const [schedules, shifts, people] = await Promise.all([
      client.getSchedules({ from, to, department_ids: deptFilter ? [...deptFilter] : undefined, show_costs: true }),
      client.getShifts({ from, to, show_costs: true }),
      loadPeople(client),
    ]);

    const includeBookkeeping = bool(args.include_bookkeeping);
    const keep = (r: Rec) =>
      r.date !== null && (r.date as string) >= from && (r.date as string) <= to &&
      (!deptFilter || deptFilter.has(r.department_id as number)) &&
      (includeBookkeeping || !org.isBookkeepingLocation(r.location_id as number | null));
    const planned = schedules.map((s) => workRow(s, org, people, { cost: true })).filter(keep);
    const worked = shifts
      .filter((s) => toUnixSeconds(s.finish) !== null)
      .map((s) => workRow(s, org, people, { cost: true }))
      .filter(keep);

    const keyOf = (r: Rec): string => {
      switch (groupBy) {
        case 'day': return String(r.date);
        case 'department': return String(r.department_id);
        case 'user': return String(r.user_id);
        default: return String(r.location_id);
      }
    };
    const buckets = new Map<string, Bucket>();
    const bucket = (k: string) => {
      let b = buckets.get(k);
      if (!b) buckets.set(k, (b = { scheduled_hours: 0, scheduled_cost: 0, actual_hours: 0, actual_cost: 0, shifts: 0 }));
      return b;
    };
    for (const r of planned) {
      const b = bucket(keyOf(r));
      b.scheduled_hours += r.hours as number;
      b.scheduled_cost += (r.cost as number) || 0;
    }
    for (const r of worked) {
      const b = bucket(keyOf(r));
      b.actual_hours += r.hours as number;
      b.actual_cost += (r.cost as number) || 0;
      b.shifts += 1;
    }

    const label = (k: string): Rec => {
      const id = k === 'null' ? null : Number(k);
      switch (groupBy) {
        case 'day': return { date: k };
        case 'department': return { department_id: id, name: org.departmentName(id), location_id: id !== null ? org.deptLocation.get(id) ?? null : null };
        case 'user': return { user_id: id, name: people.name(id) };
        default: return { location_id: id, name: org.locationName(id) };
      }
    };
    const finish = (b: Bucket): Rec => ({
      scheduled_hours: round2(b.scheduled_hours),
      actual_hours: round2(b.actual_hours),
      variance_hours: round2(b.actual_hours - b.scheduled_hours),
      scheduled_cost: round2(b.scheduled_cost),
      actual_cost: round2(b.actual_cost),
      variance_cost: round2(b.actual_cost - b.scheduled_cost),
      worked_shifts: b.shifts,
    });

    const rows = [...buckets.entries()].map(([k, b]) => ({ ...label(k), ...finish(b) }));
    rows.sort((a, b) => (groupBy === 'day' ? String(a.date).localeCompare(String(b.date)) : (b.actual_hours as number) - (a.actual_hours as number)));
    const total = [...buckets.values()].reduce(
      (t, b) => ({
        scheduled_hours: t.scheduled_hours + b.scheduled_hours,
        scheduled_cost: t.scheduled_cost + b.scheduled_cost,
        actual_hours: t.actual_hours + b.actual_hours,
        actual_cost: t.actual_cost + b.actual_cost,
        shifts: t.shifts + b.shifts,
      }),
      { scheduled_hours: 0, scheduled_cost: 0, actual_hours: 0, actual_cost: 0, shifts: 0 }
    );
    return guardResponse(
      { from, to, group_by: groupBy, groups: rows.length, ...finish(total), headcount: new Set(worked.map((r) => r.user_id)).size },
      rows,
      { offset: args.offset, pageSize: args.limit }
    );
  },
};
