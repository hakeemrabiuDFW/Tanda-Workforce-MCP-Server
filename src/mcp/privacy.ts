/**
 * Privacy filters. User records are whitelisted; sensitive keys are stripped from
 * any other payload unless the caller explicitly asks for them via `fields`.
 */

export const DEFAULT_USER_FIELDS = [
  'id',
  'name',
  'employee_id',
  'employment_start_date',
  'active',
  'user_levels',
  'department_ids',
  'report_department_id',
  'award_template_id',
] as const;

/** Keys never returned unless explicitly requested. */
const SENSITIVE_KEY_RE = /^(date_of_birth|passcode|phone|normalised_phone|email|legal_.*|address|emergency_contact.*|tax_.*|bank_.*|super_.*|hourly_rate)$/i;

/** Keys never returned, even when requested via `fields`. */
const POLICY_BLOCKED_RE = /^(passcode|tax_.*|bank_.*|super_.*)$/i;

/** Wage fields: only returned with show_wages and the "cost" scope. */
export const WAGE_FIELDS = new Set(['hourly_rate']);

export function isPolicyBlocked(key: string): boolean {
  return POLICY_BLOCKED_RE.test(key);
}

export interface IgnoredField {
  field: string;
  reason: 'unknown_field' | 'needs_scope:cost' | 'not_exposed_by_policy';
}

/**
 * Which requested `fields` will not come back, and why. A field is unknown when none of the
 * returned records carry it; a wage field missing from the records means the token lacks "cost".
 */
export function ignoredFields(requested: string[], records: Record<string, unknown>[]): IgnoredField[] {
  const out: IgnoredField[] = [];
  for (const field of new Set(requested)) {
    if ((DEFAULT_USER_FIELDS as readonly string[]).includes(field)) continue;
    if (isPolicyBlocked(field)) out.push({ field, reason: 'not_exposed_by_policy' });
    else if (records.some((r) => field in r)) continue;
    else if (WAGE_FIELDS.has(field)) out.push({ field, reason: 'needs_scope:cost' });
    else if (records.length) out.push({ field, reason: 'unknown_field' });
  }
  return out;
}

export function isSensitiveKey(key: string): boolean {
  return SENSITIVE_KEY_RE.test(key);
}

/** Parse a `fields` argument (array or comma string) into a list of extra keys. */
export function parseFields(fields: unknown): string[] {
  if (Array.isArray(fields)) return fields.map(String).map((f) => f.trim()).filter(Boolean);
  if (typeof fields === 'string') return fields.split(',').map((f) => f.trim()).filter(Boolean);
  return [];
}

/**
 * Whitelist a Tanda user. `extraFields` are added on top of the default set; this is the
 * only way to receive sensitive keys such as email or date_of_birth.
 */
export function pickUserFields(user: Record<string, unknown>, extraFields: string[] = []): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const key of [...DEFAULT_USER_FIELDS, ...extraFields.filter((f) => !isPolicyBlocked(f))]) {
    if (key in user) out[key] = user[key];
  }
  return out;
}

/** Recursively drop sensitive keys from an arbitrary payload (e.g. embedded user objects). */
export function redactSensitive<T>(value: T, allow: string[] = []): T {
  const allowed = new Set(allow.filter((k) => !isPolicyBlocked(k)));
  const walk = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(walk);
    if (v && typeof v === 'object') {
      const out: Record<string, unknown> = {};
      for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
        if (isSensitiveKey(k) && !allowed.has(k)) continue;
        out[k] = walk(val);
      }
      return out;
    }
    return v;
  };
  return walk(value) as T;
}
