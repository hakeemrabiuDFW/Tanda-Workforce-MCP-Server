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

  it('tanda_approve_timesheets refuses the shared identity even with source_ref', async () => {
    const shared = fakeTanda(routes(), { sharedIdentity: true }).client;
    const res = await executeTool(shared, 'tanda_approve_timesheets', { from: '2026-08-10', to: '2026-08-23', source_ref: 'x' });
    expect(res.isError).toBe(true);
    expect(JSON.stringify(res.content)).toContain("person's own Tanda login");
  });
});
