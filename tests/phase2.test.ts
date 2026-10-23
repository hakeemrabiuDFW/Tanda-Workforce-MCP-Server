import { executeTool, tandaTools, TOOLS, aliasUsage } from '../src/mcp/tools';
import { byteSize, MAX_BYTES } from '../src/mcp/guard';
import { buildExportParams } from '../src/tanda/client';
import { fixtureClient, FIXTURE_FROM, FIXTURE_TO } from './helpers/fixture';
import { fakeTanda, nySeconds } from './helpers/fakeTanda';

type Content = { summary: Record<string, unknown>; rows: Array<Record<string, unknown>>; truncated?: boolean; suggestions?: unknown[] };
const range = { from: FIXTURE_FROM, to: FIXTURE_TO };

const EXPECTED = [
  'tanda_org', 'tanda_people', 'tanda_schedules', 'tanda_timesheets', 'tanda_live', 'tanda_time_off',
  'tanda_labor_summary', 'tanda_coverage', 'tanda_validate_schedule', 'tanda_exceptions',
  'tanda_export_preview', 'tanda_change_history',
];

/** One representative call per tool against the 84-site / 70-user fixture. */
export const SMOKE_CALLS: Array<[string, Record<string, unknown>]> = [
  ['tanda_org', {}],
  ['tanda_people', {}],
  ['tanda_schedules', { ...range, show_costs: true }],
  ['tanda_timesheets', { ...range, view: 'shifts' }],
  ['tanda_live', {}],
  ['tanda_time_off', range],
  ['tanda_labor_summary', range],
  ['tanda_coverage', range],
  ['tanda_validate_schedule', { shifts: [{ user_id: 5010, location_id: 1005, start: '2026-10-13 09:00', finish: '2026-10-13 23:00' }] }],
  ['tanda_exceptions', range],
  ['tanda_export_preview', { date: '2026-10-14' }],
  ['tanda_change_history', { type: 'shift', id: 1 }],
];

beforeAll(() => {
  process.env.TANDA_EXPORT_FORMAT = 'adp_csv';
});

describe('tool surface', () => {
  it('exposes exactly the 12 v4 tools', () => {
    expect(tandaTools.map((t) => t.name)).toEqual(EXPECTED);
  });

  it('has a one-sentence description for every tool', () => {
    for (const t of tandaTools) {
      expect(t.description.length).toBeGreaterThan(40);
      expect(t.description.length).toBeLessThan(330);
      expect(t.description.trim().split(/(?<=[a-z0-9)])\.\s+[A-Z]/).length).toBeLessThanOrEqual(2);
    }
  });

  it('removes tanda_get_shift_limits', async () => {
    expect(tandaTools.find((t) => t.name === 'tanda_get_shift_limits')).toBeUndefined();
    const { client } = fakeTanda([]);
    const res = await executeTool(client, 'tanda_get_shift_limits', {});
    expect(res.isError).toBe(true);
    expect(JSON.stringify(res.content)).toContain('removed');
  });
});

describe('done-when: 84 sites / 70 users / 7 days', () => {
  it.each(SMOKE_CALLS)('%s returns < 25 KB with no date_of_birth/passcode', async (name, args) => {
    const { client } = fixtureClient();
    const res = await executeTool(client, name, args);
    expect(res.isError).toBeFalsy();
    const text = JSON.stringify(res.content);
    expect(byteSize(res.content)).toBeLessThanOrEqual(MAX_BYTES);
    expect(text).not.toMatch(/date_of_birth|passcode|legal_first_name|@example\.com|\+1555/);
  });

  it('every tool is covered by the smoke calls', () => {
    expect(SMOKE_CALLS.map(([n]) => n).sort()).toEqual([...EXPECTED].sort());
  });
});

describe('tanda_org', () => {
  it('nests departments in locations, flags bookkeeping sites and caches for 24h', async () => {
    const { client, requests } = fixtureClient();
    const res = (await executeTool(client, 'tanda_org', { limit: 50 })).content as Content;
    const otp = res.rows.find((r) => r.id === 281737)!;
    expect(otp.bookkeeping).toBe(true);
    expect(res.rows.find((r) => r.id === 1005)!.bookkeeping).toBeUndefined();
    expect((otp.departments as Array<Record<string, unknown>>).map((d) => d.name)).toEqual(['Cleaning', 'Supervisors']);
    expect(res.summary.locations).toBe(84);
    expect(res.summary.work_sites).toBe(81);

    const before = requests.length;
    await executeTool(client, 'tanda_org', {});
    expect(requests.length).toBe(before); // served from the 24h cache
  });
});

