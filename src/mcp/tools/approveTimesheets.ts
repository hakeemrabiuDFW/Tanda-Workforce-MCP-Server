import { Tool } from './types';
import { ArgError, bool, dateRange, idList, oneOf, S, text } from '../args';
import { guardResponse } from '../guard';
import { departmentsForLocations, loadOrg, loadPeople } from '../context';
import { checkConfirmToken, CONFIRM_TTL_MS, signConfirmToken } from '../confirm';
import { writesEnabled } from '../../config/writes';
import { Rec, TandaApiError, TandaClient } from '../../tanda/client';
import { itemDate, itemHours } from '../../tanda/normalize';
import { addDays, round2, todayInZone, toUnixSeconds } from '../../utils/time';
import { logger } from '../../utils/logger';
import { workweek } from '../workweek';

export const APPROVE_TIMESHEETS_TOOL = 'tanda_approve_timesheets';

/** Most timesheets changed by one confirm. */
export const MAX_BATCH = 100;
/** Periods that ended longer ago than this need allow_past_period (they are likely paid already). */
const PAST_PERIOD_DAYS = 14;
const MAX_SHIFT_HOURS = 12;
const WEEKLY_LIMIT = 40;
/** A roster finish is only used to fill a missing clock-out if the result is at most this long. */
const MAX_FILLED_HOURS = 16;
export const EXCEPTION_MARK = 'MCP-EXCEPTION';

type Action = 'approve' | 'unapprove';

interface ShiftChange {
  shift_id: number;
  finish?: number;
  metadata?: string;
  reasons: string[];
}

interface Plan {
  timesheet_id: number;
  user_id: unknown;
  user_name: string | null;
  period: string;
  status: string;
  shifts: number;
  hours: number;
  cost: number;
  will_change: boolean;
  skip_reason?: string;
  flags: Array<{ shift_id: number | null; date: string | null; reason: string }>;
  shift_changes: ShiftChange[];
}

const statusOf = (ts: Rec) => String(ts.status || '').toLowerCase();

/** Shift note shown in Workforce: keeps any existing metadata and adds the exception reasons once. */
export function exceptionNote(existing: unknown, reasons: string[], today: string): string | undefined {
  const prev = typeof existing === 'string' ? existing.trim() : '';
  if (prev.includes(EXCEPTION_MARK)) return undefined;
  const mark = `${EXCEPTION_MARK} ${today}: ${reasons.join('; ')}`;
  return prev ? `${prev} | ${mark}` : mark;
}

/** The single rostered finish for this user's shift on that date, if it gives a sane shift length. */
function rosterFinish(shift: Rec, schedules: Rec[]): number | null {
  const date = itemDate(shift);
  const start = toUnixSeconds(shift.start);
  if (!date || start === null) return null;
  const matches = schedules.filter((sc) => sc.user_id === shift.user_id && itemDate(sc) === date && toUnixSeconds(sc.finish) !== null);
  if (matches.length !== 1) return null;
  const finish = toUnixSeconds(matches[0].finish) as number;
  if (finish <= start || finish - start > MAX_FILLED_HOURS * 3600) return null;
  return finish;
}

/** Flags, fixes and exception notes for one timesheet's shifts. */
function planShifts(ts: Rec, schedules: Rec[], fillMissing: boolean, today: string, weekStart: (d: string) => string): Pick<Plan, 'flags' | 'shift_changes'> {
  const flags: Plan['flags'] = [];
  const changes = new Map<number, ShiftChange>();
  const shifts = (ts.shifts as Rec[]).slice().sort((a, b) => (toUnixSeconds(a.start) ?? 0) - (toUnixSeconds(b.start) ?? 0));
  const flag = (shift: Rec, reason: string, change?: Partial<ShiftChange>) => {
    const id = shift.id as number;
    flags.push({ shift_id: id ?? null, date: itemDate(shift), reason });
    const c = changes.get(id) || { shift_id: id, reasons: [] };
    c.reasons.push(reason);
    Object.assign(c, change);
    changes.set(id, c);
  };

  const weekHours = new Map<string, number>();
  for (const s of shifts) {
    const start = toUnixSeconds(s.start);
    const finish = toUnixSeconds(s.finish);
    let hours = itemHours(s);
    if (start !== null && finish === null) {
      const filled = fillMissing ? rosterFinish(s, schedules) : null;
      if (filled !== null) {
        flag(s, 'missing clock-out, filled from roster', { finish: filled });
        hours = round2((filled - start) / 3600);
      } else {
        flag(s, 'missing clock-out, no single roster match');
      }
    } else if (start !== null && finish !== null && finish === start) {
      flag(s, 'zero-length shift');
    } else if (hours > MAX_SHIFT_HOURS) {
      flag(s, `shift over ${MAX_SHIFT_HOURS}h (${hours}h)`);
    }
    if (hours > 0 && Array.isArray(s.award_interpretation) && s.award_interpretation.length === 0) flag(s, 'no pay code');
    const d = itemDate(s);
    if (d) {
      const wk = weekStart(d);
      const before = weekHours.get(wk) || 0;
      const after = round2(before + hours);
      weekHours.set(wk, after);
      if (before <= WEEKLY_LIMIT && after > WEEKLY_LIMIT) flag(s, `week of ${wk} over ${WEEKLY_LIMIT}h`);
    }
  }

  const byId = new Map(shifts.map((s) => [s.id as number, s]));
  const shiftChanges = [...changes.values()].map((c) => {
    const note = exceptionNote(byId.get(c.shift_id)?.metadata, c.reasons, today);
    return { ...c, ...(note ? { metadata: note } : {}) };
  });
  return { flags, shift_changes: shiftChanges.filter((c) => c.finish !== undefined || c.metadata !== undefined) };
}

