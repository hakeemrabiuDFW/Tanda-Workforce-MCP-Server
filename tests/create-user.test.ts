/** #84: tanda_create_user, the one write path (preview -> confirm_token -> create). */
import { executeTool, getAvailableTools } from '../src/mcp/tools';
import { fakeTanda, RecordedRequest } from './helpers/fakeTanda';

type Content = Record<string, unknown> & { payload?: Record<string, unknown>; confirm_token?: string; warnings?: Array<Record<string, unknown>> };

const run = async (client: Parameters<typeof executeTool>[0], args: Record<string, unknown>) =>
  (await executeTool(client, 'tanda_create_user', args)) as { content: Content; isError?: boolean };

const existing = [
  { id: 10, name: 'Pat Lee', email: 'Pat@Example.com', employment_start_date: '2026-01-05', active: true },
];
const inactive = [
  { id: 11, name: 'Old Hire', email: 'old@example.com', employment_start_date: '2025-02-01', active: false },
  // Tanda returns null for an inactive user's email but still refuses to create a user with it
  { id: 12, name: 'Former Smoke', email: null, employment_start_date: null, active: false },
];
const departments = [{ id: 1156446, name: 'Trainee', location_id: 1 }];

function tanda(opts: { createStatus?: number; inviteStatus?: number } = {}) {
  let nextId = 500;
  return fakeTanda([
    ['/users', (r: RecordedRequest) => {
      if (r.method !== 'POST') return existing;
      if (opts.createStatus) return { __status: opts.createStatus, body: { error: 'nope' } };
      const body = r.body as Record<string, unknown>;
      return { __status: 201, body: { id: nextId++, ...body, active: true, date_of_birth: '1990-01-01', passcode: '9999', hourly_rate: 20 } };
    }],
    ['/users/inactive', () => inactive],
    ['/users/me', () => ({ id: 1, name: 'Manager' })],
    [/^\/users\/\d+\/invite$/, () => ({ __status: opts.inviteStatus ?? 201, body: {} })],
    ['/departments', () => departments],
    ['/locations', () => [{ id: 1, name: 'Site' }]],
  ]);
}

const hire = { name: 'Test Hire', email: 'test.hire@example.com', phone: '+15555550100', employment_start_date: '2026-12-01', department_ids: [1156446], source_ref: 'monday-123' };
const posts = (requests: RecordedRequest[]) => requests.filter((r) => r.method === 'POST');

