/** WFM-106 (#65): tanda_qualifications_watch, certifications expired or expiring soon. "Today" is Mon 2026-11-23. */
import { executeTool } from '../src/mcp/tools';
import { fakeTanda, nySeconds, RouteHandler } from './helpers/fakeTanda';

type Content = {
  summary: Record<string, unknown>;
  rows: Array<Record<string, unknown>>;
  warnings?: Array<Record<string, unknown>>;
  error?: string;
};

const run = async (client: Parameters<typeof executeTool>[0], args: Record<string, unknown> = {}) =>
  (await executeTool(client, 'tanda_qualifications_watch', args)) as { content: Content; isError?: boolean };

let nowSpy: jest.SpyInstance;
beforeEach(() => {
  nowSpy = jest.spyOn(Date, 'now').mockReturnValue(nySeconds('2026-11-23', '12:00') * 1000);
});
afterEach(() => nowSpy.mockRestore());

const q = (id: number, qualificationId: number, expires: string | null, extra: Record<string, unknown> = {}) => ({
  id, qualification_id: qualificationId, enabled: true, expires, in_training: false,
  license_number: 'LIC-SECRET', image: 'https://files.test/cert.pdf', training_provider_name: 'Acme', ...extra,
});
const emp = (id: number, name: string, quals: unknown[] | undefined, extra: Record<string, unknown> = {}) => ({
  id, name, user_levels: ['employee'], employment_start_date: '2024-01-01', active: true,
  email: `u${id}@example.com`, phone: '+15550000000', department_ids: [11], qualifications: quals, ...extra,
});
const users = [
  emp(1, 'Ana', [q(1, 501, '2026-12-01'), q(2, 502, '2027-06-01')]),
  emp(2, 'Ben', [q(3, 501, '2026-11-20'), q(4, 503, null)]),
  emp(3, 'Cy', [q(5, 502, '2026-12-23T00:00:00Z', { in_training: true })], { department_ids: [21] }),
  emp(4, 'Dee', [q(6, 501, '2026-11-25', { enabled: false })]),
  emp(5, 'Test Cleaner', [q(7, 501, '2026-11-24')]),
];
const quals = [{ id: 501, name: 'Floor Machine', maximum_hours: null }, { id: 502, name: 'Bloodborne Pathogens' }, { id: 503, name: 'Forklift' }];

function tanda(over: { users?: RouteHandler; qualifications?: RouteHandler } = {}) {
  return fakeTanda([
    ['/locations', () => [{ id: 1, name: 'Site A' }, { id: 2, name: 'Site B' }]],
    ['/departments', () => [{ id: 11, name: 'Cleaning', location_id: 1 }, { id: 21, name: 'Cleaning', location_id: 2 }]],
    ['/users', over.users || (() => users)],
    ['/qualifications', over.qualifications || (() => quals)],
  ]);
}

