import { Args } from '../args';
import { addDays, todayInZone } from '../../utils/time';
import { logger } from '../../utils/logger';

/**
 * Deprecated tool names (v3.x individual tools and the interim 9 action-based tools).
 * They keep working for one release by translating to the new tools. Each use is logged.
 */
export type AliasResult = { tool: string; args: Args } | { removed: string };
type Mapper = (args: Args) => AliasResult;

const to = (tool: string, extra: (a: Args) => Args = () => ({})): Mapper => (a) => ({ tool, args: { ...a, ...extra(a) } });
const removed = (msg: string): Mapper => () => ({ removed: msg });
const deptIds = (a: Args) => (a.department_id !== undefined ? { department_ids: [a.department_id] } : {});
const evening = (a: Args) => ({ mode: 'gaps', from: a.date ?? a.from, to: a.date ?? a.to, window_start: '17:00', window_end: '22:00' });
const week = (a: Args) => {
  const from = (a.date as string) || todayInZone();
  return { from, to: addDays(from, 6) };
};

const SHIFT_LIMITS = 'tanda_get_shift_limits was removed: Tanda\'s endpoint returns first/last shifts, not limits. Use tanda_exceptions (open > 12h, weekly > 40h).';
const BREAKS = 'Shift breaks are now returned as break_minutes on tanda_timesheets view=shifts.';
const WRITE = 'This server is read-only; write actions were removed.';

export const V3_ALIASES: Record<string, Mapper> = {
  tanda_get_current_user: to('tanda_people', () => ({ me: true })),
  tanda_get_users: to('tanda_people', (a) => ({ status: a.active === false ? 'inactive' : 'active' })),
  tanda_get_user: to('tanda_people'),
  tanda_get_inactive_users: to('tanda_people', () => ({ status: 'inactive' })),
  tanda_get_staff_by_department: to('tanda_people', deptIds),
  tanda_get_departments: to('tanda_org'),
  tanda_get_locations: to('tanda_org'),
  tanda_get_teams: to('tanda_org'),
  tanda_get_schedules: to('tanda_schedules'),
  tanda_get_current_roster: to('tanda_schedules', week),
  tanda_get_roster_by_date: to('tanda_schedules', week),
  tanda_get_roster: to('tanda_schedules', week),
  tanda_get_shifts: to('tanda_timesheets', () => ({ view: 'shifts' })),
  tanda_get_timesheets: to('tanda_timesheets'),
  tanda_get_award_interpretation: to('tanda_timesheets', () => ({ view: 'shifts' })),
  tanda_get_shift_breaks: removed(BREAKS),
  tanda_get_active_shifts: to('tanda_live'),
  tanda_get_clocked_in_users: to('tanda_live'),
  tanda_get_shift_limits: removed(SHIFT_LIMITS),
  tanda_get_daily_stats: to('tanda_labor_summary', (a) => ({ group_by: 'day', ...deptIds(a) })),
  tanda_get_roster_costs: to('tanda_labor_summary', () => ({ group_by: 'day' })),
  tanda_get_leave_requests: to('tanda_time_off', () => ({ kind: 'leave' })),
  tanda_get_leave_balances: to('tanda_time_off', () => ({ kind: 'balances' })),
  tanda_get_leave_types: to('tanda_time_off', () => ({ kind: 'balances' })),
  tanda_calculate_leave_hours: removed('Use tanda_time_off kind=leave (requests include hours) or kind=balances.'),
  tanda_get_unavailability: to('tanda_time_off', () => ({ kind: 'unavailability' })),
  tanda_detect_supervisor_overlaps: to('tanda_coverage', () => ({ mode: 'overlaps' })),
  tanda_analyze_evening_coverage: to('tanda_coverage', evening),
  tanda_get_placement_recommendations: to('tanda_coverage', () => ({ mode: 'gaps' })),
  tanda_optimize_supervisor_schedules: to('tanda_coverage', () => ({ mode: 'gaps' })),
  tanda_validate_supervisor_schedules: to('tanda_validate_schedule', (a) => ({ shifts: a.shifts ?? a.schedules })),
};

