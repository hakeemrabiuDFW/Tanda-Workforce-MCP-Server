/** #94: tanda_update_user (PUT /users/{id}), the hourly_rate input on tanda_create_user, and the missing_pay_rate check. */
import { executeTool, getAvailableTools } from '../src/mcp/tools';
import { fakeTanda, RecordedRequest } from './helpers/fakeTanda';

type Row = Record<string, unknown> & { changes?: Array<Record<string, unknown>>; flags?: string[] };
type Content = Record<string, unknown> & { summary: Record<string, unknown> & { confirm_token?: string; warnings?: unknown[] }; rows: Row[] };

const run = async (client: Parameters<typeof executeTool>[0], args: Record<string, unknown>) =>
  (await executeTool(client, 'tanda_update_user', args)) as { content: Content; isError?: boolean };

function fixture() {
  return {
    500: { id: 500, name: 'No Rate', active: true, user_levels: ['employee'], award_template_id: null, department_ids: [3, 1], employment_start_date: '2026-08-10', date_of_birth: '1990-01-01' },
    501: { id: 501, name: 'Has Rate', active: true, user_levels: ['employee'], hourly_rate: 15.5, award_template_id: 42, department_ids: [1] },
    502: { id: 502, name: 'A Manager', active: true, user_levels: ['employee', 'manager'], hourly_rate: 19 },
    503: { id: 503, name: 'Gone', active: false, user_levels: ['employee'] },
    1: { id: 1, name: 'Caller', active: true, user_levels: ['employee'], hourly_rate: 20 },
  } as Record<number, Record<string, unknown>>;
}

function tanda(opts: { meStatus?: number; noCost?: boolean; putStatus?: number; ignoreRate?: boolean } = {}) {
  const users = fixture();
  const view = (u: Record<string, unknown>, wages: boolean) => {
    if (wages && !opts.noCost) return u;
    const { hourly_rate: _r, ...rest } = u;
    return rest;
  };
  const fake = fakeTanda([
    ['/users/me', () => (opts.meStatus ? { __status: opts.meStatus, body: {} } : users[1])],
    ['/users', (r: RecordedRequest) => Object.values(users).map((u) => view(u, r.params.show_wages === 'true'))],
    [/^\/users\/\d+$/, (r: RecordedRequest) => {
      const u = users[Number(r.path.split('/').pop())];
      if (!u) return { __status: 404, body: {} };
      if (r.method === 'PUT') {
        if (opts.putStatus) return { __status: opts.putStatus, body: { error: 'nope' } };
        const body = { ...(r.body as Record<string, unknown>) };
        if (opts.ignoreRate) delete body.hourly_rate;
        Object.assign(u, body);
        return u;
      }
      return view(u, r.params.show_wages === 'true');
    }],
  ]);
  return { ...fake, users };
}
const puts = (requests: RecordedRequest[]) => requests.filter((r) => r.method === 'PUT');

