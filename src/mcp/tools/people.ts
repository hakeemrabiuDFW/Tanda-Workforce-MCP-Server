import { Tool } from './types';
import { ArgError, bool, idList, num, oneOf, S, updatedAfter } from '../args';
import { guardResponse } from '../guard';
import { loadOrg, departmentsForLocations } from '../context';
import { ignoredFields, parseFields, pickUserFields, DEFAULT_USER_FIELDS, IgnoredField, WAGE_FIELDS } from '../privacy';
import { Rec, TandaApiError, TandaClient } from '../../tanda/client';

/** Ask Tanda for wages only when a wage field is requested; a 403 drops the wages, not the call. */
async function withWages<T>(wanted: boolean, fetch: (showWages: boolean) => Promise<T>): Promise<{ data: T; wagesDenied: boolean }> {
  if (!wanted) return { data: await fetch(false), wagesDenied: false };
  try {
    return { data: await fetch(true), wagesDenied: false };
  } catch (error) {
    if (!(error instanceof TandaApiError) || error.statusCode !== 403) throw error;
    return { data: await fetch(false), wagesDenied: true };
  }
}

function ignored(extra: string[], records: Rec[], wagesDenied: boolean): { ignored_fields?: IgnoredField[] } {
  let list = ignoredFields(extra, records);
  if (wagesDenied) {
    list = list.filter((f) => !WAGE_FIELDS.has(f.field));
    for (const f of extra.filter((x) => WAGE_FIELDS.has(x))) list.push({ field: f, reason: 'needs_scope:cost' });
  }
  return list.length ? { ignored_fields: list } : {};
}

async function oneUser(client: TandaClient, userId: number | 'me', extra: string[], showWages: boolean): Promise<Rec> {
  // /users/me has no wage option, so with wages requested look the user up by id instead
  const id = userId === 'me' && showWages ? ((await client.getCurrentUser()) as unknown as Rec).id as number : userId;
  const { data, wagesDenied } = await withWages(showWages, (w) =>
    id === 'me' ? (client.getCurrentUser() as unknown as Promise<Rec>) : client.getUser(id, { show_wages: w })
  );
  return { user: pickUserFields(data, extra), ...ignored(extra, [data], wagesDenied) };
}

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
      fields: { type: 'array', items: { type: 'string' }, description: `Extra fields beyond the default (${DEFAULT_USER_FIELDS.join(', ')}); e.g. hourly_rate (needs the cost scope). Fields that cannot be returned are listed in ignored_fields` },
      show_wages: { type: 'boolean', description: 'Include hourly_rate (needs the cost scope). Same as adding hourly_rate to fields' },
      updated_after: S.updatedAfter,
      offset: S.offset,
      limit: S.limit,
    },
  },
  async run(client, args) {
    const extra = parseFields(args.fields);
    if (bool(args.show_wages) && !extra.includes('hourly_rate')) extra.push('hourly_rate');
    const showWages = extra.some((f) => WAGE_FIELDS.has(f));
    if (args.me === true || args.me === 'true') return oneUser(client, 'me', extra, showWages);
    const userId = num(args.user_id);
    if (args.user_id !== undefined && !userId) throw new ArgError('user_id must be a number.');
    if (userId) return oneUser(client, userId, extra, showWages);

    const status = oneOf(args.status, ['active', 'inactive', 'all'] as const, 'active', 'status');
    const after = updatedAfter(args.updated_after);
    let users: Rec[] = [];
    let wagesDenied = false;
    if (status !== 'inactive') {
      const res = await withWages(showWages, (w) => client.getUsers({ updated_after: after, show_wages: w }));
      users.push(...res.data);
      wagesDenied = res.wagesDenied;
    }
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
      { offset: args.offset, pageSize: args.limit, extra: ignored(extra, users, wagesDenied) }
    );
  },
};
