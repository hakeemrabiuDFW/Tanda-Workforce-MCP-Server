import crypto from 'crypto';
import { config } from '../config/environment';
import { ArgError } from './args';

/** How long a preview's confirm_token stays valid. */
export const CONFIRM_TTL_MS = 15 * 60 * 1000;

/**
 * confirm_token for the write tools' preview-then-confirm step: an HMAC (JWT_SECRET) over the
 * tool name, the caller's token scope, the exact request and an expiry, so it can't be replayed
 * for other arguments, another identity or another tool.
 */
function mac(tool: string, callerScope: string, request: unknown, exp: number): string {
  return crypto.createHmac('sha256', config.JWT_SECRET).update(JSON.stringify([tool, exp, callerScope, request])).digest('hex');
}

export function signConfirmToken(tool: string, callerScope: string, request: unknown, now = Date.now()): string {
  const exp = now + CONFIRM_TTL_MS;
  return `${exp}.${mac(tool, callerScope, request, exp)}`;
}

export function checkConfirmToken(token: string, tool: string, callerScope: string, request: unknown): void {
  const [expRaw, got] = token.split('.');
  const exp = Number(expRaw);
  if (!Number.isFinite(exp) || !got) throw new ArgError('confirm_token is malformed. Call again without it to get a new preview.');
  const a = Buffer.from(got);
  const b = Buffer.from(mac(tool, callerScope, request, exp));
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
    throw new ArgError('confirm_token does not match these arguments. Send exactly the arguments from the preview, or call again without confirm_token for a new preview.');
  }
  if (Date.now() > exp) throw new ArgError('confirm_token has expired (15 minutes). Call again without it for a new preview.');
}