describe('tanda_create_user', () => {
  const before = process.env.TANDA_WRITES_ENABLED;
  beforeEach(() => { process.env.TANDA_WRITES_ENABLED = 'true'; });
  afterAll(() => { process.env.TANDA_WRITES_ENABLED = before; });

  it('is off by default: not listed and refuses to run', async () => {
    delete process.env.TANDA_WRITES_ENABLED;
    expect(getAvailableTools().map((t) => t.name)).not.toContain('tanda_create_user');
    const { client, requests } = tanda();
    const res = await run(client, hire);
    expect(res.isError).toBe(true);
    expect(JSON.stringify(res.content)).toContain('TANDA_WRITES_ENABLED');
    expect(posts(requests)).toHaveLength(0);
  });

  it('is listed when writes are enabled', () => {
    expect(getAvailableTools().map((t) => t.name)).toContain('tanda_create_user');
  });

  it('acceptance 1: the first call previews the exact payload and creates nothing', async () => {
    const { client, requests } = tanda();
    const res = await run(client, { ...hire, fields: ['email', 'phone'] });
    expect(res.isError).toBeFalsy();
    expect(res.content.status).toBe('preview');
    expect(res.content.created).toBe(false);
    expect(res.content.payload).toEqual({
      name: 'Test Hire', email: 'test.hire@example.com', phone: '+15555550100', employment_start_date: '2026-12-01',
      department_ids: [1156446], award_template_id: 42, user_levels: ['employee'],
    });
    expect(typeof res.content.confirm_token).toBe('string');
    expect(posts(requests)).toHaveLength(0);
  });

  it('keeps email and phone out of the preview unless asked for in fields', async () => {
    const res = await run(tanda().client, hire);
    expect(res.content.payload).not.toHaveProperty('email');
    expect(res.content.payload).not.toHaveProperty('phone');
  });

  it('acceptance 2: the same call plus confirm_token creates the user, without DOB or wages in the result', async () => {
    const { client, requests } = tanda();
    const preview = await run(client, hire);
    const res = await run(client, { ...hire, confirm_token: preview.content.confirm_token });
    expect(res.isError).toBeFalsy();
    expect(res.content).toMatchObject({ status: 'created', created: true, user_id: 500, invite: 'not_requested' });
    expect(res.content.user).toMatchObject({ id: 500, name: 'Test Hire', award_template_id: 42, department_ids: [1156446] });
    const text = JSON.stringify(res.content);
    for (const leak of ['date_of_birth', 'passcode', 'hourly_rate', '1990-01-01']) expect(text).not.toContain(leak);
    const sent = posts(requests);
    expect(sent).toHaveLength(1);
    expect(sent[0].path).toBe('/users');
    expect(sent[0].body).toEqual({
      name: 'Test Hire', email: 'test.hire@example.com', phone: '+15555550100', employment_start_date: '2026-12-01',
      department_ids: [1156446], award_template_id: 42, user_levels: ['employee'],
    });
  });

  it('sends the invite only when send_invite is true, and reports an invite failure as a warning', async () => {
    const ok = tanda();
    const p1 = await run(ok.client, { ...hire, send_invite: true });
    const r1 = await run(ok.client, { ...hire, send_invite: true, confirm_token: p1.content.confirm_token });
    expect(r1.content.invite).toBe('sent');
    expect(posts(ok.requests).map((r) => r.path)).toEqual(['/users', '/users/500/invite']);

    const bad = tanda({ inviteStatus: 400 });
    const p2 = await run(bad.client, { ...hire, send_invite: true });
    const r2 = await run(bad.client, { ...hire, send_invite: true, confirm_token: p2.content.confirm_token });
    expect(r2.isError).toBeFalsy();
    expect(r2.content).toMatchObject({ status: 'created', invite: 'failed' });
    expect(r2.content.warnings?.[0].check).toBe('send_invite');
  });

  it('acceptance 3: an existing email (any case, active or inactive) returns the existing id', async () => {
    const { client, requests } = tanda();
    const active = await run(client, { ...hire, email: 'pat@example.COM' });
    expect(active.content).toMatchObject({ status: 'exists', created: false, existing_user_id: 10, matched_on: 'email', active: true });
    expect(active.content.confirm_token).toBeUndefined();
    const old = await run(client, { ...hire, email: 'old@example.com', confirm_token: 'x.y' });
    expect(old.content).toMatchObject({ status: 'exists', existing_user_id: 11, active: false });
    expect(posts(requests)).toHaveLength(0);
  });

  it('matches an inactive user whose email Tanda hides by name, never creates or reactivates, and allows not_a_rehire', async () => {
    const { client, requests } = tanda();
    const args = { name: ' former  SMOKE ', email: 'former.smoke@example.com', source_ref: 'monday-9' };
    const preview = await run(client, args);
    expect(preview.content).toMatchObject({ status: 'exists', created: false, existing_user_id: 12, matched_on: 'name_inactive', active: false });
    expect(String(preview.content.note)).toMatch(/rehire them in Tanda/);
    expect(preview.content.confirm_token).toBeUndefined();
    const confirm = await run(client, { ...args, confirm_token: 'x.y' });
    expect(confirm.content).toMatchObject({ status: 'exists', existing_user_id: 12 });
    expect(requests.filter((r) => r.method !== 'GET')).toHaveLength(0);         // no POST, PUT or DELETE: nobody created or reactivated

    const different = await run(client, { ...args, not_a_rehire: true });
    expect(different.content).toMatchObject({ status: 'preview' });
    expect(typeof different.content.confirm_token).toBe('string');
  });

  it('does not name-match an active user or an inactive user whose email is visible', async () => {
    const res = await run(tanda().client, { name: 'Old Hire', email: 'someone.else@example.com', source_ref: 'monday-9' });
    expect(res.content).toMatchObject({ status: 'preview' });
    const act = await run(tanda().client, { name: 'Pat Lee', email: 'another.pat@example.com', source_ref: 'monday-9' });
    expect(act.content).toMatchObject({ status: 'preview' });
  });

  it('refuses the same name and start date under a different email', async () => {
    const res = await run(tanda().client, { ...hire, name: ' pat  LEE ', email: 'new@example.com', employment_start_date: '2026-01-05' });
    expect(res.content).toMatchObject({ status: 'exists', existing_user_id: 10, matched_on: 'name_and_start_date' });
  });

  it('refuses a confirm_token that does not match the arguments, or is malformed', async () => {
    const { client, requests } = tanda();
    const preview = await run(client, hire);
    const changed = await run(client, { ...hire, department_ids: [1156446], award_template_id: 7, confirm_token: preview.content.confirm_token });
    expect(changed.isError).toBe(true);
    expect(JSON.stringify(changed.content)).toContain('does not match');
    const malformed = await run(client, { ...hire, confirm_token: 'garbage' });
    expect(malformed.isError).toBe(true);
    expect(posts(requests)).toHaveLength(0);
  });

  it('refuses a token issued to a different Tanda identity', async () => {
    const preview = await run(tanda().client, hire);
    const other = tanda();
    const res = await run(other.client, { ...hire, confirm_token: preview.content.confirm_token });
    expect(res.isError).toBe(true);
    expect(posts(other.requests)).toHaveLength(0);
  });

  it('refuses an expired token', async () => {
    const { client, requests } = tanda();
    const preview = await run(client, hire);
    const spy = jest.spyOn(Date, 'now').mockReturnValue(Date.now() + 16 * 60 * 1000);
    try {
      const res = await run(client, { ...hire, confirm_token: preview.content.confirm_token });
      expect(res.isError).toBe(true);
      expect(JSON.stringify(res.content)).toContain('expired');
    } finally {
      spy.mockRestore();
    }
    expect(posts(requests)).toHaveLength(0);
  });

  it('dry_run: true with a valid token still creates nothing', async () => {
    const { client, requests } = tanda();
    const preview = await run(client, hire);
    const res = await run(client, { ...hire, dry_run: true, confirm_token: preview.content.confirm_token });
    expect(res.content.status).toBe('preview');
    expect(posts(requests)).toHaveLength(0);
  });

  it.each([
    [{ name: '' }, 'name is required'],
    [{ email: undefined }, 'email is required'],
    [{ email: 'not-an-email' }, 'valid email'],
    [{ employment_start_date: '12/01/2026' }, 'YYYY-MM-DD'],
    [{ department_ids: ['x'] }, 'department_ids'],
    [{ department_ids: [999] }, 'Unknown department_ids: 999'],
    [{ award_template_id: -1 }, 'award_template_id'],
    [{ user_levels: ['admin'] }, 'user_levels may only contain'],
  ])('validates input %p', async (override, message) => {
    const { client, requests } = tanda();
    const res = await run(client, { ...hire, ...override });
    expect(res.isError).toBe(true);
    expect(JSON.stringify(res.content)).toContain(message);
    expect(posts(requests)).toHaveLength(0);
  });

  it('ignores wage, DOB and role fields passed as arguments', async () => {
    const { client, requests } = tanda();
    const extra = { date_of_birth: '1990-01-01', passcode: '1', managed_department_ids: [1] };
    const preview = await run(client, { ...hire, ...extra });
    await run(client, { ...hire, ...extra, confirm_token: preview.content.confirm_token });
    const body = posts(requests)[0].body as Record<string, unknown>;
    for (const k of Object.keys(extra)) expect(body).not.toHaveProperty(k);
  });

  it('reports a create response without an id as an error, not an undefined user_id', async () => {
    const { client } = fakeTanda([
      ['/users', (r: RecordedRequest) => (r.method === 'POST' ? { __status: 201, body: {} } : [])],
      ['/users/inactive', () => []],
      ['/departments', () => departments],
    ]);
    const preview = await run(client, hire);
    const res = await run(client, { ...hire, confirm_token: preview.content.confirm_token });
    expect(res.isError).toBe(true);
    expect(JSON.stringify(res.content)).toContain('no user id');
  });

  it('maps a Tanda rejection to a clear error', async () => {
    const { client } = tanda({ createStatus: 403 });
    const preview = await run(client, hire);
    const res = await run(client, { ...hire, confirm_token: preview.content.confirm_token });
    expect(res.isError).toBe(true);
    expect(String(res.content.hint)).toContain('"user" scope');
  });
});

