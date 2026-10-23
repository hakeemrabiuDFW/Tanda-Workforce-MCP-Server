/**
 * Workforce MCP backlog (2026-10-22 smoke test findings): WFM-001 .. WFM-012.
 * "Today" is pinned to Friday 2026-10-23 (America/New_York) for date-relative checks.
 */
import { executeTool } from '../src/mcp/tools';
import { fakeTanda, nySeconds } from './helpers/fakeTanda';
import { fixtureClient } from './helpers/fixture';
import { TokenBucketLimiter } from '../src/tanda/rateLimiter';
import { loadPeople, PEOPLE_TTL_MS } from '../src/mcp/context';
import { parsePayCalendar, periodContaining, previousPeriod } from '../src/mcp/payCalendar';
import { addDays, daysBetween, weekStartOn } from '../src/utils/time';

type Content = {
  summary: Record<string, unknown>;
  rows: Array<Record<string, unknown>>;
  warnings?: Array<Record<string, unknown>>;
  suggestions?: Array<Record<string, unknown>>;
  assumptions?: string[];
  ignored_fields?: Array<Record<string, unknown>>;
  user?: Record<string, unknown>;
  error?: string;
};

const NOW = nySeconds('2026-10-23', '12:00');
let nowSpy: jest.SpyInstance;
beforeEach(() => {
  nowSpy = jest.spyOn(Date, 'now').mockReturnValue(NOW * 1000);
});
afterEach(() => nowSpy.mockRestore());

const run = async (client: Parameters<typeof executeTool>[0], name: string, args: Record<string, unknown>) =>
  (await executeTool(client, name, args)) as { content: Content; isError?: boolean };

describe('WFM-001 tanda_export_preview setup', () => {
  it('names the Tanda setup step when TANDA_EXPORT_FORMAT is missing', async () => {
    const saved = process.env.TANDA_EXPORT_FORMAT;
    delete process.env.TANDA_EXPORT_FORMAT;
    const { client, requests } = fixtureClient();
    const res = await run(client, 'tanda_export_preview', {});
    process.env.TANDA_EXPORT_FORMAT = saved;
    expect(res.isError).toBe(true);
    expect(res.content.error).toMatch(/Build Your Own/);
    expect(res.content.error).toMatch(/isolved/);
    expect(res.content.error).toMatch(/TANDA_EXPORT_FORMAT/);
    expect(requests).toHaveLength(0);
  });

  it('previews with approved_only and skip_status_update, using GET only', async () => {
    process.env.TANDA_EXPORT_FORMAT = 'isolved_custom';
    const { client, requests } = fixtureClient();
    const res = await run(client, 'tanda_export_preview', { date: '2026-10-14' });
    expect(res.content.summary).toMatchObject({ row_count: 1200, rows_missing_pay_code: 48, export_format: 'isolved_custom' });
    const call = requests.find((r) => r.params.export_format)!;
    expect(call.params).toMatchObject({ approved_only: 'true', skip_status_update: 'true' });
    expect(requests.every((r) => r.method === 'GET')).toBe(true);
  });
});

