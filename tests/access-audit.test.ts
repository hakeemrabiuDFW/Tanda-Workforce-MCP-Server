/** WFM-107 (#66): tanda_access_audit, admin/manager levels, last app open and users in the wrong teams. "Today" is Mon 2026-11-23. */
import { executeTool } from '../src/mcp/tools';
import { fakeTanda, nySeconds, RouteHandler } from './helpers/fakeTanda';

type Content = {
  summary: Record<string, unknown>;
  rows: Array<Record<string, unknown>>;
  warnings?: Array<Record<string, unknown>>;
  error?: string;
};

const run = async (client: Parameters<typeof executeTool>[0], args: Record<string, unknown> = {}) =>
  (await executeTool(client, 'tanda_access_audit', args)) as { content: Content; isError?: boolean };

let nowSpy: jest.SpyInstance;
beforeEach(() => {
  nowSpy = jest.spyOn(Date, 'now').mockReturnValue(nySeconds('2026-11-23', '12:00') * 1000);
});
afterEach(() => nowSpy.mockRestore());

const seen = (date: string) => nySeconds(date, '09:00');
const user = (id: number, name: string, extra: Record<string, unknown> = {}) => ({
  id, name, user_levels: ['employee'], employment_start_date: '2024-01-01', active: true, department_ids: [11],
  managed_department_ids: [], can_see_costs: false, last_synced_mobile_app: seen('2026-11-20'),
  email: `u${id}@example.com`, phone: '+15550000000', passcode: '1234', hourly_rate: 18,
  ...extra,
});
const users = [
  user(1, 'Ana Admin', { user_levels: ['organisation_admin'], last_synced_mobile_app: seen('2026-11-01') }),
  user(2, 'Ben Manager', { user_levels: ['employee', 'roster_manager'], managed_department_ids: [11, 21], last_synced_mobile_app: null }),
  user(3, 'Cy Clean'),
  user(4, 'Dee NoTeam', { department_ids: [] }),
  user(5, 'Eve Gone', { department_ids: [99], employment_end_date: '2026-10-31' }),
  user(6, 'Fay Lead', { managed_department_ids: [21], can_see_costs: true }),
  user(7, 'Test Cleaner'),
  user(8, 'Old Leaver', { active: false, user_levels: ['organisation_admin'], department_ids: [] }),
];

function tanda(over: { users?: RouteHandler; departments?: RouteHandler } = {}) {
  return fakeTanda([
    ['/locations', () => [{ id: 1, name: 'Site A' }, { id: 2, name: 'Site B' }]],
    ['/departments', over.departments || (() => [{ id: 11, name: 'Cleaning', location_id: 1 }, { id: 21, name: 'Cleaning', location_id: 2 }])],
    ['/users', over.users || (() => users)],
  ]);
}

describe('tanda_access_audit', () => {
  it('lists admins and managers with last app open, and active users with access or team problems', async () => {
    const { client, requests } = tanda();
    const res = await run(client);
    expect(res.isError).toBeUndefined();
    expect(Object.keys(res.content)[0]).toBe('summary');
    expect(res.content.rows).toEqual([
      { user_id: 5, user_name: 'Eve Gone', user_levels: ['employee'], elevated: false, teams: ['team 99'], managed_teams: 0,
        last_app_open: '2026-11-20', days_since_app_open: 3, findings: ['employment_ended', 'unknown_team'] },
      { user_id: 6, user_name: 'Fay Lead', user_levels: ['employee'], elevated: false, teams: ['Cleaning @ Site A'], managed_teams: 1,
        last_app_open: '2026-11-20', days_since_app_open: 3, findings: ['manages_without_manager_level', 'employee_can_see_costs'] },
      { user_id: 2, user_name: 'Ben Manager', user_levels: ['employee', 'roster_manager'], elevated: true, teams: ['Cleaning @ Site A'], managed_teams: 2,
        last_app_open: null, days_since_app_open: null, findings: ['elevated_not_seen'] },
      { user_id: 4, user_name: 'Dee NoTeam', user_levels: ['employee'], elevated: false, teams: [], managed_teams: 0,
        last_app_open: '2026-11-20', days_since_app_open: 3, findings: ['no_team'] },
      { user_id: 7, user_name: 'Test Cleaner', user_levels: ['employee'], elevated: false, teams: ['Cleaning @ Site A'], managed_teams: 0,
        last_app_open: '2026-11-20', days_since_app_open: 3, findings: ['test_account'] },
      { user_id: 1, user_name: 'Ana Admin', user_levels: ['organisation_admin'], elevated: true, teams: ['Cleaning @ Site A'], managed_teams: 0,
        last_app_open: '2026-11-01', days_since_app_open: 22, findings: [] },
    ]);
    expect(res.content.summary).toMatchObject({
      as_of: '2026-11-23', stale_days: 90, active_users: 7, elevated: 2,
      by_level: { organisation_admin: 1, employee: 6, roster_manager: 1 },
      findings: { elevated_not_seen: 1, employment_ended: 1, unknown_team: 1, no_team: 1, test_account: 1, manages_without_manager_level: 1, employee_can_see_costs: 1 },
    });
    expect(res.content.warnings).toBeUndefined();
    expect(requests.every((r) => r.method === 'GET')).toBe(true);
  });

  it('never returns contact details, pay or passcodes', async () => {
    const { client } = tanda();
    const text = JSON.stringify((await run(client)).content);
    expect(text).not.toMatch(/example\.com|\+1555|"1234"|email|phone|passcode|hourly_rate/);
  });

  it('honours stale_days and elevated_only', async () => {
    const { client } = tanda();
    const strict = await run(client, { stale_days: 7 });
    expect(strict.content.rows.find((r) => r.user_id === 1)?.findings).toEqual(['elevated_not_seen']);
    const elevated = await run(client, { elevated_only: true });
    expect(elevated.content.rows.map((r) => r.user_id)).toEqual([2, 1]);
    // Counts still cover everyone
    expect(elevated.content.summary.findings).toMatchObject({ no_team: 1 });
  });

  it('without the department scope, still audits access but skips the deleted-team check, with one warning', async () => {
    const { client } = tanda({ departments: () => ({ __status: 403, body: { error: 'insufficient scope' } }) });
    const res = await run(client);
    expect(res.isError).toBeUndefined();
    const eve = res.content.rows.find((r) => r.user_id === 5);
    expect(eve).toMatchObject({ teams: ['team 99'], findings: ['employment_ended'] });
    expect(res.content.warnings).toEqual([{ check: 'teams', reason: 'missing scope: department' }]);
  });

  it('without the user scope, returns an empty list with a warning instead of failing', async () => {
    const { client } = tanda({ users: () => ({ __status: 403, body: { error: 'insufficient scope' } }) });
    const res = await run(client);
    expect(res.isError).toBeUndefined();
    expect(res.content.rows).toEqual([]);
    expect(res.content.summary).toMatchObject({ active_users: 0, elevated: 0 });
    expect(res.content.warnings).toEqual([{ check: 'users', reason: 'missing scope: user' }]);
  });

  it('rejects a bad stale_days value and still fails on Tanda errors that are not a missing scope', async () => {
    const { client } = tanda();
    const bad = await run(client, { stale_days: 0 });
    expect(bad.isError).toBe(true);
    expect(bad.content.error).toMatch(/stale_days must be a whole number from 1 to 730/);

    const { client: broken } = tanda({ users: () => ({ __status: 500, body: {} }) });
    expect((await run(broken)).isError).toBe(true);
  });
});
