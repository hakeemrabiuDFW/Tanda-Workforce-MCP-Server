import crypto from 'crypto';
import { Tool } from './types';
import { ArgError, Args, bool, idList, num } from '../args';
import { loadOrg } from '../context';
import { pickUserFields } from '../privacy';
import { Warning, withWarnings } from '../warnings';
import { config } from '../../config/environment';
import { writesEnabled } from '../../config/writes';
import { Rec, TandaApiError, TandaClient } from '../../tanda/client';
import { isDate } from '../../utils/time';
import { logger } from '../../utils/logger';

export const CREATE_USER_TOOL = 'tanda_create_user';

/** How long a preview's confirm_token stays valid. */
const TOKEN_TTL_MS = 15 * 60 * 1000;
/** Only plain employees can be created here; elevated levels stay a manual Tanda change. */
const ALLOWED_LEVELS = ['employee'];
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function defaultAwardTemplateId(): number {
  return num(process.env.TANDA_DEFAULT_AWARD_TEMPLATE_ID, 42) as number;
}

function text(value: unknown, name: string, max: number): string | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  if (typeof value !== 'string') throw new ArgError(`${name} must be a string.`);
  const trimmed = value.trim().replace(/\s+/g, ' ');
  if (trimmed.length > max) throw new ArgError(`${name} must be at most ${max} characters.`);
  return trimmed || undefined;
}

/**
 * The exact body sent to POST /users. Only these keys can ever be sent: no wage, DOB,
 * passcode, tax, bank or role fields.
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
  payload.user_levels = levels.map(String);
  return payload;
}

/** What the confirm_token is bound to: the payload, the invite choice, the audit ref and the caller. */
function signedMaterial(payload: Rec, sendInvite: boolean, sourceRef: string | undefined, callerScope: string, exp: number): string {
  return JSON.stringify([exp, callerScope, payload, sendInvite, sourceRef ?? null]);
}

export function signConfirmToken(payload: Rec, sendInvite: boolean, sourceRef: string | undefined, callerScope: string, now = Date.now()): string {
  const exp = now + TOKEN_TTL_MS;
  const mac = crypto.createHmac('sha256', config.JWT_SECRET).update(signedMaterial(payload, sendInvite, sourceRef, callerScope, exp)).digest('hex');
  return `${exp}.${mac}`;
}

function checkConfirmToken(token: string, payload: Rec, sendInvite: boolean, sourceRef: string | undefined, callerScope: string): void {
  const [expRaw, mac] = token.split('.');
  const exp = Number(expRaw);
  if (!Number.isFinite(exp) || !mac) throw new ArgError('confirm_token is malformed. Call again without it to get a new preview.');
  const expected = crypto.createHmac('sha256', config.JWT_SECRET).update(signedMaterial(payload, sendInvite, sourceRef, callerScope, exp)).digest('hex');
  const a = Buffer.from(mac);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
    throw new ArgError('confirm_token does not match these arguments. Send exactly the arguments from the preview, or call again without confirm_token for a new preview.');
  }
  if (Date.now() > exp) throw new ArgError('confirm_token has expired (15 minutes). Call again without it for a new preview.');
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
    return ((await client.getCurrentUser()) as unknown as Rec).id ?? null;
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
      user_levels: { type: 'array', items: { type: 'string' }, description: 'Default ["employee"]; only "employee" is allowed' },
      send_invite: { type: 'boolean', description: 'Email the Tanda invite after creating (default false)' },
      source_ref: { type: 'string', description: 'Audit reference, e.g. the Monday item id' },
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
      return {
        status: 'preview',
        created: false,
        payload,
        send_invite: sendInvite,
        confirm_token: signConfirmToken(payload, sendInvite, sourceRef, client.cacheScope),
        expires_in_minutes: TOKEN_TTL_MS / 60000,
        next_step: 'To create this user, call again with the same arguments plus confirm_token.',
        ...withWarnings(warnings),
      };
    }

    checkConfirmToken(token, payload, sendInvite, sourceRef, client.cacheScope);
    const created = await client.createUser(payload);
    const userId = created.id as number;
    logger.info(`${CREATE_USER_TOOL} created user`, { user_id: userId, caller_user_id: await callerId(client), caller: client.cacheScope, source_ref: sourceRef });

    let invite: 'not_requested' | 'sent' | 'failed' = 'not_requested';
    if (sendInvite) {
      try {
        await client.inviteUser(userId);
        invite = 'sent';
      } catch (error) {
        invite = 'failed';
        warnings.push({ check: 'send_invite', reason: error instanceof TandaApiError ? error.message : 'invite failed; send it from Tanda' });
      }
    }
    return { status: 'created', created: true, user_id: userId, user: pickUserFields(created), invite, ...withWarnings(warnings) };
  },
};
