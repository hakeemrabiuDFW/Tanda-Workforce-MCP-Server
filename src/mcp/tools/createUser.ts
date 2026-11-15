import { Tool } from './types';
import { ArgError, Args, bool, idList, num, parseHourlyRate, text } from '../args';
import { loadOrg } from '../context';
import { pickUserFields } from '../privacy';
import { Warning, withWarnings, writeFailureReason } from '../warnings';
import { checkConfirmToken, CONFIRM_TTL_MS, signConfirmToken } from '../confirm';
import { writesEnabled } from '../../config/writes';
import { Rec, TandaApiError, TandaClient } from '../../tanda/client';
import { isDate } from '../../utils/time';
import { logger } from '../../utils/logger';

export const CREATE_USER_TOOL = 'tanda_create_user';

/** Only plain employees can be created here; elevated levels stay a manual Tanda change. */
const ALLOWED_LEVELS = ['employee'];
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function defaultAwardTemplateId(): number {
  return num(process.env.TANDA_DEFAULT_AWARD_TEMPLATE_ID) ?? 42;
}

/**
 * The exact body sent to POST /users. Only these keys can ever be sent: no DOB, passcode,
 * tax, bank or role fields. hourly_rate is optional (#94) and needs the "cost" scope.
 */
export function buildCreatePayload(args: Args): Rec {
  const name = text(args.name, 'name', 100);
  if (!name) throw new ArgError('name is required.');
  const email = text(args.email, 'email', 254)?.toLowerCase();
  if (!email) throw new ArgError('email is required (used for the duplicate check and the invite).');
  if (!EMAIL_RE.test(email)) throw new ArgError('email must be a valid email address.');
  const phone = text(args.phone, 'phone', 30);
  const start = args.employment_start_date;
  if (start !== undefined && start !== null && start !== '' && !isDate(start)) {
    throw new ArgError('employment_start_date must be a date in YYYY-MM-DD format.');
  }
  if (args.department_ids !== undefined && !idList(args.department_ids)) {
    throw new ArgError('department_ids must be a list of positive numbers.');
  }
  const award = args.award_template_id === undefined || args.award_template_id === null || args.award_template_id === ''
    ? defaultAwardTemplateId()
    : num(args.award_template_id);
  if (!award || award <= 0) throw new ArgError('award_template_id must be a positive number.');
  const rate = parseHourlyRate(args.hourly_rate);
  const levels = args.user_levels === undefined ? ['employee'] : args.user_levels;
  if (!Array.isArray(levels) || !levels.length || levels.some((l) => !ALLOWED_LEVELS.includes(String(l)))) {
    throw new ArgError(`user_levels may only contain: ${ALLOWED_LEVELS.join(', ')}. Grant other levels in Tanda.`);
  }

  const payload: Rec = { name, email };
  if (phone) payload.phone = phone;
  if (start) payload.employment_start_date = start;
  const depts = idList(args.department_ids);
  if (depts) payload.department_ids = [...new Set(depts)].sort((a, b) => a - b);
  payload.award_template_id = award;
  if (rate !== undefined) payload.hourly_rate = rate;
  payload.user_levels = levels.map(String);
  return payload;
}

const normName = (v: unknown) => String(v ?? '').trim().replace(/\s+/g, ' ').toLowerCase();

/** An existing user (active or inactive) with the same email, or the same name and start date. */
async function findExisting(client: TandaClient, payload: Rec): Promise<Rec | null> {
  const [active, inactive] = await Promise.all([client.getUsers(), client.getInactiveUsers()]);
  const all = [...active, ...inactive];
  const email = payload.email as string;
  const byEmail = all.find((u) => typeof u.email === 'string' && u.email.trim().toLowerCase() === email);
  if (byEmail) return { existing_user_id: byEmail.id, matched_on: 'email', active: byEmail.active !== false };
  if (payload.employment_start_date) {
    const byName = all.find((u) => normName(u.name) === normName(payload.name) && u.employment_start_date === payload.employment_start_date);
    if (byName) return { existing_user_id: byName.id, matched_on: 'name_and_start_date', active: byName.active !== false };
  }
  return null;
}

