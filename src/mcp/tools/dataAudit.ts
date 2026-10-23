import { Tool } from './types';
import { num } from '../args';
import { guardResponse } from '../guard';
import { coverageExcludedUserIds, hasLevel, loadOrg, loadPeople, orgFrom, peopleFrom } from '../context';
import { Rec } from '../../tanda/client';
import { itemCost, itemDate, itemHours } from '../../tanda/normalize';
import { addDays, round2, todayInZone } from '../../utils/time';
import { soft, Warning, withWarnings } from '../warnings';

const MAX_SAMPLES = 20;
const MAX_DAYS = 35;
/** Pending leave is looked for this far back (4 Tanda calls). */
export const LEAVE_LOOKBACK_DAYS = 28;
/** Sites whose cost per worked hour is below this are flagged (MIN_EFFECTIVE_RATE, default 16.00). */
export const MIN_EFFECTIVE_RATE = Number(process.env.MIN_EFFECTIVE_RATE) || 16;

interface CheckResult {
  check: string;
  description: string;
  count: number | null;
  sample_ids: unknown[];
  samples?: Rec[];
}

function result(check: string, description: string, items: Rec[] | null, sample: (r: Rec) => Rec = (r) => ({ id: r.id, name: r.name ?? null })): CheckResult {
  if (items === null) return { check, description, count: null, sample_ids: [] };
  const samples = items.slice(0, MAX_SAMPLES).map(sample);
  return { check, description, count: items.length, sample_ids: samples.map((s) => s.id), samples };
}

