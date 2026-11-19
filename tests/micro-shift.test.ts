/** WFM-010 (#57): tanda_exceptions flags micro-shifts and likely accidental clock-outs. */
import { executeTool } from '../src/mcp/tools';
import { fakeTanda, nySeconds, RouteHandler } from './helpers/fakeTanda';

type Content = { summary: Record<string, unknown>; rows: Array<Record<string, unknown>>; warnings?: Array<Record<string, unknown>>; error?: string };

const run = async (client: Parameters<typeof executeTool>[0], args: Record<string, unknown>) =>
  (await executeTool(client, 'tanda_exceptions', { checks: ['micro_shift'], from: day, to: day, ...args })) as { content: Content; isError?: boolean };

const day = '2026-10-22';
const t0 = nySeconds(day, '08:00');
const t1 = nySeconds(day, '09:00');
const t2 = nySeconds(day, '10:00');
const shifts = [
  { id: 1, user_id: 1, department_id: 11, date: day, start: t0, finish: t0 + 23 }, // 23s, same device
  { id: 2, user_id: 2, department_id: 11, date: day, start: t1, finish: t1 + 40 }, // 40s, different devices
  { id: 3, user_id: 1, department_id: 11, date: day, start: t2, finish: t2 + 180 }, // 3 min: micro, not accidental
  { id: 4, user_id: 1, department_id: 11, date: day, start: t2 + 3600, finish: t2 + 3600 }, // zero-length: not micro
  { id: 5, user_id: 2, department_id: 11, date: day, start: t2, finish: t2 + 4 * 3600 }, // normal
  { id: 6, user_id: 2, department_id: 11, date: day, start: t2 + 7200, finish: null }, // still open
];
const clockins: Record<string, unknown[]> = {
  1: [
    { id: 10, user_id: 1, type: 'start', time: t0, device_id: 7, photo: 'p.jpg', latitude: 42.6, ip_address: '10.0.0.1' },
    { id: 11, user_id: 1, type: 'finish', time: t0 + 23, device_id: 7 },
  ],
  2: [
    { id: 20, user_id: 2, type: 'start', time: t1, device_id: 8 },
    { id: 21, user_id: 2, type: 'finish', time: t1 + 40, device_id: 9 },
  ],
};
const versions = (id: number) => [
  { time: t0 + 600, author: { id: 99, name: 'Manager M' }, event: 'update' },
  { time: t0 + 30, author: { id: 1, name: 'A' }, event: 'create' },
].map((v) => ({ ...v, item_id: id }));

const routes = (overrides: Record<string, RouteHandler> = {}) => fakeTanda([
  ['/departments', () => [{ id: 11, name: 'Cleaning', location_id: 1 }]],
  ['/locations', () => [{ id: 1, name: 'Site A' }]],
  ['/users', () => [{ id: 1, name: 'A' }, { id: 2, name: 'B' }]],
  ['/shifts', () => shifts],
  ['/clockins', overrides['/clockins'] || ((r) => clockins[r.params.user_id] || [])],
  [/^\/shifts\/\d+\/versions$/, overrides.versions || ((r) => versions(Number(r.path.split('/')[2])))],
]);

describe('WFM-010 micro_shift in tanda_exceptions', () => {
  it('flags shifts under 5 min, and same-device clock-outs within 60s as likely accidental', async () => {
    const { client, requests } = routes();
    const res = await run(client, {});
    expect(res.isError).toBeFalsy();
    const rows = res.content.rows;
    expect(rows.map((r) => r.shift_id)).toEqual([1, 2, 3]);
    expect(rows[0]).toMatchObject({
      type: 'micro_shift', user_id: 1, user_name: 'A', location_name: 'Site A', seconds: 23,
      device_match: true, clock_gap_seconds: 23, likely_accidental_clockout: true, created_by: 'A', last_changed_by: 'Manager M',
    });
    expect(rows[1]).toMatchObject({ seconds: 40, device_match: false, likely_accidental_clockout: false });
    expect(rows[2]).toMatchObject({ seconds: 180, likely_accidental_clockout: false });
    expect(res.content.summary.by_type).toEqual({ micro_shift: 3 });
    expect(res.content.summary.micro_shift_basis).toMatch(/under 5 min/);
    expect(res.content.summary.warnings).toBeUndefined();
    // Raw punch data (photo, location, IP, device id) never reaches the response
    expect(JSON.stringify(res.content)).not.toMatch(/photo|latitude|ip_address|device_id/);
    // Read-only: every Tanda call is a GET
    expect(requests.every((r) => r.method === 'GET')).toBe(true);
  });

  it('min_shift_minutes changes the threshold and is validated', async () => {
    const res = await run(routes().client, { min_shift_minutes: 1 });
    expect(res.content.rows.map((r) => r.shift_id)).toEqual([1, 2]);
    const bad = await run(routes().client, { min_shift_minutes: 0 });
    expect(bad.isError).toBe(true);
    expect(bad.content.error).toMatch(/min_shift_minutes/);
  });

  it('without the device scope, warns once, keeps the rows and falls back to duration', async () => {
    const { client, requests } = routes({ '/clockins': () => ({ __status: 403, body: {} }) });
    const res = await run(client, {});
    expect(res.isError).toBeFalsy();
    expect(res.content.summary.warnings).toEqual([{ check: 'micro_shift.device', reason: 'missing scope: device' }]);
    expect(requests.filter((r) => r.path === '/clockins')).toHaveLength(1);
    expect(res.content.rows.map((r) => [r.shift_id, r.device_match, r.likely_accidental_clockout])).toEqual([
      [1, 'unknown', true], [2, 'unknown', true], [3, 'unknown', false],
    ]);
    expect(res.content.rows[0].created_by).toBe('A');
  });

  it('a missing version history fails soft too', async () => {
    const res = await run(routes({ versions: () => ({ __status: 404, body: {} }) }).client, {});
    expect(res.content.summary.warnings).toEqual([{ check: 'micro_shift.change_history', reason: 'not available from Tanda (404)' }]);
    expect(res.content.rows[0]).toMatchObject({ device_match: true, created_by: null, last_changed_by: null });
  });

  it('other Tanda errors still fail the call', async () => {
    const res = await run(routes({ '/clockins': () => ({ __status: 500, body: {} }) }).client, {});
    expect(res.isError).toBe(true);
  });

  it('is not run when another check is asked for', async () => {
    const { client, requests } = routes();
    const res = await run(client, { checks: ['zero_length_shift'] });
    expect(res.content.rows.map((r) => [r.type, r.shift_id])).toEqual([['zero_length_shift', 4]]);
    expect(requests.some((r) => r.path === '/clockins')).toBe(false);
  });
});