describe('tanda_qualifications_watch', () => {
  it('lists expired and expiring certifications soonest first, with names and days left', async () => {
    const { client, requests } = tanda();
    const res = await run(client);
    expect(res.isError).toBeUndefined();
    expect(Object.keys(res.content)[0]).toBe('summary');
    expect(res.content.rows).toEqual([
      { user_id: 2, user_name: 'Ben', qualification_id: 501, qualification: 'Floor Machine', expires: '2026-11-20', days_left: -3, status: 'expired', in_training: false },
      { user_id: 1, user_name: 'Ana', qualification_id: 501, qualification: 'Floor Machine', expires: '2026-12-01', days_left: 8, status: 'expiring', in_training: false },
      { user_id: 3, user_name: 'Cy', qualification_id: 502, qualification: 'Bloodborne Pathogens', expires: '2026-12-23', days_left: 30, status: 'expiring', in_training: true },
    ]);
    expect(res.content.summary).toMatchObject({
      as_of: '2026-11-23', until: '2026-12-23', days: 30, staff_checked: 4, expired: 1, expiring: 2, no_expiry_date: 1,
      by_qualification: [
        { qualification_id: 501, qualification: 'Floor Machine', expired: 1, expiring: 1 },
        { qualification_id: 502, qualification: 'Bloodborne Pathogens', expired: 0, expiring: 1 },
      ],
      left_out: { test_users: 1 },
    });
    expect(res.content.warnings).toBeUndefined();
    // Asks Tanda for per-user qualifications, and only ever reads
    expect(requests.find((r) => r.path === '/users')?.params.show_qualifications).toBe('true');
    expect(requests.every((r) => r.method === 'GET')).toBe(true);
  });

  it('never returns licence numbers, attachments, contact details or the raw qualification records', async () => {
    const { client } = tanda();
    const text = JSON.stringify((await run(client, { days: 365 })).content);
    expect(text).not.toMatch(/LIC-SECRET|cert\.pdf|Acme|example\.com|\+1555|license_number|training_provider/);
  });

  it('honours days, include_expired and the filters', async () => {
    const { client } = tanda();
    expect((await run(client, { days: 7 })).content.rows.map((r) => r.user_id)).toEqual([2]);
    expect((await run(client, { include_expired: false })).content.rows.map((r) => r.user_id)).toEqual([1, 3]);
    expect((await run(client, { days: 365, qualification_ids: [502] })).content.rows.map((r) => r.user_id)).toEqual([3, 1]);
    expect((await run(client, { user_ids: [2] })).content.rows.map((r) => r.user_id)).toEqual([2]);
    expect((await run(client, { location_ids: [2] })).content.rows.map((r) => r.user_id)).toEqual([3]);
  });

  it('without the qualifications scope, still lists expiries by id with one warning', async () => {
    const { client } = tanda({ qualifications: () => ({ __status: 403, body: { error: 'insufficient scope' } }) });
    const res = await run(client);
    expect(res.isError).toBeUndefined();
    expect(res.content.rows).toHaveLength(3);
    expect(res.content.rows[0]).toMatchObject({ qualification_id: 501, qualification: null, expires: '2026-11-20' });
    expect(res.content.warnings).toEqual([{ check: 'qualification_names', reason: 'missing scope: qualifications' }]);
  });

  it('when Tanda has no qualifications endpoint (404), still lists expiries by id with one warning', async () => {
    const { client } = tanda({ qualifications: () => ({ __status: 404, body: {} }) });
    const res = await run(client);
    expect(res.isError).toBeUndefined();
    expect(res.content.rows).toHaveLength(3);
    expect(res.content.warnings).toEqual([{ check: 'qualification_names', reason: 'not available from Tanda (404)' }]);
  });

  it('without the user scope, returns an empty list with a warning instead of failing', async () => {
    const { client } = tanda({ users: () => ({ __status: 403, body: { error: 'insufficient scope' } }) });
    const res = await run(client);
    expect(res.isError).toBeUndefined();
    expect(res.content.rows).toEqual([]);
    expect(res.content.summary).toMatchObject({ staff_checked: 0, expired: 0, expiring: 0 });
    expect(res.content.warnings).toEqual([{ check: 'holders', reason: 'missing scope: user' }]);
  });

  it('says when Tanda held back qualifications for some staff', async () => {
    const held = [emp(1, 'Ana', undefined, { _qualifications_dev_warning: 'too many qualifications' })];
    const { client } = tanda({ users: () => held });
    const res = await run(client);
    expect(res.content.rows).toEqual([]);
    expect(res.content.warnings).toEqual([{ check: 'holders', reason: 'Tanda did not return qualifications for 1 staff' }]);
  });

  it('rejects a bad days value and still fails on Tanda errors that are not a missing scope', async () => {
    const { client } = tanda();
    const bad = await run(client, { days: 400 });
    expect(bad.isError).toBe(true);
    expect(bad.content.error).toMatch(/days must be a whole number from 0 to 365/);

    const { client: broken } = tanda({ users: () => ({ __status: 500, body: {} }) });
    expect((await run(broken)).isError).toBe(true);
  });
});
