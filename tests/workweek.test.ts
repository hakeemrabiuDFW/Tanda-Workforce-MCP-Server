/** WFM-005 (#52): weekly hours use explicit calendar workweeks. "Today" is pinned to Friday 2026-10-23. */
import { executeTool } from '../src/mcp/tools';
import { fakeTanda, nySeconds } from './helpers/fakeTanda';
import { weekStartOn } from '../src/utils/time';

type Content = { summary: Record<string, unknown>; rows: Array<Record<string, unknown>> };

const run = async (client: Parameters<typeof executeTool>[0], name: string, args: Record<string, unknown>) =>
  (await executeTool(client, name, args)) as { content: Content; isError?: boolean };

const NOW = nySeconds('2026-10-23', '12:00');
let nowSpy: jest.SpyInstance;
beforeEach(() => {
  nowSpy = jest.spyOn(Date, 'now').mockReturnValue(NOW * 1000);
});
afterEach(() => nowSpy.mockRestore());

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

describe('workweek helper', () => {
  it('finds the week start for any start day', () => {
    expect(weekStartOn('2026-10-23', 1)).toBe('2026-10-19');
    expect(weekStartOn('2026-10-23', 0)).toBe('2026-10-18');
    expect(weekStartOn('2026-10-23', 5)).toBe('2026-10-23');
    expect(weekStartOn('2026-10-22', 5)).toBe('2026-10-16');
  });
});
