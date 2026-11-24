/** WFM-103 (#62): tanda_propose_cover, draft cover for an absence. "Today" is Wed 2026-11-18. */
import { executeTool } from '../src/mcp/tools';
import { fakeTanda, nySeconds, RouteHandler } from './helpers/fakeTanda';

type Content = {
  summary: Record<string, unknown> & { shifts: Array<Record<string, unknown>> };
  rows: Array<Record<string, unknown>>;
  warnings?: Array<Record<string, unknown>>;
  error?: string;
};

const run = async (client: Parameters<typeof executeTool>[0], args: Record<string, unknown>) =>
  (await executeTool(client, 'tanda_propose_cover', args)) as { content: Content; isError?: boolean };

const DAY = '2026-11-18';
let nowSpy: jest.SpyInstance;
beforeEach(() => {
  nowSpy = jest.spyOn(Date, 'now').mockReturnValue(nySeconds(DAY, '12:00') * 1000);
});
afterEach(() => nowSpy.mockRestore());

const sched = (id: number, userId: number, dept: number, date: string, start: string, finish: string) => ({
  id, user_id: userId, department_id: dept, date, start: nySeconds(date, start), finish: nySeconds(date, finish),
});
const emp = (id: number, name: string, extra: Record<string, unknown> = {}) => ({
  id, name, user_levels: ['employee'], employment_start_date: '2024-01-01', active: true, ...extra,
});

const users = [
  emp(1, 'Absent Person'),
  emp(2, 'Same Dept'),
  emp(3, 'Same Dept Busy'),
  emp(4, 'Site B Free'),
  emp(5, 'Site B Clash'),
  emp(6, 'On Leave'),
  emp(7, 'Unavailable Evening'),
  emp(8, 'Day Porter'),
  emp(9, 'Office Only'),
  emp(10, 'Test Cleaner'),
  emp(11, 'No Start', { employment_start_date: null }),
  emp(12, 'Manager Only', { user_levels: ['manager'] }),
  emp(20, 'Senior Supervisor', { employment_start_date: '2020-01-01' }),
  emp(21, 'Newer Supervisor', { employment_start_date: '2023-01-01' }),
];

const schedules = [
  sched(100, 1, 11, DAY, '17:00', '21:00'), // the shift to cover (4h)
  sched(101, 2, 11, '2026-11-16', '09:00', '17:00'), // 8h this week
  sched(102, 3, 11, '2026-11-16', '06:00', '18:00'),
  sched(103, 3, 11, '2026-11-17', '06:00', '18:00'),
  sched(104, 3, 11, '2026-11-19', '06:00', '20:00'), // 38h: 38 + 4 > 40
  sched(105, 5, 21, DAY, '18:00', '22:00'), // clashes with the shift
  sched(106, 8, 12, '2026-11-16', '09:00', '11:00'), // knows Site A, other department
  sched(107, 20, 31, DAY, '20:00', '23:00'), // supervisor shift, overlaps 1's shift
];

function tanda(over: { unavailability?: RouteHandler; leave?: RouteHandler; schedules?: unknown[] } = {}) {
  return fakeTanda([
    ['/locations', () => [{ id: 1, name: 'Site A' }, { id: 2, name: 'Site B' }, { id: 9, name: 'Administrative Office' }]],
    ['/departments', () => [
      { id: 11, name: 'Cleaning', location_id: 1, staff: [1, 2, 3] },
      { id: 12, name: 'Day Porter', location_id: 1, staff: [] },
      { id: 21, name: 'Cleaning', location_id: 2, staff: [4, 5, 6, 7, 8] },
      { id: 31, name: 'Supervisor', location_id: 1, staff: [20, 21] },
      { id: 91, name: 'Office', location_id: 9, staff: [9] },
    ]],
    ['/users', () => users],
    ['/schedules', () => over.schedules ?? schedules],
    ['/leave', over.leave || (() => [
      { id: 1, user_id: 6, status: 'approved', start: DAY, finish: DAY },
      { id: 2, user_id: 8, status: 'rejected', start: DAY, finish: DAY },
    ])],
    ['/unavailability', over.unavailability || (() => [{ id: 1, user_id: 7, start: nySeconds(DAY, '16:00'), finish: nySeconds(DAY, '23:00') }])],
  ]);
}