export const dataAuditTool: Tool = {
  name: 'tanda_data_audit',
  description:
    'Returns a data-quality audit in one call: counts plus up to 20 sample ids for staff missing award templates or position titles, active staff with no recent shifts, sites with hours but $0 or below-minimum cost, non-supervisors in Supervisor departments, and stale pending leave.',
  inputSchema: {
    type: 'object',
    properties: {
      days: { type: 'number', description: `Look-back for shift-based checks. Default 14, max ${MAX_DAYS}` },
      min_effective_rate: { type: 'number', description: `Flag sites whose cost per worked hour is below this. Default ${MIN_EFFECTIVE_RATE}` },
    },
  },
  async run(client, args) {
    const startRequests = client.requestCount;
    const days = Math.min(Math.max(Math.floor(num(args.days, 14) as number), 1), MAX_DAYS);
    const minRate = num(args.min_effective_rate, MIN_EFFECTIVE_RATE) as number;
    const today = todayInZone();
    const from = addDays(today, -(days - 1));
    const warnings: Warning[] = [];

    const [org, people, shifts, leave] = await Promise.all([
      soft(warnings, 'site_lookup', orgFrom([], []), () => loadOrg(client)),
      soft(warnings, 'user_lookup', null as ReturnType<typeof peopleFrom> | null, () => loadPeople(client)),
      soft(warnings, 'shifts', null as Rec[] | null, () => client.getShifts({ from, to: today, show_costs: true })),
      soft(warnings, 'stale_pending_leave', null as Rec[] | null, () =>
        client.getLeaveRequests({ from: addDays(today, -LEAVE_LOOKBACK_DAYS), to: today, status: 'pending' })),
    ]);
    const active = people ? people.users.filter((u) => u.active !== false) : null;
    const results: CheckResult[] = [];

    results.push(result('missing_award_template', 'Active users with no award_template_id',
      active && active.filter((u) => u.award_template_id === null || u.award_template_id === undefined)));

    const worked = shifts ? new Set(shifts.map((s) => s.user_id)) : null;
    results.push(result('no_recent_shifts', `Active users with no shifts in the last ${days} days`,
      active && worked && active.filter((u) => !worked.has(u.id))));

    // Site cost checks: only meaningful when Tanda returned costs at all (cost scope)
    let bySite: Array<{ id: number | null; name: string | null; hours: number; cost: number; rate: number | null }> | null = null;
    if (shifts) {
      if (shifts.length && !shifts.some((s) => typeof s.cost === 'number' || Array.isArray(s.award_interpretation))) {
        for (const check of ['zero_cost_sites', 'low_effective_rate']) warnings.push({ check, reason: 'missing scope: cost (shifts came back without costs)' });
      } else {
        const sites = new Map<number | null, { hours: number; cost: number }>();
        for (const s of shifts) {
          const d = itemDate(s);
          if (!d || d < from || d > today) continue;
          const dept = s.department_id as number | undefined;
          const loc = dept !== undefined && dept !== null ? org.deptLocation.get(dept) ?? null : null;
          if (org.isBookkeepingLocation(loc)) continue;
          const b = sites.get(loc) || { hours: 0, cost: 0 };
          b.hours += itemHours(s);
          b.cost += itemCost(s);
          sites.set(loc, b);
        }
        bySite = [...sites.entries()]
          .filter(([, b]) => b.hours > 0)
          .map(([id, b]) => ({ id, name: org.locationName(id), hours: round2(b.hours), cost: round2(b.cost), rate: b.cost > 0 ? round2(b.cost / b.hours) : null }))
          .sort((a, b) => b.hours - a.hours);
      }
    }
    const siteSample = (r: Rec) => ({ id: r.id, name: r.name, hours: r.hours, cost: r.cost, ...(r.rate !== null ? { effective_rate: r.rate } : {}) });
    results.push(result('zero_cost_sites', `Sites with worked hours but $0 cost in the last ${days} days`,
      bySite && bySite.filter((s) => s.cost === 0), siteSample));
    results.push(result('low_effective_rate', `Sites whose cost per worked hour is below $${minRate.toFixed(2)}`,
      bySite && bySite.filter((s) => s.rate !== null && s.rate < minRate).sort((a, b) => (a.rate as number) - (b.rate as number)), siteSample));

    // Supervisor departments should only hold real supervisors
    const excluded = coverageExcludedUserIds();
    const supStaff = new Set<number>();
    for (const id of org.supervisorDeptIds) for (const uid of (org.departmentById.get(id)?.staff as number[]) || []) supStaff.add(uid);
    const notSupervisors = people
      ? [...supStaff].flatMap((uid) => {
          const u = people.byId.get(uid);
          if (!u) return [];
          const reason = excluded.has(uid) ? 'in COVERAGE_EXCLUDE_USER_IDS' : !hasLevel(u, 'employee') ? 'no employee level' : null;
          return reason ? [{ id: uid, name: u.name ?? null, reason }] : [];
        })
      : null;
    results.push(result('non_supervisors_in_supervisor_depts', 'Users on the staff of a Supervisor department who are excluded from coverage or lack the employee level',
      notSupervisors, (r) => ({ id: r.id, name: r.name, reason: r.reason })));

    if (active && active.length && !active.some((u) => 'position_title' in u)) {
      warnings.push({ check: 'missing_position_title', reason: 'position_title is not returned on user records for this token' });
      results.push(result('missing_position_title', 'Active users with no position_title', null));
    } else {
      results.push(result('missing_position_title', 'Active users with no position_title',
        active && active.filter((u) => u.position_title === null || u.position_title === undefined || String(u.position_title).trim() === '')));
    }

    const stale = leave && leave.filter((l) => String(l.start ?? '').slice(0, 10) < today);
    results.push(result('stale_pending_leave', `Pending leave whose start date has passed (looks back ${LEAVE_LOOKBACK_DAYS} days)`,
      stale, (l) => ({ id: l.id, user_id: l.user_id, user_name: people?.name(l.user_id) ?? null, start: l.start, leave_type: l.leave_type ?? null })));

    const byCheck = Object.fromEntries(results.map((r) => [r.check, r.count]));
    return guardResponse(
      {
        as_of: today,
        days,
        shift_window: `${from}..${today}`,
        min_effective_rate: minRate,
        active_users: active ? active.length : null,
        flagged: results.reduce((n, r) => n + (r.count || 0), 0),
        by_check: byCheck,
        tanda_requests: client.requestCount - startRequests,
      },
      results,
      { extra: withWarnings(warnings) }
    );
  },
};
