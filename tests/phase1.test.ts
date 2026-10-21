import { computeDailyStats } from '../src/tanda/client';
import { toUnixSeconds, toZonedISO, chunkDateRange, hoursBetween } from '../src/utils/time';
import { guardResponse, byteSize, MAX_BYTES } from '../src/mcp/guard';
import { pickUserFields, redactSensitive } from '../src/mcp/privacy';
import { executeTool } from '../src/mcp/tools';
import { fakeTanda, nySeconds } from './helpers/fakeTanda';

const START = nySeconds('2026-10-20', '09:00');
const EIGHT_HOURS = 8 * 3600;

describe('time helpers', () => {
  it('normalises seconds, milliseconds and ISO strings to unix seconds', () => {
    expect(toUnixSeconds(START)).toBe(START);
    expect(toUnixSeconds(START * 1000)).toBe(START);
    expect(toUnixSeconds(String(START))).toBe(START);
    expect(toUnixSeconds(new Date(START * 1000).toISOString())).toBe(START);
  });

  it('renders ISO strings in America/New_York with the right offset', () => {
    expect(toZonedISO(START)).toBe('2026-10-20T09:00:00-04:00');
    expect(toZonedISO(nySeconds('2026-12-01', '17:30'))).toBe('2026-12-01T17:30:00-05:00');
  });

  it('splits long ranges into <= 7 day windows', () => {
    expect(chunkDateRange('2026-10-01', '2026-10-17')).toEqual([
      { from: '2026-10-01', to: '2026-10-07' },
      { from: '2026-10-08', to: '2026-10-14' },
      { from: '2026-10-15', to: '2026-10-17' },
    ]);
    expect(chunkDateRange('2026-10-01', '2026-10-01')).toEqual([{ from: '2026-10-01', to: '2026-10-01' }]);
  });

  it('computes 8 hours for an 8h shift given in unix seconds', () => {
    expect(hoursBetween(START, START + EIGHT_HOURS)).toBe(8);
  });
});

describe('tanda_get_daily_stats actual_hours', () => {
  const shift = { id: 1, user_id: 7, date: '2026-10-20', start: START, finish: START + EIGHT_HOURS, breaks: [] };
  const schedule = { id: 2, user_id: 7, start: START, finish: START + EIGHT_HOURS };

  it('reports 8.0 actual hours for a known 8h shift (not 0.008)', () => {
    const [day] = computeDailyStats([schedule], [shift], '2026-10-20', '2026-10-20');
    expect(day.date).toBe('2026-10-20');
    expect(day.actual_hours).toBe(8);
    expect(day.scheduled_hours).toBe(8);
    expect(day.headcount).toBe(1);
  });

  it('subtracts breaks (minutes)', () => {
    const [day] = computeDailyStats([], [{ ...shift, breaks: [{ length: 30 }] }], '2026-10-20', '2026-10-20');
    expect(day.actual_hours).toBe(7.5);
  });

  it('ignores open shifts for actual hours', () => {
    const [day] = computeDailyStats([], [{ ...shift, finish: null }], '2026-10-20', '2026-10-20');
    expect(day.actual_hours).toBe(0);
    expect(day.worked_shifts).toBe(1);
  });

  it('end-to-end through the tool returns 8h', async () => {
    const { client } = fakeTanda([
      ['/schedules', () => [schedule]],
      ['/shifts', () => [shift]],
    ]);
    const res = await executeTool(client, 'tanda_reference', { action: 'daily_stats', from: '2026-10-20', to: '2026-10-20' });
    const content = res.content as { rows: Array<{ actual_hours: number }>; summary: { actual_hours: number } };
    expect(res.isError).toBeFalsy();
    expect(content.rows[0].actual_hours).toBe(8);
    expect(content.summary.actual_hours).toBe(8);
  });
});

describe('7-day chunking', () => {
  it('never asks Tanda for more than 7 days at once', async () => {
    const { client, requests } = fakeTanda([['/schedules', () => [{ id: 1, start: START, finish: START + 3600 }]]]);
    const res = await executeTool(client, 'tanda_schedules', { action: 'list', from: '2026-10-01', to: '2026-10-20' });
    expect(res.isError).toBeFalsy();
    expect(requests).toHaveLength(3);
    for (const r of requests) {
      const days = (Date.parse(r.params.to) - Date.parse(r.params.from)) / 86400000 + 1;
      expect(days).toBeLessThanOrEqual(7);
    }
    // Same schedule returned by every chunk is de-duplicated
    expect((res.content as { rows: unknown[] }).rows).toHaveLength(1);
  });
});