describe('tanda_propose_cover', () => {
  it("ranks people who can take the absent person's shift: department, then site, then fewest hours, then tenure", async () => {
    const { client, requests } = tanda();
    const res = await run(client, { user_id: 1, date: DAY });
    expect(res.isError).toBeUndefined();
    const s = res.content.summary;
    expect(Object.keys(res.content)[0]).toBe('summary');
    expect(s.absent_user).toEqual({ id: 1, name: 'Absent Person' });
    expect(s.shifts).toEqual([{
      shift: 0, schedule_id: 100, location_id: 1, location_name: 'Site A', department_name: 'Cleaning',
      start_iso: '2026-11-18T17:00:00-05:00', finish_iso: '2026-11-18T21:00:00-05:00', hours: 4, eligible: 4,
      excluded: { on_leave: 1, unavailable: 1, rostered_at_that_time: 2, over_weekly_hours: 1 },
    }]);
    expect(s.left_out).toEqual({ office: 1, test_or_no_start_date: 2, not_employee_level: 1 });
    expect(s.candidates_checked).toBe(9);
    // 2 is in the department; 21 and 8 know the site; 4 is new to it
    expect(res.content.rows.map((r) => r.user_id)).toEqual([2, 21, 8, 4]);
    expect(res.content.rows[0]).toMatchObject({
      shift: 0, rank: 1, user_name: 'Same Dept', knows_site: true, same_department: true,
      week_hours: 8, week_hours_after: 12, why: 'works in this department; 12h of 40h this week with the shift',
    });
    expect(res.content.rows[3]).toMatchObject({ knows_site: false, why: expect.stringMatching(/^new to this site/) });
    // 20 is rostered at that time; 5 clashes; 3 would go over 40h; 6 on leave; 7 unavailable; 8's leave was rejected
    expect(res.content.rows.map((r) => r.user_id)).not.toEqual(expect.arrayContaining([20, 5, 3, 6, 7]));
    expect(s.note).toMatch(/nothing was written/i);
    expect(res.content.warnings).toBeUndefined();
    expect(requests.every((r) => r.method === 'GET')).toBe(true);
    // One workweek of schedules, in a single call
    expect(requests.filter((r) => r.path === '/schedules')).toHaveLength(1);
  });

  it('caps the list with max_candidates and honours max_weekly_hours', async () => {
    const { client } = tanda();
    const two = await run(client, { user_id: 1, date: DAY, max_candidates: 2 });
    expect(two.content.rows.map((r) => r.user_id)).toEqual([2, 21]);
    const tight = await run(client, { user_id: 1, date: DAY, max_weekly_hours: 10 });
    // 2 already has 8h, so 8 + 4 > 10
    expect(tight.content.rows.map((r) => r.user_id)).toEqual([21, 8, 4]);
  });

  it('without the unavailability scope, still proposes cover and says unavailability was not checked', async () => {
    const { client } = tanda({ unavailability: () => ({ __status: 403, body: { error: 'insufficient scope' } }) });
    const res = await run(client, { user_id: 1, date: DAY });
    expect(res.isError).toBeUndefined();
    expect(res.content.warnings).toEqual([{ check: 'unavailability', reason: 'missing scope: unavailability' }]);
    expect(res.content.summary.checks_skipped).toEqual(['unavailability']);
    expect(res.content.rows.map((r) => r.user_id)).toContain(7);
  });

  it('only offers a Supervisor-department shift to supervisors', async () => {
    const { client } = tanda();
    const res = await run(client, { user_id: 20, date: DAY });
    const shift = res.content.summary.shifts[0];
    expect(shift).toMatchObject({ schedule_id: 107, department_name: 'Supervisor', eligible: 1 });
    expect((shift.excluded as Record<string, number>).not_a_supervisor).toBe(8);
    expect(res.content.rows.map((r) => r.user_id)).toEqual([21]);
  });

  it('with no rostered shift, says so; with start/finish and a site, covers that shift', async () => {
    const { client } = tanda();
    const none = await run(client, { user_id: 2, date: DAY });
    expect(none.content.rows).toEqual([]);
    expect(none.content.summary.note).toMatch(/No rostered shift found/);

    const given = await run(client, { date: DAY, location_id: 2, start: '22:00', finish: '02:00' });
    const shift = given.content.summary.shifts[0];
    expect(shift).toMatchObject({ schedule_id: null, location_name: 'Site B', hours: 4, finish_iso: '2026-11-19T02:00:00-05:00' });
    expect(given.content.summary.absent_user).toBeNull();
    // Site B staff by hours (5's 18:00-22:00 shift ends as this one starts); 6 (leave) and 7 (unavailable) are out
    expect(given.content.rows.slice(0, 3).map((r) => r.user_id)).toEqual([4, 8, 5]);
    expect(shift.excluded).toMatchObject({ on_leave: 1, unavailable: 1 });
  });

  it('rejects bad arguments before calling Tanda', async () => {
    const { client, requests } = tanda();
    expect((await run(client, { date: DAY })).content.error).toMatch(/Give user_id/);
    expect((await run(client, { user_id: 1, date: '18/11/2026' })).content.error).toMatch(/YYYY-MM-DD/);
    expect((await run(client, { user_id: 1, max_candidates: 50 })).content.error).toMatch(/max_candidates/);
    expect((await run(client, { start: 'soon', finish: '10:00', location_id: 1 })).content.error).toMatch(/start must be/);
    expect(requests).toHaveLength(0);
  });

  it('still fails on Tanda errors that are not a missing scope', async () => {
    const { client } = tanda({ leave: () => ({ __status: 500, body: {} }) });
    const res = await run(client, { user_id: 1, date: DAY });
    expect(res.isError).toBe(true);
  });
});
