/** WFM-108 (#67): tanda_labor_vs_revenue joins Tanda labor cost by site to revenue passed in by the caller. */
import { executeTool } from '../src/mcp/tools';
import { fakeTanda, nySeconds, RouteHandler } from './helpers/fakeTanda';

type Row = Record<string, unknown> & { flags: string[] };
type Content = {
  summary: Record<string, unknown>;
  rows: Row[];
  warnings?: Array<Record<string, unknown>>;
  error?: string;
};

const run = async (client: Parameters<typeof executeTool>[0], args: Record<string, unknown>) =>
  (await executeTool(client, 'tanda_labor_vs_revenue', args)) as { content: Content; isError?: boolean };

const range = { from: '2026-11-02', to: '2026-11-08' };
const shift = (id: number, dept: number, date: string, cost: number | undefined, finish = '17:00') => ({
  id, user_id: 100 + id, department_id: dept, date,
  start: nySeconds(date, '09:00'), finish: nySeconds(date, finish), ...(cost !== undefined ? { cost } : {}),
});

function tanda(shifts: RouteHandler) {
  return fakeTanda([
    ['/locations', () => [
      { id: 1, name: 'KIPP #3' },
      { id: 2, name: 'Main St Bank' },
      { id: 3, name: 'Quiet Office' },
      { id: 4, name: 'Twin Site' },
      { id: 5, name: 'twin-site' },
      { id: 281737, name: 'One Time Projects' },
    ]],
    ['/departments', () => [
      { id: 11, name: 'Cleaning', location_id: 1 },
      { id: 21, name: 'Cleaning', location_id: 2 },
      { id: 31, name: 'Cleaning', location_id: 3 },
      { id: 91, name: 'Office', location_id: 281737 },
    ]],
    ['/shifts', shifts],
  ]);
}

const shifts = () => [
  shift(1, 11, '2026-11-03', 300),
  shift(2, 11, '2026-11-04', 300),
  shift(3, 21, '2026-11-03', 900),
  shift(4, 91, '2026-11-03', 500), // bookkeeping site: left out by default
  shift(5, 21, '2026-11-20', 999), // outside the range
];

describe('tanda_labor_vs_revenue', () => {
  it('joins labor cost to revenue by site name or id, with labor % and margin', async () => {
    const { client, requests } = tanda(shifts);
    const res = await run(client, {
      ...range,
      revenue: [
        { site: 'kipp 3', amount: 1000 },
        { site: 'KIPP #3', amount: 500 },
        { location_id: 2, amount: 800 },
        { location_id: 3, amount: 200 },
      ],
    });
    expect(res.isError).toBeUndefined();
    const rows = res.content.rows;
    expect(rows.map((r) => r.location_id)).toEqual([2, 1, 3]);
    expect(rows[0]).toMatchObject({ name: 'Main St Bank', revenue: 800, labor_cost: 900, labor_hours: 8, labor_pct: 112.5, margin: -100, flags: ['labor_exceeds_revenue'] });
    expect(rows[1]).toMatchObject({ name: 'KIPP #3', revenue: 1500, labor_cost: 600, labor_hours: 16, worked_shifts: 2, labor_pct: 40, margin: 900, flags: [] });
    expect(rows[2]).toMatchObject({ name: 'Quiet Office', revenue: 200, labor_cost: 0, labor_pct: 0, flags: ['no_labor'] });
    expect(res.content.summary).toMatchObject({
      from: '2026-11-02', to: '2026-11-08', sites: 3, total_revenue: 2500, labor_cost_at_revenue_sites: 1500,
      labor_pct: 60, margin: 1000, labor_cost_without_revenue: 0, unmatched_revenue_total: 0, unmatched_revenue: [],
      flagged: { labor_exceeds_revenue: 1, over_target: 0, no_revenue: 0, no_labor: 1 },
    });
    // One shifts read plus the org lookups; nothing but GETs
    expect(requests.every((r) => r.method === 'GET')).toBe(true);
    expect(requests.filter((r) => r.path === '/shifts')).toHaveLength(1);
    expect(requests.find((r) => r.path === '/shifts')?.params.show_costs).toBe('true');
  });

  it('flags labor with no revenue, over-target sites, and revenue it cannot place', async () => {
    const { client } = tanda(shifts);
    const res = await run(client, {
      ...range,
      target_labor_pct: 35,
      include_bookkeeping: true,
      revenue: [
        { site: 'KIPP #3', amount: 1000 },
        { site: 'Nowhere Plaza', amount: 70 },
        { site: 'Twin Site', amount: 40 },
        { location_id: 999, amount: 30 },
      ],
    });
    const byId = new Map(res.content.rows.map((r) => [r.location_id, r]));
    expect(byId.get(1)).toMatchObject({ labor_pct: 60, flags: ['over_target'] });
    expect(byId.get(2)).toMatchObject({ revenue: null, labor_pct: null, margin: null, labor_cost: 900, flags: ['no_revenue'] });
    expect(byId.get(281737)).toMatchObject({ revenue: null, labor_cost: 500, flags: ['no_revenue'] });
    // No-revenue sites come after the ones with a labor %, biggest cost first
    expect(res.content.rows.map((r) => r.location_id)).toEqual([1, 2, 281737]);
    expect(res.content.summary).toMatchObject({
      target_labor_pct: 35, labor_cost_without_revenue: 1400, unmatched_revenue_total: 140,
      flagged: { labor_exceeds_revenue: 0, over_target: 1, no_revenue: 2, no_labor: 0 },
    });
    expect(res.content.summary.unmatched_revenue).toEqual([
      { site: 'Nowhere Plaza', location_id: null, amount: 70, reason: 'no site with this name; pass location_id' },
      { site: 'Twin Site', location_id: null, amount: 40, reason: 'name matches more than one site; pass location_id' },
      { site: null, location_id: 999, amount: 30, reason: 'unknown location_id' },
    ]);
  });

  it('warns instead of failing when Tanda returns no shift costs', async () => {
    const { client } = tanda(() => [shift(1, 11, '2026-11-03', undefined)]);
    const res = await run(client, { ...range, revenue: [{ location_id: 1, amount: 1000 }] });
    expect(res.isError).toBeUndefined();
    expect(res.content.rows[0]).toMatchObject({ labor_cost: 0, labor_hours: 8 });
    expect(res.content.warnings).toEqual([expect.objectContaining({ check: 'labor_cost' })]);
  });

  it.each([
    [{ revenue: [{ site: 'KIPP #3', amount: 1 }] }, 'from and to are required'],
    [{ ...range }, 'revenue is required'],
    [{ ...range, revenue: [] }, 'revenue is required'],
    [{ ...range, revenue: [{ amount: 5 }] }, 'needs a site name or a location_id'],
    [{ ...range, revenue: [{ site: 'KIPP #3', amount: -1 }] }, 'amount must be a number'],
    [{ ...range, revenue: [{ site: 'KIPP #3' }] }, 'amount must be a number'],
    [{ ...range, revenue: Array.from({ length: 201 }, () => ({ site: 'x', amount: 1 })) }, 'the maximum is 200'],
    [{ ...range, revenue: [{ site: 'KIPP #3', amount: 1 }], target_labor_pct: 0 }, 'target_labor_pct'],
  ])('rejects bad input %#', async (args, message) => {
    const { client, requests } = tanda(shifts);
    const res = await run(client, args);
    expect(res.isError).toBe(true);
    expect(res.content.error).toContain(message);
    expect(requests.filter((r) => r.path === '/shifts')).toHaveLength(0);
  });
});