describe('ETag caching', () => {
  it('sends If-None-Match and serves cached data on 304', async () => {
    let calls = 0;
    const { client, requests } = fakeTanda([
      ['/shifts/1/versions', (r) => {
        calls++;
        if (r.headers['If-None-Match'] === '"v1"') return { __status: 304 };
        return { __status: 200, __headers: { etag: '"v1"' }, body: [{ version_id: 1, event: 'create' }] };
      }],
    ]);
    const first = await executeTool(client, 'tanda_change_history', { type: 'shift', id: 1 });
    const second = await executeTool(client, 'tanda_change_history', { type: 'shift', id: 1 });
    expect(calls).toBe(2);
    expect(requests[1].headers['If-None-Match']).toBe('"v1"');
    expect((second.content as Content).rows).toEqual((first.content as Content).rows);
  });
});

describe('tanda_export_preview', () => {
  it('hard-codes skip_status_update=true and approved_only=true', () => {
    expect(buildExportParams('adp_csv')).toEqual({ export_format: 'adp_csv', approved_only: 'true', skip_status_update: 'true' });
  });

  it('sends skip_status_update=true even if the caller tries to override it', async () => {
    const { client, requests } = fixtureClient();
    await executeTool(client, 'tanda_export_preview', { date: '2026-10-14', skip_status_update: false, approved_only: false });
    const call = requests.find((r) => r.params.export_format)!;
    expect(call.params.skip_status_update).toBe('true');
    expect(call.params.approved_only).toBe('true');
    expect(call.params.export_format).toBe('adp_csv');
  });

  it('summarises without returning the raw file', async () => {
    const { client, org } = fixtureClient();
    const res = (await executeTool(client, 'tanda_export_preview', { date: '2026-10-14' })).content as Content;
    expect(Buffer.byteLength(org.exportCsv)).toBeGreaterThan(MAX_BYTES);
    expect(res.summary.row_count).toBe(1200);
    expect(res.summary.pay_code_column).toBe('Pay Code');
    expect(res.summary.rows_missing_pay_code).toBe(48);
    expect((res.summary.totals as Record<string, number>).Hours).toBe(9000);
    expect(JSON.stringify(res)).not.toContain('Worker 1"');
  });

  it('explains when TANDA_EXPORT_FORMAT is missing', async () => {
    const saved = process.env.TANDA_EXPORT_FORMAT;
    delete process.env.TANDA_EXPORT_FORMAT;
    const { client } = fixtureClient();
    const res = await executeTool(client, 'tanda_export_preview', {});
    process.env.TANDA_EXPORT_FORMAT = saved;
    expect(res.isError).toBe(true);
    expect(JSON.stringify(res.content)).toContain('TANDA_EXPORT_FORMAT');
  });
});