async function buildPlans(client: TandaClient, args: Record<string, unknown>, action: Action): Promise<{ plans: Plan[]; from: string; to: string; week_basis: string }> {
  if (!args.from || !args.to) throw new ArgError('from and to are required (the pay period, e.g. 2026-08-10 to 2026-08-23).');
  const { from, to } = dateRange(args);
  const ids = idList(args.timesheet_ids);
  const locIds = idList(args.location_ids);
  const fillMissing = bool(args.fill_missing_clock_out, true);
  const allowPast = bool(args.allow_past_period);
  const week = workweek(args.workweek_start);
  const today = todayInZone();

  const [org, people, sheets] = await Promise.all([
    loadOrg(client),
    loadPeople(client),
    client.getTimesheets({ from, to, user_ids: idList(args.user_ids), include_empty: true }),
  ]);
  const deptFilter = locIds ? new Set(departmentsForLocations(org, locIds)) : null;
  let selected = sheets.filter((ts) => !ids || ids.includes(ts.id as number));
  if (deptFilter) selected = selected.filter((ts) => (ts.shifts as Rec[]).some((s) => deptFilter.has(s.department_id as number)));
  if (ids) {
    const missing = ids.filter((id) => !selected.some((ts) => ts.id === id));
    if (missing.length) throw new ArgError(`Timesheets not found in ${from}..${to}: ${missing.join(', ')}.`);
  }
  if (!selected.length) throw new ArgError('No timesheets match. Check from/to and the filters.');

  const needsRoster = action === 'approve' && fillMissing && selected.some((ts) => (ts.shifts as Rec[]).some((s) => s.start && !s.finish));
  const schedules = needsRoster ? await client.getSchedules({ from, to }) : [];

  const plans: Plan[] = selected.map((ts) => {
    const status = statusOf(ts);
    const finish = String(ts.finish ?? '').slice(0, 10);
    const shifts = ts.shifts as Rec[];
    const base = {
      timesheet_id: ts.id as number,
      user_id: ts.user_id,
      user_name: people.name(ts.user_id),
      period: `${String(ts.start ?? '').slice(0, 10)}..${finish}`,
      status,
      shifts: shifts.length,
      hours: round2(shifts.reduce((n, s) => n + itemHours(s), 0)),
      cost: round2(Number(ts.total_cost) || 0),
    };
    const skip = (reason: string): Plan => ({ ...base, will_change: false, skip_reason: reason, flags: [], shift_changes: [] });
    if (status === 'exported') return skip('exported: costs are locked');
    if (action === 'approve' && status === 'approved') return skip('already approved');
    if (action === 'unapprove' && status !== 'approved') return skip('not approved');
    if (finish && finish < addDays(today, -PAST_PERIOD_DAYS) && !allowPast) return skip(`period ended over ${PAST_PERIOD_DAYS} days ago: pass allow_past_period`);
    if (action === 'unapprove') return { ...base, will_change: true, flags: [], shift_changes: [] };
    return { ...base, will_change: true, ...planShifts(ts, schedules, fillMissing, today, week.start) };
  });
  const changing = plans.filter((p) => p.will_change).length;
  if (changing > MAX_BATCH) throw new ArgError(`${changing} timesheets would change; the limit is ${MAX_BATCH} per call. Narrow with timesheet_ids, user_ids or location_ids.`);
  return { plans, from, to, week_basis: week.basis };
}

/** What the confirm_token covers: the action, every change, and the audit ref. Changed data means a new preview. */
const tokenRequest = (action: Action, plans: Plan[], sourceRef: string | undefined) => [
  action,
  plans.filter((p) => p.will_change).map((p) => [p.timesheet_id, p.shift_changes.map((c) => [c.shift_id, c.finish ?? null, c.metadata ?? null])]),
  sourceRef ?? null,
];

