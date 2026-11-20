/** WFM-101 (#60): tanda_approval_queue, a read-only clean / needs-review split with pay codes explained. */
import { executeTool, getAvailableTools } from '../src/mcp/tools';
import { explainPayCodes, payCodeKind } from '../src/mcp/tools/approvalQueue';
import { fakeTanda, nySeconds, RecordedRequest } from './helpers/fakeTanda';

type Row = Record<string, unknown> & { queue: string; pay_codes: Array<Record<string, unknown>>; review_reasons?: Array<Record<string, unknown>> };
type Content = { summary: Record<string, unknown>; rows: Row[]; warnings?: Array<Record<string, unknown>>; error?: string };

const run = async (client: Parameters<typeof executeTool>[0], args: Record<string, unknown> = {}) =>
  (await executeTool(client, 'tanda_approval_queue', args)) as { content: Content; isError?: boolean };

const ORD = (date: string) => [{ export_name: 'ORD', units: 8, cost: 120, date }];
const shift = (id: number, userId: number, date: string, start: string, finish: string | null, extra: Record<string, unknown> = {}) => ({
  id, user_id: userId, date, department_id: 1, start: nySeconds(date, start), finish: finish ? nySeconds(date, finish) : null, cost: 120, award_interpretation: ORD(date), ...extra,
});
const sheet = (id: number, userId: number, status: string, shifts: unknown[], cost = 120) => ({ id, user_id: userId, status, start: '2026-11-16', finish: '2026-11-29', total_cost: cost, shifts });

// Five 9h days plus a Saturday: 54h in the week of 2026-11-16, with an overtime line
const longWeek = ['16', '17', '18', '19', '20', '21'].map((d, i) => shift(600 + i, 15, `2026-11-${d}`, '08:00', '17:00', {
  award_interpretation: i < 4
    ? ORD(`2026-11-${d}`)
    : [{ export_name: 'ORD', units: 2, cost: 30, date: `2026-11-${d}` }, { export_name: 'Overtime 1.5', units: 7, cost: 157.5, date: `2026-11-${d}`, from: nySeconds(`2026-11-${d}`, '10:00'), to: nySeconds(`2026-11-${d}`, '17:00') }],
}));

function sheets() {
  return [
    sheet(1, 10, 'pending', [shift(101, 10, '2026-11-17', '09:00', '17:00')]),
    sheet(2, 11, 'pending', [shift(201, 11, '2026-11-18', '09:00', null)]),
    sheet(3, 12, 'pending', [shift(301, 12, '2026-11-18', '09:00', '13:00', { award_interpretation: [] })]),
    sheet(4, 13, 'approved', [shift(401, 13, '2026-11-17', '09:00', '17:00')]),
    sheet(5, 14, 'exported', [shift(501, 14, '2026-11-17', '09:00', '17:00')]),
    sheet(6, 15, 'pending', longWeek, 900),
  ];
}