describe('tanda_coverage', () => {
  const sup = (id: number, user: number, dept: number, date: string, from: string, hours: number) => {
    const start = nySeconds(date, from);
    return { id, user_id: user, department_id: dept, start, finish: start + hours * 3600 };
  };
  const routes = (schedules: unknown[]) => fakeTanda([
    ['/locations', () => [{ id: 1, name: 'Alpha HS' }, { id: 2, name: 'Beta MS' }]],
    ['/departments', () => [
      { id: 11, name: 'Cleaning', location_id: 1, staff: [] },
      { id: 12, name: 'Supervisor', location_id: 1, staff: [100, 101] },
      { id: 21, name: 'Day Porter', location_id: 2, staff: [] },
      { id: 22, name: 'supervisors', location_id: 2, staff: [] },
      { id: 23, name: 'Supervisor Training', location_id: 2, staff: [] },
    ]],
    ['/users', () => [{ id: 100, name: 'Sam' }, { id: 101, name: 'Ria' }, { id: 1, name: 'A' }, { id: 2, name: 'B' }]],
    ['/schedules', () => schedules],
  ]);
  const d = '2026-10-20';

  it('finds gaps by LOCATION and suggests a redundant supervisor move', async () => {
    const { client } = routes([
      sup(1, 1, 11, d, '17:00', 5), // Alpha staff 17-22
      sup(2, 2, 21, d, '17:00', 5), // Beta staff 17-22
      sup(3, 100, 12, d, '17:00', 5), // Sam at Alpha
      sup(4, 101, 12, d, '17:00', 5), // Ria also at Alpha (redundant)
      sup(5, 2, 23, d, '17:00', 5), // "Supervisor Training" is NOT a supervisor dept
    ]);
    const res = (await executeTool(client, 'tanda_coverage', { from: d, to: d })).content as Content;
    expect(res.rows).toHaveLength(1);
    expect(res.rows[0]).toMatchObject({ location_id: 2, location_name: 'Beta MS', hours: 5 });
    expect(res.summary.overlaps).toBe(1);
    const [first] = res.suggestions as Array<Record<string, unknown>>;
    expect(first).toMatchObject({ action: 'reassign', user_id: 101, to_location_id: 2 });
  });

  it('reports overlaps, including double-booked supervisors', async () => {
    const { client } = routes([
      sup(1, 100, 12, d, '17:00', 5),
      sup(2, 101, 12, d, '18:00', 2),
      sup(3, 100, 22, d, '20:00', 3), // Sam also at Beta 20-23
    ]);
    const res = (await executeTool(client, 'tanda_coverage', { mode: 'overlaps', from: d, to: d })).content as Content;
    const types = res.rows.map((r) => r.type).sort();
    expect(types).toEqual(['double_booked', 'same_location']);
  });

  it('respects a time window and caps suggestions at 10', async () => {
    const many = Array.from({ length: 30 }, (_, i) => sup(i + 1, 1, 11, `2026-10-${String(1 + (i % 28)).padStart(2, '0')}`, '17:00', 5));
    const { client } = routes(many);
    const res = (await executeTool(client, 'tanda_coverage', { from: '2026-10-01', to: '2026-10-28', window_start: '18:00', window_end: '20:00' })).content as Content;
    expect(res.rows.every((r) => r.hours === 2)).toBe(true);
    expect((res.suggestions as unknown[]).length).toBeLessThanOrEqual(10);
  });
});

describe('tanda_live', () => {
  it('enriches active shifts and flags those open > 12h', async () => {
    const { client } = fixtureClient();
    const res = (await executeTool(client, 'tanda_live', {})).content as Content;
    expect(res.summary.on_clock).toBe(20);
    expect(res.summary.open_over_12h).toBe(3);
    expect(res.rows[0]).toMatchObject({ open_over_limit: true });
    expect(res.rows[0].location_name).toMatch(/School/);
    expect(res.rows[0].user_name).toMatch(/Worker/);
  });
});

