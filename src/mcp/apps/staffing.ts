/**
 * Shared data for the two staffing MCP Apps (conversation_to_site_schedule and
 * staff_allocation_board): who could staff a site, how loaded they already are in the
 * target week, and how long they have been with the company. Read-only: only GETs
 * /locations, /departments, /users and /schedules.
 */
import { TandaClient } from '../../tanda/client';
import { ArgError, Args, num } from '../args';
import { coverageExcludedUserIds, loadOrg, loadPeople, Org } from '../context';
import { itemHours } from '../../tanda/normalize';
import { addDays, isDate, round2, todayInZone } from '../../utils/time';
import { workweek } from '../workweek';
import { shortName, tenureFrom } from './tenure';

/** A trainer, and the lead cleaner at a new site, need at least this much tenure. */
export const MIN_EXPERIENCED_MONTHS = 12;
/** Anyone newer than this is listed as a trainee, not offered as a cleaner. */
const TRAINEE_MAX_MONTHS = 3;
/** Departments whose staff can train, when TRAINER_USER_IDS is not set. */
const TRAINER_DEPT_RE = /^(ambassadors?|training)$/i;
/** user_levels that count as a supervisor alongside the Supervisor departments. */
const MANAGER_LEVEL_RE = /manager|supervisor/i;
/** Hours a week past which someone is not suggested for more work. */
const FULL_WEEK_HOURS = 40;
/** Most rows returned per list, so the result stays under the 25 KB cap. */
const MAX_POOL = 60;
const MAX_SITES = 30;

export type Role = 'supervisor' | 'trainer' | 'cleaner' | 'trainee';
export const ROLES: Role[] = ['supervisor', 'trainer', 'cleaner', 'trainee'];
export const SORTS = ['load', 'tenure', 'name'] as const;
export type Sort = (typeof SORTS)[number];

export interface Person {
  id: number;
  /** First name + last initial. */
  name: string;
  /** Site with most of their hours this week, else their first department's site. */
  site: string;
  week_hours: number;
  start_date: string | null;
  /** Time since start_date; null when Tanda has no start date for them. */
  tenure: { years: number; months: number; total_months: number } | null;
  /** e.g. "3y 2m" */
  tenure_label: string;
  lead?: boolean;
  why?: string;
}

export interface SiteLoad {
  id: number;
  name: string;
  cleaners: number;
  supervisors: number;
  week_hours: number;
}

export interface Staffing {
  week: { from: string; to: string; basis: string };
  pools: Record<Role, Person[]>;
  sites: SiteLoad[];
  sites_omitted: number;
  trainer_source: string;
  shifts_counted: number;
}

/** Trainer user ids from TRAINER_USER_IDS (comma separated); empty when unset. Read at call time. */
export function configuredTrainerIds(): Set<number> {
  return new Set(
    (process.env.TRAINER_USER_IDS || '')
      .split(',')
      .map((s) => Number(s.trim()))
      .filter((n) => Number.isFinite(n) && n > 0)
  );
}

/** The workweek to plan in: the one containing `week_of`, else the one containing tomorrow. */
export function targetWeek(args: Args): { from: string; to: string; basis: string } {
  const given = args.week_of;
  if (given !== undefined && given !== null && given !== '' && !isDate(given)) {
    throw new ArgError('`week_of` must be a date in YYYY-MM-DD format.');
  }
  // Tomorrow, so a call on the last day of a week plans the week about to start.
  const anchor = isDate(given) ? given : addDays(todayInZone(), 1);
  const ww = workweek();
  return { from: ww.start(anchor), to: ww.end(anchor), basis: ww.basis };
}

export function minTenureMonths(args: Args): number {
  const n = num(args.min_tenure_months, 0) ?? 0;
  if (n < 0 || n > 600) throw new ArgError('min_tenure_months must be between 0 and 600.');
  return Math.floor(n);
}

