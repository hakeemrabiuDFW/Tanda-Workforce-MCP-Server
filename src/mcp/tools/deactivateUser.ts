import { Tool } from './types';
import { ArgError, bool, requireId, text } from '../args';
import { pickUserFields } from '../privacy';
import { checkConfirmToken, CONFIRM_TTL_MS, signConfirmToken } from '../confirm';
import { writesEnabled } from '../../config/writes';
import { Rec, TandaApiError } from '../../tanda/client';
import { logger } from '../../utils/logger';

export const DEACTIVATE_USER_TOOL = 'tanda_deactivate_user';

/** Only plain employees can be deactivated here; managers and admins stay a manual change in Tanda. */
function onlyEmployee(user: Rec): boolean {
  const levels = user.user_levels;
  return Array.isArray(levels) && levels.length > 0 && levels.every((l) => String(l).toLowerCase() === 'employee');
}

export const deactivateUserTool: Tool = {
  name: DEACTIVATE_USER_TOOL,
  description:
    'Deactivates a Tanda employee (Tanda DELETE /users/{id}, which marks them inactive and can be undone with a rehire) in two steps: a call without confirm_token previews the user and returns a confirm_token, and the same call plus confirm_token deactivates. ' +
    'Refuses managers, admins and the caller.',
  inputSchema: {
    type: 'object',
    properties: {
      user_id: { type: 'number', description: 'User to deactivate (required)' },
      source_ref: { type: 'string', description: 'Audit reference, e.g. the Monday item id' },
      dry_run: { type: 'boolean', description: 'Preview only. Default true without confirm_token, false with it' },
      confirm_token: { type: 'string', description: 'Token from the preview; deactivates the user' },
    },
    required: ['user_id'],
  },
  async run(client, args) {
    if (!writesEnabled()) {
      throw new ArgError(`${DEACTIVATE_USER_TOOL} is turned off on this server (TANDA_WRITES_ENABLED is not true). Nothing was changed.`);
    }
    const userId = requireId(args.user_id, 'user_id');
    const sourceRef = text(args.source_ref, 'source_ref', 100);
    const token = typeof args.confirm_token === 'string' && args.confirm_token.trim() ? args.confirm_token.trim() : undefined;
    const dryRun = bool(args.dry_run, !token);

    const user = await client.getUser(userId);
    if (user.active === false) return { status: 'already_inactive', changed: false, user: pickUserFields(user) };
    if (!onlyEmployee(user)) {
      throw new ArgError(`User ${userId} has levels other than "employee" (${JSON.stringify(user.user_levels ?? [])}). Deactivate managers and admins in Tanda.`);
    }
    // Fail closed: if we can't tell who is calling, we can't rule out self-deactivation
    let callerId: unknown;
    try {
      callerId = (await client.getCurrentUser()).id;
    } catch (error) {
      if (error instanceof TandaApiError) throw new TandaApiError('Could not identify the caller, so nothing was changed.', error.statusCode, 'The token needs the "me" scope.');
      throw error;
    }
    if (callerId === userId) throw new ArgError('You cannot deactivate your own account with this tool.');

    if (dryRun || !token) {
      return {
        status: 'preview',
        changed: false,
        user: pickUserFields(user),
        confirm_token: signConfirmToken(DEACTIVATE_USER_TOOL, client.cacheScope, [userId, sourceRef ?? null]),
        expires_in_minutes: CONFIRM_TTL_MS / 60000,
        next_step: 'To deactivate this user, call again with the same arguments plus confirm_token. Tanda can reactivate them later (rehire).',
      };
    }

    checkConfirmToken(token, DEACTIVATE_USER_TOOL, client.cacheScope, [userId, sourceRef ?? null]);
    const result = await client.deactivateUser(userId);
    logger.info(`${DEACTIVATE_USER_TOOL} deactivated user`, { user_id: userId, caller_user_id: callerId ?? null, caller: client.cacheScope, source_ref: sourceRef });
    return { status: 'deactivated', changed: true, user_id: userId, user: pickUserFields({ ...user, ...result, active: false }) };
  },
};
