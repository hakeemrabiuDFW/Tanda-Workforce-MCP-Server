/**
 * The one exception to the read-only rule (#84): creating a user and sending their invite.
 * Every other write verb is refused by the Tanda client, and these two are refused too
 * unless TANDA_WRITES_ENABLED=true. Read at call time so it can be toggled per deploy.
 */
const ALLOWED_WRITES: Array<{ method: string; path: RegExp }> = [
  { method: 'post', path: /^\/users$/ },
  { method: 'post', path: /^\/users\/\d+\/invite$/ },
];

export function writesEnabled(): boolean {
  return process.env.TANDA_WRITES_ENABLED === 'true';
}

export function isAllowedWrite(method: string, path: string | undefined): boolean {
  if (!writesEnabled() || !path) return false;
  return ALLOWED_WRITES.some((w) => w.method === method && w.path.test(path));
}