/** Interim (main-branch) 9 action-based tools. */
const ACTION_ALIASES: Record<string, Record<string, Mapper>> = {
  tanda_users: {
    list: V3_ALIASES.tanda_get_users,
    get: V3_ALIASES.tanda_get_user,
    current: V3_ALIASES.tanda_get_current_user,
    inactive: V3_ALIASES.tanda_get_inactive_users,
    by_department: V3_ALIASES.tanda_get_staff_by_department,
  },
  tanda_rosters: {
    get: V3_ALIASES.tanda_get_roster,
    current: V3_ALIASES.tanda_get_current_roster,
    by_date: V3_ALIASES.tanda_get_roster_by_date,
  },
  tanda_reference: {
    departments: V3_ALIASES.tanda_get_departments,
    locations: V3_ALIASES.tanda_get_locations,
    teams: V3_ALIASES.tanda_get_teams,
    daily_stats: V3_ALIASES.tanda_get_daily_stats,
  },
  tanda_realtime: {
    active_shifts: V3_ALIASES.tanda_get_active_shifts,
    clocked_in: V3_ALIASES.tanda_get_clocked_in_users,
    shift_limits: V3_ALIASES.tanda_get_shift_limits,
    award_interpretation: V3_ALIASES.tanda_get_award_interpretation,
    roster_costs: V3_ALIASES.tanda_get_roster_costs,
  },
  tanda_leave: {
    list: V3_ALIASES.tanda_get_leave_requests,
    balances: V3_ALIASES.tanda_get_leave_balances,
    types: V3_ALIASES.tanda_get_leave_types,
    calculate_hours: V3_ALIASES.tanda_calculate_leave_hours,
  },
  tanda_unavailability: { list: V3_ALIASES.tanda_get_unavailability },
  tanda_supervisors: {
    detect_overlaps: V3_ALIASES.tanda_detect_supervisor_overlaps,
    evening_coverage: V3_ALIASES.tanda_analyze_evening_coverage,
    recommendations: V3_ALIASES.tanda_get_placement_recommendations,
    optimize: V3_ALIASES.tanda_optimize_supervisor_schedules,
    validate: V3_ALIASES.tanda_validate_supervisor_schedules,
  },
};

/** New tool names that also existed in the interim build with an `action` argument. */
const ACTION_ON_NEW_TOOL: Record<string, Record<string, Mapper>> = {
  tanda_schedules: { list: to('tanda_schedules'), get: removed('Use tanda_change_history type=schedule id=<id>, or tanda_schedules with from/to.') },
  tanda_timesheets: {
    shifts: to('tanda_timesheets', () => ({ view: 'shifts' })),
    timesheets: to('tanda_timesheets', () => ({ view: 'timesheets' })),
    breaks: removed(BREAKS),
  },
};

const usage = new Map<string, number>();

export function aliasUsage(): Record<string, number> {
  return Object.fromEntries(usage);
}

export function isAlias(name: string): boolean {
  return name in V3_ALIASES || name in ACTION_ALIASES;
}

export const ALIAS_NAMES = [...Object.keys(V3_ALIASES), ...Object.keys(ACTION_ALIASES)];

/**
 * Translate a deprecated name (or a new name called with a legacy `action`) to the new tool.
 * Returns null when no translation applies.
 */
export function resolveAlias(name: string, args: Args): AliasResult | null {
  const { action, ...rest } = args;
  let mapper: Mapper | undefined;
  if (V3_ALIASES[name]) mapper = V3_ALIASES[name];
  else if (ACTION_ALIASES[name]) {
    mapper = ACTION_ALIASES[name][String(action)] ?? removed(
      action ? `${name} action=${String(action)}: ${WRITE}` : `${name} needs an action; prefer the new tools.`
    );
  } else if (ACTION_ON_NEW_TOOL[name] && action !== undefined) {
    mapper = ACTION_ON_NEW_TOOL[name][String(action)] ?? removed(`${name} action=${String(action)}: ${WRITE}`);
  }
  if (!mapper) return null;

  const key = action !== undefined ? `${name}:${String(action)}` : name;
  usage.set(key, (usage.get(key) || 0) + 1);
  const result = mapper(rest);
  logger.warn('Deprecated MCP tool alias used', { alias: key, maps_to: 'tool' in result ? result.tool : 'removed' });
  return result;
}
