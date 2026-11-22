/** WFM-104 (#63): tanda_leave_impact, coverage impact and a suggested fill per pending leave request. "Today" is Wed 2026-11-18. */
import { executeTool } from '../src/mcp/tools';
import { fakeTanda, nySeconds, RouteHandler } from './helpers/fakeTanda';

type Shift = Record<string, unknown> & { suggested_fill: Array<Record<string, unknown>> };
type Content = {
  summary: Record<string, unknown>;
  rows: Array<Record<string, unknown> & { shifts: Shift[] }>;
  warnings?: Array<Record<string, unknown>>;
  error?: string;
};

const run = async (client: Parameters<typeof executeTool>[0], args: Record<string, unknown>) =>
  (await executeTool(client, 'tanda_leave_impact', args)) as { content: Content; isError?: boolean };

const DAY = '2026-11-18';
const NEXT = '2026-11-19';
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
  emp(1, 'Leave Site A'),
  emp(2, 'Leave Site B'),
  emp(3, 'Leave No Shifts'),
  emp(4, 'Same Dept A'),
  emp(5, 'Site B Colleague'),
  emp(6, 'Approved Leave'),
  emp(7, 'Unavailable'),
  emp(8, 'Test Cleaner'),
];

const schedules = [
  sched(100, 1, 11, DAY, '17:00', '21:00'), // alone at Site A: site left empty
  sched(101, 2, 21, NEXT, '09:00', '13:00'), // Site B, 5 also rostered
  sched(102, 5, 21, NEXT, '08:00', '12:00'),
  sched(103, 4, 11, '2026-11-16', '09:00', '17:00'), // 8h this week
  sched(104, 1, 11, '2026-12-10', '09:00', '13:00'), // outside the range
];

const leaveRows = [
  { id: 1, user_id: 1, status: 'pending', leave_type: 'Annual', start: DAY, finish: DAY },
  { id: 2, user_id: 2, status: 'pending', leave_type: 'Sick', start: NEXT, finish: NEXT },
  { id: 3, user_id: 3, status: 'pending', leave_type: 'Annual', start: NEXT, finish: NEXT },
  { id: 4, user_id: 6, status: 'approved', start: DAY, finish: NEXT },
  { id: 5, user_id: 7, status: 'rejected', start: DAY, finish: DAY },
];

function tanda(over: { unavailability?: RouteHandler; leave?: RouteHandler } = {}) {
  return fakeTanda([
    ['/locations', () => [{ id: 1, name: 'Site A' }, { id: 2, name: 'Site B' }]],
    ['/departments', () => [
      { id: 11, name: 'Cleaning', location_id: 1, staff: [1, 4] },
      { id: 21, name: 'Cleaning', location_id: 2, staff: [2, 5, 6, 7, 8] },
    ]],
    ['/users', () => users],
    ['/schedules', () => schedules],
    ['/leave', over.leave || (() => leaveRows)],
    ['/unavailability', over.unavailability || (() => [{ id: 1, user_id: 7, start: nySeconds(DAY, '16:00'), finish: nySeconds(NEXT, '23:00') }])],
  ]);
}