describe('WFM-002 tanda_validate_schedule fails soft per check', () => {
  const day = '2026-10-13';
  const routes = (overrides: Record<string, () => unknown> = {}) => fakeTanda([
    ['/users', overrides['/users'] || (() => [{ id: 1, name: 'A' }])],
    ['/schedules', overrides['/schedules'] || (() => [
      { id: 50, user_id: 1, start: nySeconds(day, '08:00'), finish: nySeconds(day, '12:00') },
      { id: 51, user_id: 1, start: nySeconds('2026-10-14', '06:00'), finish: nySeconds('2026-10-14', '18:00') },
      { id: 52, user_id: 1, start: nySeconds('2026-10-15', '06:00'), finish: nySeconds('2026-10-15', '18:00') },
      { id: 53, user_id: 1, start: nySeconds('2026-10-16', '06:00'), finish: nySeconds('2026-10-16', '18:00') },
    ])],
    ['/leave', overrides['/leave'] || (() => [{ id: 3, user_id: 1, status: 'approved', start: '2026-10-17', finish: '2026-10-17' }])],
    ['/unavailability', overrides['/unavailability'] || (() => ({ __status: 403, body: { error: 'insufficient scope' } }))],
  ]);
  const shifts = [
    { user_id: 1, start: `${day} 10:00`, finish: `${day} 14:00` }, // overlaps roster
    { user_id: 1, start: '2026-10-17 06:00', finish: '2026-10-17 20:00' }, // leave + 14h + > 40h week
    { user_id: 1, location_id: 1, start: '2026-10-18 09:00', finish: '2026-10-18 10:00' },
    { user_id: 1, location_id: 2, start: '2026-10-18 09:30', finish: '2026-10-18 11:00' }, // double-booked
  ];
  const issues = (r: Record<string, unknown>) => [...(r.errors as string[]), ...(r.warnings as string[])].join('; ');

  it('without the unavailability scope, every other check still runs and one warning is returned', async () => {
    const res = await run(routes().client, 'tanda_validate_schedule', { shifts });
    expect(res.isError).toBeFalsy();
    expect(res.content.warnings).toEqual([{ check: 'unavailability', reason: 'missing scope: unavailability' }]);
    expect(res.content.summary.checks_skipped).toEqual(['unavailability']);
    expect(issues(res.content.rows[0])).toMatch(/overlaps existing schedule 50/);
    expect(issues(res.content.rows[1])).toMatch(/approved leave/);
    expect(issues(res.content.rows[1])).toMatch(/exceeds 12h/);
    expect(issues(res.content.rows[1])).toMatch(/> 40h/);
    expect(issues(res.content.rows[3])).toMatch(/double-booked/);
  });

  it('without the roster scope, skips roster conflicts and says the weekly total is partial', async () => {
    const res = await run(routes({ '/schedules': () => ({ __status: 403, body: {} }) }).client, 'tanda_validate_schedule', { shifts });
    expect(res.content.warnings!.map((w) => w.check).sort()).toEqual(['roster_conflicts', 'unavailability', 'weekly_hours']);
    expect(issues(res.content.rows[0])).not.toMatch(/existing schedule/);
    expect(issues(res.content.rows[1])).toMatch(/approved leave/);
  });

  it('still fails on errors that are not a missing scope', async () => {
    const res = await run(routes({ '/leave': () => ({ __status: 500, body: {} }) }).client, 'tanda_validate_schedule', { shifts });
    expect(res.isError).toBe(true);
    expect(res.content.error).toMatch(/unavailable/);
  });
});