describe('write allowlist in the Tanda client', () => {
  const before = process.env.TANDA_WRITES_ENABLED;
  afterAll(() => { process.env.TANDA_WRITES_ENABLED = before; });

  it('refuses every write when TANDA_WRITES_ENABLED is off, even POST /users', async () => {
    delete process.env.TANDA_WRITES_ENABLED;
    const { client, requests } = tanda();
    await expect(client.createUser({ name: 'x' })).rejects.toThrow(/Read-only/);
    expect(posts(requests)).toHaveLength(0);
  });

  it('still refuses writes outside the allowlist when enabled', async () => {
    process.env.TANDA_WRITES_ENABLED = 'true';
    const { client } = tanda();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const axiosInstance = (client as any).client;
    await expect(axiosInstance.post('/schedules', {})).rejects.toThrow(/Read-only/);
    await expect(axiosInstance.put('/users/1/rates', {})).rejects.toThrow(/Read-only/); // PUT /users/{id} is allowlisted (#94)
    await expect(axiosInstance.delete('/users/1/alternate_rates')).rejects.toThrow(/Read-only/);
    await expect(axiosInstance.delete('/schedules/1')).rejects.toThrow(/Read-only/);
    await expect(axiosInstance.post('/users/1/onboard', {})).rejects.toThrow(/Read-only/);
  });
});
