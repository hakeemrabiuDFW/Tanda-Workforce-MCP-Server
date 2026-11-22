/** WFM-105 (#64): tanda_broadcast_draft, a bilingual SMS draft for a crew. "Today" is Wed 2026-11-18. */
import { executeTool } from '../src/mcp/tools';
import { smsLength } from '../src/mcp/sms';
import { fakeTanda, nySeconds, RouteHandler } from './helpers/fakeTanda';

type Content = {
  summary: Record<string, unknown> & { draft: Record<'es' | 'en' | 'combined', Record<string, unknown>> };
  rows: Array<Record<string, unknown>>;
  warnings?: Array<Record<string, unknown>>;
  error?: string;
};

const run = async (client: Parameters<typeof executeTool>[0], args: Record<string, unknown>) =>
  (await executeTool(client, 'tanda_broadcast_draft', args)) as { content: Content; isError?: boolean };

const DAY = '2026-11-18';
const NEXT = '2026-11-19';
let nowSpy: jest.SpyInstance;
beforeEach(() => {
  nowSpy = jest.spyOn(Date, 'now').mockReturnValue(nySeconds(DAY, '12:00') * 1000);
});
afterEach(() => nowSpy.mockRestore());

const emp = (id: number, name: string, extra: Record<string, unknown> = {}) => ({
  id, name, user_levels: ['employee'], employment_start_date: '2024-01-01', active: true, ...extra,
});
const users = [
  emp(1, 'Ana Site A', { phone: '+15550000001' }),
  emp(2, 'Ben Site A'),
  emp(3, 'Cy Site B', { normalised_phone: '+15550000003' }),
  emp(4, 'Test Cleaner', { phone: '+15550000004' }),
];
const sched = (id: number, userId: number | null, dept: number, date: string, start: string, finish: string) => ({
  id, user_id: userId, department_id: dept, date, start: nySeconds(date, start), finish: nySeconds(date, finish),
});
const schedules = [
  sched(100, 1, 11, NEXT, '17:00', '21:00'),
  sched(101, 2, 11, NEXT, '09:00', '13:00'),
  sched(102, 3, 21, NEXT, '17:00', '21:00'),
  sched(103, 4, 11, NEXT, '17:00', '21:00'), // test user: left out
  sched(104, 99, 11, NEXT, '17:00', '21:00'), // not an active user: left out
  sched(105, null, 11, NEXT, '17:00', '21:00'), // vacant shift
  sched(106, 2, 11, DAY, '09:00', '13:00'), // another day
];

function tanda(over: { users?: RouteHandler; schedules?: RouteHandler } = {}) {
  return fakeTanda([
    ['/locations', () => [{ id: 1, name: 'Site A' }, { id: 2, name: 'Site B' }]],
    ['/departments', () => [{ id: 11, name: 'Cleaning', location_id: 1 }, { id: 21, name: 'Cleaning', location_id: 2 }]],
    ['/users', over.users || (() => users)],
    ['/schedules', over.schedules || (() => schedules)],
  ]);
}

describe('smsLength', () => {
  it('counts GSM-7 at 160 a segment, extension characters as two, and splits at 153', () => {
    expect(smsLength('Hello')).toEqual({ encoding: 'GSM-7', units: 5, segments: 1 });
    expect(smsLength('€')).toMatchObject({ encoding: 'GSM-7', units: 2 });
    expect(smsLength('a'.repeat(160)).segments).toBe(1);
    expect(smsLength('a'.repeat(161)).segments).toBe(2);
  });

  it('switches to UCS-2 for Spanish accents outside GSM-7 and names them', () => {
    const r = smsLength('¿Puede cubrir el turno? Sí, gracias. ñ é');
    expect(r).toMatchObject({ encoding: 'UCS-2', segments: 1, non_gsm_chars: ['í'] });
    expect(smsLength('í'.repeat(71)).segments).toBe(2);
  });
});

