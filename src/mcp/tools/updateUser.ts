import { Tool } from './types';
import { ArgError, Args, bool, idList, num, parseHourlyRate, requireId, text } from '../args';
import { guardResponse } from '../guard';
import { parseFields, pickUserFields, WAGE_FIELDS } from '../privacy';
import { Warning, withWarnings, writeFailureReason } from '../warnings';
import { checkConfirmToken, CONFIRM_TTL_MS, signConfirmToken } from '../confirm';
import { writesEnabled } from '../../config/writes';
import { Rec, TandaApiError, TandaClient } from '../../tanda/client';
import { isDate } from '../../utils/time';
import { logger } from '../../utils/logger';

export const UPDATE_USER_TOOL = 'tanda_update_user';

/** The only user fields this tool will send to PUT /users/{id}: no level, email, name, tax or bank changes. */
export const UPDATABLE_FIELDS = ['hourly_rate', 'award_template_id', 'employment_start_date', 'department_ids', 'employee_id'] as const;
type Field = (typeof UPDATABLE_FIELDS)[number];

export const MAX_UPDATES = 50;
/** Arguments that steer the call rather than change the user. */
const CALL_ARGS = new Set(['user_id', 'updates', 'source_ref', 'dry_run', 'confirm_token', 'limit', 'offset', 'fields', 'show_wages']);
/** A rate change bigger than this (vs the current rate) is flagged in the preview, not refused. */
const RATE_CHANGE_FLAG = 0.25;

export interface UserUpdate {
  user_id: number;
  changes: Partial<Record<Field, unknown>>;
}

function parseChanges(raw: Rec, where: string): UserUpdate['changes'] {
  const changes: UserUpdate['changes'] = {};
  const rate = parseHourlyRate(raw.hourly_rate, `${where}hourly_rate`);
  if (rate !== undefined) changes.hourly_rate = rate;
  if (raw.award_template_id !== undefined && raw.award_template_id !== null && raw.award_template_id !== '') {
    const award = num(raw.award_template_id);
    if (!award || award <= 0 || !Number.isInteger(award)) throw new ArgError(`${where}award_template_id must be a positive whole number.`);
    changes.award_template_id = award;
  }
  if (raw.employment_start_date !== undefined && raw.employment_start_date !== null && raw.employment_start_date !== '') {
    if (!isDate(raw.employment_start_date)) throw new ArgError(`${where}employment_start_date must be a date in YYYY-MM-DD format.`);
    changes.employment_start_date = raw.employment_start_date;
  }
  if (raw.department_ids !== undefined) {
    const depts = idList(raw.department_ids);
    if (!depts || !depts.length) throw new ArgError(`${where}department_ids must be a non-empty list of positive numbers.`);
    changes.department_ids = [...new Set(depts)].sort((a, b) => a - b);
  }
  const employeeId = text(raw.employee_id, `${where}employee_id`, 50);
  if (employeeId) changes.employee_id = employeeId;
  if (!Object.keys(changes).length) throw new ArgError(`${where}nothing to change: give at least one of ${UPDATABLE_FIELDS.join(', ')}.`);
  return changes;
}

/**
 * Normalise the single-user form (user_id + fields) or the bulk form (updates[]) into a
 * list sorted by user_id, so the confirm token binds the exact change set.
 */
export function parseUpdates(args: Args): UserUpdate[] {
  let list: UserUpdate[];
  if (args.updates !== undefined) {
    if (args.user_id !== undefined) throw new ArgError('Give either user_id (one user) or updates (several), not both.');
    if (!Array.isArray(args.updates) || !args.updates.length) throw new ArgError('updates must be a non-empty list.');
    if (args.updates.length > MAX_UPDATES) throw new ArgError(`updates is limited to ${MAX_UPDATES} users per call.`);
    list = args.updates.map((u, i) => {
      if (!u || typeof u !== 'object' || Array.isArray(u)) throw new ArgError(`updates[${i}] must be an object.`);
      const rec = u as Rec;
      const unknown = Object.keys(rec).filter((k) => k !== 'user_id' && !(UPDATABLE_FIELDS as readonly string[]).includes(k));
      if (unknown.length) throw new ArgError(`updates[${i}] has fields this tool can't change: ${unknown.join(', ')}. Allowed: ${UPDATABLE_FIELDS.join(', ')}.`);
      return { user_id: requireId(rec.user_id, `updates[${i}].user_id`), changes: parseChanges(rec, `updates[${i}].`) };
    });
  } else {
    const unknown = Object.keys(args).filter((k) => !CALL_ARGS.has(k) && !(UPDATABLE_FIELDS as readonly string[]).includes(k));
    if (unknown.length) throw new ArgError(`This tool can't change: ${unknown.join(', ')}. Allowed: ${UPDATABLE_FIELDS.join(', ')}.`);
    list = [{ user_id: requireId(args.user_id, 'user_id'), changes: parseChanges(args, '') }];
  }
  const seen = new Set<number>();
  for (const u of list) {
    if (seen.has(u.user_id)) throw new ArgError(`user_id ${u.user_id} appears more than once in updates.`);
    seen.add(u.user_id);
  }
  return list.sort((a, b) => a.user_id - b.user_id);
}

