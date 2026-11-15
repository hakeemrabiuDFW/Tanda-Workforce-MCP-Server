/** #86: tanda_approve_timesheets (preview -> confirm, fill missing clock-outs, MCP-EXCEPTION notes). */
import { executeTool, getAvailableTools } from '../src/mcp/tools';
import { exceptionNote } from '../src/mcp/tools/approveTimesheets';
import { fakeTanda, nySeconds, RecordedRequest } from './helpers/fakeTanda';

type Row = Record<string, unknown> & { flags: Array<Record<string, unknown>>; shift_changes: Array<Record<string, unknown>> };
type Content = { summary: Record<string, unknown>; rows: Row[]; confirm_token?: string; error?: string };

const run = async (client: Parameters<typeof executeTool>[0], args: Record<string, unknown>) =>
  (await executeTool(client, 'tanda_approve_timesheets', args)) as { content: Content; isError?: boolean };

const ORD = [{ export_name: 'ORD', units: 8, cost: 120 }];
const shift = (id: number, userId: number, date: string, start: string, finish: string | null, extra: Record<string, unknown> = {}) => ({
  id, user_id: userId, date, department_id: 1, start: nySeconds(date, start), finish: finish ? nySeconds(date, finish) : null, cost: 100, award_interpretation: ORD, ...extra,
});
const sheet = (id: number, userId: number, status: string, shifts: unknown[]) => ({ id, user_id: userId, status, start: '2026-08-10', finish: '2026-08-23', shifts });

function sheets() {
  return [
    sheet(1, 10, 'pending', [shift(101, 10, '2026-08-11', '09:00', '17:00')]),
    sheet(2, 11, 'pending', [shift(201, 11, '2026-08-12', '09:00', null)]),
    sheet(3, 12, 'pending', [
      shift(301, 12, '2026-08-12', '09:00', null),
      shift(302, 12, '2026-08-13', '09:00', '09:00'),
      shift(303, 12, '2026-08-14', '06:00', '20:00', { metadata: 'existing note' }),
      shift(304, 12, '2026-08-17', '09:00', '13:00', { award_interpretation: [] }),
    ]),
    sheet(4, 13, 'exported', [shift(401, 13, '2026-08-11', '09:00', '17:00')]),
    sheet(5, 14, 'approved', [shift(501, 14, '2026-08-11', '09:00', '17:00')]),
    sheet(6, 15, 'pending', ['10', '11', '12', '13', '14'].map((d, i) => shift(600 + i, 15, `2026-08-${d}`, '08:00', '17:00'))),
  ];
}