describe('tanda_leave_impact', () => {
  it('lists each pending request with the shifts it leaves open, worst first, and a ranked fill', async () => {
    const { client, requests } = tanda();
    const res = await run(client, { from: DAY, to: '2026-11-24' });
    expect(res.isError).toBeUndefined();
    expect(Object.keys(res.content)[0]).toBe('summary');
    const s = res.content.summary;
    expect(s).toMatchObject({
      from: DAY, to: '2026-11-24', pending_requests: 3,
      by_impact: { site_left_empty: 1, shifts_to_cover: 1, no_rostered_shifts: 1 },
      shifts_affected: 2, hours_affected: 8, shifts_with_no_fill: 0,
    });
    expect(s.left_out).toEqual({ office: 0, test_or_no_start_date: 1, not_employee_level: 0 });
    expect(s.note).toMatch(/nothing was written/i);

    expect(res.content.rows.map((r) => [r.leave_id, r.impact])).toEqual([
      [1, 'site_left_empty'], [2, 'shifts_to_cover'], [3, 'no_rostered_shifts'],
    ]);
    const [a, b, none] = res.content.rows;
    expect(a).toMatchObject({ user_id: 1, user_name: 'Leave Site A', leave_type: 'Annual', shifts_affected: 1, hours_affected: 4 });
    // The December shift is outside the range
    expect(a.shifts.map((x) => x.schedule_id)).toEqual([100]);
    expect(a.shifts[0]).toMatchObject({
      date: DAY, location_name: 'Site A', start_iso: '2026-11-18T17:00:00-05:00', others_on_site: 0,
      excluded: { on_leave: 1, unavailable: 1, rostered_at_that_time: 0, over_weekly_hours: 0 },
    });
    // 4 works in the department; 5 knows neither; 6 is on approved leave; 7 is unavailable (rejected leave doesn't count)
    expect(a.shifts[0].suggested_fill.map((c) => c.user_id)).toEqual([4, 5]);
    expect(a.shifts[0].suggested_fill[0]).toMatchObject({ rank: 1, same_department: true, week_hours: 8, week_hours_after: 12 });

    expect(b.shifts[0]).toMatchObject({ schedule_id: 101, others_on_site: 1 });
    // 5 is rostered at that time; 1 and 3 are on pending leave themselves and aren't proposed
    expect(b.shifts[0].suggested_fill.map((c) => c.user_id)).toEqual([4]);
    expect(none).toMatchObject({ shifts_affected: 0, hours_affected: 0, shifts: [] });

    expect(res.content.warnings).toBeUndefined();
    expect(requests.every((r) => r.method === 'GET')).toBe(true);
  });

  it('filters by user_ids and location_id, and caps fills with max_candidates', async () => {
    const { client } = tanda();
    const one = await run(client, { from: DAY, to: NEXT, user_ids: [2] });
    expect(one.content.rows.map((r) => r.leave_id)).toEqual([2]);
    const siteA = await run(client, { from: DAY, to: NEXT, location_id: 1 });
    expect(siteA.content.summary.shifts_affected).toBe(1);
    const capped = await run(client, { from: DAY, to: NEXT, max_candidates: 1 });
    expect(capped.content.rows[0].shifts[0].suggested_fill).toHaveLength(1);
  });

  it('says when nothing is pending, without reading schedules', async () => {
    const { client, requests } = tanda({ leave: () => [{ id: 9, user_id: 1, status: 'approved', start: DAY, finish: DAY }] });
    const res = await run(client, {});
    expect(res.content.rows).toEqual([]);
    expect(res.content.summary).toMatchObject({ from: DAY, to: '2026-12-01', pending_requests: 0 });
    expect(requests.some((r) => r.path === '/schedules')).toBe(false);
  });

  it('without the unavailability scope, still answers and says unavailability was not checked', async () => {
    const { client } = tanda({ unavailability: () => ({ __status: 403, body: { error: 'insufficient scope' } }) });
    const res = await run(client, { from: DAY, to: NEXT });
    expect(res.isError).toBeUndefined();
    expect(res.content.warnings).toEqual([{ check: 'unavailability', reason: 'missing scope: unavailability' }]);
    expect(res.content.summary.checks_skipped).toEqual(['unavailability']);
    expect(res.content.rows[0].shifts[0].suggested_fill.map((c) => c.user_id)).toContain(7);
  });

  it('rejects bad arguments before calling Tanda', async () => {
    const { client, requests } = tanda();
    for (const args of [{ from: DAY, to: '2026-12-31' }, { max_candidates: 9 }, { max_weekly_hours: 0 }, { from: 'soon' }]) {
      const res = await run(client, args);
      expect(res.isError).toBe(true);
    }
    expect(requests).toHaveLength(0);
  });

  it('still fails on Tanda errors that are not a missing scope', async () => {
    const { client } = tanda({ leave: () => ({ __status: 500, body: {} }) });
    const res = await run(client, {});
    expect(res.isError).toBe(true);
  });
});
