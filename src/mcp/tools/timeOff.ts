import { Tool } from './types';
import { ArgError, dateRange, idList, num, oneOf, S } from '../args';
import { guardResponse } from '../guard';
import { loadPeople } from '../context';
import { Rec } from '../../tanda/client';
import { round2, toZonedISO } from '../../utils/time';

const LEAVE_STATUSES = ['pending', 'approved', 'rejected'] as const;

export const timeOffTool: Tool = {
  name: 'tanda_time_off',
  description:
    'Returns leave requests, staff unavailability, or leave balances/types for a user; use it to see who is off or unavailable before scheduling.',
  inputSchema: {
    type: 'object',
    properties: {
      kind: { type: 'string', enum: ['leave', 'unavailability', 'balances'], description: 'Default leave' },
      from: S.from,
      to: S.to,
      status: { type: 'string', enum: [...LEAVE_STATUSES], description: 'Leave status filter' },
      user_ids: S.userIds,
      user_id: { type: 'number', description: 'Required for kind=balances' },
      offset: S.offset,
      limit: S.limit,
    },
  },
  async run(client, args) {
    const kind = oneOf(args.kind, ['leave', 'unavailability', 'balances'] as const, 'leave', 'kind');

    if (kind === 'balances') {
      const userId = num(args.user_id) ?? idList(args.user_ids)?.[0];
      if (!userId) throw new ArgError('user_id is required for kind=balances.');
      const [balances, types] = await Promise.all([
        client.getLeaveBalances([userId]),
        client.getLeaveTypes(userId).catch(() => null),
      ]);
      const rows = balances.map((b) => ({
        user_id: b.user_id,
        leave_type: b.leave_type,
        balance: typeof b.balance === 'number' ? round2(b.balance) : b.balance,
        ...(b.should_accrue !== undefined ? { accrues: b.should_accrue } : {}),
      }));
      return guardResponse({ user_id: userId, balances: rows.length, ...(types ? { leave_types: types } : {}) }, rows, {
        offset: args.offset,
        pageSize: args.limit,
      });
    }

    const { from, to } = dateRange(args);
    const people = await loadPeople(client);
    const userIds = idList(args.user_ids);

    if (kind === 'unavailability') {
      const rows = (await client.getUnavailability({ from, to, user_ids: userIds })).map((u) => ({
        id: u.id,
        user_id: u.user_id,
        user_name: people.name(u.user_id),
        title: u.title ?? null,
        start: u.start,
        start_iso: toZonedISO(u.start),
        finish: u.finish,
        finish_iso: toZonedISO(u.finish),
        ...(u.repeating ? { repeating: true } : {}),
      }));
      return guardResponse({ from, to, unavailability: rows.length, users: new Set(rows.map((r) => r.user_id)).size }, rows, {
        offset: args.offset,
        pageSize: args.limit,
      });
    }

    const status = args.status ? oneOf(args.status, LEAVE_STATUSES, 'pending', 'status') : undefined;
    const leave = await client.getLeaveRequests({ from, to, user_ids: userIds, status });
    const rows: Rec[] = leave.map((l) => ({
      id: l.id,
      user_id: l.user_id,
      user_name: people.name(l.user_id),
      leave_type: l.leave_type ?? null,
      status: l.status,
      start: l.start,
      finish: l.finish,
      hours: typeof l.hours === 'number' ? round2(l.hours) : null,
      ...(l.all_day === false ? { all_day: false } : {}),
    }));
    const byStatus: Record<string, number> = {};
    for (const r of rows) byStatus[r.status as string] = (byStatus[r.status as string] || 0) + 1;
    return guardResponse(
      { from, to, requests: rows.length, by_status: byStatus, hours: round2(rows.reduce((n, r) => n + ((r.hours as number) || 0), 0)) },
      rows,
      { offset: args.offset, pageSize: args.limit }
    );
  },
};