describe('tanda_broadcast_draft', () => {
  it('drafts a template in both languages for the crew rostered at the site that day', async () => {
    const { client, requests } = tanda();
    const res = await run(client, { template: 'shift_reminder', location_id: 1, date: NEXT, time: '17:00' });
    expect(res.isError).toBeUndefined();
    expect(Object.keys(res.content)[0]).toBe('summary');
    const s = res.content.summary;
    expect(s.draft.es.text).toBe('Recordatorio: tiene turno en Site A el jueves, 19 de noviembre a las 17:00. Responda si no puede ir.');
    expect(s.draft.en.text).toBe("Reminder: you have a shift at Site A on Thursday, November 19 at 5:00 PM. Reply if you can't make it.");
    expect(s.draft.combined.text).toBe(`${s.draft.es.text}\n\n${s.draft.en.text}`);
    expect(s.draft.combined).toMatchObject({ encoding: 'GSM-7', segments: 2 });
    expect(s).toMatchObject({
      date: NEXT, location_id: 1, location_name: 'Site A', audience: 'rostered', template: 'shift_reminder',
      recipients: 2, with_phone: 1, without_phone: 1, estimated_segments: 2,
      left_out: { not_active: 1, test_or_no_start_date: 1 },
    });
    expect(s.note).toMatch(/nothing was sent/i);

    expect(res.content.rows.map((r) => r.user_id)).toEqual([1, 2]);
    expect(res.content.rows[0]).toMatchObject({ user_name: 'Ana Site A', has_phone: true });
    expect(res.content.rows[1]).toMatchObject({ has_phone: false, shifts: [{ location_name: 'Site A', start_iso: '2026-11-19T09:00:00-05:00' }] });

    // Read-only, and no phone number leaves the server
    expect(requests.every((r) => r.method === 'GET')).toBe(true);
    expect(JSON.stringify(res.content)).not.toMatch(/\+1555|"phone"|normalised_phone/);
  });

  it('takes custom Spanish and English text with placeholders, and picks a crew by department', async () => {
    const { client } = tanda();
    const res = await run(client, {
      message_es: 'Hoy {date} no hay químicos en el almacén.',
      message_en: 'No chemicals in the storeroom on {date}.',
      department_ids: [21],
      date: NEXT,
    });
    expect(res.isError).toBeUndefined();
    expect(res.content.summary.draft.es).toMatchObject({ text: 'Hoy jueves, 19 de noviembre no hay químicos en el almacén.', encoding: 'UCS-2', non_gsm_chars: ['í'] });
    expect(res.content.summary).toMatchObject({ recipients: 1, with_phone: 1, department_ids: [21] });
    expect(res.content.rows.map((r) => r.user_id)).toEqual([3]);
  });

  it('sends to exactly the user_ids given, without reading the roster', async () => {
    const { client, requests } = tanda();
    const res = await run(client, { template: 'cover_needed', location_id: 2, user_ids: [2, 3], date: NEXT });
    expect(res.content.summary).toMatchObject({ audience: 'user_ids', recipients: 2 });
    expect(res.content.rows.map((r) => r.user_id)).toEqual([2, 3]);
    expect(res.content.rows[0].shifts).toBeUndefined();
    expect(requests.some((r) => r.path === '/schedules')).toBe(false);
  });

  it('says when nobody is rostered', async () => {
    const { client } = tanda({ schedules: () => [] });
    const res = await run(client, { template: 'site_closed', location_id: 2, date: NEXT });
    expect(res.content.rows).toEqual([]);
    expect(res.content.summary).toMatchObject({ recipients: 0, note_empty: expect.stringMatching(/nobody is rostered/i) });
  });

  it('without the user scope, still drafts and says phones and names were not checked', async () => {
    const { client } = tanda({ users: () => ({ __status: 403, body: { error: 'insufficient scope' } }) });
    const res = await run(client, { template: 'shift_reminder', location_id: 1, date: NEXT });
    expect(res.isError).toBeUndefined();
    expect(res.content.warnings).toEqual([{ check: 'recipients', reason: 'missing scope: user' }]);
    expect(res.content.summary).toMatchObject({ recipients: 4, with_phone: null, estimated_segments: null });
    expect(res.content.rows[0]).toMatchObject({ user_name: null, has_phone: null });
  });

  it('rejects bad arguments before calling Tanda', async () => {
    const { client, requests } = tanda();
    for (const args of [
      {}, // no message
      { message_es: 'Hola', location_id: 1 }, // English missing: the server does not translate
      { template: 'shift_reminder', message_es: 'Hola', message_en: 'Hi', location_id: 1 },
      { template: 'nope', location_id: 1 },
      { template: 'shift_reminder' }, // no audience
      { template: 'shift_reminder', location_id: 1, time: '5pm' },
      { template: 'shift_reminder', location_id: 1, date: 'tomorrow' },
      { message_es: 'x'.repeat(321), message_en: 'Hi', location_id: 1 },
    ]) {
      const res = await run(client, args);
      expect(res.isError).toBe(true);
    }
    expect(requests).toHaveLength(0);
  });

  it('rejects an unknown site, a {site} with no location_id, and an unknown placeholder', async () => {
    const { client } = tanda();
    const bad = [
      { template: 'shift_reminder', location_id: 7 },
      { template: 'shift_reminder', user_ids: [1] },
      { message_es: 'Hola {nombre}', message_en: 'Hi', user_ids: [1] },
    ];
    for (const args of bad) {
      const res = await run(client, args);
      expect(res.isError).toBe(true);
      expect(res.content.error).toMatch(/location_id|placeholder/);
    }
  });

  it('still fails on Tanda errors that are not a missing scope', async () => {
    const { client } = tanda({ schedules: () => ({ __status: 500, body: {} }) });
    const res = await run(client, { template: 'shift_reminder', location_id: 1 });
    expect(res.isError).toBe(true);
  });
});
