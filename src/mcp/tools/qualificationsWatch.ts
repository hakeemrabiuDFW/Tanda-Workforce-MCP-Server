import { Tool } from './types';
import { ArgError, bool, idList, num, S } from '../args';
import { guardResponse } from '../guard';
import { departmentsForLocations, loadOrg, ORG_TTL_MS } from '../context';
import { soft, Warning, withWarnings } from '../warnings';
import { isTestUser } from '../apps/staffing';
import { Rec } from '../../tanda/client';
import { addDays, daysBetween, isDate, todayInZone } from '../../utils/time';

export const QUALIFICATIONS_WATCH_TOOL = 'tanda_qualifications_watch';

const DEFAULT_DAYS = 30;
const MAX_DAYS = 365;
const TOP_QUALIFICATIONS = 10;

/** Tanda sends `expires` as a date; take the date part of anything longer. */
function expiryDate(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const d = value.slice(0, 10);
  return isDate(d) ? d : null;
}

export const qualificationsWatchTool: Tool = {
  name: QUALIFICATIONS_WATCH_TOOL,
  description:
    'Lists staff certifications that have expired or expire in the next `days` (default 30), soonest first, with days left. ' +
    'Read-only: a list for a person to act on; nothing is changed in Tanda and nobody is notified.',
  inputSchema: {
    type: 'object',
    properties: {
      days: { type: 'number', description: `Look-ahead in days. Default ${DEFAULT_DAYS}, max ${MAX_DAYS}` },
      include_expired: { type: 'boolean', description: 'Also list certifications that have already expired. Default true' },
      qualification_ids: { type: 'array', items: { type: 'number' }, description: 'Only these qualifications' },
      user_ids: S.userIds,
      location_ids: S.locationIds,
      offset: S.offset,
      limit: S.limit,
    },
  },
  async run(client, args) {
    const days = num(args.days, DEFAULT_DAYS) as number;
    if (!Number.isInteger(days) || days < 0 || days > MAX_DAYS) throw new ArgError(`days must be a whole number from 0 to ${MAX_DAYS}.`);
    const includeExpired = bool(args.include_expired, true);
    const qualIds = idList(args.qualification_ids);
    const userIds = idList(args.user_ids);
    const locIds = idList(args.location_ids);
    const today = todayInZone();
    const until = addDays(today, days);
    const warnings: Warning[] = [];

    const [users, quals, org] = await Promise.all([
      soft(warnings, 'holders', [] as Rec[], () => client.getUsers({ show_qualifications: true })),
      // Names only: without the scope (or the feature) rows still come back, keyed by qualification_id
      soft(warnings, 'qualification_names', [] as Rec[], () => client.getQualifications({ freshMs: ORG_TTL_MS }), { notFoundOk: true }),
      locIds ? loadOrg(client) : Promise.resolve(null),
    ]);
    const nameOf = new Map(quals.map((q) => [q.id as number, String(q.name ?? '')]));
    const deptFilter = org && locIds ? new Set(departmentsForLocations(org, locIds)) : null;
    const wantUsers = userIds ? new Set(userIds) : null;
    const wantQuals = qualIds ? new Set(qualIds) : null;

    let checked = 0;
    let leftOut = 0;
    let noExpiry = 0;
    let hidden = 0;
    const rows: Rec[] = [];
    for (const u of users) {
      if (wantUsers && !wantUsers.has(u.id as number)) continue;
      if (deptFilter && !((u.department_ids as number[]) || []).some((d) => deptFilter.has(d))) continue;
      if (isTestUser(u)) {
        leftOut++;
        continue;
      }
      if (!Array.isArray(u.qualifications)) {
        // Tanda sends this marker instead of the list when it holds them back
        if (u._qualifications_dev_warning) hidden++;
        continue;
      }
      checked++;
      for (const q of u.qualifications as Rec[]) {
        if (q.enabled === false) continue;
        const qid = q.qualification_id as number;
        if (wantQuals && !wantQuals.has(qid)) continue;
        const expires = expiryDate(q.expires);
        if (!expires) {
          noExpiry++;
          continue;
        }
        const daysLeft = daysBetween(today, expires);
        if (expires > until || (daysLeft < 0 && !includeExpired)) continue;
        // license_number, attachments and training details stay out: only what's needed to act
        rows.push({
          user_id: u.id,
          user_name: u.name ?? null,
          qualification_id: qid,
          qualification: nameOf.get(qid) || null,
          expires,
          days_left: daysLeft,
          status: daysLeft < 0 ? 'expired' : 'expiring',
          in_training: q.in_training === true,
        });
      }
    }
    rows.sort((a, b) => (a.days_left as number) - (b.days_left as number) || String(a.user_name).localeCompare(String(b.user_name)));
    if (hidden) warnings.push({ check: 'holders', reason: `Tanda did not return qualifications for ${hidden} staff` });

    const byQual = new Map<number, { qualification_id: number; qualification: string | null; expired: number; expiring: number }>();
    for (const r of rows) {
      const id = r.qualification_id as number;
      const b = byQual.get(id) || { qualification_id: id, qualification: r.qualification as string | null, expired: 0, expiring: 0 };
      b[r.status as 'expired' | 'expiring'] += 1;
      byQual.set(id, b);
    }
    const byQualification = [...byQual.values()].sort((a, b) => b.expired + b.expiring - (a.expired + a.expiring));

    const summary: Rec = {
      as_of: today,
      until,
      days,
      include_expired: includeExpired,
      staff_checked: checked,
      expired: rows.filter((r) => r.status === 'expired').length,
      expiring: rows.filter((r) => r.status === 'expiring').length,
      no_expiry_date: noExpiry,
      by_qualification: byQualification.slice(0, TOP_QUALIFICATIONS),
      ...(byQualification.length > TOP_QUALIFICATIONS ? { by_qualification_omitted: byQualification.length - TOP_QUALIFICATIONS } : {}),
      ...(leftOut ? { left_out: { test_users: leftOut } } : {}),
      note: 'Read-only list. Renewals are recorded in Workforce; nothing is changed and nobody is notified.',
    };
    return guardResponse(summary, rows, { offset: args.offset, pageSize: args.limit, extra: withWarnings(warnings) });
  },
};