/**
 * Tanda rejects a second user with the same email even when its API doesn't return that email to us
 * (#105): "Validation failed: Email is already in use by an inactive user <name>".
 */
export function emailInUse(error: unknown): { name: string; active: boolean } | null {
  if (!(error instanceof TandaApiError) || (error.statusCode !== 400 && error.statusCode !== 422)) return null;
  const m = error.message.match(/email is already in use by an? (active|inactive)? ?user (.+?)\.?$/i);
  return m ? { name: m[2].trim(), active: m[1]?.toLowerCase() !== 'inactive' } : null;
}

/** The existing user Tanda named, by name among active and inactive users: an id only when exactly one matches. */
async function existingByName(client: TandaClient, name: string): Promise<{ existing_user_id: unknown; same_name_users: number }> {
  const [active, inactive] = await Promise.all([client.getUsers(), client.getInactiveUsers()]);
  const matches = [...active, ...inactive].filter((u) => normName(u.name) === normName(name));
  return { existing_user_id: matches.length === 1 ? matches[0].id : null, same_name_users: matches.length };
}

/** Unknown department ids are refused; if departments can't be read the check is skipped with a warning. */
async function checkDepartments(client: TandaClient, ids: number[] | undefined, warnings: Warning[]): Promise<void> {
  if (!ids?.length) return;
  try {
    const org = await loadOrg(client);
    const unknown = ids.filter((id) => !org.departmentById.has(id));
    if (unknown.length) throw new ArgError(`Unknown department_ids: ${unknown.join(', ')}. Use tanda_org to list departments.`);
  } catch (error) {
    if (!(error instanceof TandaApiError)) throw error;
    warnings.push({ check: 'department_ids', reason: `not verified: ${error.message}` });
  }
}

async function callerId(client: TandaClient): Promise<unknown> {
  try {
    return (await client.getCurrentUser()).id ?? null;
  } catch {
    return null;
  }
}

