import { Tool } from './types';
import { ArgError, idList, num, oneOf, S, updatedAfter } from '../args';
import { guardResponse } from '../guard';
import { loadOrg, departmentsForLocations } from '../context';
import { parseFields, pickUserFields, DEFAULT_USER_FIELDS } from '../privacy';
import { Rec } from '../../tanda/client';

export const peopleTool: Tool = {
  name: 'tanda_people',
  description:
    'Returns privacy-filtered staff records (id, name, employee_id, start date, active, levels, department ids, award template) filtered by department, site, status or name; use it to find who works where. Email, phone and date of birth are only returned if listed in `fields`.',
  inputSchema: {
    type: 'object',
    properties: {
      user_id: { type: 'number', description: 'Return a single user' },
      me: { type: 'boolean', description: 'Return the authenticated user' },
      status: { type: 'string', enum: ['active', 'inactive', 'all'], description: 'Default active' },
      department_ids: S.departmentIds,
      location_ids: S.locationIds,
      search: { type: 'string', description: 'Case-insensitive name match' },
      fields: { type: 'array', items: { type: 'string' }, description: `Extra fields beyond the default (${DEFAULT_USER_FIELDS.join(', ')})` },
      updated_after: S.updatedAfter,
      offset: S.offset,
      limit: S.limit,
    },
  },
  async run(client, args) {
    const extra = parseFields(args.fields);
    if (args.me === true || args.me === 'true') {
      const me = await client.getCurrentUser();
      return { user: pickUserFields(me as unknown as Rec, extra) };
    }
    const userId = num(args.user_id);
    if (args.user_id !== undefined && !userId) throw new ArgError('user_id must be a number.');
    if (userId) {
      return { user: pickUserFields(await client.getUser(userId), extra) };
    }

    const status = oneOf(args.status, ['active', 'inactive', 'all'] as const, 'active', 'status');
    const after = updatedAfter(args.updated_after);
    let users: Rec[] = [];
    if (status !== 'inactive') users.push(...(await client.getUsers({ updated_after: after })));
    if (status !== 'active') users.push(...(await client.getInactiveUsers()));

    let deptIds = idList(args.department_ids);
    const locIds = idList(args.location_ids);
    if (deptIds || locIds) {
      const org = await loadOrg(client);
      const wanted = new Set([...(deptIds || []), ...(locIds ? departmentsForLocations(org, locIds) : [])]);
      deptIds = [...wanted];
      // Department membership comes from department.staff (Tanda's source of truth)
      const members = new Set<number>();
      for (const id of wanted) for (const uid of (org.departmentById.get(id)?.staff as number[]) || []) members.add(uid);
      users = users.filter((u) => members.has(u.id as number));
    }
    const search = typeof args.search === 'string' ? args.search.trim().toLowerCase() : '';
    if (search) users = users.filter((u) => String(u.name || '').toLowerCase().includes(search));

    const rows = users.map((u) => pickUserFields(u, extra));
    return guardResponse(
      {
        total: rows.length,
        active: users.filter((u) => u.active !== false).length,
        missing_award_template: users.filter((u) => u.active !== false && (u.award_template_id === null || u.award_template_id === undefined)).length,
        ...(deptIds ? { department_ids: deptIds } : {}),
      },
      rows,
      { offset: args.offset, pageSize: args.limit }
    );
  },
};
