/** WFM-002 (#49): tanda_validate_schedule fails soft per check. */
import { executeTool } from '../src/mcp/tools';
import { fakeTanda, nySeconds } from './helpers/fakeTanda';

type Content = { summary: Record<string, unknown>; rows: Array<Record<string, unknown>>; warnings?: Array<Record<string, unknown>>; error?: string };

const run = async (client: Parameters<typeof executeTool>[0], name: string, args: Record<string, unknown>) =>
  (await executeTool(client, name, args)) as { content: Content; isError?: boolean };

describe('WFM-002 tanda_validate_schedule fails soft per check', () => {
  const day = '2026-10-13';
  const routes = (overrides: Record<string, () => unknown> = {}) => fakeTanda([
    ['/users', overrides['/users'] || (() => [{ id: 1, name: 'A' }])],
    ['/schedules', overrides['/schedules'] || (() => [
      { id: 50, user_id: 1, start: nySeconds(day, '08:00'), finish: nySeconds(day, '12:00') },
      { id: 51, user_id: 1, start: nySeconds('2026-10-14', '06:00'), finish: nySeconds('2026-10-14', '18:00') },
      { id: 52, user_id: 1, start: nySeconds('2026-10-15', '06:00'), finish: nySeconds('2026-10-15', '18:00') },
      { id: 53, user_id: 1, start: nySeconds('2026-10-16', '06:00'), finish: nySeconds('2026-10-16', '18:00') },
    ])],
    ['/leave', overrides['/leave'] || (() => [{ id: 3, user_id: 1, status: 'approved', start: '2026-10-17', finish: '2026-10-17' }])],
    ['/unavailability', overrides['/unavailability'] || (() => ({ __status: 403, body: { error: 'insufficient scope' } }))],
  ]);
  const shifts = [
    { user_id: 1, start: `${day} 10:00`, finish: `${day} 14:00` }, // overlaps roster
    { user_id: 1, start: '2026-10-17 06:00', finish: '2026-10-17 20:00' }, // leave + 14h + > 40h week
    { user_id: 1, location_id: 1, start: '2026-10-18 09:00', finish: '2026-10-18 10:00' },
    { user_id: 1, location_id: 2, start: '2026-10-18 09:30', finish: '2026-10-18 11:00' }, // double-booked
  ];
  const issues = (r: Record<string, unknown>) => [...(r.errors as string[]), ...(r.warnings as string[])].join('; ');

  it('without the unavailability scope, every other check still runs and one warning is returned', async () => {
    const res = await run(routes().client, 'tanda_validate_schedule', { shifts });
    expect(res.isError).toBeFalsy();
    expect(res.content.warnings).toEqual([{ check: 'unavailability', reason: 'missing scope: unavailability' }]);
    expect(res.content.summary.checks_skipped).toEqual(['unavailability']);
    expect(issues(res.content.rows[0])).toMatch(/overlaps existing schedule 50/);
    expect(issues(res.content.rows[1])).toMatch(/approved leave/);
    expect(issues(res.content.rows[1])).toMatch(/exceeds 12h/);
    expect(issues(res.content.rows[1])).toMatch(/> 40h/);
    expect(issues(res.content.rows[3])).toMatch(/double-booked/);
  });

  it('without the roster scope, skips roster conflicts and says the weekly total is partial', async () => {
    const res = await run(routes({ '/schedules': () => ({ __status: 403, body: {} }) }).client, 'tanda_validate_schedule', { shifts });
    expect(res.content.warnings!.map((w) => w.check).sort()).toEqual(['roster_conflicts', 'unavailability', 'weekly_hours']);
    expect(issues(res.content.rows[0])).not.toMatch(/existing schedule/);
    expect(issues(res.content.rows[1])).toMatch(/approved leave/);
  });

  it('still fails on errors that are not a missing scope', async () => {
    const res = await run(routes({ '/leave': () => ({ __status: 500, body: {} }) }).client, 'tanda_validate_schedule', { shifts });
    expect(res.isError).toBe(true);
    expect(res.content.error).toMatch(/unavailable/);
  });
});

