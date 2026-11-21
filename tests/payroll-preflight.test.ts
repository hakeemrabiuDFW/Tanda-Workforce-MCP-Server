/** WFM-102 (#61): tanda_payroll_preflight, one read-only go / no-go before payroll. "Today" is 2027-01-12. */
import { executeTool } from '../src/mcp/tools';
import { fakeTanda, nySeconds, RouteHandler } from './helpers/fakeTanda';

type Item = { part: string; check: string; level: string; count?: number; detail: string };
type Content = { summary: Record<string, unknown>; rows: Item[]; warnings?: Array<Record<string, unknown>>; error?: string };

const run = async (client: Parameters<typeof executeTool>[0], args: Record<string, unknown> = {}) =>
  (await executeTool(client, 'tanda_payroll_preflight', args)) as { content: Content; isError?: boolean };

const NOW = nySeconds('2027-01-12', '12:00');
let nowSpy: jest.SpyInstance;
beforeEach(() => {
  nowSpy = jest.spyOn(Date, 'now').mockReturnValue(NOW * 1000);
  process.env.TANDA_EXPORT_FORMAT = 'test_csv';
});
afterEach(() => {
  nowSpy.mockRestore();
  delete process.env.TANDA_EXPORT_FORMAT;
});

const shift = (id: number, userId: number, date: string, cost: number) => ({
  id, user_id: userId, department_id: 11, date, start: nySeconds(date, '09:00'), finish: nySeconds(date, '17:00'), cost,
});
const users = [
  { id: 1, name: 'Cleaner One', user_levels: ['employee'], award_template_id: 5, position_title: 'Cleaner' },
  { id: 2, name: 'Cleaner Two', user_levels: ['employee'], award_template_id: 5, position_title: 'Cleaner' },
];
const CLEAN_EXPORT = 'Employee ID,Pay Code,Hours,Amount\n1,REG,8,160\n2,REG,8,160\n';

