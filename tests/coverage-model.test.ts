/** WFM-006 (#53): coverage suggestions, exclusion list and supervision model. */
import { executeTool } from '../src/mcp/tools';
import { fakeTanda, nySeconds } from './helpers/fakeTanda';

type Content = {
  summary: Record<string, unknown>;
  rows: Array<Record<string, unknown>>;
  warnings?: Array<Record<string, unknown>>;
  suggestions?: Array<Record<string, unknown>>;
  assumptions?: string[];
};

const run = async (client: Parameters<typeof executeTool>[0], name: string, args: Record<string, unknown>) =>
  (await executeTool(client, name, args)) as { content: Content; isError?: boolean };

describe('WFM-006 coverage suggestions and supervision model', () => {
  const d = '2026-10-20';
  const sched = (id: number, user: number, dept: number, from: string, hours: number) => {
    const start = nySeconds(d, from);
    return { id, user_id: user, department_id: dept, start, finish: start + hours * 3600 };
  };
  const routes = (schedules: unknown[], unavailability: () => unknown = () => []) => fakeTanda([
    ['/locations', () => [{ id: 1, name: 'Alpha' }, { id: 2, name: 'Beta' }, { id: 3, name: 'Gamma' }]],
    ['/departments', () => [
      { id: 11, name: 'Cleaning', location_id: 1, staff: [] },
      { id: 21, name: 'Cleaning', location_id: 2, staff: [] },
      { id: 31, name: 'Cleaning', location_id: 3, staff: [] },
      { id: 12, name: 'Supervisor', location_id: 1, staff: [100, 102, 103, 104] },
    ]],
    ['/users', () => [
      { id: 100, name: 'Sam', user_levels: ['employee'] },
      { id: 102, name: 'Bookkeeper', user_levels: ['employee', 'organisation_admin'] },
      { id: 103, name: 'Admin Only', user_levels: ['organisation_admin'] },
      { id: 104, name: 'Off Today', user_levels: ['employee'] },
      { id: 1, name: 'A' }, { id: 2, name: 'B' }, { id: 3, name: 'C' },
    ]],
    ['/schedules', () => schedules],
    ['/leave', () => [{ id: 9, user_id: 104, status: 'approved', start: d, finish: d }]],
    ['/unavailability', unavailability],
  ]);
  const staffAll = [sched(1, 1, 11, '17:00', 5), sched(2, 2, 21, '17:00', 5), sched(3, 3, 31, '17:00', 5)];
  afterEach(() => delete process.env.COVERAGE_EXCLUDE_USER_IDS);

  it('never suggests excluded, non-employee or on-leave users, and states its assumptions', async () => {
    process.env.COVERAGE_EXCLUDE_USER_IDS = '102';
    const res = await run(routes(staffAll).client, 'tanda_coverage', { from: d, to: d });
    const named = (res.content.suggestions || []).map((s) => s.user_id).filter(Boolean);
    expect(named).not.toContain(102);
    expect(named).not.toContain(103);
    expect(named).not.toContain(104);
    expect(named).toEqual([100]);
    expect(res.content.summary.supervision_model).toBe('site');
    expect(res.content.assumptions!.join(' ')).toMatch(/model "site"/);
    expect(res.content.assumptions!.join(' ')).toMatch(/1 user\(s\) in COVERAGE_EXCLUDE_USER_IDS/);
  });

  it('an excluded user rostered in a Supervisor department does not count as coverage', async () => {
    process.env.COVERAGE_EXCLUDE_USER_IDS = '102';
    const res = await run(routes([sched(1, 1, 11, '17:00', 5), sched(9, 102, 12, '17:00', 5)]).client, 'tanda_coverage', { from: d, to: d });
    expect(res.content.summary.gaps).toBe(1);
    expect(res.content.summary.supervisors_rostered).toBe(0);
  });

  it('roving mode counts one supervisor as covering several sites', async () => {
    const withSup = [...staffAll, sched(4, 100, 12, '17:00', 5)];
    const site = await run(routes(withSup).client, 'tanda_coverage', { from: d, to: d });
    expect(site.content.summary.gaps).toBe(2); // Beta and Gamma have no on-site supervisor

    const roving5 = await run(routes(withSup).client, 'tanda_coverage', { from: d, to: d, supervision_model: 'roving', sites_per_supervisor: 5 });
    expect(roving5.content.summary.gaps).toBe(0);
    expect(roving5.content.assumptions![0]).toMatch(/roving/);

    const roving2 = await run(routes(withSup).client, 'tanda_coverage', { from: d, to: d, supervision_model: 'roving', sites_per_supervisor: 2 });
    expect(roving2.content.summary.gaps).toBe(1);
    expect(roving2.content.rows[0]).toMatchObject({ sites_with_staff: 3, supervisors_on_duty: 1, capacity_sites: 2, uncovered_sites: 1, hours: 5 });
  });

  it('without the unavailability scope, only suggests supervisors already rostered that day', async () => {
    const rostered = [...staffAll, sched(5, 100, 12, '08:00', 4)]; // Sam rostered in the morning
    const res = await run(routes(rostered, () => ({ __status: 403, body: {} })).client, 'tanda_coverage', { from: d, to: d });
    expect(res.content.warnings).toEqual([{ check: 'suggestions.unavailability', reason: 'missing scope: unavailability' }]);
    expect((res.content.suggestions || []).map((s) => s.user_id).filter(Boolean)).toEqual([100]);
    expect(res.content.assumptions!.join(' ')).toMatch(/could not be confirmed/);

    const none = await run(routes(staffAll, () => ({ __status: 403, body: {} })).client, 'tanda_coverage', { from: d, to: d });
    expect((none.content.suggestions || []).every((s) => s.action === 'unfilled')).toBe(true);
  });
});

