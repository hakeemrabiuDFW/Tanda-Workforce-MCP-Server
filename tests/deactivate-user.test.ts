/** #88: tanda_deactivate_user (Tanda DELETE /users/{id} marks the user inactive). */
import { executeTool, getAvailableTools } from '../src/mcp/tools';
import { fakeTanda, RecordedRequest } from './helpers/fakeTanda';

type Content = Record<string, unknown> & { confirm_token?: string; user?: Record<string, unknown> };

const run = async (client: Parameters<typeof executeTool>[0], args: Record<string, unknown>) =>
  (await executeTool(client, 'tanda_deactivate_user', args)) as { content: Content; isError?: boolean };

const users: Record<number, Record<string, unknown>> = {
  500: { id: 500, name: 'ZZ MCP Test', active: true, user_levels: ['employee'], email: 'zz@example.com', date_of_birth: '1990-01-01' },
  501: { id: 501, name: 'Gone Already', active: false, user_levels: ['employee'] },
  502: { id: 502, name: 'A Manager', active: true, user_levels: ['employee', 'manager'] },
  1: { id: 1, name: 'Caller', active: true, user_levels: ['employee'] },
};

function tanda(opts: { meStatus?: number } = {}) {
  return fakeTanda([
    ['/users/me', () => (opts.meStatus ? { __status: opts.meStatus, body: {} } : users[1])],
    [/^\/users\/\d+$/, (r: RecordedRequest) => {
      const u = users[Number(r.path.split('/').pop())];
      if (!u) return { __status: 404, body: {} };
      return r.method === 'DELETE' ? { ...u, active: false } : u;
    }],
  ]);
}
const deletes = (requests: RecordedRequest[]) => requests.filter((r) => r.method === 'DELETE');

describe('tanda_deactivate_user', () => {
  const before = process.env.TANDA_WRITES_ENABLED;
  beforeEach(() => { process.env.TANDA_WRITES_ENABLED = 'true'; });
  afterAll(() => { process.env.TANDA_WRITES_ENABLED = before; });

  it('is off by default: not listed, refuses to run, sends nothing', async () => {
    delete process.env.TANDA_WRITES_ENABLED;
    expect(getAvailableTools().map((t) => t.name)).not.toContain('tanda_deactivate_user');
    const { client, requests } = tanda();
    const res = await run(client, { user_id: 500 });
    expect(res.isError).toBe(true);
    expect(JSON.stringify(res.content)).toContain('TANDA_WRITES_ENABLED');
    expect(deletes(requests)).toHaveLength(0);
    await expect(client.deactivateUser(500)).rejects.toThrow(/Read-only/);
  });

  it('acceptance 1: previews the user without changing anything, and without DOB or email', async () => {
    const { client, requests } = tanda();
    const res = await run(client, { user_id: 500, source_ref: 'monday-1' });
    expect(res.content).toMatchObject({ status: 'preview', changed: false, user: { id: 500, name: 'ZZ MCP Test', active: true } });
    expect(typeof res.content.confirm_token).toBe('string');
    expect(JSON.stringify(res.content)).not.toMatch(/1990-01-01|zz@example/);
    expect(deletes(requests)).toHaveLength(0);
  });

  it('acceptance 2: the same call plus confirm_token sends DELETE /users/{id}', async () => {
    const { client, requests } = tanda();
    const preview = await run(client, { user_id: 500, source_ref: 'monday-1' });
    const res = await run(client, { user_id: 500, source_ref: 'monday-1', confirm_token: preview.content.confirm_token });
    expect(res.isError).toBeFalsy();
    expect(res.content).toMatchObject({ status: 'deactivated', changed: true, user_id: 500, user: { id: 500, active: false } });
    expect(deletes(requests).map((r) => r.path)).toEqual(['/users/500']);
  });

  it('acceptance 3: an inactive user returns already_inactive and changes nothing', async () => {
    const { client, requests } = tanda();
    const res = await run(client, { user_id: 501, confirm_token: 'x.y' });
    expect(res.content).toMatchObject({ status: 'already_inactive', changed: false });
    expect(deletes(requests)).toHaveLength(0);
  });

  it('acceptance 4: refuses managers/admins and the caller', async () => {
    const { client, requests } = tanda();
    const manager = await run(client, { user_id: 502 });
    expect(manager.isError).toBe(true);
    expect(JSON.stringify(manager.content)).toContain('manager');
    const self = await run(client, { user_id: 1 });
    expect(self.isError).toBe(true);
    expect(JSON.stringify(self.content)).toContain('your own account');
    expect(deletes(requests)).toHaveLength(0);
  });

  it('fails closed when the caller cannot be identified', async () => {
    const { client, requests } = tanda({ meStatus: 403 });
    const res = await run(client, { user_id: 500 });
    expect(res.isError).toBe(true);
    expect(JSON.stringify(res.content)).toContain('Could not identify the caller');
    expect(deletes(requests)).toHaveLength(0);
  });

  it('refuses a token for another user, another tool, or after expiry', async () => {
    const { client, requests } = tanda();
    const preview = await run(client, { user_id: 500 });
    const otherUser = await run(client, { user_id: 503, confirm_token: preview.content.confirm_token });
    expect(otherUser.isError).toBe(true); // 503 doesn't exist
    const otherRef = await run(client, { user_id: 500, source_ref: 'changed', confirm_token: preview.content.confirm_token });
    expect(JSON.stringify(otherRef.content)).toContain('does not match');
    const create = await executeTool(client, 'tanda_create_user', { name: 'X', email: 'x@example.com', confirm_token: preview.content.confirm_token });
    expect(create.isError).toBe(true);
    const spy = jest.spyOn(Date, 'now').mockReturnValue(Date.now() + 16 * 60 * 1000);
    try {
      const expired = await run(client, { user_id: 500, confirm_token: preview.content.confirm_token });
      expect(JSON.stringify(expired.content)).toContain('expired');
    } finally {
      spy.mockRestore();
    }
    expect(deletes(requests)).toHaveLength(0);
  });

  it('dry_run: true with a valid token changes nothing; a missing user_id is an argument error', async () => {
    const { client, requests } = tanda();
    const preview = await run(client, { user_id: 500 });
    const dry = await run(client, { user_id: 500, dry_run: true, confirm_token: preview.content.confirm_token });
    expect(dry.content.status).toBe('preview');
    const missing = await run(client, {});
    expect(JSON.stringify(missing.content)).toContain('user_id is required');
    expect(deletes(requests)).toHaveLength(0);
  });
});
