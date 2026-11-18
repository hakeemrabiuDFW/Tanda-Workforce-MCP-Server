/** WFM-009 (#56): tanda_data_audit. "Today" is pinned to 2026-10-23. */
import { executeTool } from '../src/mcp/tools';
import { fakeTanda, nySeconds, RouteHandler } from './helpers/fakeTanda';

type Row = { check: string; count: number | null; sample_ids: unknown[]; samples: Array<Record<string, unknown>> };
type Content = { summary: Record<string, unknown>; rows: Row[]; warnings?: Array<Record<string, unknown>>; error?: string };

const run = async (client: Parameters<typeof executeTool>[0], args: Record<string, unknown> = {}) =>
  (await executeTool(client, 'tanda_data_audit', args)) as { content: Content; isError?: boolean };

const NOW = nySeconds('2026-10-23', '12:00');
let nowSpy: jest.SpyInstance;
beforeEach(() => {
  nowSpy = jest.spyOn(Date, 'now').mockReturnValue(NOW * 1000);
  process.env.COVERAGE_EXCLUDE_USER_IDS = '3';
});
afterEach(() => {
  nowSpy.mockRestore();
  delete process.env.COVERAGE_EXCLUDE_USER_IDS;
  delete process.env.MIN_EFFECTIVE_RATE;
});

const shift = (id: number, userId: number, dept: number, date: string, cost?: number) => ({
  id, user_id: userId, department_id: dept, date,
  start: nySeconds(date, '09:00'), finish: nySeconds(date, '17:00'),
  ...(cost !== undefined ? { cost } : {}),
});

const users = [
  { id: 1, name: 'Sup Real', user_levels: ['employee'], award_template_id: 5, position_title: 'Supervisor' },
  { id: 2, name: 'Office Manager', user_levels: ['manager'], award_template_id: 5, position_title: ' ' },
  { id: 3, name: 'Bookkeeper', user_levels: ['employee'], award_template_id: null, position_title: null },
  { id: 4, name: 'Idle Cleaner', user_levels: ['employee'], award_template_id: 5, position_title: 'Cleaner' },
  { id: 5, name: 'Busy Cleaner', user_levels: ['employee'], award_template_id: 5, position_title: 'Cleaner' },
];
const shifts = [
  shift(100, 1, 11, '2026-10-20', 160), // Site A: 8h, $20/h
  shift(101, 5, 12, '2026-10-21', 0), //   Site B: 8h, $0
  shift(102, 2, 13, '2026-10-22', 96), //  Site C: 8h, $12/h
  shift(103, 3, 30, '2026-10-22', 0), //   bookkeeping site: ignored
];
const leave = [
  { id: 900, user_id: 4, status: 'pending', start: '2026-10-20', finish: '2026-10-21', leave_type: 'Vacation' }, // stale
  { id: 901, user_id: 5, status: 'pending', start: '2026-10-24', finish: '2026-10-24' }, // not started yet
  { id: 902, user_id: 1, status: 'approved', start: '2026-10-10', finish: '2026-10-10' }, // not pending
];

function tanda(overrides: Record<string, RouteHandler> = {}) {
  return fakeTanda([
    ['/locations', overrides['/locations'] || (() => [
      { id: 1, name: 'Site A' }, { id: 2, name: 'Site B' }, { id: 3, name: 'Site C' }, { id: 281737, name: 'Bookkeeping' },
    ])],
    ['/departments', overrides['/departments'] || (() => [
      { id: 11, name: 'Cleaners', location_id: 1, staff: [1, 4] },
      { id: 12, name: 'Cleaners', location_id: 2, staff: [5] },
      { id: 13, name: 'Cleaners', location_id: 3, staff: [2] },
      { id: 20, name: 'Supervisors', location_id: 1, staff: [1, 2, 3] },
      { id: 30, name: 'Books', location_id: 281737, staff: [3] },
    ])],
    ['/users', overrides['/users'] || (() => users)],
    ['/shifts', overrides['/shifts'] || (() => shifts)],
    ['/leave', overrides['/leave'] || (() => leave)],
  ]);
}

const byCheck = (c: Content) => Object.fromEntries(c.rows.map((r) => [r.check, r]));

