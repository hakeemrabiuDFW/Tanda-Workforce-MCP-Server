import { Tool } from './types';
import { ArgError, bool, num, S } from '../args';
import { guardResponse } from '../guard';
import { loadOrg, Org, USERS_TTL_MS } from '../context';
import { soft, Warning, withWarnings } from '../warnings';
import { isTestUser } from '../apps/staffing';
import { Rec } from '../../tanda/client';
import { daysBetween, isDate, todayInZone, toZonedDate } from '../../utils/time';

export const ACCESS_AUDIT_TOOL = 'tanda_access_audit';

const DEFAULT_STALE_DAYS = 90;
const MAX_STALE_DAYS = 730;
/** Team names listed per row; the rest are counted. */
const MAX_TEAMS = 5;

export const FINDINGS = {
  elevated_not_seen: 'Admin or manager level, and has not opened the Workforce app within stale_days (or never)',
  employment_ended: 'Still active although the employment end date has passed',
  test_account: 'Active test account ("ZZ …", "Test …")',
  no_team: 'Active with no team',
  unknown_team: 'In a team that no longer exists',
  manages_without_manager_level: 'Manages teams but only has the employee level',
  employee_can_see_costs: 'Employee level only, but can see costs',
} as const;
type Finding = keyof typeof FINDINGS;

const ids = (v: unknown): number[] => (Array.isArray(v) ? v.filter((n): n is number => typeof n === 'number') : []);
const levelsOf = (u: Rec): string[] => (Array.isArray(u.user_levels) ? u.user_levels.map((l) => String(l).toLowerCase()) : []);

function teamName(org: Org | null, id: number): string | null {
  if (!org) return null;
  const dept = org.departmentName(id);
  if (!dept) return null;
  const site = org.locationName(org.deptLocation.get(id));
  return site ? `${dept} @ ${site}` : dept;
}

export const accessAuditTool: Tool = {
  name: ACCESS_AUDIT_TOOL,
  description:
    'Who has admin or manager access in Workforce, when each person last opened the app, and active users in the wrong teams ' +
    '(no team, a deleted team, managing teams without a manager level), plus ended employment still active and test accounts. ' +
    'Read-only: a list for a person to act on in Workforce; nothing is changed.',
  inputSchema: {
    type: 'object',
    properties: {
      stale_days: { type: 'number', description: `Flag admins and managers who have not opened the app in this many days. Default ${DEFAULT_STALE_DAYS}, max ${MAX_STALE_DAYS}` },
      elevated_only: { type: 'boolean', description: 'Only list admins and managers. Default false' },
      offset: S.offset,
      limit: S.limit,
    },
  },
  async run(client, args) {
    const staleDays = num(args.stale_days, DEFAULT_STALE_DAYS) as number;
    if (!Number.isInteger(staleDays) || staleDays < 1 || staleDays > MAX_STALE_DAYS) {
      throw new ArgError(`stale_days must be a whole number from 1 to ${MAX_STALE_DAYS}.`);
    }
    const elevatedOnly = bool(args.elevated_only, false);
    const today = todayInZone();
    const warnings: Warning[] = [];

    const [users, org] = await Promise.all([
      soft(warnings, 'users', [] as Rec[], () => client.getUsers({ freshMs: USERS_TTL_MS })),
      soft(warnings, 'teams', null as Org | null, () => loadOrg(client)),
    ]);

    const levelCounts: Record<string, number> = {};
    const findingCounts: Partial<Record<Finding, number>> = {};
    let activeUsers = 0;
    let elevatedCount = 0;
    const rows: Rec[] = [];
    for (const u of users) {
      if (u.active === false) continue;
      activeUsers++;
      const levels = levelsOf(u);
      for (const l of levels) levelCounts[l] = (levelCounts[l] || 0) + 1;
      const elevated = levels.some((l) => l !== 'employee');
      if (elevated) elevatedCount++;

      const teams = ids(u.department_ids);
      const managed = ids(u.managed_department_ids);
      const lastOpen = u.last_synced_mobile_app ? toZonedDate(u.last_synced_mobile_app) : null;
      const daysSince = lastOpen ? daysBetween(lastOpen, today) : null;

      const findings: Finding[] = [];
      if (elevated && (daysSince === null || daysSince > staleDays)) findings.push('elevated_not_seen');
      if (isDate(u.employment_end_date) && u.employment_end_date < today) findings.push('employment_ended');
      if (isTestUser(u)) findings.push('test_account');
      if (!teams.length) findings.push('no_team');
      // Only judged when the team list loaded: without it every team would look deleted
      if (org && teams.some((id) => !org.departmentById.has(id))) findings.push('unknown_team');
      if (managed.length && !elevated) findings.push('manages_without_manager_level');
      if (!elevated && u.can_see_costs === true) findings.push('employee_can_see_costs');
      for (const f of findings) findingCounts[f] = (findingCounts[f] || 0) + 1;

      if (!elevated && (elevatedOnly || !findings.length)) continue;
      const teamNames = teams.map((id) => teamName(org, id) ?? `team ${id}`);
      // Contact details, pay and passcodes stay out: only what's needed to review access
      rows.push({
        user_id: u.id,
        user_name: u.name ?? null,
        user_levels: levels,
        elevated,
        teams: teamNames.slice(0, MAX_TEAMS),
        ...(teamNames.length > MAX_TEAMS ? { teams_omitted: teamNames.length - MAX_TEAMS } : {}),
        managed_teams: managed.length,
        last_app_open: lastOpen,
        days_since_app_open: daysSince,
        findings,
      });
    }
    // Most findings first, then admins and managers, then by name
    rows.sort((a, b) =>
      (b.findings as Finding[]).length - (a.findings as Finding[]).length
      || Number(b.elevated) - Number(a.elevated)
      || String(a.user_name).localeCompare(String(b.user_name)));

    const summary: Rec = {
      as_of: today,
      stale_days: staleDays,
      active_users: activeUsers,
      elevated: elevatedCount,
      by_level: levelCounts,
      findings: findingCounts,
      finding_meanings: FINDINGS,
      note: 'last_app_open is when the person last opened the Workforce mobile app, the only sign-in date Tanda gives per user; ' +
        'web sign-ins are not included. Read-only: change levels and teams in Workforce.',
    };
    return guardResponse(summary, rows, { offset: args.offset, pageSize: args.limit, extra: withWarnings(warnings) });
  },
};