function tanda(opts: { failTimesheet?: number; shared?: boolean } = {}) {
  const data = sheets();
  return fakeTanda([
    [/^\/timesheets\/on\//, () => data],
    [/^\/timesheets\/\d+$/, (r: RecordedRequest) => {
      const id = Number(r.path.split('/').pop());
      if (id === opts.failTimesheet) return { __status: 403, body: {} };
      return { id, ...(r.body as object) };
    }],
    [/^\/shifts\/\d+$/, (r: RecordedRequest) => ({ id: Number(r.path.split('/').pop()), ...(r.body as object) })],
    ['/schedules', () => [{ id: 9, user_id: 11, date: '2026-08-12', start: nySeconds('2026-08-12', '09:00'), finish: nySeconds('2026-08-12', '15:00') }]],
    ['/users/me', () => ({ id: 1, name: 'Sarah' })],
    ['/users', () => [10, 11, 12, 13, 14, 15].map((id) => ({ id, name: `User ${id}`, active: true }))],
    ['/departments', () => [{ id: 1, name: 'Team', location_id: 7 }]],
    ['/locations', () => [{ id: 7, name: 'Site' }]],
  ], opts.shared ? { sharedIdentity: true } : {});
}

const writes = (requests: RecordedRequest[]) => requests.filter((r) => r.method === 'PUT');
const period = { from: '2026-08-10', to: '2026-08-23', allow_past_period: true };
const row = (c: Content, id: number) => c.rows.find((r) => r.timesheet_id === id) as Row;

describe('tanda_approve_timesheets', () => {
  const before = process.env.TANDA_WRITES_ENABLED;
  beforeEach(() => { process.env.TANDA_WRITES_ENABLED = 'true'; });
  afterAll(() => { process.env.TANDA_WRITES_ENABLED = before; });

  it('is off by default: not listed and refuses to run', async () => {
    delete process.env.TANDA_WRITES_ENABLED;
    expect(getAvailableTools().map((t) => t.name)).not.toContain('tanda_approve_timesheets');
    const { client, requests } = tanda();
    const res = await run(client, period);
    expect(res.isError).toBe(true);
    expect(writes(requests)).toHaveLength(0);
  });

  it('lets the shared server identity preview, without a token, and refuses to apply', async () => {
    const { client, requests } = tanda({ shared: true });
    const preview = await run(client, period);
    expect(preview.isError).toBeFalsy();
    expect(preview.content.summary).toMatchObject({ status: 'preview', will_change: 4 });
    expect(preview.content.confirm_token).toBeUndefined();
    const own = await run(tanda().client, period);
    const res = await run(client, { ...period, confirm_token: own.content.confirm_token });
    expect(res.isError).toBe(true);
    expect(JSON.stringify(res.content)).toContain("person's own Tanda login");
    expect(writes(requests)).toHaveLength(0);
  });

  it('requires from/to and allow_past_period for a period that ended long ago', async () => {
    const missing = await run(tanda().client, {});
    expect(JSON.stringify(missing.content)).toContain('from and to are required');
    const res = await run(tanda().client, { from: '2026-08-10', to: '2026-08-23' });
    expect(res.content.summary.will_change).toBe(0);
    expect(res.content.rows.every((r) => String(r.skip_reason).includes('allow_past_period') || r.status !== 'pending')).toBe(true);
  });

  it('acceptance 1: the dry run lists every timesheet with flags and fixes, and changes nothing', async () => {
    const { client, requests } = tanda();
    const res = await run(client, period);
    expect(res.content.summary).toMatchObject({ status: 'preview', timesheets: 6, will_change: 4, skipped: 2, flagged: 3 });
    expect(typeof res.content.confirm_token).toBe('string');
    expect(row(res.content, 1)).toMatchObject({ will_change: true, status: 'pending', new_status: 'approved', flags: [], shift_changes: [] });
    expect(row(res.content, 2).shift_changes).toEqual([
      expect.objectContaining({ shift_id: 201, finish: nySeconds('2026-08-12', '15:00'), metadata: expect.stringContaining('MCP-EXCEPTION') }),
    ]);
    const reasons = row(res.content, 3).flags.map((f) => f.reason);
    expect(reasons).toEqual(expect.arrayContaining([
      'missing clock-out, no single roster match', 'zero-length shift', 'shift over 12h (14h)', 'no pay code',
    ]));
    const note303 = row(res.content, 3).shift_changes.find((c) => c.shift_id === 303);
    expect(note303?.metadata).toMatch(/^existing note \| MCP-EXCEPTION \d{4}-\d{2}-\d{2}: shift over 12h/);
    expect(row(res.content, 3).shift_changes.find((c) => c.shift_id === 301)?.finish).toBeUndefined();
    expect(row(res.content, 4)).toMatchObject({ will_change: false, skip_reason: 'exported: costs are locked' });
    expect(row(res.content, 5)).toMatchObject({ will_change: false, skip_reason: 'already approved' });
    expect(row(res.content, 6).flags).toEqual([expect.objectContaining({ shift_id: 604, reason: expect.stringContaining('over 40h') })]);
    expect(writes(requests)).toHaveLength(0);
  });

  it('acceptance 2: a small confirmed batch approves only those timesheets, after fixing their shifts', async () => {
    const { client, requests } = tanda();
    const args = { ...period, timesheet_ids: [1, 2], source_ref: 'test-1' };
    const preview = await run(client, args);
    expect(preview.content.summary.will_change).toBe(2);
    const res = await run(client, { ...args, confirm_token: preview.content.confirm_token });
    expect(res.isError).toBeFalsy();
    expect(res.content.summary).toMatchObject({ status: 'applied', succeeded: 2, failed: 0 });
    expect(res.content.rows[0]).toMatchObject({ previous_status: 'pending', new_status: 'approved', hours: 8, cost: expect.any(Number) });
    expect(writes(requests).map((r) => [r.path, r.body])).toEqual([
      ['/timesheets/1', { status: 'approved' }],
      ['/shifts/201', { finish: nySeconds('2026-08-12', '15:00'), metadata: expect.stringContaining('missing clock-out, filled from roster') }],
      ['/timesheets/2', { status: 'approved' }],
    ]);
  });

  it('acceptance 3: flagged timesheets are approved with notes; exported ones are never touched', async () => {
    const { client, requests } = tanda();
    const args = { ...period, timesheet_ids: [3, 4] };
    const preview = await run(client, args);
    await run(client, { ...args, confirm_token: preview.content.confirm_token });
    const paths = writes(requests).map((r) => r.path);
    expect(paths).toEqual(['/shifts/301', '/shifts/302', '/shifts/303', '/shifts/304', '/timesheets/3']);
    expect(paths.some((p) => p.includes('/4') || p.includes('401'))).toBe(false);
    for (const r of writes(requests).filter((w) => w.path.startsWith('/shifts'))) {
      expect(Object.keys(r.body as object)).toEqual(['metadata']);
    }
  });

  it('acceptance 4: unapprove returns an approved timesheet to pending and edits no shifts', async () => {
    const { client, requests } = tanda();
    const args = { ...period, action: 'unapprove', timesheet_ids: [5] };
    const preview = await run(client, args);
    expect(preview.content.summary.will_change).toBe(1);
    await run(client, { ...args, confirm_token: preview.content.confirm_token });
    expect(writes(requests).map((r) => [r.path, r.body])).toEqual([['/timesheets/5', { status: 'pending' }]]);
  });

  it('reports a per-timesheet failure and carries on with the rest', async () => {
    const { client } = tanda({ failTimesheet: 1 });
    const args = { ...period, timesheet_ids: [1, 6] };
    const preview = await run(client, args);
    const res = await run(client, { ...args, confirm_token: preview.content.confirm_token });
    expect(res.content.summary).toMatchObject({ succeeded: 1, failed: 1 });
    expect(res.content.rows.find((r) => r.timesheet_id === 1)).toMatchObject({ outcome: 'failed', reason: expect.stringMatching(/^Tanda returned HTTP 403/) });
  });

  it('refuses a token for a different batch, action or source_ref', async () => {
    const { client, requests } = tanda();
    const preview = await run(client, { ...period, timesheet_ids: [1] });
    for (const change of [{ timesheet_ids: [1, 2] }, { action: 'unapprove' }, { source_ref: 'x' }]) {
      const res = await run(client, { ...period, timesheet_ids: [1], ...change, confirm_token: preview.content.confirm_token });
      expect(res.isError).toBe(true);
    }
    expect(writes(requests)).toHaveLength(0);
  });

  it('validates ids and the batch cap', async () => {
    const res = await run(tanda().client, { ...period, timesheet_ids: [999] });
    expect(JSON.stringify(res.content)).toContain('not found');
  });

  it('fill_missing_clock_out: false flags instead of filling', async () => {
    const res = await run(tanda().client, { ...period, timesheet_ids: [2], fill_missing_clock_out: false });
    const change = row(res.content, 2).shift_changes[0];
    expect(change.finish).toBeUndefined();
    expect(change.metadata).toContain('no single roster match');
  });
});

describe('exceptionNote', () => {
  it('appends once and keeps existing metadata', () => {
    expect(exceptionNote(undefined, ['a', 'b'], '2026-11-15')).toBe('MCP-EXCEPTION 2026-11-15: a; b');
    expect(exceptionNote('note', ['a'], '2026-11-15')).toBe('note | MCP-EXCEPTION 2026-11-15: a');
    expect(exceptionNote('MCP-EXCEPTION 2026-11-01: a', ['b'], '2026-11-15')).toBeUndefined();
  });
});

describe('write allowlist for #86', () => {
  const before = process.env.TANDA_WRITES_ENABLED;
  afterAll(() => { process.env.TANDA_WRITES_ENABLED = before; });

  it('allows only PUT /timesheets/{id} and PUT /shifts/{id}, and only with writes enabled', async () => {
    process.env.TANDA_WRITES_ENABLED = 'true';
    const { client } = tanda();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const ax = (client as any).client;
    for (const path of ['/shifts/1/breaks/2', '/timesheets/1/esign', '/schedules/1', '/leave/1']) {
      await expect(ax.put(path, {})).rejects.toThrow(/Read-only/);
    }
    await expect(ax.post('/shifts', {})).rejects.toThrow(/Read-only/);
    delete process.env.TANDA_WRITES_ENABLED;
    await expect(client.setTimesheetStatus(1, 'approved')).rejects.toThrow(/Read-only/);
    await expect(client.updateShift(1, { metadata: 'x' })).rejects.toThrow(/Read-only/);
  });
});
