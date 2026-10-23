/** WFM-008 (#55): leave balances say whether accruals are configured. */
import { executeTool } from '../src/mcp/tools';
import { fakeTanda } from './helpers/fakeTanda';

type Content = { summary: Record<string, unknown>; rows: Array<Record<string, unknown>> };

const run = async (client: Parameters<typeof executeTool>[0], name: string, args: Record<string, unknown>) =>
  (await executeTool(client, name, args)) as { content: Content; isError?: boolean };

describe('WFM-008 leave balances explain an empty result', () => {
  const routes = (balances: unknown[]) => fakeTanda([
    ['/leave_balances', () => balances],
    [/^\/leave\/types_for\//, () => [{ name: 'Sick Leave' }]],
  ]);

  it('says no accrual is configured when Tanda returns no balances', async () => {
    const res = await run(routes([]).client, 'tanda_time_off', { kind: 'balances', user_id: 7 });
    expect(res.content.summary).toMatchObject({ balances: 0, balances_configured: false, case: 'no_accrual_configured' });
    expect(res.content.summary.hint).toMatch(/Sick Leave/);
    expect(res.content.summary.hint).toMatch(/isolved/);
  });

  it('distinguishes a real zero balance', async () => {
    const res = await run(routes([{ user_id: 7, leave_type: 'Sick Leave', balance: 0 }]).client, 'tanda_time_off', { kind: 'balances', user_id: 7 });
    expect(res.content.summary).toMatchObject({ balances_configured: true, case: 'zero_balance' });
  });
});

describe('WFM-008 when the leave-types lookup fails', () => {
  it('still answers, without naming types', async () => {
    const { client } = fakeTanda([
      ['/leave_balances', () => []],
      [/^\/leave\/types_for\//, () => ({ __status: 500, body: {} })],
    ]);
    const res = await run(client, 'tanda_time_off', { kind: 'balances', user_id: 7 });
    expect(res.isError).toBeFalsy();
    expect(res.content.summary).toMatchObject({ balances_configured: false, case: 'no_accrual_configured' });
  });
});