const norm = (s: unknown) => String(s ?? '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

/** The Tanda site whose name contains, or is contained in, `query`. */
export function matchSite(sites: SiteLoad[], org: Org, query: unknown): SiteLoad | null {
  const q = norm(query);
  if (!q) return null;
  const hit = org.locations.find((l) => {
    const n = norm(l.name);
    return n !== '' && !org.isBookkeepingLocation(l.id as number) && (n.includes(q) || q.includes(n));
  });
  if (!hit) return null;
  return sites.find((s) => s.id === hit.id) ?? { id: hit.id as number, name: String(hit.name), cleaners: 0, supervisors: 0, week_hours: 0 };
}

function sortPeople(list: Person[], sort: Sort): Person[] {
  const months = (p: Person) => p.tenure?.total_months ?? -1;
  const byLoad = (a: Person, b: Person) => a.week_hours - b.week_hours || months(b) - months(a) || a.name.localeCompare(b.name);
  if (sort === 'tenure') return [...list].sort((a, b) => months(b) - months(a) || a.week_hours - b.week_hours);
  if (sort === 'name') return [...list].sort((a, b) => a.name.localeCompare(b.name));
  return [...list].sort(byLoad);
}

/**
 * Everyone active, with a role, their scheduled hours for the whole target week and tenure.
 * Supervisor = on a Supervisor department's staff list or a manager user level. Trainer =
 * TRAINER_USER_IDS when set, else Ambassador/TRAINING department staff with a year or more.
 */
export async function loadStaffing(
  client: TandaClient,
  week: { from: string; to: string; basis: string },
  opts: { sort?: Sort; minTenureMonths?: number } = {}
): Promise<{ staffing: Staffing; org: Org }> {
  const [org, people, schedules] = await Promise.all([
    loadOrg(client),
    loadPeople(client),
    // getSchedules returns every rostered shift in the range, not a page of them.
    client.getSchedules({ from: week.from, to: week.to }),
  ]);
  const today = todayInZone();
  const excluded = coverageExcludedUserIds();
  const trainerIds = configuredTrainerIds();

  const supervisorStaff = new Set<number>();
  const trainerDeptStaff = new Set<number>();
  const firstSite = new Map<number, number>();
  for (const d of org.departments) {
    const staff = Array.isArray(d.staff) ? (d.staff as number[]) : [];
    const loc = (d.location_id as number | undefined) ?? null;
    const isSup = org.supervisorDeptIds.has(d.id as number);
    const isTrainer = TRAINER_DEPT_RE.test(String(d.name || '').trim());
    for (const uid of staff) {
      if (isSup) supervisorStaff.add(uid);
      if (isTrainer) trainerDeptStaff.add(uid);
      if (!isSup && loc !== null && !org.isBookkeepingLocation(loc) && !firstSite.has(uid)) firstSite.set(uid, loc);
    }
  }

  const hours = new Map<number, number>();
  const hoursBySite = new Map<number, Map<number, number>>();
  const siteAgg = new Map<number, { cleaners: Set<number>; supervisors: Set<number>; hours: number }>();
  for (const s of schedules) {
    const h = itemHours(s);
    const uid = s.user_id as number | null | undefined;
    const deptId = (s.department_id as number | undefined) ?? null;
    const loc = deptId !== null ? org.deptLocation.get(deptId) ?? null : null;
    if (uid) {
      hours.set(uid, (hours.get(uid) || 0) + h);
      if (loc !== null) {
        if (!hoursBySite.has(uid)) hoursBySite.set(uid, new Map());
        const m = hoursBySite.get(uid) as Map<number, number>;
        m.set(loc, (m.get(loc) || 0) + h);
      }
    }
    if (loc === null || org.isBookkeepingLocation(loc)) continue;
    if (!siteAgg.has(loc)) siteAgg.set(loc, { cleaners: new Set(), supervisors: new Set(), hours: 0 });
    const agg = siteAgg.get(loc) as { cleaners: Set<number>; supervisors: Set<number>; hours: number };
    agg.hours += h;
    if (uid) (deptId !== null && org.supervisorDeptIds.has(deptId) ? agg.supervisors : agg.cleaners).add(uid);
  }

  const homeSite = (uid: number): string => {
    const worked = [...(hoursBySite.get(uid)?.entries() || [])].sort((a, b) => b[1] - a[1])[0];
    return org.locationName(worked ? worked[0] : firstSite.get(uid)) ?? 'No site yet';
  };

  const pools: Record<Role, Person[]> = { supervisor: [], trainer: [], cleaner: [], trainee: [] };
  const minMonths = opts.minTenureMonths ?? 0;
  for (const u of people.users) {
    const id = u.id as number;
    if (u.active === false || excluded.has(id)) continue;
    const tenure = tenureFrom(u.employment_start_date, today);
    if (minMonths > 0 && (tenure?.total_months ?? -1) < minMonths) continue;
    const levels = Array.isArray(u.user_levels) ? (u.user_levels as unknown[]) : [];
    const experienced = (tenure?.total_months ?? -1) >= MIN_EXPERIENCED_MONTHS;
    const base = (): Person => ({
      id,
      name: shortName(u.name),
      site: homeSite(id),
      week_hours: round2(hours.get(id) || 0),
      start_date: isDate(u.employment_start_date) ? u.employment_start_date : null,
      tenure: tenure ? { years: tenure.years, months: tenure.months, total_months: tenure.total_months } : null,
      tenure_label: tenure ? tenure.label : 'start date not set',
    });
    const isSupervisor = supervisorStaff.has(id) || levels.some((l) => MANAGER_LEVEL_RE.test(String(l)));
    const isTrainer = trainerIds.size > 0 ? trainerIds.has(id) : trainerDeptStaff.has(id) && experienced;
    if (isSupervisor) pools.supervisor.push(base());
    if (isTrainer) pools.trainer.push(base());
    if (isSupervisor || isTrainer) continue;
    const isTrainee = tenure !== null && tenure.total_months < TRAINEE_MAX_MONTHS;
    pools[isTrainee ? 'trainee' : 'cleaner'].push(base());
  }
  for (const r of ROLES) pools[r] = sortPeople(pools[r], opts.sort ?? 'load').slice(0, MAX_POOL);

  const allSites: SiteLoad[] = [...siteAgg.entries()]
    .map(([id, a]) => ({ id, name: org.locationName(id) ?? `Site ${id}`, cleaners: a.cleaners.size, supervisors: a.supervisors.size, week_hours: round2(a.hours) }))
    .sort((a, b) => b.week_hours - a.week_hours);

  return {
    org,
    staffing: {
      week,
      pools,
      sites: allSites.slice(0, MAX_SITES),
      sites_omitted: Math.max(0, allSites.length - MAX_SITES),
      trainer_source: trainerIds.size > 0
        ? `TRAINER_USER_IDS (${trainerIds.size} configured)`
        : `Ambassador/TRAINING department staff with ${MIN_EXPERIENCED_MONTHS}+ months tenure (set TRAINER_USER_IDS to use an exact list)`,
      shifts_counted: schedules.length,
    },
  };
}

export interface Need {
  cleaners: number;
  supervisor: number;
  trainer: number;
}

export interface Recommendation {
  cleaners: Person[];
  supervisor: Person[];
  trainer: Person[];
  warnings: string[];
}

/**
 * Who to put on the site. Lowest load in the target week first, with two tenure rules: the
 * trainer has a year or more, and the first cleaner (the lead) has a year or more when anyone does.
 * `siteHours` is what the new site adds to each cleaner's week; people it would push past 40 h come last.
 */
export function recommend(staffing: Staffing, need: Need, siteHours = 0): Recommendation {
  const warnings: string[] = [];
  const months = (p: Person) => p.tenure?.total_months ?? -1;
  const fits = (p: Person) => p.week_hours + siteHours <= FULL_WEEK_HOURS;
  const byLoad = (list: Person[]) => [...list].sort((a, b) => Number(fits(b)) - Number(fits(a)) || a.week_hours - b.week_hours || months(b) - months(a));
  const loadNote = (p: Person) => `${p.week_hours} h scheduled this week, ${p.tenure_label} tenure`;

  const cleaners: Person[] = [];
  const pool = byLoad(staffing.pools.cleaner);
  if (need.cleaners > 0) {
    const lead = pool.find((p) => months(p) >= MIN_EXPERIENCED_MONTHS);
    if (lead) cleaners.push({ ...lead, lead: true, why: `Lead cleaner: ${MIN_EXPERIENCED_MONTHS}+ months experience; ${loadNote(lead)}` });
    else if (pool.length) warnings.push(`No cleaner with ${MIN_EXPERIENCED_MONTHS}+ months tenure is available to lead; pick a lead by hand.`);
    for (const p of pool) {
      if (cleaners.length >= need.cleaners) break;
      if (cleaners.some((c) => c.id === p.id)) continue;
      cleaners.push({ ...p, why: `Lowest load: ${loadNote(p)}` });
    }
    if (cleaners.length < need.cleaners) warnings.push(`Only ${cleaners.length} of ${need.cleaners} cleaners found.`);
    const over = cleaners.filter((p) => !fits(p));
    if (over.length) warnings.push(`${over.map((p) => p.name).join(', ')} would pass ${FULL_WEEK_HOURS} h this week with this site.`);
  }

  const supervisor = byLoad(staffing.pools.supervisor).slice(0, need.supervisor).map((p) => ({ ...p, why: `Lowest supervisor load: ${loadNote(p)}` }));
  if (supervisor.length < need.supervisor) warnings.push('No supervisor found in a Supervisor department or with a manager level.');

  const trainerPool = [...staffing.pools.trainer].sort((a, b) => a.week_hours - b.week_hours || months(b) - months(a));
  const trainer = trainerPool.slice(0, need.trainer).map((p) => ({ ...p, why: `Trainer: ${loadNote(p)}` }));
  if (trainer.length < need.trainer) warnings.push(`No trainer found (${staffing.trainer_source}).`);
  for (const t of trainer) {
    if (months(t) < MIN_EXPERIENCED_MONTHS) warnings.push(`${t.name} is on the trainer list with under ${MIN_EXPERIENCED_MONTHS} months tenure.`);
  }
  return { cleaners, supervisor, trainer, warnings };
}

export const peopleLine = (list: Person[]): string =>
  list.map((p) => `${p.name}${p.lead ? ' (lead)' : ''} [${p.tenure_label}, ${p.week_hours} h]`).join(', ') || 'none';