export const createUserTool: Tool = {
  name: CREATE_USER_TOOL,
  description:
    'Creates a Tanda employee in two steps: a call without confirm_token returns the exact payload and a confirm_token, and the same call plus confirm_token creates the user. ' +
    'Refuses duplicates (same email, or same name and start date) by returning the existing user id.',
  inputSchema: {
    type: 'object',
    properties: {
      name: { type: 'string', description: 'Full name (required)' },
      email: { type: 'string', description: 'Email (required): used for the duplicate check and the invite' },
      phone: { type: 'string', description: 'Mobile number' },
      employment_start_date: { type: 'string', description: 'Start date YYYY-MM-DD' },
      department_ids: { type: 'array', items: { type: 'number' }, description: 'Teams to add the user to (e.g. Trainee departments)' },
      award_template_id: { type: 'number', description: 'Award template (default 42, or TANDA_DEFAULT_AWARD_TEMPLATE_ID)' },
      hourly_rate: { type: 'number', description: 'Hourly pay rate, above 0 and at most 100 (needs the cost scope). Without it timesheets cost $0' },
      user_levels: { type: 'array', items: { type: 'string' }, description: 'Default ["employee"]; only "employee" is allowed' },
      send_invite: { type: 'boolean', description: 'Email the Tanda invite after creating (default false)' },
      source_ref: { type: 'string', description: 'Audit reference, e.g. the Monday item id. Required when called with the shared server token (ADR 0001)' },
      dry_run: { type: 'boolean', description: 'Preview only. Default true without confirm_token, false with it' },
      confirm_token: { type: 'string', description: 'Token from the preview; creates the user' },
      fields: { type: 'array', items: { type: 'string' }, description: 'Add email and/or phone to echo them in the preview' },
    },
    required: ['name', 'email'],
  },
  async run(client, args) {
    if (!writesEnabled()) {
      throw new ArgError(`${CREATE_USER_TOOL} is turned off on this server (TANDA_WRITES_ENABLED is not true). Nothing was created.`);
    }
    const payload = buildCreatePayload(args);
    const sendInvite = bool(args.send_invite);
    const sourceRef = text(args.source_ref, 'source_ref', 100);
    // ADR 0001: under the shared identity, name the decision this write carries out
    if (client.isSharedIdentity && !sourceRef) {
      throw new ArgError(`${CREATE_USER_TOOL} needs source_ref (e.g. the Monday item id) when called with the shared server token. See docs/adr/0001-write-tool-identity.md.`);
    }
    const token = typeof args.confirm_token === 'string' && args.confirm_token.trim() ? args.confirm_token.trim() : undefined;
    const dryRun = bool(args.dry_run, !token);
    const warnings: Warning[] = [];

    await checkDepartments(client, payload.department_ids as number[] | undefined, warnings);
    const existing = await findExisting(client, payload);
    if (existing) {
      if (token) logger.info(`${CREATE_USER_TOOL} refused duplicate`, { existing_user_id: existing.existing_user_id, matched_on: existing.matched_on, caller: client.cacheScope, source_ref: sourceRef });
      return { status: 'exists', created: false, ...existing, ...withWarnings(warnings) };
    }

    if (dryRun || !token) {
      if (payload.hourly_rate === undefined) {
        warnings.push({ check: 'hourly_rate', reason: 'no pay rate given: this user\'s timesheets will cost $0 until one is set (tanda_update_user)' });
      }
      return {
        status: 'preview',
        created: false,
        payload,
        // payload.hourly_rate is redacted like any wage key; say it's set without the value
        ...(payload.hourly_rate !== undefined ? { pay_rate_set: true } : {}),
        send_invite: sendInvite,
        confirm_token: signConfirmToken(CREATE_USER_TOOL, client.cacheScope, [payload, sendInvite, sourceRef ?? null]),
        expires_in_minutes: CONFIRM_TTL_MS / 60000,
        next_step: 'To create this user, call again with the same arguments plus confirm_token.',
        ...withWarnings(warnings),
      };
    }

    checkConfirmToken(token, CREATE_USER_TOOL, client.cacheScope, [payload, sendInvite, sourceRef ?? null]);
    let created: Rec;
    try {
      created = await client.createUser(payload);
    } catch (error) {
      const inUse = emailInUse(error);
      if (!inUse) throw error;
      const found = await existingByName(client, inUse.name);
      logger.info(`${CREATE_USER_TOOL} refused duplicate (Tanda: email in use)`, { existing_user_id: found.existing_user_id, caller: client.cacheScope, source_ref: sourceRef });
      return {
        status: 'exists',
        created: false,
        matched_on: 'email_in_tanda',
        active: inUse.active,
        ...found,
        note: 'Tanda already has a user with this email. Reactivate (rehire) them in Tanda instead of creating a new one.',
        ...withWarnings(warnings),
      };
    }
    const userId = created.id;
    if (typeof userId !== 'number') {
      logger.warn(`${CREATE_USER_TOOL}: Tanda returned no user id`, { caller: client.cacheScope, source_ref: sourceRef });
      throw new TandaApiError('Tanda accepted the request but returned no user id.', 502, 'Check tanda_people (search by name) before retrying, so the user is not created twice.');
    }
    logger.info(`${CREATE_USER_TOOL} created user`, { user_id: userId, caller_user_id: await callerId(client), caller: client.cacheScope, source_ref: sourceRef });

    // Tanda can keep the email but not return it to this token (#105): then our email duplicate check can't see it
    const storedEmail = typeof created.email === 'string' ? created.email.trim().toLowerCase() : '';
    if (storedEmail !== payload.email) {
      warnings.push({ check: 'email', reason: 'Tanda did not return the email for the new user, so this tool\'s duplicate check can\'t match it by email (Tanda itself still refuses a second user with the same email). Check the email in Tanda.' });
    }

    let invite: 'not_requested' | 'sent' | 'failed' = 'not_requested';
    if (sendInvite) {
      try {
        await client.inviteUser(userId);
        invite = 'sent';
      } catch (error) {
        invite = 'failed';
        warnings.push({ check: 'send_invite', reason: writeFailureReason(error, 'invite failed; send it from Tanda') });
      }
    }
    return { status: 'created', created: true, user_id: userId, user: pickUserFields(created), invite, ...withWarnings(warnings) };
  },
};
