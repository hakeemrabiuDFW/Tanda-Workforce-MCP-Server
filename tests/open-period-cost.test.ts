/** WFM-004 (#51): unapproved cost covers every open pay period. "Today" is pinned to 2026-10-23. */
import { executeTool } from '../src/mcp/tools';
import { fakeTanda, nySeconds } from './helpers/fakeTanda';

type Content = { summary: Record<string, unknown>; rows: Array<Record<string, unknown>> };

const run = async (client: Parameters<typeof executeTool>[0], name: string, args: Record<string, unknown>) =>
  (await executeTool(client, name, args)) as { content: Content; isError?: boolean };

const NOW = nySeconds('2026-10-23', '12:00');
let nowSpy: jest.SpyInstance;
beforeEach(() => {
  nowSpy = jest.spyOn(Date, 'now').mockReturnValue(NOW * 1000);
});
afterEach(() => nowSpy.mockRestore());

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

  it('filters the open-period exposure by location', async () => {
    const res = await run(routes().client, 'tanda_exceptions', { from: '2026-10-17', to: '2026-10-23', checks: ['unapproved_timesheet_cost'], location_ids: [999] });
    expect(res.content.summary.all_open_periods_unapproved_cost).toMatchObject({ cost: 0, timesheets: 0 });
  });

  it('fails clearly when timesheets are not readable', async () => {
    const { client } = fakeTanda([[/^\/timesheets\/on\//, () => ({ __status: 403, body: {} })]]);
    const res = await run(client, 'tanda_exceptions', { checks: ['unapproved_timesheet_cost'] });
    expect(res.isError).toBe(true);
    expect(JSON.stringify(res.content)).toContain('timesheet');
  });
});