function onlyEmployee(user: Rec): boolean {
  const levels = user.user_levels;
  return Array.isArray(levels) && levels.length > 0 && levels.every((l) => String(l).toLowerCase() === 'employee');
}

const sameValue = (field: Field, before: unknown, after: unknown): boolean => {
  if (field === 'department_ids') {
    const b = Array.isArray(before) ? [...new Set(before.map(Number))].sort((x, y) => x - y) : [];
    return JSON.stringify(b) === JSON.stringify(after);
  }
  if (field === 'hourly_rate' || field === 'award_template_id') return typeof before === 'number' && before === after;
  return before === after;
};

interface Planned {
  update: UserUpdate;
  user?: Rec;
  refused?: string;
  diff: Array<{ field: Field; before: unknown; after: unknown }>;
  flags: string[];
}

async function plan(client: TandaClient, update: UserUpdate, callerId: unknown): Promise<Planned> {
  const wantsRate = 'hourly_rate' in update.changes;
  let user: Rec;
  try {
    user = await client.getUser(update.user_id, { show_wages: wantsRate });
  } catch (error) {
    if (error instanceof TandaApiError && error.statusCode === 404) return { update, refused: 'user not found', diff: [], flags: [] };
    throw error;
  }
  if (user.active === false) return { update, user, refused: 'user is inactive; rehire them in Tanda first', diff: [], flags: [] };
  if (!onlyEmployee(user)) return { update, user, refused: 'has levels other than "employee"; change managers and admins in Tanda', diff: [], flags: [] };
  if (callerId === update.user_id) return { update, user, refused: 'you cannot change your own account with this tool', diff: [], flags: [] };

  const diff: Planned['diff'] = [];
  const flags: string[] = [];
  for (const field of UPDATABLE_FIELDS) {
    if (!(field in update.changes)) continue;
    const after = update.changes[field];
    // Tanda leaves hourly_rate off a user with no rate, and off everyone without the "cost" scope
    const before = user[field] ?? null;
    if (sameValue(field, before, after)) continue;
    diff.push({ field, before, after });
    if (field === 'hourly_rate' && typeof before === 'number' && before > 0 && Math.abs((after as number) - before) / before > RATE_CHANGE_FLAG) {
      flags.push(`hourly_rate changes by more than ${RATE_CHANGE_FLAG * 100}%`);
    }
  }
  return { update, user, diff, flags };
}

/** Wage values stay hidden unless the caller opts in, like everywhere else (privacy.ts). */
function present(diff: Planned['diff'], showWages: boolean): Rec[] {
  return diff.map((d) => (WAGE_FIELDS.has(d.field) && !showWages
    ? { field: d.field, before: 'hidden', after: 'hidden', note: 'pass show_wages: true to see rates' }
    : d));
}

function previewRow(p: Planned, showWages: boolean): Rec {
  const base = { user_id: p.update.user_id, user_name: (p.user?.name as string) ?? null };
  if (p.refused) return { ...base, will_change: false, outcome: 'refused', reason: p.refused };
  if (!p.diff.length) return { ...base, will_change: false, outcome: 'unchanged' };
  return { ...base, will_change: true, changes: present(p.diff, showWages), flags: p.flags };
}

