import { Tool } from './types';
import { idList, num, S } from '../args';
import { guardResponse } from '../guard';
import { loadOrg, loadPeople } from '../context';
import { round2, toUnixSeconds, toZonedISO } from '../../utils/time';
import { Rec } from '../../tanda/client';

export const OPEN_SHIFT_FLAG_HOURS = 12;

export const liveTool: Tool = {
  name: 'tanda_live',
  description:
    'Returns who is clocked in right now (active shifts) with name, site, start time and elapsed hours, flagging shifts open longer than 12 hours; use it for real-time attendance.',
  inputSchema: {
    type: 'object',
    properties: {
      location_ids: S.locationIds,
      flag_hours: { type: 'number', description: 'Flag shifts open longer than this many hours. Default 12' },
      offset: S.offset,
      limit: S.limit,
    },
  },
  async run(client, args) {
    const flagHours = num(args.flag_hours, OPEN_SHIFT_FLAG_HOURS) as number;
    const [active, org, people] = await Promise.all([client.getActiveShifts(), loadOrg(client), loadPeople(client)]);
    const now = Math.floor(Date.now() / 1000);
    const locIds = idList(args.location_ids);

    const rows: Rec[] = active
      .map((s) => {
        const deptId = (s.department_id as number | undefined) ?? null;
        const locId = deptId !== null ? org.deptLocation.get(deptId) ?? null : null;
        const start = toUnixSeconds(s.start);
        const elapsed = start !== null ? round2((now - start) / 3600) : null;
        return {
          shift_id: s.id,
          user_id: s.user_id,
          user_name: (s.user_name as string) ?? people.name(s.user_id),
          department_id: deptId,
          department_name: org.departmentName(deptId),
          location_id: locId,
          location_name: org.locationName(locId),
          start,
          start_iso: toZonedISO(start),
          elapsed_hours: elapsed,
          on_break: s.status === 'on_break' || undefined,
          open_over_limit: elapsed !== null && elapsed > flagHours ? true : undefined,
        } as Rec;
      })
      .filter((r) => !locIds || locIds.includes(r.location_id as number))
      .sort((a, b) => ((b.elapsed_hours as number) || 0) - ((a.elapsed_hours as number) || 0));

    const bySite = new Map<number | null, number>();
    for (const r of rows) bySite.set(r.location_id as number | null, (bySite.get(r.location_id as number | null) || 0) + 1);

    return guardResponse(
      {
        as_of: toZonedISO(now),
        on_clock: rows.length,
        [`open_over_${flagHours}h`]: rows.filter((r) => r.open_over_limit).length,
        sites_active: bySite.size,
        by_location: [...bySite.entries()]
          .map(([id, count]) => ({ location_id: id, name: org.locationName(id), on_clock: count }))
          .sort((a, b) => b.on_clock - a.on_clock)
          .slice(0, 30),
      },
      rows,
      { offset: args.offset, pageSize: args.limit }
    );
  },
};
