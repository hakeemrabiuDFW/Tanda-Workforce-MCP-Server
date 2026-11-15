/** ADR 0001: which identity each write tool may run as. */
import { executeTool } from '../src/mcp/tools';
import { fakeTanda } from './helpers/fakeTanda';

const routes = () => [
  ['/users', () => []],
  ['/users/inactive', () => []],
  ['/users/me', () => ({ id: 1 })],
  ['/users/500', () => ({ id: 500, name: 'ZZ', active: true, user_levels: ['employee'] })],
] as Parameters<typeof fakeTanda>[0];

describe('ADR 0001 write identity', () => {
  const before = process.env.TANDA_WRITES_ENABLED;
  beforeEach(() => { process.env.TANDA_WRITES_ENABLED = 'true'; });
  afterAll(() => { process.env.TANDA_WRITES_ENABLED = before; });

  const hire = { name: 'ZZ MCP Test', email: 'zz@example.com' };

  it.each([
    ['tanda_create_user', hire],
    ['tanda_deactivate_user', { user_id: 500 }],
  ])('%s under the shared identity needs source_ref', async (tool, args) => {
    const shared = fakeTanda(routes(), { sharedIdentity: true }).client;
    const without = await executeTool(shared, tool, args);
    expect(without.isError).toBe(true);
    expect(JSON.stringify(without.content)).toContain('source_ref');
    const withRef = await executeTool(shared, tool, { ...args, source_ref: 'monday-123' });
    expect(withRef.isError).toBeFalsy();
    expect((withRef.content as Record<string, unknown>).status).toBe('preview');
  });

  it.each([
    ['tanda_create_user', hire],
    ['tanda_deactivate_user', { user_id: 500 }],
  ])('%s under a personal identity does not need source_ref', async (tool, args) => {
    const res = await executeTool(fakeTanda(routes()).client, tool, args);
    expect(res.isError).toBeFalsy();
  });

  it('tanda_approve_timesheets lets the shared identity preview but never apply', async () => {
    const sheet = { id: 1, user_id: 10, status: 'pending', start: '2026-08-10', finish: '2026-08-23', shifts: [{ id: 5, user_id: 10, date: '2026-08-11', start: 1786453200, finish: 1786482000, award_interpretation: [{ units: 8 }] }] };
    const extra = [[/^\/timesheets\/on\//, () => [sheet]], ['/departments', () => []], ['/locations', () => []]] as Parameters<typeof fakeTanda>[0];
    const { client, requests } = fakeTanda([...extra, ...routes()], { sharedIdentity: true });
    const args = { from: '2026-08-10', to: '2026-08-23', allow_past_period: true, source_ref: 'x' };
    const preview = await executeTool(client, 'tanda_approve_timesheets', args);
    expect(preview.isError).toBeFalsy();
    const body = preview.content as Record<string, unknown>;
    expect((body.summary as Record<string, unknown>).status).toBe('preview');
    expect(body.confirm_token).toBeUndefined();
    expect(String(body.next_step)).toContain("person's own Tanda login");
    const apply = await executeTool(client, 'tanda_approve_timesheets', { ...args, confirm_token: '1.x' });
    expect(apply.isError).toBe(true);
    expect(JSON.stringify(apply.content)).toContain("person's own Tanda login");
    expect(requests.filter((r) => r.method !== 'GET')).toHaveLength(0);
  });
});