export const updateUserTool: Tool = {
  name: UPDATE_USER_TOOL,
  description:
    'Updates pay rate, award template, start date, teams or employee id for Tanda employees (one, or up to 50 via updates) in two steps: a call without confirm_token previews a before/after diff and a confirm_token, and the same call plus the token applies it. ' +
    'Refuses managers, admins and the caller.',
  inputSchema: {
    type: 'object',
    properties: {
      user_id: { type: 'number', description: 'One user to update (or use updates for several)' },
      hourly_rate: { type: 'number', description: 'New hourly rate, above 0 and at most 100 (needs the cost scope)' },
      award_template_id: { type: 'number', description: 'Award template id' },
      employment_start_date: { type: 'string', description: 'Start date YYYY-MM-DD' },
      department_ids: { type: 'array', items: { type: 'number' }, description: 'Replaces the user\'s teams' },
      employee_id: { type: 'string', description: 'Payroll employee id' },
      updates: {
        type: 'array',
        description: 'Bulk form, max 50: [{user_id, hourly_rate?, award_template_id?, employment_start_date?, department_ids?, employee_id?}]',
        items: { type: 'object' },
      },
      source_ref: { type: 'string', description: 'Audit reference, e.g. "iSolved rate backfill". Required when called with the shared server token (ADR 0001)' },
      dry_run: { type: 'boolean', description: 'Preview only. Default true without confirm_token, false with it' },
      confirm_token: { type: 'string', description: 'Token from the preview; applies the changes' },
      show_wages: { type: 'boolean', description: 'Show current and new rates in the diff (hidden by default)' },
      limit: { type: 'number', description: 'Rows per page (max 50)' },
      offset: { type: 'number', description: 'Row offset for paging (use page.next_offset from the previous response)' },
    },
  },
  async run(client, args) {
    if (!writesEnabled()) {
      throw new ArgError(`${UPDATE_USER_TOOL} is turned off on this server (TANDA_WRITES_ENABLED is not true). Nothing was changed.`);
    }
    const updates = parseUpdates(args);
    const sourceRef = text(args.source_ref, 'source_ref', 100);
    // ADR 0001: under the shared identity, name the decision this write carries out
    if (client.isSharedIdentity && !sourceRef) {
      throw new ArgError(`${UPDATE_USER_TOOL} needs source_ref (e.g. "iSolved rate backfill") when called with the shared server token. See docs/adr/0001-write-tool-identity.md.`);
    }
    const token = typeof args.confirm_token === 'string' && args.confirm_token.trim() ? args.confirm_token.trim() : undefined;
    const dryRun = bool(args.dry_run, !token);
    const request = [updates, sourceRef ?? null];
    const showWages = bool(args.show_wages) || parseFields(args.fields).includes('hourly_rate');
    // Check the token before any Tanda call, so a mismatched confirm fails fast
    if (token && !dryRun) checkConfirmToken(token, UPDATE_USER_TOOL, client.cacheScope, request);

    // Fail closed: if we can't tell who is calling, we can't rule out a self-edit
    let callerId: unknown;
    try {
      callerId = (await client.getCurrentUser()).id;
    } catch (error) {
      if (error instanceof TandaApiError) throw new TandaApiError('Could not identify the caller, so nothing was changed.', error.statusCode, 'The token needs the "me" scope.');
      throw error;
    }

    const warnings: Warning[] = [];
    const planned: Planned[] = [];
    for (const u of updates) planned.push(await plan(client, u, callerId));
    const ratedUsers = planned.flatMap((p) => (p.user && 'hourly_rate' in p.update.changes ? [p.user] : []));
    if (ratedUsers.length && !ratedUsers.some((u) => 'hourly_rate' in u)) {
      warnings.push({ check: 'hourly_rate', reason: 'no current rate visible: either none is set or the token lacks the cost scope, in which case Tanda may refuse the change' });
    }
    const toChange = planned.filter((p) => !p.refused && p.diff.length);
    const counts = {
      users: planned.length,
      will_change: toChange.length,
      unchanged: planned.filter((p) => !p.refused && !p.diff.length).length,
      refused: planned.filter((p) => p.refused).length,
      flagged: toChange.filter((p) => p.flags.length).length,
    };

    if (dryRun || !token) {
      const status = toChange.length ? 'preview' : planned.every((p) => !p.refused) ? 'unchanged' : 'nothing_to_change';
      const summary: Rec = { status, changed: false, ...counts };
      if (toChange.length) {
        summary.confirm_token = signConfirmToken(UPDATE_USER_TOOL, client.cacheScope, request);
        summary.expires_in_minutes = CONFIRM_TTL_MS / 60000;
        summary.next_step = `To apply the ${toChange.length} change(s) marked will_change, call again with the same arguments plus confirm_token.`;
      }
      return guardResponse({ ...summary, ...withWarnings(warnings) }, planned.map((p) => previewRow(p, showWages)), { offset: args.offset, pageSize: args.limit });
    }

    const rows: Rec[] = [];
    let succeeded = 0;
    let failed = 0;
    for (const p of planned) {
      if (p.refused || !p.diff.length) {
        rows.push(previewRow(p, showWages));
        continue;
      }
      const body: Rec = {};
      for (const d of p.diff) body[d.field] = d.after;
      try {
        const result = await client.updateUser(p.update.user_id, body);
        // Tanda drops fields the token can't write; report that instead of claiming success
        const dropped = p.diff.filter((d) => d.field in result && !sameValue(d.field, result[d.field], d.after)).map((d) => d.field);
        if (dropped.length) {
          failed++;
          rows.push({ user_id: p.update.user_id, user_name: p.user?.name ?? null, outcome: 'not_applied', fields: dropped, reason: 'Tanda kept the old value; check the token\'s scopes' });
        } else {
          succeeded++;
          rows.push({ user_id: p.update.user_id, user_name: p.user?.name ?? null, outcome: 'updated', changes: present(p.diff, showWages), user: pickUserFields({ ...p.user, ...result }) });
        }
        logger.info(`${UPDATE_USER_TOOL} updated user`, { user_id: p.update.user_id, fields: p.diff.map((d) => d.field), caller_user_id: callerId ?? null, caller: client.cacheScope, source_ref: sourceRef });
      } catch (error) {
        failed++;
        rows.push({ user_id: p.update.user_id, user_name: p.user?.name ?? null, outcome: 'failed', reason: writeFailureReason(error, 'update failed') });
        logger.warn(`${UPDATE_USER_TOOL} failed`, { user_id: p.update.user_id, caller: client.cacheScope, source_ref: sourceRef });
      }
    }
    return guardResponse(
      { status: 'applied', changed: succeeded > 0, ...counts, succeeded, failed, ...withWarnings(warnings) },
      rows,
      { offset: args.offset, pageSize: args.limit }
    );
  },
};
