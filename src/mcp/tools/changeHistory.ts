import { Tool } from './types';
import { oneOf, requireId, S } from '../args';
import { guardResponse } from '../guard';
import { Rec } from '../../tanda/client';
import { toZonedISO } from '../../utils/time';

const TIME_KEYS = /^(time|created_at|updated_at|timestamp|start|finish)$/;

export const changeHistoryTool: Tool = {
  name: 'tanda_change_history',
  description:
    'Returns the version history (who changed what, when) of a single shift or schedule; use it to audit edits to a timesheet shift or roster entry.',
  inputSchema: {
    type: 'object',
    properties: {
      type: { type: 'string', enum: ['shift', 'schedule'], description: 'shift = timesheet shift, schedule = rostered shift' },
      id: { type: 'number', description: 'Shift or schedule id' },
      offset: S.offset,
      limit: S.limit,
    },
    required: ['type', 'id'],
  },
  async run(client, args) {
    const type = oneOf(args.type, ['shift', 'schedule'] as const, 'shift', 'type');
    const id = requireId(args.id ?? args.shift_id ?? args.schedule_id, 'id');
    const versions = await client.getVersions(type === 'shift' ? 'shifts' : 'schedules', id);
    const rows = versions.map((v) => {
      const out: Rec = {};
      for (const [k, val] of Object.entries(v)) {
        out[k] = val;
        if (TIME_KEYS.test(k) && (typeof val === 'number' || typeof val === 'string')) out[`${k}_iso`] = toZonedISO(val);
      }
      return out;
    });
    return guardResponse({ type, id, versions: rows.length }, rows, { offset: args.offset, pageSize: args.limit });
  },
};