describe('WFM-004 unapproved cost covers every open pay period', () => {
  const s = (id: number, date: string, cost: number) => ({ id, date, department_id: 11, start: nySeconds(date, '09:00'), finish: nySeconds(date, '17:00'), cost });
  const current = [
    { id: 1, user_id: 1, status: 'pending', start: '2026-10-19', finish: '2026-11-01', shifts: [s(10, '2026-10-20', 100), s(11, '2026-10-22', 50)] },
    { id: 2, user_id: 2, status: 'approved', start: '2026-10-19', finish: '2026-11-01', shifts: [s(12, '2026-10-20', 999)] },
  ];
  const prior = [
    { id: 3, user_id: 1, status: 'pending', start: '2026-10-05', finish: '2026-10-18', shifts: [s(13, '2026-10-06', 200), s(14, '2026-10-16', 300)] },
    { id: 4, user_id: 3, status: 'exported', start: '2026-10-05', finish: '2026-10-18', shifts: [s(15, '2026-10-06', 999)] },
  ];
  const routes = () => fakeTanda([
    ['/departments', () => [{ id: 11, name: 'Cleaning', location_id: 1 }]],
    ['/locations', () => [{ id: 1, name: 'KIPP #3' }]],
    [/^\/timesheets\/on\//, (r) => {
      const date = r.path.split('/').pop() as string;
      if (date >= '2026-10-19' && date <= '2026-11-01') return current;
      if (date >= '2026-10-05' && date <= '2026-10-18') return prior;
      return [];
    }],
  ]);

  it('reports the window and all open periods separately, with counts and period ranges', async () => {
    const res = await run(routes().client, 'tanda_exceptions', { from: '2026-10-17', to: '2026-10-23', checks: ['unapproved_timesheet_cost'] });
    const sum = res.content.summary;
    // Window: shifts dated 10/17..10/23 only (10/16 is outside)
    expect(sum.window_unapproved_cost).toMatchObject({ cost: 150, timesheets: 1, period_ranges: ['2026-10-19..2026-11-01'] });
    expect(sum.unapproved_cost_total).toBe(150);
    // All open periods: the whole prior period is still pending, regardless of window
    expect(sum.all_open_periods_unapproved_cost).toMatchObject({ cost: 650, timesheets: 2, period_ranges: ['2026-10-05..2026-10-18', '2026-10-19..2026-11-01'] });
    expect(sum.pending_open_periods).toEqual([
      { period_start: '2026-10-05', period_finish: '2026-10-18', period_status: 'ended', timesheets: 1, hours: 16, cost: 500 },
      { period_start: '2026-10-19', period_finish: '2026-11-01', period_status: 'current', timesheets: 1, hours: 16, cost: 150 },
    ]);
  });

  it('keeps the window breakdown when the open-period walk is rate limited', async () => {
    let calls = 0;
    const { client } = fakeTanda([
      ['/departments', () => [{ id: 11, name: 'Cleaning', location_id: 1 }]],
      [/^\/timesheets\/on\//, () => (++calls <= 2 ? current : { __status: 429, body: {} })],
    ], { retryBaseMs: 1 });
    const res = await run(client, 'tanda_exceptions', { from: '2026-10-19', to: '2026-10-23', checks: ['unapproved_timesheet_cost'] });
    expect(res.isError).toBeFalsy();
    expect(res.content.summary.window_unapproved_cost).toMatchObject({ cost: 150 });
    expect(res.content.warnings).toEqual([{ check: 'pending_open_periods', reason: 'Tanda rate limit reached after retries', rate_limited: true }]);
  });
});

