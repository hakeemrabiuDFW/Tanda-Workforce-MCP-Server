import { TandaClient, Rec } from '../tanda/client';

/** Locations treated as bookkeeping (not real work sites). Override with TANDA_BOOKKEEPING_LOCATION_IDS. */
export const BOOKKEEPING_IDS = new Set(
  (process.env.TANDA_BOOKKEEPING_LOCATION_IDS || '281737,301754,396358')
    .split(',')
    .map((s) => Number(s.trim()))
    .filter((n) => Number.isFinite(n) && n > 0)
);

export const SUPERVISOR_DEPT_RE = /^supervisors?$/i;

/** Users never suggested or counted as supervisors (e.g. the external bookkeeper). Set COVERAGE_EXCLUDE_USER_IDS. */
export function coverageExcludedUserIds(): Set<number> {
  return new Set(
    (process.env.COVERAGE_EXCLUDE_USER_IDS || '')
      .split(',')
      .map((s) => Number(s.trim()))
      .filter((n) => Number.isFinite(n) && n > 0)
  );
}

/** True when a Tanda user record carries the given user level (e.g. "employee"). */
export function hasLevel(user: Rec | undefined, level: string): boolean {
  const levels = user?.user_levels;
  return Array.isArray(levels) && levels.some((l) => String(l).toLowerCase() === level);
}

export const ORG_TTL_MS = 24 * 60 * 60 * 1000;
/** People reference data (names, levels, departments) is cached like org data: 24h, then ETag revalidation. */
export const PEOPLE_TTL_MS = (Number(process.env.PEOPLE_CACHE_TTL_HOURS) || 24) * 60 * 60 * 1000;

export interface Org {
  locations: Rec[];
  departments: Rec[];
  locationById: Map<number, Rec>;
  departmentById: Map<number, Rec>;
  /** department id -> location id */
  deptLocation: Map<number, number | null>;
  supervisorDeptIds: Set<number>;
  isBookkeepingLocation(id: number | null | undefined): boolean;
  isBookkeepingDept(id: number | null | undefined): boolean;
  locationName(id: number | null | undefined): string | null;
  departmentName(id: number | null | undefined): string | null;
}

/** Locations + departments, served from cache for 24h then revalidated with ETag. */
export async function loadOrg(client: TandaClient): Promise<Org> {
  const [locations, departments] = await Promise.all([
    client.getLocations({ freshMs: ORG_TTL_MS }),
    client.getDepartments({ freshMs: ORG_TTL_MS }),
  ]);
  return orgFrom(locations, departments);
}

export function orgFrom(locations: Rec[], departments: Rec[]): Org {
  const locationById = new Map(locations.map((l) => [l.id as number, l]));
  const departmentById = new Map(departments.map((d) => [d.id as number, d]));
  const deptLocation = new Map<number, number | null>(
    departments.map((d) => [d.id as number, (d.location_id as number | undefined) ?? null])
  );
  const supervisorDeptIds = new Set(
    departments.filter((d) => SUPERVISOR_DEPT_RE.test(String(d.name || '').trim())).map((d) => d.id as number)
  );
  const isBookkeepingLocation = (id: number | null | undefined) => id !== null && id !== undefined && BOOKKEEPING_IDS.has(id);
  return {
    locations,
    departments,
    locationById,
    departmentById,
    deptLocation,
    supervisorDeptIds,
    isBookkeepingLocation,
    isBookkeepingDept: (id) => {
      if (id === null || id === undefined) return false;
      return BOOKKEEPING_IDS.has(id) || isBookkeepingLocation(deptLocation.get(id));
    },
    locationName: (id) => (id === null || id === undefined ? null : ((locationById.get(id)?.name as string) ?? null)),
    departmentName: (id) => (id === null || id === undefined ? null : ((departmentById.get(id)?.name as string) ?? null)),
  };
}

/** Department ids belonging to the given locations. */
export function departmentsForLocations(org: Org, locationIds: number[]): number[] {
  const wanted = new Set(locationIds);
  return org.departments.filter((d) => wanted.has(d.location_id as number)).map((d) => d.id as number);
}

export interface People {
  users: Rec[];
  byId: Map<number, Rec>;
  name(id: unknown): string | null;
}

/** Active users (cached 24h). Only names/ids are used from here; callers whitelist fields. */
export async function loadPeople(client: TandaClient): Promise<People> {
  return peopleFrom(await client.getUsers({ freshMs: PEOPLE_TTL_MS }));
}

export function peopleFrom(users: Rec[]): People {
  const byId = new Map(users.map((u) => [u.id as number, u]));
  return { users, byId, name: (id) => ((byId.get(id as number)?.name as string) ?? null) };
}