describe('WFM-009 tanda_data_audit', () => {
  it('returns every check with counts and sample ids, summary first', async () => {
    const { client } = tanda();
    const res = await run(client);
    expect(res.isError).toBeFalsy();
    const c = byCheck(res.content);
    expect(c.missing_award_template.sample_ids).toEqual([3]);
    expect(c.no_recent_shifts.sample_ids).toEqual([4]);
    expect(c.zero_cost_sites.samples).toEqual([{ id: 2, name: 'Site B', hours: 8, cost: 0, effective_rate: null }]);
    expect(c.low_effective_rate.samples).toEqual([{ id: 3, name: 'Site C', hours: 8, cost: 96, effective_rate: 12 }]);
    expect(c.non_supervisors_in_supervisor_depts.samples).toEqual([
      { id: 2, name: 'Office Manager', reason: 'no employee level' },
      { id: 3, name: 'Bookkeeper', reason: 'in COVERAGE_EXCLUDE_USER_IDS' },
    ]);
    expect(c.missing_position_title.sample_ids).toEqual([2, 3]);
    expect(c.stale_pending_leave.samples).toEqual([{ id: 900, user_id: 4, user_name: 'Idle Cleaner', leave_type: 'Vacation', start: '2026-10-20' }]);

    expect(Object.keys(res.content)[0]).toBe('summary');
    expect(res.content.summary).toMatchObject({
      as_of: '2026-10-23', days: 14, shift_window: '2026-10-10..2026-10-23', min_effective_rate: 16, active_users: 5, flagged: 9,
    });
    expect(res.content.warnings).toBeUndefined();
  });

  it('stays under 20 Tanda requests, all reads, even at the longest look-back', async () => {
    const { client, requests } = tanda();
    const res = await run(client, { days: 999 });
    expect(res.content.summary.days).toBe(35);
    expect(requests.length).toBe(12); // 3 lookups + 5 shift weeks + 4 leave weeks: under the 20 the issue allows
    expect(requests.every((r) => r.method === 'GET')).toBe(true);
  });

  it('caps samples at 20 while counting everything', async () => {
    const many = Array.from({ length: 30 }, (_, i) => ({ id: 100 + i, name: `U${i}`, user_levels: ['employee'], award_template_id: null, position_title: 'Cleaner' }));
    const { client } = tanda({ '/users': () => many, '/shifts': () => [] });
    const c = byCheck((await run(client)).content);
    expect(c.missing_award_template.count).toBe(30);
    expect(c.missing_award_template.sample_ids).toHaveLength(20);
  });

  it('honours min_effective_rate from the argument and from MIN_EFFECTIVE_RATE', async () => {
    let c = byCheck((await run(tanda().client, { min_effective_rate: 25 })).content);
    expect(c.low_effective_rate.sample_ids).toEqual([3, 1]);
    process.env.MIN_EFFECTIVE_RATE = '10';
    c = byCheck((await run(tanda().client)).content);
    expect(c.low_effective_rate.count).toBe(0);
  });

  it('rejects a min_effective_rate that is not above 0', async () => {
    const res = await run(tanda().client, { min_effective_rate: -1 });
    expect(res.isError).toBe(true);
    expect(JSON.stringify(res.content)).toMatch(/min_effective_rate must be a number above 0/);
  });

  it('fails soft: a missing leave scope skips only that check', async () => {
    const { client } = tanda({ '/leave': () => ({ __status: 403, body: { error: 'insufficient scope' } }) });
    const res = await run(client);
    expect(res.isError).toBeFalsy();
    const c = byCheck(res.content);
    expect(c.stale_pending_leave.count).toBeNull();
    expect(c.missing_award_template.count).toBe(1);
    expect(c.low_effective_rate.count).toBe(1);
    expect(res.content.warnings).toEqual([{ check: 'stale_pending_leave', reason: 'missing scope: leave' }]);
    expect(res.content.summary.checks_skipped).toEqual(['stale_pending_leave']);
  });

  it('fails soft: shifts without costs skip the two cost checks', async () => {
    const { client } = tanda({ '/shifts': () => shifts.map(({ cost: _c, ...s }) => s) });
    const res = await run(client);
    const c = byCheck(res.content);
    expect(c.zero_cost_sites.count).toBeNull();
    expect(c.low_effective_rate.count).toBeNull();
    expect(c.no_recent_shifts.count).toBe(1);
    expect(res.content.summary.checks_skipped).toEqual(['zero_cost_sites', 'low_effective_rate']);
  });

  it('fails soft: without user access the user checks are skipped and site checks still run', async () => {
    const { client } = tanda({ '/users': () => ({ __status: 403, body: { error: 'insufficient scope' } }) });
    const res = await run(client);
    expect(res.isError).toBeFalsy();
    const c = byCheck(res.content);
    expect(c.missing_award_template.count).toBeNull();
    expect(c.no_recent_shifts.count).toBeNull();
    expect(c.non_supervisors_in_supervisor_depts.count).toBeNull();
    expect(c.zero_cost_sites.count).toBe(1);
    expect(res.content.summary.active_users).toBeNull();
    expect(res.content.warnings?.[0]).toMatchObject({ check: 'user_lookup' });
  });

  it('reports position_title as skipped when user records never carry it', async () => {
    const bare = users.map(({ position_title: _p, ...u }) => u);
    const res = await run(tanda({ '/users': () => bare }).client);
    expect(byCheck(res.content).missing_position_title.count).toBeNull();
    expect(res.content.warnings).toEqual([{ check: 'missing_position_title', reason: 'position_title is not returned on user records for this token' }]);
  });
});
