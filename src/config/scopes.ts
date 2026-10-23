/**
 * Tanda OAuth scopes.
 *
 * This server is read-only and only needs the least-privilege set below.
 * Scopes that expose financial (wages, bank/tax details) or personal
 * (address, emergency contacts, tax file numbers) data are never requested,
 * even if configured via TANDA_SCOPES.
 */
//
// `unavailability` is left out: Workforce.com's OAuth authorize page fails with a server
// error when it is requested. Tools that read unavailability work without it (validate
// skips that check; time_off reports the missing scope). Add it via TANDA_SCOPES where the
// OAuth app supports it.
export const LEAST_PRIVILEGE_SCOPES = [
  'me',
  'roster',
  'timesheet',
  'department',
  'user',
  'cost',
  'leave',
] as const;

export const FORBIDDEN_SCOPES = new Set(['financial', 'personal']);

export interface ParsedScopes {
  scopes: string[];
  rejected: string[];
}

export function parseScopes(raw: string | undefined): ParsedScopes {
  const requested = (raw && raw.trim() ? raw : LEAST_PRIVILEGE_SCOPES.join(' '))
    .split(/[\s,]+/)
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);

  const scopes: string[] = [];
  const rejected: string[] = [];
  for (const scope of requested) {
    if (FORBIDDEN_SCOPES.has(scope)) {
      rejected.push(scope);
    } else if (!scopes.includes(scope)) {
      scopes.push(scope);
    }
  }
  return { scopes, rejected };
}