describe('tanda_exceptions', () => {
  it('runs every check', async () => {
    const now = Math.floor(Date.now() / 1000);
    const day = '2026-10-13';
    const s = nySeconds(day, '08:00');
    const { client } = fakeTanda([
      ['/departments', () => [{ id: 11, name: 'Cleaning', location_id: 1 }]],
      ['/locations', () => [{ id: 1, name: 'Alpha' }]],
      ['/users', () => [{ id: 1, name: 'A', active: true, award_template_id: null }, { id: 2, name: 'B', active: true, award_template_id: 5 }]],
      ['/shifts/active', () => [{ id: 9, user_id: 2, department_id: 11, start: now - 13 * 3600 }]],
      ['/shifts', () => [
        { id: 1, user_id: 1, department_id: 11, date: day, start: s, finish: s },
        ...Array.from({ length: 5 }, (_, i) => ({ id: 10 + i, user_id: 2, department_id: 11, date: `2026-10-1${2 + i}`, start: s + i * 86400, finish: s + i * 86400 + 9 * 3600 })),
      ]],
      ['/leave', () => [{ id: 3, user_id: 1, status: 'pending', start: '2026-10-13', finish: '2026-10-13' }]],
      [/^\/timesheets\/on\//, () => [{ id: 4, user_id: 2, status: 'pending', start: '2026-10-12', finish: '2026-10-18', shifts: [{ id: 10, date: day, department_id: 11, start: s, finish: s + 3600, cost: 50 }] }]],
    ]);
    const res = (await executeTool(client, 'tanda_exceptions', { from: '2026-10-12', to: '2026-10-18' })).content as Content;
    expect(res.summary.by_type).toEqual({
      open_shift_over_12h: 1,
      zero_length_shift: 1,
      weekly_hours_over_40: 1,
      stale_pending_leave: 1,
      unapproved_timesheet_cost: 1,
      missing_award_template: 1,
    });
    expect(res.summary.unapproved_cost_total).toBe(50);
  });
});

describe('tanda_validate_schedule', () => {
  it('flags overlaps, leave, long shifts and zero-length shifts without writing', async () => {
    const day = '2026-10-13';
    const { client, requests } = fakeTanda([
      ['/users', () => [{ id: 1, name: 'A' }]],
      ['/schedules', () => [{ id: 50, user_id: 1, start: nySeconds(day, '08:00'), finish: nySeconds(day, '12:00') }]],
      ['/leave', () => [{ id: 3, user_id: 1, status: 'approved', start: '2026-10-15', finish: '2026-10-15' }]],
      ['/unavailability', () => []],
    ]);
    const res = (await executeTool(client, 'tanda_validate_schedule', {
      shifts: [
        { user_id: 1, start: `${day} 10:00`, finish: `${day} 14:00` },
        { user_id: 1, start: '2026-10-15 09:00', finish: '2026-10-15 10:00' },
        { user_id: 1, start: '2026-10-16 06:00', finish: '2026-10-16 20:00' },
        { user_id: 1, start: '2026-10-17 06:00', finish: '2026-10-17 06:00' },
      ],
    })).content as Content;
    const issues = res.rows.map((r) => [...(r.errors as string[]), ...(r.warnings as string[])].join('; '));
    expect(issues[0]).toMatch(/overlaps existing schedule 50/);
    expect(issues[1]).toMatch(/approved leave/);
    expect(issues[2]).toMatch(/exceeds 12h/);
    expect(issues[3]).toMatch(/zero-length/);
    expect(requests.every((r) => r.method === 'GET')).toBe(true);
  });

  it('still validates when the connection lacks the unavailability scope', async () => {
    const day = '2026-10-13';
    const { client } = fakeTanda([
      ['/users', () => [{ id: 1, name: 'A' }]],
      ['/schedules', () => [{ id: 50, user_id: 1, start: nySeconds(day, '08:00'), finish: nySeconds(day, '12:00') }]],
      ['/leave', () => []],
      ['/unavailability', () => ({ __status: 403, body: { error: 'insufficient scope' } })],
    ]);
    const res = (await executeTool(client, 'tanda_validate_schedule', {
      shifts: [{ user_id: 1, start: `${day} 10:00`, finish: `${day} 14:00` }],
    })).content as Content;
    expect([...(res.rows[0].errors as string[]), ...(res.rows[0].warnings as string[])].join('; ')).toMatch(/overlaps existing schedule 50/);
    expect(res.summary.note).toMatch(/Unavailability was not checked/);
  });
});

describe('deprecated aliases', () => {
  it('maps v3 and interim names to v4 tools and logs usage', async () => {
    const { client } = fixtureClient();
    const res = await executeTool(client, 'tanda_get_locations', {});
    expect((res.content as Record<string, unknown>).deprecation).toMatch(/tanda_org/);
    await executeTool(client, 'tanda_reference', { action: 'locations' });
    const usage = aliasUsage();
    expect(usage.tanda_get_locations).toBeGreaterThanOrEqual(1);
    expect(usage['tanda_reference:locations']).toBeGreaterThanOrEqual(1);
  });

  it('rejects interim write actions', async () => {
    const { client } = fakeTanda([]);
    const res = await executeTool(client, 'tanda_leave', { action: 'approve', leave_id: 1 });
    expect(res.isError).toBe(true);
    expect(JSON.stringify(res.content)).toContain('read-only');
  });
});

describe('errors', () => {
  it('returns actionable messages without upstream stacks', async () => {
    const { client } = fakeTanda([['/shifts/5/versions', () => ({ __status: 403, body: { error: 'forbidden', stack: 'at secret.rb:1' } })]]);
    const res = await executeTool(client, 'tanda_change_history', { type: 'shift', id: 5 });
    expect(res.isError).toBe(true);
    const text = JSON.stringify(res.content);
    expect(text).toContain('timesheet');
    expect(text).not.toContain('secret.rb');
  });

  it('validates arguments', async () => {
    const { client } = fakeTanda([]);
    const res = await executeTool(client, 'tanda_schedules', { from: '2026-01-01', to: '2026-06-01' });
    expect(JSON.stringify(res.content)).toContain('maximum is 62');
  });

  it('all tool modules export a run function', () => {
    expect(TOOLS.every((t) => typeof t.run === 'function')).toBe(true);
  });
});
