/** WFM-007 (#54): tanda_people reports fields it cannot return. */
import { executeTool } from '../src/mcp/tools';
import { fakeTanda } from './helpers/fakeTanda';

type Content = { summary: Record<string, unknown>; rows: Array<Record<string, unknown>>; ignored_fields?: Array<Record<string, unknown>>; user?: Record<string, unknown> };

const run = async (client: Parameters<typeof executeTool>[0], name: string, args: Record<string, unknown>) =>
  (await executeTool(client, name, args)) as { content: Content; isError?: boolean };

describe('WFM-007 tanda_people reports ignored fields', () => {
  const user = { id: 1, name: 'Pat', active: true, email: 'p@example.com', passcode: '1234' };
  const routes = (wages: 'ok' | 'omitted' | 'denied') => fakeTanda([
    ['/users', (r) => {
      if (r.params.show_wages && wages === 'denied') return { __status: 403, body: {} };
      return [r.params.show_wages && wages === 'ok' ? { ...user, hourly_rate: 18.5 } : user];
    }],
    ['/users/1', (r) => (r.params.show_wages && wages === 'ok' ? { ...user, hourly_rate: 18.5 } : user)],
  ]);

  it('lists unknown and policy-blocked fields', async () => {
    const res = await run(routes('ok').client, 'tanda_people', { fields: ['pay_group_id', 'passcode', 'email'] });
    expect(res.content.ignored_fields).toEqual([
      { field: 'pay_group_id', reason: 'unknown_field' },
      { field: 'passcode', reason: 'not_exposed_by_policy' },
    ]);
    expect(res.content.rows[0].email).toBe('p@example.com');
    expect(JSON.stringify(res.content)).not.toContain('1234');
  });

  it('returns hourly_rate when the cost scope allows it', async () => {
    const res = await run(routes('ok').client, 'tanda_people', { fields: ['hourly_rate'] });
    expect(res.content.rows[0].hourly_rate).toBe(18.5);
    expect(res.content.ignored_fields).toBeUndefined();
    const one = await run(routes('ok').client, 'tanda_people', { user_id: 1, show_wages: true });
    expect(one.content.user!.hourly_rate).toBe(18.5);
  });

  it('reports needs_scope:cost when wages are omitted or denied, and still returns people', async () => {
    for (const mode of ['omitted', 'denied'] as const) {
      const res = await run(routes(mode).client, 'tanda_people', { fields: ['hourly_rate'] });
      expect(res.isError).toBeFalsy();
      expect(res.content.rows).toHaveLength(1);
      expect(res.content.ignored_fields).toEqual([{ field: 'hourly_rate', reason: 'needs_scope:cost' }]);
    }
  });

  it('never returns hourly_rate unless asked', async () => {
    const { client } = fakeTanda([['/users', () => [{ ...user, hourly_rate: 18.5 }]]]);
    const res = await run(client, 'tanda_people', {});
    expect(res.content.rows[0].hourly_rate).toBeUndefined();
  });
});


describe('WFM-007 redaction scope', () => {
  it('only hourly_rate is a wage key: export columns such as "Wages" survive', async () => {
    const { redactSensitive } = await import('../src/mcp/privacy');
    expect(redactSensitive({ Wages: 1, 'Wage Type': 'ORD', wages_cost: 2, hourly_rate: 18 })).toEqual({ Wages: 1, 'Wage Type': 'ORD', wages_cost: 2 });
  });
});