describe('tanda_update_user', () => {
  const before = process.env.TANDA_WRITES_ENABLED;
  beforeEach(() => { process.env.TANDA_WRITES_ENABLED = 'true'; });
  afterAll(() => { process.env.TANDA_WRITES_ENABLED = before; });

  it('is off by default: not listed, refuses to run, and the client refuses the PUT', async () => {
    delete process.env.TANDA_WRITES_ENABLED;
    expect(getAvailableTools().map((t) => t.name)).not.toContain('tanda_update_user');
    const { client, requests } = tanda();
    const res = await run(client, { user_id: 500, hourly_rate: 15.5 });
    expect(res.isError).toBe(true);
    expect(JSON.stringify(res.content)).toContain('TANDA_WRITES_ENABLED');
    await expect(client.updateUser(500, { hourly_rate: 15.5 })).rejects.toThrow(/Read-only/);
    expect(puts(requests)).toHaveLength(0);
  });

  it('acceptance 1: a dry run returns a before → after diff and a confirm_token, and changes nothing', async () => {
    const { client, requests } = tanda();
    const res = await run(client, { user_id: 500, hourly_rate: 15.5, award_template_id: 42, source_ref: 'isolved-backfill' });
    expect(res.isError).toBeFalsy();
    expect(res.content.summary).toMatchObject({ status: 'preview', changed: false, users: 1, will_change: 1 });
    expect(typeof res.content.summary.confirm_token).toBe('string');
    expect(res.content.rows[0]).toMatchObject({ user_id: 500, will_change: true });
    expect(res.content.rows[0].changes).toEqual([
      { field: 'hourly_rate', before: null, after: 15.5 },
      { field: 'award_template_id', before: null, after: 42 },
    ]);
    expect(JSON.stringify(res.content)).not.toContain('1990-01-01');
    expect(puts(requests)).toHaveLength(0);
  });

  it('acceptance 2: the same call plus confirm_token sends PUT /users/{id} with only the changed fields', async () => {
    const { client, requests } = tanda();
    const args = { user_id: 500, hourly_rate: 15.5, department_ids: [1, 3], source_ref: 'isolved-backfill' };
    const preview = await run(client, args);
    const res = await run(client, { ...args, confirm_token: preview.content.summary.confirm_token });
    expect(res.isError).toBeFalsy();
    expect(res.content.summary).toMatchObject({ status: 'applied', changed: true, succeeded: 1, failed: 0 });
    expect(res.content.rows[0]).toMatchObject({ outcome: 'updated', user_id: 500 });
    // department_ids already matched (order ignored), so only the rate is sent
    expect(puts(requests).map((r) => [r.path, r.body])).toEqual([['/users/500', { hourly_rate: 15.5 }]]);
  });

  it('acceptance 3: bulk updates preview once and apply per user, reporting each outcome', async () => {
    const { client, requests } = tanda({ });
    const args = { updates: [{ user_id: 501, hourly_rate: 16 }, { user_id: 500, hourly_rate: 15.5 }], source_ref: 'isolved-backfill' };
    const preview = await run(client, args);
    expect(preview.content.summary).toMatchObject({ users: 2, will_change: 2 });
    expect(preview.content.rows.map((r) => r.user_id)).toEqual([500, 501]);
    const res = await run(client, { ...args, confirm_token: preview.content.summary.confirm_token });
    expect(res.content.summary).toMatchObject({ succeeded: 2, failed: 0 });
    expect(puts(requests).map((r) => r.path)).toEqual(['/users/500', '/users/501']);
  });

  it('acceptance 4: a user whose values already match is unchanged and nothing is sent', async () => {
    const { client, requests } = tanda();
    const res = await run(client, { user_id: 501, hourly_rate: 15.5, award_template_id: 42 });
    expect(res.content.summary).toMatchObject({ status: 'unchanged', will_change: 0, unchanged: 1 });
    expect(res.content.summary.confirm_token).toBeUndefined();
    expect(puts(requests)).toHaveLength(0);
  });

  it('acceptance 5: refuses managers, inactive users, the caller, unknown users, other fields and bad rates', async () => {
    const { client, requests } = tanda();
    const res = await run(client, { updates: [502, 503, 1, 999].map((user_id) => ({ user_id, hourly_rate: 15 })) });
    expect(res.content.summary).toMatchObject({ status: 'nothing_to_change', refused: 4, will_change: 0 });
    expect(res.content.rows.map((r) => r.reason)).toEqual([
      expect.stringContaining('own account'),
      expect.stringContaining('"employee"'),
      expect.stringContaining('inactive'),
      'user not found',
    ]);
    for (const bad of [{ user_id: 500, hourly_rate: 0 }, { user_id: 500, hourly_rate: 150 }, { user_id: 500 }]) {
      const r = await run(client, bad);
      expect(r.isError).toBe(true);
    }
    const level = await run(client, { updates: [{ user_id: 500, user_levels: ['manager'] }] });
    expect(JSON.stringify(level.content)).toContain("can't change: user_levels");
    const single = await run(client, { user_id: 500, hourly_rate: 15.5, user_levels: ['manager'], email: 'x@example.com' });
    expect(JSON.stringify(single.content)).toContain("can't change: user_levels, email");
    const dup = await run(client, { updates: [{ user_id: 500, hourly_rate: 15 }, { user_id: 500, hourly_rate: 16 }] });
    expect(JSON.stringify(dup.content)).toContain('more than once');
    const tooMany = await run(client, { updates: Array.from({ length: 51 }, (_, i) => ({ user_id: i + 1000, hourly_rate: 15 })) });
    expect(JSON.stringify(tooMany.content)).toContain('limited to 50');
    expect(puts(requests)).toHaveLength(0);
  });

  it('flags a rate change over 25%, and the token is bound to the exact change set', async () => {
    const { client, requests } = tanda();
    const preview = await run(client, { user_id: 501, hourly_rate: 25 });
    expect(preview.content.rows[0].flags?.[0]).toContain('more than 25%');
    const other = await run(client, { user_id: 501, hourly_rate: 26, confirm_token: preview.content.summary.confirm_token });
    expect(JSON.stringify(other.content)).toContain('does not match');
    const dry = await run(client, { user_id: 501, hourly_rate: 25, dry_run: true, confirm_token: preview.content.summary.confirm_token });
    expect(dry.content.summary.status).toBe('preview');
    expect(puts(requests)).toHaveLength(0);
  });

  it('fails soft per user: a Tanda error or a dropped rate is reported, not claimed as success', async () => {
    const failing = tanda({ putStatus: 422 });
    const args = { user_id: 500, hourly_rate: 15.5 };
    let preview = await run(failing.client, args);
    let res = await run(failing.client, { ...args, confirm_token: preview.content.summary.confirm_token });
    expect(res.content.summary).toMatchObject({ succeeded: 0, failed: 1 });
    expect(res.content.rows[0]).toMatchObject({ outcome: 'failed', reason: expect.stringContaining('HTTP 422') });

    const ignoring = tanda({ ignoreRate: true });
    ignoring.users[500].hourly_rate = 0;
    preview = await run(ignoring.client, args);
    res = await run(ignoring.client, { ...args, confirm_token: preview.content.summary.confirm_token });
    expect(res.content.rows[0]).toMatchObject({ outcome: 'not_applied', fields: ['hourly_rate'] });
  });

  it('without the cost scope the current rate shows as null and a warning says why', async () => {
    const { client } = tanda({ noCost: true });
    const res = await run(client, { user_id: 501, hourly_rate: 15.5 });
    expect(res.content.rows[0].changes?.[0]).toEqual({ field: 'hourly_rate', before: null, after: 15.5 });
    expect(JSON.stringify(res.content.summary.warnings)).toContain('cost scope');
  });

  it('fails closed when the caller cannot be identified', async () => {
    const { client, requests } = tanda({ meStatus: 403 });
    const res = await run(client, { user_id: 500, hourly_rate: 15.5 });
    expect(JSON.stringify(res.content)).toContain('Could not identify the caller');
    expect(puts(requests)).toHaveLength(0);
  });
});

