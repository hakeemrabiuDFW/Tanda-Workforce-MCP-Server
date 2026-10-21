import { Tool } from './types';
import { bool, dateRange, idList, oneOf, S, updatedAfter } from '../args';
import { guardResponse } from '../guard';
import { departmentsForLocations, loadOrg, loadPeople } from '../context';
import { groupTotals, topN, workRow } from './rows';
import { round2 } from '../../utils/time';

export const schedulesTool: Tool = {
  name: 'tanda_schedules',
  description:
    'Returns rostered (planned) shifts for a date range with totals by site and by day (hours, optional cost); use it for "who is scheduled where/when" and planned labor.',
  inputSchema: {
    type: 'object',
    properties: {
      from: S.from,
      to: S.to,
      location_ids: S.locationIds,
      department_ids: S.departmentIds,
      user_ids: S.userIds,
      show_costs: { type: 'boolean', description: 'Include rostered cost (needs cost scope)' },
      view: { type: 'string', enum: ['shifts', 'location_day'], description: 'rows = individual shifts (default) or site x day totals' },
      include_bookkeeping: { type: 'boolean', description: 'Include bookkeeping sites. Default false' },
      updated_after: S.updatedAfter,
      offset: S.offset,
      limit: S.limit,
    },
  },
  async run(client, args) {
    const { from, to } = dateRange(args);
    const view = oneOf(args.view, ['shifts', 'location_day'] as const, 'shifts', 'view');
    const showCosts = bool(args.show_costs);
    const org = await loadOrg(client);
    const locIds = idList(args.location_ids);
    const deptIds = [...(idList(args.department_ids) || []), ...(locIds ? departmentsForLocations(org, locIds) : [])];
    if (locIds && deptIds.length === 0) {
      return guardResponse({ from, to, shifts: 0, note: 'No departments found for those location_ids.' }, []);
    }

    const [schedules, people] = await Promise.all([
      client.getSchedules({
        from,
        to,
        user_ids: idList(args.user_ids),
        department_ids: deptIds.length ? deptIds : undefined,
        show_costs: showCosts,
        include_names: true,
        updated_after: updatedAfter(args.updated_after),
      }),
      loadPeople(client),
    ]);

    const includeBookkeeping = bool(args.include_bookkeeping);
    const rows = schedules
      .map((s) => workRow(s, org, people, { cost: showCosts }))
      .filter((r) => r.date && (r.date as string) >= from && (r.date as string) <= to)
      .filter((r) => includeBookkeeping || !org.isBookkeepingLocation(r.location_id as number | null))
      .sort((a, b) => ((a.start as number) || 0) - ((b.start as number) || 0));

    const byLocation = groupTotals(rows, (r) => r.location_id as number | null, (k) => ({ location_id: k, name: org.locationName(k as number) }));
    const byDay = groupTotals(rows, (r) => r.date as string, (k) => ({ date: k })).sort((a, b) => String(a.date).localeCompare(String(b.date)));
    const strip = (t: Record<string, unknown>) => (showCosts ? t : { ...t, cost: undefined });

    const summary = {
      from,
      to,
      shifts: rows.length,
      hours: round2(rows.reduce((n, r) => n + (r.hours as number), 0)),
      ...(showCosts ? { cost: round2(rows.reduce((n, r) => n + ((r.cost as number) || 0), 0)) } : {}),
      unassigned: rows.filter((r) => r.user_id === null || r.user_id === 0).length,
      sites: byLocation.length,
      by_day: byDay.map(strip),
      ...topN(byLocation.map(strip), 30, 'by_location'),
    };

    const outRows = view === 'location_day'
      ? groupTotals(rows, (r) => `${r.location_id}|${r.date}`, (k) => {
          const [loc, date] = String(k).split('|');
          const id = loc === 'null' ? null : Number(loc);
          return { location_id: id, name: org.locationName(id), date };
        }).map(strip)
      : rows;
    return guardResponse(summary, outRows, { offset: args.offset, pageSize: args.limit });
  },
};
