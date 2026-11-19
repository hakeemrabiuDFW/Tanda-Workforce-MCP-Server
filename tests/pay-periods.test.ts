/** WFM-011 (#58): tanda_pay_periods and the biweekly -> weekly pay calendar. */
import { executeTool } from '../src/mcp/tools';
import { DEFAULT_PAY_CALENDAR, parsePayCalendar, periodContaining, previousPeriod } from '../src/mcp/payCalendar';
import { addDays, daysBetween } from '../src/utils/time';
import { fakeTanda, nySeconds } from './helpers/fakeTanda';

type Status = { timesheets: number; hours: number; cost: number };
type Row = Record<string, unknown> & { period: string; start: string; finish: string; by_status: Record<string, Status> };
type Content = { summary: Record<string, unknown>; rows: Row[]; warnings?: Array<Record<string, unknown>>; error?: string };

const run = async (client: Parameters<typeof executeTool>[0], args: Record<string, unknown> = {}) =>
  (await executeTool(client, 'tanda_pay_periods', args)) as { content: Content; isError?: boolean };

const NOW = nySeconds('2027-01-04', '12:00');
let nowSpy: jest.SpyInstance;
beforeEach(() => {
  nowSpy = jest.spyOn(Date, 'now').mockReturnValue(NOW * 1000);
});
afterEach(() => {
  nowSpy.mockRestore();
  delete process.env.PAY_CALENDAR;
});

const shift = (id: number, date: string, cost: number) => ({ id, date, start: nySeconds(date, '09:00'), finish: nySeconds(date, '17:00'), cost });

describe('pay calendar', () => {
  const { segments, errors } = parsePayCalendar(DEFAULT_PAY_CALENDAR);

  it('parses the default calendar without errors', () => {
    expect(errors).toEqual([]);
    expect(segments).toEqual([{ start: '2026-12-14', days: 14 }, { start: '2026-12-28', days: 7 }]);
  });

  it('knows the biweekly periods before the cutover and the cutover periods themselves', () => {
    expect(periodContaining('2026-11-19', segments)).toMatchObject({ start: '2026-11-16', finish: '2026-11-29', days: 14, cadence: 'biweekly' });
    expect(periodContaining('2026-12-27', segments)).toMatchObject({ start: '2026-12-14', finish: '2026-12-27', days: 14, cadence: 'biweekly' });
    expect(periodContaining('2026-12-28', segments)).toMatchObject({ start: '2026-12-28', finish: '2027-01-03', days: 7, cadence: 'weekly' });
  });

  it('on 2027-01-04 the current period is 7 days, with no gap or overlap walking back across the cutover', () => {
    const cur = periodContaining('2027-01-04', segments);
    expect(cur).toMatchObject({ start: '2027-01-04', finish: '2027-01-10', days: 7 });
    expect(previousPeriod(cur, segments)).toMatchObject({ start: '2026-12-28', finish: '2027-01-03', days: 7 });
    let p = periodContaining('2027-03-01', segments);
    for (let i = 0; i < 30; i++) {
      const prev = previousPeriod(p, segments);
      expect(addDays(prev.finish, 1)).toBe(p.start);
      expect(daysBetween(prev.start, prev.finish) + 1).toBe(prev.days);
      p = prev;
    }
  });

  it('reports a cutover that does not fall on a period boundary', () => {
    expect(parsePayCalendar('2026-12-14:14,2026-12-30:7').errors[0]).toMatch(/not a biweekly period boundary/);
  });

  it('falls back to the default calendar when nothing parses', () => {
    const res = parsePayCalendar('nonsense');
    expect(res.errors).toEqual(['"nonsense" is not "YYYY-MM-DD:days"', 'no valid segments; using the default calendar']);
    expect(res.segments).toEqual(segments);
  });
});

