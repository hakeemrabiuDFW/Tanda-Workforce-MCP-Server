import { Tool } from './types';
import { bool, idList, S } from '../args';
import { guardResponse } from '../guard';
import { loadOrg, BOOKKEEPING_IDS, SUPERVISOR_DEPT_RE } from '../context';

export const orgTool: Tool = {
  name: 'tanda_org',
  description:
    'Returns locations (sites) with their departments nested, staff counts, and flags for bookkeeping sites and Supervisor departments; use it first to resolve site/department names to ids.',
  inputSchema: {
    type: 'object',
    properties: {
      location_ids: S.locationIds,
      search: { type: 'string', description: 'Case-insensitive match on location or department name' },
      include_bookkeeping: { type: 'boolean', description: 'Include bookkeeping sites (One Time Projects, Floater, MCP Test). Default true' },
      offset: S.offset,
      limit: S.limit,
    },
  },
  async run(client, args) {
    const org = await loadOrg(client);
    const ids = idList(args.location_ids);
    const search = typeof args.search === 'string' ? args.search.trim().toLowerCase() : '';
    const includeBookkeeping = bool(args.include_bookkeeping, true);

    const deptsByLocation = new Map<number | null, typeof org.departments>();
    for (const d of org.departments) {
      const loc = (d.location_id as number | undefined) ?? null;
      if (!deptsByLocation.has(loc)) deptsByLocation.set(loc, []);
      deptsByLocation.get(loc)!.push(d);
    }

    const rows = [];
    for (const loc of org.locations) {
      const id = loc.id as number;
      if (ids && !ids.includes(id)) continue;
      const bookkeeping = org.isBookkeepingLocation(id);
      if (bookkeeping && !includeBookkeeping) continue;
      const depts = (deptsByLocation.get(id) || []).map((d) => ({
        id: d.id,
        name: d.name,
        staff_count: Array.isArray(d.staff) ? d.staff.length : 0,
        ...(SUPERVISOR_DEPT_RE.test(String(d.name || '').trim()) ? { supervisor: true } : {}),
        ...(BOOKKEEPING_IDS.has(d.id as number) ? { bookkeeping: true } : {}),
      }));
      const nameHit = !search || String(loc.name || '').toLowerCase().includes(search);
      const matchedDepts = search && !nameHit ? depts.filter((d) => String(d.name || '').toLowerCase().includes(search)) : depts;
      if (search && !nameHit && matchedDepts.length === 0) continue;
      rows.push({
        id,
        name: loc.name,
        ...(loc.short_name ? { short_name: loc.short_name } : {}),
        ...(bookkeeping ? { bookkeeping: true } : {}),
        departments: matchedDepts,
      });
    }

    const unassigned = (deptsByLocation.get(null) || []).length;
    return guardResponse(
      {
        locations: rows.length,
        work_sites: rows.filter((r) => !r.bookkeeping).length,
        departments: rows.reduce((n, r) => n + r.departments.length, 0),
        supervisor_departments: org.supervisorDeptIds.size,
        bookkeeping_location_ids: [...BOOKKEEPING_IDS],
        ...(unassigned ? { departments_without_location: unassigned } : {}),
        cached_for_hours: 24,
      },
      rows,
      { offset: args.offset, pageSize: args.limit }
    );
  },
};