describe('#94 tanda_create_user hourly_rate', () => {
  const before = process.env.TANDA_WRITES_ENABLED;
  beforeEach(() => { process.env.TANDA_WRITES_ENABLED = 'true'; });
  afterAll(() => { process.env.TANDA_WRITES_ENABLED = before; });

  const create = (client: Parameters<typeof executeTool>[0], args: Record<string, unknown>) =>
    executeTool(client, 'tanda_create_user', args) as Promise<{ content: Record<string, unknown> & { confirm_token?: string; warnings?: unknown[] }; isError?: boolean }>;
  const createTanda = () => fakeTanda([
    ['/users', (r: RecordedRequest) => (r.method === 'POST' ? { __status: 201, body: { id: 700, ...(r.body as object), active: true } } : [])],
    ['/users/inactive', () => []],
    ['/users/me', () => ({ id: 1 })],
  ]);

  it('acceptance 7: creates the user with the rate; without one the preview warns', async () => {
    const { client, requests } = createTanda();
    const args = { name: 'Rate Hire', email: 'rate@example.com', hourly_rate: 15.5 };
    const preview = await create(client, args);
    expect(preview.content.pay_rate).toBe(15.5);
    expect(preview.content.warnings).toBeUndefined();
    await create(client, { ...args, confirm_token: preview.content.confirm_token });
    expect((requests.find((r) => r.method === 'POST')?.body as Record<string, unknown>).hourly_rate).toBe(15.5);

    const noRate = await create(client, { name: 'No Rate', email: 'norate@example.com' });
    expect(JSON.stringify(noRate.content.warnings)).toContain('cost $0');
    const bad = await create(client, { name: 'Bad', email: 'bad@example.com', hourly_rate: -1 });
    expect(bad.isError).toBe(true);
  });
});

describe('#94 tanda_exceptions missing_pay_rate', () => {
  const exceptions = (client: Parameters<typeof executeTool>[0]) =>
    executeTool(client, 'tanda_exceptions', { checks: ['missing_pay_rate'] }) as Promise<{ content: { summary: Record<string, unknown>; rows: Row[] } }>;

  it('acceptance 6: lists active employee-level staff with no rate, and nobody once rates are set', async () => {
    const res = await exceptions(tanda().client);
    expect(res.content.rows).toEqual([{ type: 'missing_pay_rate', user_id: 500, user_name: 'No Rate', employment_start_date: '2026-08-10' }]);
    // A fresh fake, since user lists are cached per client
    const backfilled = tanda();
    backfilled.users[500].hourly_rate = 15.5;
    expect((await exceptions(backfilled.client)).content.rows).toEqual([]);
  });

  it('degrades to a warning without the cost scope instead of flagging everyone', async () => {
    const res = await exceptions(tanda({ noCost: true }).client);
    expect(res.content.rows).toEqual([]);
    expect(JSON.stringify(res.content.summary)).toContain('missing scope: cost');
  });
});
