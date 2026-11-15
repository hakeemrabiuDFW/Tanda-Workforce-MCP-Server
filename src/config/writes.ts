/**
 * The only exceptions to the read-only rule: creating a user and sending their invite (#84),
 * deactivating a user (#88; Tanda's DELETE /users/{id} only marks them inactive), and
 * approving timesheets, including filling a missing clock-out and noting exceptions on the shift (#86).
 * Every other write verb is refused by the Tanda client, and these are refused too
 * unless TANDA_WRITES_ENABLED=true. Read at call time so it can be toggled per deploy.
 */
const ALLOWED_WRITES: Array<{ method: string; path: RegExp }> = [
  { method: 'post', path: /^\/users$/ },
  { method: 'post', path: /^\/users\/\d+\/invite$/ },
  { method: 'delete', path: /^\/users\/\d+$/ },
  { method: 'put', path: /^\/timesheets\/\d+$/ },
  { method: 'put', path: /^\/shifts\/\d+$/ },
];

export function writesEnabled(): boolean {
  return process.env.TANDA_WRITES_ENABLED === 'true';
}

export function isAllowedWrite(method: string, path: string | undefined): boolean {
  if (!writesEnabled() || !path) return false;
  return ALLOWED_WRITES.some((w) => w.method === method && w.path.test(path));
}