export const approveTimesheetsTool: Tool = {
  name: APPROVE_TIMESHEETS_TOOL,
  description:
    'Approves (or returns to pending) Tanda timesheets for a pay period in two steps: a call without confirm_token previews each timesheet with data-quality flags, fixes and a confirm_token, and the same call plus confirm_token applies them. ' +
    'Flagged shifts are approved with an MCP-EXCEPTION note visible in Workforce.',
  inputSchema: {
    type: 'object',
    properties: {
      from: { ...S.from, description: 'Pay period start YYYY-MM-DD (required)' },
      to: { ...S.to, description: 'Pay period end YYYY-MM-DD (required)' },
      action: { type: 'string', enum: ['approve', 'unapprove'], description: 'Default approve. unapprove returns approved timesheets to pending' },
      timesheet_ids: { type: 'array', items: { type: 'number' }, description: 'Only these timesheets (recommended for small batches)' },
      user_ids: S.userIds,
      location_ids: S.locationIds,
      fill_missing_clock_out: { type: 'boolean', description: 'Fill a missing clock-out from the single matching roster finish. Default true' },
      allow_past_period: { type: 'boolean', description: `Allow periods that ended more than ${PAST_PERIOD_DAYS} days ago. Default false` },
      workweek_start: { type: 'string', enum: ['SUN', 'MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT'], description: 'First day of the 40h workweek. Default WORKWEEK_START (MON)' },
      source_ref: { type: 'string', description: 'Audit reference' },
      dry_run: { type: 'boolean', description: 'Preview only. Default true without confirm_token, false with it' },
      confirm_token: { type: 'string', description: 'Token from the preview; applies the changes' },
      offset: S.offset,
      limit: S.limit,
    },
    required: ['from', 'to'],
  },
  async run(client, args) {
    if (!writesEnabled()) {
      throw new ArgError(`${APPROVE_TIMESHEETS_TOOL} is turned off on this server (TANDA_WRITES_ENABLED is not true). Nothing was changed.`);
    }
    if (client.isSharedIdentity) {
      throw new ArgError(`${APPROVE_TIMESHEETS_TOOL} needs a person's own Tanda login (OAuth), so Tanda records who approved. The shared server token can't approve.`);
    }
    const action = oneOf(args.action, ['approve', 'unapprove'] as const, 'approve', 'action');
    const sourceRef = text(args.source_ref, 'source_ref', 100);
    const token = typeof args.confirm_token === 'string' && args.confirm_token.trim() ? args.confirm_token.trim() : undefined;
    const dryRun = bool(args.dry_run, !token);

    const { plans, from, to, week_basis } = await buildPlans(client, args, action);
    const changing = plans.filter((p) => p.will_change);
    const summary = {
      action,
      from,
      to,
      week_basis,
      timesheets: plans.length,
      will_change: changing.length,
      skipped: plans.length - changing.length,
      flagged: changing.filter((p) => p.flags.length).length,
      shift_updates: changing.reduce((n, p) => n + p.shift_changes.length, 0),
      hours: round2(changing.reduce((n, p) => n + p.hours, 0)),
      cost: round2(changing.reduce((n, p) => n + p.cost, 0)),
    };

    if (dryRun || !token) {
      if (!changing.length) return guardResponse({ status: 'nothing_to_do', ...summary }, plans, { offset: args.offset, pageSize: args.limit });
      return guardResponse(
        { status: 'preview', changed: false, ...summary },
        plans,
        {
          offset: args.offset,
          pageSize: args.limit,
          extra: {
            confirm_token: signConfirmToken(APPROVE_TIMESHEETS_TOOL, client.cacheScope, tokenRequest(action, plans, sourceRef)),
            expires_in_minutes: CONFIRM_TTL_MS / 60000,
            next_step: `To ${action} the ${changing.length} timesheet(s) marked will_change, call again with the same arguments plus confirm_token.`,
          },
        }
      );
    }

    checkConfirmToken(token, APPROVE_TIMESHEETS_TOOL, client.cacheScope, tokenRequest(action, plans, sourceRef));
    let callerId: unknown = null;
    try {
      callerId = (await client.getCurrentUser()).id ?? null;
    } catch {
      /* audit only */
    }

    const results: Rec[] = [];
    for (const p of changing) {
      try {
        for (const c of p.shift_changes) await client.updateShift(c.shift_id, { finish: c.finish, metadata: c.metadata });
        await client.setTimesheetStatus(p.timesheet_id, action === 'approve' ? 'approved' : 'pending');
        results.push({ timesheet_id: p.timesheet_id, user_name: p.user_name, outcome: action === 'approve' ? 'approved' : 'pending', flags: p.flags, shift_updates: p.shift_changes.length });
      } catch (error) {
        const reason = error instanceof TandaApiError ? error.message : 'unexpected error';
        results.push({ timesheet_id: p.timesheet_id, user_name: p.user_name, outcome: 'failed', reason, flags: p.flags });
      }
    }
    const ok = results.filter((r) => r.outcome !== 'failed');
    logger.info(`${APPROVE_TIMESHEETS_TOOL} ${action}`, {
      timesheet_ids: ok.map((r) => r.timesheet_id),
      failed_ids: results.filter((r) => r.outcome === 'failed').map((r) => r.timesheet_id),
      exceptions: ok.filter((r) => (r.flags as unknown[]).length).map((r) => r.timesheet_id),
      caller_user_id: callerId,
      caller: client.cacheScope,
      source_ref: sourceRef,
    });
    return guardResponse(
      { status: 'applied', changed: ok.length > 0, ...summary, succeeded: ok.length, failed: results.length - ok.length },
      results,
      { offset: args.offset, pageSize: args.limit }
    );
  },
};