describe('WFM-005 weekly hours use explicit calendar workweeks', () => {
  // 9h shifts Thu 10/15 .. Wed 10/21 except Sat/Sun: 36h in week 10/12, 27h in week 10/19, 45h in the rolling 10/16..10/22
  const days = ['2026-10-15', '2026-10-16', '2026-10-19', '2026-10-20', '2026-10-21'];
  const extra = ['2026-10-12', '2026-10-13'];
  const shift = (id: number, user: number, date: string, hours: number) => {
    const start = nySeconds(date, '07:00');
    return { id, user_id: user, department_id: 11, date, start, finish: start + hours * 3600, cost: hours * 20 };
  };
  const shifts = [
    ...[...extra, ...days].map((d, i) => shift(i + 1, 1, d, 9)),
    ...['2026-10-12', '2026-10-13', '2026-10-14', '2026-10-15', '2026-10-16'].map((d, i) => shift(100 + i, 2, d, 9)),
    // user 3: 32h worked Mon-Thu this week, 10h still rostered Saturday
    ...['2026-10-19', '2026-10-20', '2026-10-21', '2026-10-22'].map((d, i) => shift(200 + i, 3, d, 8)),
  ];
  const routes = () => fakeTanda([
    ['/departments', () => [{ id: 11, name: 'Cleaning', location_id: 1 }]],
    ['/locations', () => [{ id: 1, name: 'Alpha' }]],
    ['/users', () => [{ id: 1, name: 'A' }, { id: 2, name: 'B' }, { id: 3, name: 'C' }]],
    ['/shifts', (r) => shifts.filter((s) => s.date >= r.params.from && s.date <= r.params.to)],
    ['/schedules', (r) => {
      const sat = { id: 900, user_id: 3, department_id: 11, start: nySeconds('2026-10-24', '07:00'), finish: nySeconds('2026-10-24', '17:00'), cost: 200 };
      return r.params.from <= '2026-10-24' && r.params.to >= '2026-10-24' ? [sat] : [];
    }],
  ]);

  it('echoes the week basis and each week range, and agrees with labor_summary for a Mon-Sun week', async () => {
    const { client } = routes();
    const week = { from: '2026-10-12', to: '2026-10-18' };
    const ex = await run(client, 'tanda_exceptions', { ...week, checks: ['weekly_hours_over_40'] });
    expect(ex.content.summary.week_basis).toBe('calendar workweek MON-SUN (WORKWEEK_START=MON)');
    expect(ex.content.summary.weeks).toEqual([{ week_start: '2026-10-12', week_end: '2026-10-18' }]);
    expect(ex.content.rows).toEqual([expect.objectContaining({ user_id: 2, week_start: '2026-10-12', week_end: '2026-10-18', hours: 45 })]);

    const labor = await run(client, 'tanda_labor_summary', { ...week, group_by: 'user' });
    const over = labor.content.rows.filter((r) => (r.actual_hours as number) > 40).map((r) => r.user_id);
    expect(over).toEqual(ex.content.rows.map((r) => r.user_id));
  });

  it('a rolling window that straddles two weeks is evaluated per calendar week', async () => {
    const res = await run(routes().client, 'tanda_exceptions', { from: '2026-10-16', to: '2026-10-22', checks: ['weekly_hours_over_40'] });
    // user 1 has 45h in the rolling window but 36h + 27h in the two calendar weeks
    expect(res.content.rows.map((r) => r.user_id)).toEqual([2]);
    expect((res.content.summary.weeks as unknown[]).length).toBe(2);
  });

  it('WORKWEEK_START changes the week boundaries', async () => {
    const res = await run(routes().client, 'tanda_exceptions', { from: '2026-10-16', to: '2026-10-22', checks: ['weekly_hours_over_40'], workweek_start: 'THU' });
    expect(res.content.summary.week_basis).toBe('calendar workweek THU-WED (WORKWEEK_START=THU)');
    expect(res.content.rows.find((r) => r.user_id === 1)).toMatchObject({ week_start: '2026-10-15', week_end: '2026-10-21', hours: 45 });
  });

  it('projects the current partial week from worked + still-rostered hours', async () => {
    const res = await run(routes().client, 'tanda_exceptions', { checks: ['projected_over_40'] });
    expect(res.content.rows).toEqual([expect.objectContaining({
      type: 'projected_over_40', user_id: 3, week_start: '2026-10-19', week_end: '2026-10-25',
      worked_hours: 32, rostered_remaining_hours: 10, projected_hours: 42, over_by: 2,
    })]);
  });

  it('rejects an unknown workweek_start', async () => {
    const res = await run(routes().client, 'tanda_exceptions', { checks: ['weekly_hours_over_40'], workweek_start: 'FUNDAY' });
    expect(res.isError).toBe(true);
  });
});

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

describe('WFM-007 tanda_people reports ignored fields', () => {
  const user = { id: 1, name: 'Pat', active: true, email: 'p@example.com', passcode: '1234' };
  const routes = (wages: 'ok' | 'omitted' | 'denied') => fakeTanda([
    ['/users', (r) => {
      if (r.params.show_wages && wages === 'denied') return { __status: 403, body: {} };
      return [r.params.show_wages && wages === 'ok' ? { ...user, hourly_rate: 18.5 } : user];
    }],
    ['/users/1', (r) => (r.params.show_wages && wages === 'ok' ? { ...user, hourly_rate: 18.5 } : user)],
  ]);

  it('lists unknown and policy-blocked fields', async () => {
    const res = await run(routes('ok').client, 'tanda_people', { fields: ['pay_group_id', 'passcode', 'email'] });
    expect(res.content.ignored_fields).toEqual([
      { field: 'pay_group_id', reason: 'unknown_field' },
      { field: 'passcode', reason: 'not_exposed_by_policy' },
    ]);
    expect(res.content.rows[0].email).toBe('p@example.com');
    expect(JSON.stringify(res.content)).not.toContain('1234');
  });

  it('returns hourly_rate when the cost scope allows it', async () => {
    const res = await run(routes('ok').client, 'tanda_people', { fields: ['hourly_rate'] });
    expect(res.content.rows[0].hourly_rate).toBe(18.5);
    expect(res.content.ignored_fields).toBeUndefined();
    const one = await run(routes('ok').client, 'tanda_people', { user_id: 1, show_wages: true });
    expect(one.content.user!.hourly_rate).toBe(18.5);
  });

  it('reports needs_scope:cost when wages are omitted or denied, and still returns people', async () => {
    for (const mode of ['omitted', 'denied'] as const) {
      const res = await run(routes(mode).client, 'tanda_people', { fields: ['hourly_rate'] });
      expect(res.isError).toBeFalsy();
      expect(res.content.rows).toHaveLength(1);
      expect(res.content.ignored_fields).toEqual([{ field: 'hourly_rate', reason: 'needs_scope:cost' }]);
    }
  });

  it('never returns hourly_rate unless asked', async () => {
    const { client } = fakeTanda([['/users', () => [{ ...user, hourly_rate: 18.5 }]]]);
    const res = await run(client, 'tanda_people', {});
    expect(res.content.rows[0].hourly_rate).toBeUndefined();
  });
});