describe('tanda_pay_periods', () => {
  const routes = () => fakeTanda([
    [/^\/timesheets\/on\//, (r) => {
      const date = r.path.split('/').pop() as string;
      if (date >= '2027-01-04') return [
        { id: 1, user_id: 1, status: 'pending', start: '2027-01-04', finish: '2027-01-10', shifts: [shift(1, '2027-01-04', 100)] },
        { id: 2, user_id: 2, status: 'approved', start: '2027-01-04', finish: '2027-01-10', shifts: [shift(2, '2027-01-04', 40)] },
      ];
      if (date >= '2026-12-28') return [{ id: 3, user_id: 1, status: 'exported', start: '2026-12-28', finish: '2027-01-03', shifts: [shift(3, '2026-12-29', 80)] }];
      return [];
    }],
  ]);

  it('on 2027-01-04 reports the 7-day current period, the prior one, and $ by status', async () => {
    const { client, requests } = routes();
    const res = await run(client);
    expect(res.isError).toBeUndefined();
    const sum = res.content.summary;
    expect(sum.as_of).toBe('2027-01-04');
    expect(sum.current_period).toEqual({ start: '2027-01-04', finish: '2027-01-10', days: 7, cadence: 'weekly' });
    expect(sum.next_period).toEqual({ start: '2027-01-11', finish: '2027-01-17', days: 7, cadence: 'weekly' });
    expect(sum.cadence_changes).toEqual([{ date: '2026-12-28', from: 'biweekly', to: 'weekly' }]);
    const [cur, prior] = res.content.rows;
    expect(cur).toMatchObject({ period: 'current', state: 'open', timesheets: 2, cost: 140, unapproved_cost: 100 });
    expect(cur.by_status).toMatchObject({
      pending: { timesheets: 1, hours: 8, cost: 100 },
      approved: { timesheets: 1, hours: 8, cost: 40 },
      exported: { timesheets: 0, hours: 0, cost: 0 },
    });
    expect(prior).toMatchObject({ period: 'prior_1', start: '2026-12-28', finish: '2027-01-03', state: 'ended', unapproved_cost: 0 });
    expect(prior.by_status.exported).toEqual({ timesheets: 1, hours: 8, cost: 80 });
    expect(res.content.warnings).toBeUndefined();
    // Read-only: GETs only
    expect(requests.every((r) => r.method === 'GET')).toBe(true);
  });

  it('caps prior_periods at 4', async () => {
    const res = await run(routes().client, { prior_periods: 10 });
    expect(res.content.rows.map((r) => r.period)).toEqual(['current', 'prior_1', 'prior_2', 'prior_3', 'prior_4']);
    // Each period ends the day before the next one starts
    const rows = res.content.rows;
    for (let i = 1; i < rows.length; i++) expect(addDays(rows[i].finish, 1)).toBe(rows[i - 1].start);
  });

  it('warns when Tanda periods do not match the calendar', async () => {
    const { client } = fakeTanda([[/^\/timesheets\/on\//, () => [{ id: 1, status: 'pending', start: '2026-10-12', finish: '2026-10-25', shifts: [], cost: 5 }]]]);
    const res = await run(client, { date: '2026-10-23', prior_periods: 0 });
    expect(res.content.warnings![0]).toMatchObject({ check: 'tanda_period_alignment' });
  });

  it('fails soft when the timesheet scope is missing', async () => {
    const { client } = fakeTanda([[/^\/timesheets\/on\//, () => ({ __status: 403, body: {} })]]);
    const res = await run(client, { prior_periods: 0 });
    expect(res.isError).toBeUndefined();
    expect(res.content.rows[0]).toMatchObject({ period: 'current', timesheets: 0, note: 'Timesheets could not be read; see warnings.' });
    expect(res.content.warnings![0]).toMatchObject({ check: 'timesheets:current' });
    expect(String(res.content.warnings![0].reason)).toMatch(/missing scope/);
  });

  it('reports a malformed PAY_CALENDAR as a warning and still answers', async () => {
    process.env.PAY_CALENDAR = 'bad';
    const res = await run(routes().client, { prior_periods: 0 });
    expect(res.content.summary.current_period).toMatchObject({ start: '2027-01-04', days: 7 });
    expect(res.content.warnings!.map((w) => w.check)).toContain('pay_calendar');
  });

  it('rejects a malformed date', async () => {
    const res = await run(routes().client, { date: '01/04/2027' });
    expect(res.isError).toBe(true);
    expect(res.content.error).toMatch(/YYYY-MM-DD/);
  });
});