function tanda(opts: { rosterForbidden?: boolean } = {}) {
  return fakeTanda([
    [/^\/timesheets\/on\//, () => sheets()],
    ['/schedules', () => (opts.rosterForbidden
      ? { __status: 403, body: { error: 'missing scope: roster' } }
      : [{ id: 9, user_id: 11, date: '2026-11-18', start: nySeconds('2026-11-18', '09:00'), finish: nySeconds('2026-11-18', '15:00') }])],
    ['/users', () => [10, 11, 12, 13, 14, 15].map((id) => ({ id, name: `User ${id}`, active: true }))],
    ['/departments', () => [{ id: 1, name: 'Team', location_id: 7 }]],
    ['/locations', () => [{ id: 7, name: 'Site' }]],
  ]);
}

const row = (c: Content, id: number) => c.rows.find((r) => r.timesheet_id === id) as Row;
const nonGets = (requests: RecordedRequest[]) => requests.filter((r) => r.method !== 'GET');

let nowSpy: jest.SpyInstance;
beforeEach(() => { nowSpy = jest.spyOn(Date, 'now').mockReturnValue(nySeconds('2026-11-20', '12:00') * 1000); });
afterEach(() => { nowSpy.mockRestore(); delete process.env.PAY_CALENDAR; });

describe('tanda_approval_queue', () => {
  it('is listed even when writes are off (it only reads)', () => {
    const before = process.env.TANDA_WRITES_ENABLED;
    process.env.TANDA_WRITES_ENABLED = 'false';
    expect(getAvailableTools().map((t) => t.name)).toContain('tanda_approval_queue');
    process.env.TANDA_WRITES_ENABLED = before;
  });

  it('defaults to the current pay period and splits pending timesheets into clean and needs_review', async () => {
    const { client, requests } = tanda();
    const { content, isError } = await run(client);
    expect(isError).toBeUndefined();
    expect(content.summary).toMatchObject({ from: '2026-11-16', to: '2026-11-29', pending: 4 });
    expect(content.summary.basis).toMatch(/current pay period/);
    // Approved and exported timesheets are not in the queue
    expect(content.rows.map((r) => r.timesheet_id).sort()).toEqual([1, 2, 3, 6]);
    expect(row(content, 1).queue).toBe('clean');
    expect(row(content, 1).review_reasons).toBeUndefined();
    // A missing clock-out filled from the single roster match is still an exception to review
    expect(row(content, 2).queue).toBe('needs_review');
    expect(row(content, 2).review_reasons?.[0].reason).toBe('missing clock-out, filled from roster');
    expect(row(content, 3).review_reasons?.[0].reason).toBe('no pay code');
    expect(row(content, 6).review_reasons?.[0].reason).toBe('week of 2026-11-16 over 40h');
    expect(content.summary.clean).toEqual({ timesheets: 1, hours: 8, cost: 120 });
    expect(content.summary.needs_review).toMatchObject({ timesheets: 3, by_reason: { 'missing clock-out, filled from roster': 1, 'no pay code': 1, 'week over 40h': 1 } });
    expect(content.summary.clean_timesheet_ids).toEqual([1]);
    expect(content.summary.next_step).toMatch(/Draft only; nothing was approved/);
    // needs_review rows come first
    expect(content.rows[content.rows.length - 1].timesheet_id).toBe(1);
    expect(nonGets(requests)).toEqual([]);
  });

  it('explains each pay code, including why overtime applied', async () => {
    const { client } = tanda();
    const { content } = await run(client, { queue: 'needs_review' });
    const codes = row(content, 6).pay_codes;
    expect(codes.map((c) => c.pay_code)).toEqual(['ORD', 'Overtime 1.5']);
    expect(codes[0]).toMatchObject({ kind: 'regular', hours: 36, cost: 540 });
    expect(codes[0].why).toBe('Regular hours at the base rate; on 6 days.');
    expect(codes[1]).toMatchObject({ kind: 'overtime', hours: 14, cost: 315 });
    expect(codes[1].why).toBe('Overtime: Tanda paid these hours at a higher rate; between 10:00 and 17:00; on 2 days; workweek of 2026-11-16 went over 40h; paid at 1.5x the regular rate.');
    expect(content.rows.every((r) => r.queue === 'needs_review')).toBe(true);
  });

  it('accepts from/to and previous, and rejects half a range', async () => {
    const { client } = tanda();
    expect((await run(client, { period: 'previous' })).content.summary).toMatchObject({ from: '2026-11-02', to: '2026-11-15' });
    expect((await run(client, { from: '2026-11-16', to: '2026-11-22' })).content.summary).toMatchObject({ from: '2026-11-16', to: '2026-11-22', basis: 'from/to' });
    const half = await run(client, { from: '2026-11-16' });
    expect(half.isError).toBe(true);
    expect(half.content.error).toMatch(/both from and to/);
  });

  it('fails soft when the roster cannot be read: a warning, and the missing clock-out stays in needs_review', async () => {
    const { client } = tanda({ rosterForbidden: true });
    const { content, isError } = await run(client);
    expect(isError).toBeUndefined();
    expect(content.warnings).toEqual([{ check: 'roster', reason: expect.stringMatching(/^missing scope/) }]);
    expect(row(content, 2)).toMatchObject({ queue: 'needs_review', review_reasons: [expect.objectContaining({ reason: 'missing clock-out, no single roster match' })] });
  });
});

describe('pay code explanations', () => {
  it('classifies common export names', () => {
    expect(['ORD', 'Regular', 'OT', 'Overtime 1.5', 'Holiday Pay', 'PTO', 'Sick Leave', 'Night Shift', 'EVE', 'Saturday', 'Cleaning Allowance'].map(payCodeKind))
      .toEqual(['regular', 'regular', 'overtime', 'overtime', 'holiday', 'leave', 'leave', 'night', 'evening', 'weekend', 'other']);
  });

  it('says to check the rule when overtime appears without a week over 40h, and handles codes with no detail', () => {
    const codes = explainPayCodes([{ id: 1, date: '2026-11-17', award_interpretation: [{ export_name: 'OT', units: 1 }, { export_name: 'Mystery', units: 2 }] }], []);
    expect(codes.find((c) => c.pay_code === 'OT')?.why).toMatch(/no workweek here went over 40h, so check the rule/);
    expect(codes.find((c) => c.pay_code === 'Mystery')).toMatchObject({ kind: 'other', why: 'Set by the award template in Workforce; check the rule there if it looks wrong; on 1 day.' });
    expect(explainPayCodes([{ id: 2 }], [])).toEqual([]);
  });
});