describe('WFM-008 leave balances explain an empty result', () => {
  const routes = (balances: unknown[]) => fakeTanda([
    ['/leave_balances', () => balances],
    [/^\/leave\/types_for\//, () => [{ name: 'Sick Leave' }]],
  ]);

  it('says no accrual is configured when Tanda returns no balances', async () => {
    const res = await run(routes([]).client, 'tanda_time_off', { kind: 'balances', user_id: 7 });
    expect(res.content.summary).toMatchObject({ balances: 0, balances_configured: false, case: 'no_accrual_configured' });
    expect(res.content.summary.hint).toMatch(/Sick Leave/);
    expect(res.content.summary.hint).toMatch(/isolved/);
  });

  it('distinguishes a real zero balance', async () => {
    const res = await run(routes([{ user_id: 7, leave_type: 'Sick Leave', balance: 0 }]).client, 'tanda_time_off', { kind: 'balances', user_id: 7 });
    expect(res.content.summary).toMatchObject({ balances_configured: true, case: 'zero_balance' });
  });
});

describe('WFM-009 tanda_data_audit', () => {
  const shift = (id: number, user: number, dept: number, date: string, hours: number, cost: number) => {
    const start = nySeconds(date, '08:00');
    return { id, user_id: user, department_id: dept, date, start, finish: start + hours * 3600, cost };
  };
  const routes = (shiftsRoute: () => unknown) => fakeTanda([
    ['/locations', () => [{ id: 1, name: 'KIPP #7' }, { id: 2, name: 'Upstate Vet' }, { id: 3, name: 'Hill Street Cafe' }, { id: 281737, name: 'One Time Projects' }]],
    ['/departments', () => [
      { id: 11, name: 'Cleaning', location_id: 1 }, { id: 21, name: 'Cleaning', location_id: 2 }, { id: 31, name: 'Cleaning', location_id: 3 },
      { id: 41, name: 'Cleaning', location_id: 281737 },
      { id: 12, name: 'Supervisors', location_id: 1, staff: [1, 4] },
    ]],
    ['/users', () => [
      { id: 1, name: 'Sup', active: true, user_levels: ['employee'], award_template_id: 5, position_title: 'Supervisor' },
      { id: 2, name: 'Crew', active: true, user_levels: ['employee'], award_template_id: null, position_title: null },
      { id: 3, name: 'Idle', active: true, user_levels: ['employee'], award_template_id: null, position_title: 'Cleaner' },
      { id: 4, name: 'Bookkeeper', active: true, user_levels: ['organisation_admin'], award_template_id: 5, position_title: '' },
    ]],
    ['/shifts', shiftsRoute],
    ['/leave', () => [
      { id: 70, user_id: 2, status: 'pending', start: '2026-10-01', finish: '2026-10-02', leave_type: 'Sick' },
      { id: 71, user_id: 2, status: 'pending', start: '2026-10-30', finish: '2026-10-30' },
    ]],
  ]);
  const shifts = () => [
    shift(1, 1, 11, '2026-10-20', 8, 0), // KIPP #7: hours, $0
    shift(2, 2, 21, '2026-10-21', 8, 120), // Upstate Vet: $15/h
    shift(3, 2, 31, '2026-10-22', 8, 160), // Hill Street: $20/h
    shift(4, 4, 41, '2026-10-22', 8, 0), // bookkeeping site: ignored
  ];

  it('returns every check, summary first, under 20 Tanda requests', async () => {
    const { client } = routes(shifts);
    const res = await run(client, 'tanda_data_audit', {});
    expect(res.isError).toBeFalsy();
    const by = res.content.summary.by_check as Record<string, number>;
    expect(by).toEqual({
      missing_award_template: 2,
      no_recent_shifts: 1,
      zero_cost_sites: 1,
      low_effective_rate: 1,
      non_supervisors_in_supervisor_depts: 1,
      missing_position_title: 2,
      stale_pending_leave: 1,
    });
    const row = (c: string) => res.content.rows.find((r) => r.check === c)!;
    expect(row('zero_cost_sites').samples).toEqual([{ id: 1, name: 'KIPP #7', hours: 8, cost: 0 }]);
    expect(row('low_effective_rate').samples).toEqual([{ id: 2, name: 'Upstate Vet', hours: 8, cost: 120, effective_rate: 15 }]);
    expect(row('no_recent_shifts').sample_ids).toEqual([3]);
    expect(row('non_supervisors_in_supervisor_depts').samples).toEqual([{ id: 4, name: 'Bookkeeper', reason: 'no employee level' }]);
    expect(row('stale_pending_leave').sample_ids).toEqual([70]);
    expect(res.content.summary.tanda_requests as number).toBeLessThan(20);
    expect(Object.keys(res.content)[0]).toBe('summary');
  });

  it('caps samples at 20 and stays under 20 requests on the 84-site fixture', async () => {
    const { client, requests } = fixtureClient();
    const res = await run(client, 'tanda_data_audit', { days: 35 });
    expect(requests.length).toBeLessThan(20);
    for (const r of res.content.rows) expect((r.sample_ids as unknown[]).length).toBeLessThanOrEqual(20);
  });

  it('degrades cost checks when costs are missing and reports a missing scope per check', async () => {
    const noCost = await run(routes(() => shifts().map(({ cost: _c, ...s }) => s)).client, 'tanda_data_audit', {});
    expect(noCost.content.warnings!.map((w) => w.check)).toEqual(['zero_cost_sites', 'low_effective_rate']);
    const denied = await run(routes(() => ({ __status: 403, body: {} })).client, 'tanda_data_audit', {});
    expect(denied.isError).toBeFalsy();
    expect(denied.content.warnings).toEqual([{ check: 'shifts', reason: 'missing scope: timesheet' }]);
    expect((denied.content.summary.by_check as Record<string, unknown>).no_recent_shifts).toBeNull();
    expect((denied.content.summary.by_check as Record<string, unknown>).missing_award_template).toBe(2);
  });
});

describe('WFM-010 micro-shift detector', () => {
  const date = '2026-10-22';
  const start = nySeconds(date, '15:00');
  const routes = (clockins: () => unknown) => fakeTanda([
    ['/departments', () => [{ id: 31, name: 'Cleaning', location_id: 3 }]],
    ['/locations', () => [{ id: 3, name: 'KIPP #3' }]],
    ['/users', () => [{ id: 1, name: 'A' }]],
    ['/shifts', () => [
      { id: 500, user_id: 1, department_id: 31, date, start, finish: start + 23 },
      { id: 501, user_id: 1, department_id: 31, date, start: start + 3600, finish: start + 3600 + 240 },
      { id: 502, user_id: 1, department_id: 31, date, start: start + 7200, finish: start + 7200 + 3600 },
    ]],
    ['/clockins', clockins],
    [/^\/shifts\/\d+\/versions$/, () => [
      { time: start + 30, author: { id: 9, name: 'Lead', email: 'lead@example.com' } },
      { time: start + 600, author: { id: 8, name: 'Manager' } },
    ]],
  ]);

  it('flags short shifts and marks same-device clock-outs within 60s as likely accidental', async () => {
    const res = await run(routes(() => [
      { id: 1, user_id: 1, device_id: 7, type: 'start', time: start },
      { id: 2, user_id: 1, device_id: 7, type: 'finish', time: start + 23 },
      { id: 3, user_id: 1, device_id: 7, type: 'start', time: start + 3600 },
      { id: 4, user_id: 1, device_id: 8, type: 'finish', time: start + 3840 },
    ]).client, 'tanda_exceptions', { from: date, to: date, checks: ['micro_shift'] });
    expect(res.content.summary.by_type).toEqual({ micro_shift: 2 });
    expect(res.content.rows[0]).toMatchObject({
      shift_id: 500, location_name: 'KIPP #3', seconds: 23, device_match: true, clock_gap_seconds: 23,
      likely_accidental_clockout: true, created_by: 'Lead', last_changed_by: 'Manager',
    });
    expect(res.content.rows[1]).toMatchObject({ shift_id: 501, seconds: 240, device_match: false, likely_accidental_clockout: false });
    expect(JSON.stringify(res.content)).not.toContain('lead@example.com');
  });

  it('without device data, warns once and decides on duration alone', async () => {
    const res = await run(routes(() => ({ __status: 403, body: {} })).client, 'tanda_exceptions', { from: date, to: date, checks: ['micro_shift'] });
    expect(res.content.warnings).toEqual([{ check: 'micro_shift.device', reason: 'missing scope: device' }]);
    expect(res.content.rows[0]).toMatchObject({ shift_id: 500, device_match: 'unknown', likely_accidental_clockout: true, created_by: 'Lead' });
  });

  it('survives an account without the clock-ins endpoint', async () => {
    const res = await run(routes(() => ({ __status: 404, body: {} })).client, 'tanda_exceptions', { from: date, to: date, checks: ['micro_shift'] });
    expect(res.isError).toBeFalsy();
    expect(res.content.warnings).toEqual([{ check: 'micro_shift.device', reason: 'not available from Tanda (404)' }]);
  });
});

describe('WFM-011 pay periods across the biweekly -> weekly cutover', () => {
  const { segments } = parsePayCalendar();

  it('knows the current biweekly period and the cutover periods', () => {
    expect(periodContaining('2026-10-23', segments)).toMatchObject({ start: '2026-10-19', finish: '2026-11-01', days: 14 });
    expect(periodContaining('2026-10-10', segments)).toMatchObject({ start: '2026-10-05', finish: '2026-10-18' });
    expect(periodContaining('2026-12-20', segments)).toMatchObject({ start: '2026-12-14', finish: '2026-12-27', cadence: 'biweekly' });
    expect(periodContaining('2026-12-28', segments)).toMatchObject({ start: '2026-12-28', finish: '2027-01-03', cadence: 'weekly' });
  });

  it('on 2027-01-04 reports a 7-day current period with no gap or overlap', () => {
    const cur = periodContaining('2027-01-04', segments);
    expect(cur).toMatchObject({ start: '2027-01-04', finish: '2027-01-10', days: 7 });
    expect(previousPeriod(cur, segments)).toMatchObject({ start: '2026-12-28', finish: '2027-01-03', days: 7 });
    // Walk back 30 periods: each one ends the day before the next starts
    let p = periodContaining('2027-03-01', segments);
    for (let i = 0; i < 30; i++) {
      const prev = previousPeriod(p, segments);
      expect(addDays(prev.finish, 1)).toBe(p.start);
      expect(daysBetween(prev.start, prev.finish) + 1).toBe(prev.days);
      p = prev;
    }
  });

  it('reports a misaligned calendar', () => {
    const { errors } = parsePayCalendar('2026-12-14:14,2026-12-30:7');
    expect(errors[0]).toMatch(/not a biweekly period boundary/);
  });

  it('rolls up timesheet status and $ per period', async () => {
    const s = (id: number, date: string, cost: number) => ({ id, date, start: nySeconds(date, '09:00'), finish: nySeconds(date, '17:00'), cost });
    const { client } = fakeTanda([
      [/^\/timesheets\/on\//, (r) => {
        const date = r.path.split('/').pop() as string;
        if (date >= '2027-01-04') return [
          { id: 1, user_id: 1, status: 'pending', start: '2027-01-04', finish: '2027-01-10', shifts: [s(1, '2027-01-04', 100)] },
          { id: 2, user_id: 2, status: 'approved', start: '2027-01-04', finish: '2027-01-10', shifts: [s(2, '2027-01-04', 40)] },
        ];
        if (date >= '2026-12-28') return [{ id: 3, user_id: 1, status: 'exported', start: '2026-12-28', finish: '2027-01-03', shifts: [s(3, '2026-12-29', 80)] }];
        return [];
      }],
    ]);
    const res = await run(client, 'tanda_pay_periods', { date: '2027-01-04' });
    expect(res.content.summary.current_period).toEqual({ start: '2027-01-04', finish: '2027-01-10', days: 7, cadence: 'weekly' });
    expect(res.content.summary.cadence_changes).toEqual([{ date: '2026-12-28', from: 'biweekly', to: 'weekly' }]);
    const [cur, prior] = res.content.rows;
    expect(cur).toMatchObject({ period: 'current', state: 'open', timesheets: 2, cost: 140, unapproved_cost: 100 });
    expect(cur.by_status).toMatchObject({ pending: { timesheets: 1, hours: 8, cost: 100 }, approved: { timesheets: 1, hours: 8, cost: 40 }, exported: { timesheets: 0, hours: 0, cost: 0 } });
    expect(prior).toMatchObject({ period: 'prior_1', start: '2026-12-28', finish: '2027-01-03', state: 'ended', unapproved_cost: 0 });
    expect(res.content.warnings).toBeUndefined();
  });

  it('warns when Tanda periods do not match the calendar', async () => {
    const { client } = fakeTanda([[/^\/timesheets\/on\//, () => [{ id: 1, status: 'pending', start: '2026-10-12', finish: '2026-10-25', shifts: [] , cost: 5 }]]]);
    const res = await run(client, 'tanda_pay_periods', { date: '2026-10-23', prior_periods: 0 });
    expect(res.content.warnings![0]).toMatchObject({ check: 'tanda_period_alignment' });
  });
});

describe('WFM-012 rate-limit guard', () => {
  it('token bucket never allows more than burst + rate in a minute', async () => {
    nowSpy.mockRestore();
    const bucket = new TokenBucketLimiter(600, 2); // 10/s, burst 2
    const t0 = Date.now();
    for (let i = 0; i < 4; i++) await bucket.acquire();
    // 2 immediately, then ~100ms per token
    expect(Date.now() - t0).toBeGreaterThanOrEqual(150);
    nowSpy = jest.spyOn(Date, 'now').mockReturnValue(NOW * 1000);
  });

  it('retries 429s with backoff, then surfaces rate_limited instead of failing a check', async () => {
    let calls = 0;
    const flaky = fakeTanda([['/shifts/active', () => (++calls < 3 ? { __status: 429, body: {} } : [])]], { retryBaseMs: 1 });
    const ok = await run(flaky.client, 'tanda_exceptions', { checks: ['open_shift_over_12h'] });
    expect(ok.content.warnings).toBeUndefined();
    expect(calls).toBe(3);

    const always = fakeTanda([['/shifts/active', () => ({ __status: 429, body: {} })]], { retryBaseMs: 1 });
    const res = await run(always.client, 'tanda_exceptions', { checks: ['open_shift_over_12h'] });
    expect(res.isError).toBeFalsy();
    expect(res.content.warnings).toEqual([{ check: 'open_shift_over_12h', reason: 'Tanda rate limit reached after retries', rate_limited: true }]);
    expect(always.requests.filter((r) => r.path === '/shifts/active')).toHaveLength(4);
  });

  it('caches people reference data for 24h', async () => {
    expect(PEOPLE_TTL_MS).toBe(24 * 60 * 60 * 1000);
    const { client, requests } = fakeTanda([['/users', () => [{ id: 1, name: 'A' }]]]);
    await loadPeople(client);
    nowSpy.mockReturnValue((NOW + 23 * 3600) * 1000);
    await loadPeople(client);
    expect(requests.filter((r) => r.path === '/users')).toHaveLength(1);
  });
});

describe('workweek helper', () => {
  it('finds the week start for any start day', () => {
    expect(weekStartOn('2026-10-23', 1)).toBe('2026-10-19');
    expect(weekStartOn('2026-10-23', 0)).toBe('2026-10-18');
    expect(weekStartOn('2026-10-23', 5)).toBe('2026-10-23');
    expect(weekStartOn('2026-10-22', 5)).toBe('2026-10-16');
  });
});