/** Previous period 2027-01-04..10 (all approved, $320); the one before 2026-12-28..2027-01-03 ($320). */
function tanda(over: { exportCsv?: RouteHandler; timesheets?: (date: string) => unknown; users?: RouteHandler } = {}) {
  const sheets = over.timesheets || ((date: string) => {
    const period = date >= '2027-01-11' ? ['2027-01-11', '2027-01-17'] : date >= '2027-01-04' ? ['2027-01-04', '2027-01-10'] : ['2026-12-28', '2027-01-03'];
    const status = date >= '2027-01-11' ? 'pending' : 'approved';
    return [1, 2].map((u) => ({ id: u, user_id: u, status, start: period[0], finish: period[1], total_cost: 160, shifts: [shift(u, u, period[0], 160)] }));
  });
  return fakeTanda([
    [/^\/timesheets\/on\//, (r) => (r.params.export_format ? (over.exportCsv ? over.exportCsv(r) : CLEAN_EXPORT) : sheets(r.path.split('/').pop() as string))],
    ['/locations', () => [{ id: 1, name: 'Site A' }]],
    ['/departments', () => [{ id: 11, name: 'Cleaners', location_id: 1, staff: [1, 2] }]],
    ['/users', over.users || (() => users)],
    ['/shifts', () => [shift(100, 1, '2027-01-05', 160), shift(101, 2, '2027-01-06', 160)]],
    ['/leave', () => []],
  ]);
}

const checks = (c: Content) => c.rows.map((r) => `${r.level}:${r.check}`);

describe('tanda_payroll_preflight', () => {
  it('says go for an ended, fully approved period with a clean export and no audit flags', async () => {
    const { client, requests } = tanda();
    const res = await run(client, { period: 'previous' });
    expect(res.isError).toBeUndefined();
    const s = res.content.summary;
    expect(Object.keys(res.content)[0]).toBe('summary');
    expect(s.verdict).toBe('go');
    expect(s.period).toEqual({ start: '2027-01-04', finish: '2027-01-10', days: 7, cadence: 'weekly' });
    expect(s.export).toMatchObject({ export_format: 'test_csv', row_count: 2, rows_missing_pay_code: 0, totals: { Hours: 16, Amount: 320 } });
    expect(s.totals).toMatchObject({
      period: { start: '2027-01-04', timesheets: 2, hours: 16, cost: 320, cost_per_day: 45.71, pending: 0 },
      prior_period: { start: '2026-12-28', cost: 320 },
      change_pct: { cost_per_day: 0, hours: 0, timesheets: 0 },
    });
    expect(res.content.rows).toEqual([]);
    // Read-only, and the export is asked not to mark anything exported
    expect(requests.every((r) => r.method === 'GET')).toBe(true);
    expect(requests.find((r) => r.params.export_format)!.params).toMatchObject({ approved_only: 'true', skip_status_update: 'true' });
  });

  it('says no_go with the blockers when timesheets are pending and export rows lack a pay code', async () => {
    const { client } = tanda({ exportCsv: () => 'Employee ID,Pay Code,Hours\n1,REG,8\n2,,8\n' });
    const res = await run(client); // current period 2027-01-11..17: pending and still open
    const s = res.content.summary;
    expect(s.verdict).toBe('no_go');
    expect(s.blockers).toBe(2);
    expect(checks(res.content)).toEqual(['review:period_open', 'blocker:rows_missing_pay_code', 'blocker:pending_timesheets']);
    expect(res.content.rows.find((r) => r.check === 'pending_timesheets')).toMatchObject({ count: 2 });
  });

  it('treats pay-affecting audit flags as blockers and housekeeping flags as review', async () => {
    const { client } = tanda({ users: () => [{ ...users[0], award_template_id: null }, { ...users[1], position_title: '' }] });
    const res = await run(client, { period: 'previous' });
    expect(res.content.summary.verdict).toBe('no_go');
    expect(checks(res.content)).toEqual(['blocker:missing_award_template', 'review:missing_position_title']);
    expect(res.content.summary.audit).toMatchObject({ missing_award_template: 1, missing_position_title: 1 });
  });

  it('flags a $-per-day swing against the prior period above max_change_pct', async () => {
    const { client } = tanda({
      timesheets: (date) => date >= '2027-01-04'
        ? [{ id: 1, status: 'approved', start: '2027-01-04', finish: '2027-01-10', total_cost: 700, shifts: [shift(1, 1, '2027-01-05', 700)] }]
        : [{ id: 2, status: 'approved', start: '2026-12-28', finish: '2027-01-03', total_cost: 350, shifts: [shift(2, 1, '2026-12-29', 350)] }],
    });
    const res = await run(client, { period: 'previous' });
    expect(res.content.summary.verdict).toBe('review');
    expect(res.content.rows).toEqual([expect.objectContaining({ check: 'cost_change', level: 'review' })]);
    expect(res.content.rows[0].detail).toMatch(/up 100%/);
    expect((await run(tanda().client, { period: 'previous', max_change_pct: 200 })).content.summary.verdict).toBe('go');
  });

  it('fails soft: without TANDA_EXPORT_FORMAT the export part is skipped and the verdict is incomplete', async () => {
    delete process.env.TANDA_EXPORT_FORMAT;
    const res = await run(tanda().client, { period: 'previous' });
    expect(res.isError).toBeUndefined();
    expect(res.content.summary).toMatchObject({ verdict: 'incomplete', parts_skipped: ['export'], export: null });
    expect(res.content.summary.totals).not.toBeNull();
    expect(res.content.warnings![0]).toMatchObject({ check: 'export_preview' });
    expect(String(res.content.warnings![0].reason)).toMatch(/TANDA_EXPORT_FORMAT is not configured/);
  });

  it('fails soft: a Tanda error on the export is reported by status only, and a blocker still wins over incomplete', async () => {
    const { client } = tanda({ exportCsv: () => ({ __status: 422, body: { error: 'secret upstream detail' } }) });
    const res = await run(client); // current period: pending timesheets
    expect(res.content.summary).toMatchObject({ verdict: 'no_go', parts_skipped: ['export'] });
    expect(res.content.warnings).toContainEqual({ check: 'export_preview', reason: 'Tanda returned HTTP 422' });
    expect(JSON.stringify(res.content)).not.toContain('secret upstream detail');
  });

  it('rejects bad arguments', async () => {
    for (const [args, msg] of [
      [{ period: 'next' }, /period must be one of/],
      [{ date: '01/04/2027' }, /YYYY-MM-DD/],
      [{ max_change_pct: 0 }, /max_change_pct must be a number above 0/],
    ] as const) {
      const res = await run(tanda().client, args);
      expect(res.isError).toBe(true);
      expect(res.content.error).toMatch(msg);
    }
  });

  it('uses the pay period containing date when given', async () => {
    const res = await run(tanda().client, { date: '2026-12-20' });
    expect(res.content.summary.period).toMatchObject({ start: '2026-12-14', finish: '2026-12-27', cadence: 'biweekly' });
  });
});