describe('tanda_get_staff_by_department', () => {
  it('returns only users in department.staff', async () => {
    const { client } = fakeTanda([
      ['/departments/10', () => ({ id: 10, name: 'Lincoln HS', staff: [1, 3] })],
      ['/users', () => [
        { id: 1, name: 'A', department_ids: [10] },
        { id: 2, name: 'B', department_ids: [11] },
        { id: 3, name: 'C', department_ids: [10, 11] },
      ]],
    ]);
    const res = await executeTool(client, 'tanda_users', { action: 'by_department', department_id: 10 });
    const rows = (res.content as { rows: Array<{ id: number }> }).rows;
    expect(rows.map((r) => r.id)).toEqual([1, 3]);
  });
});

describe('tanda_get_timesheets', () => {
  const sheet = (id: number, shifts: unknown[], cost = 0) => ({
    id, user_id: id, start: '2026-10-19', finish: '2026-10-25', status: 'pending', cost, shifts,
  });
  const routes = (): Array<[RegExp, () => unknown]> => [[
    /^\/timesheets\/on\//,
    () => [
      sheet(1, [{ id: 11, user_id: 1, date: '2026-10-20', start: START, finish: START + EIGHT_HOURS, cost: 120 }]),
      sheet(2, [], 0),
    ],
  ]];

  it('de-duplicates timesheets returned for every day of the pay period and drops empty ones', async () => {
    const { client, requests } = fakeTanda(routes());
    const res = await executeTool(client, 'tanda_timesheets', { action: 'timesheets', from: '2026-10-19', to: '2026-10-25' });
    const content = res.content as { rows: Array<{ id: number; hours: number }>; summary: { total_cost: number } };
    expect(content.rows.map((r) => r.id)).toEqual([1]);
    expect(content.rows[0].hours).toBe(8);
    expect(content.summary.total_cost).toBe(120);
    // One call per pay period, not one per day
    expect(requests).toHaveLength(1);
    expect(requests[0].params.show_costs).toBe('true');
  });

  it('keeps empty timesheets when include_empty=true', async () => {
    const { client } = fakeTanda(routes());
    const res = await executeTool(client, 'tanda_timesheets', {
      action: 'timesheets', from: '2026-10-19', to: '2026-10-25', include_empty: true,
    });
    expect((res.content as { rows: Array<{ id: number }> }).rows.map((r) => r.id)).toEqual([1, 2]);
  });
});

describe('privacy', () => {
  const user = {
    id: 1, name: 'Pat', employee_id: 'E1', active: true, date_of_birth: '1990-01-01', passcode: '1234',
    phone: '555', email: 'pat@example.com', legal_first_name: 'Patricia', department_ids: [10],
  };

  it('whitelists user fields by default', () => {
    const out = pickUserFields(user);
    expect(out).toEqual({ id: 1, name: 'Pat', employee_id: 'E1', active: true, department_ids: [10] });
  });

  it('returns sensitive fields only when listed in fields', () => {
    expect(pickUserFields(user, ['email'])).toHaveProperty('email', 'pat@example.com');
  });

  it('strips nested sensitive keys from any payload', () => {
    const out = redactSensitive({ rows: [{ user: user }] });
    expect(JSON.stringify(out)).not.toMatch(/date_of_birth|passcode|legal_first_name|pat@example/);
  });

  it('user tools never return date_of_birth or passcode by default', async () => {
    const { client } = fakeTanda([
      ['/users', () => [user]],
      ['/users/me', () => user],
      ['/users/1', () => user],
    ]);
    for (const action of ['list', 'current', 'get']) {
      const res = await executeTool(client, 'tanda_users', { action, user_id: 1 });
      const text = JSON.stringify(res.content);
      expect(text).not.toContain('date_of_birth');
      expect(text).not.toContain('passcode');
      expect(text).not.toContain('pat@example.com');
    }
  });
});

describe('response guard', () => {
  it('caps rows at 50 and flags truncation with paging info', () => {
    const rows = Array.from({ length: 120 }, (_, i) => ({ id: i }));
    const res = guardResponse({ total: 120 }, rows);
    expect(res.rows).toHaveLength(50);
    expect(res.truncated).toBe(true);
    expect(res.page.next_offset).toBe(50);
    expect(res.how_to_page).toContain('offset=50');
    const next = guardResponse({ total: 120 }, rows, { offset: 50 });
    expect((next.rows[0] as { id: number }).id).toBe(50);
  });

  it('hard caps at 25 KB', () => {
    const rows = Array.from({ length: 50 }, (_, i) => ({ id: i, blob: 'x'.repeat(2000) }));
    const res = guardResponse({}, rows);
    expect(byteSize(res)).toBeLessThanOrEqual(MAX_BYTES);
    expect(res.truncated).toBe(true);
    expect(res.page.next_offset).toBe(res.rows.length);
  });

  it('is not truncated when everything fits', () => {
    const res = guardResponse({}, [{ id: 1 }]);
    expect(res.truncated).toBeUndefined();
  });
});
