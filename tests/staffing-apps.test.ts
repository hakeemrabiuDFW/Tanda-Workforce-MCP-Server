/**
 * MCP App tools: conversation_to_site_schedule and staff_allocation_board.
 * All people, sites and shifts here are made up.
 */
import request from 'supertest';
import { createApp } from '../src/server/app';
import { executeTool, getAvailableTools } from '../src/mcp/tools';
import { fakeTanda, nySeconds, RouteHandler } from './helpers/fakeTanda';
import { tenureFrom, shortName } from '../src/mcp/apps/tenure';
import { APP_MIME_TYPE, renderAppHtml } from '../src/mcp/apps/ui';
import { addDays, todayInZone } from '../src/utils/time';
import { fixtureClient, FIXTURE_FROM } from './helpers/fixture';
import { byteSize, MAX_BYTES } from '../src/mcp/guard';
import { chromium, Browser } from 'playwright';

const AUTH = `Bearer ${process.env.MCP_SHARED_SECRET}`;
const WEEK = { from: '2026-10-12', to: '2026-10-18' };
const DAYS = ['2026-10-12', '2026-10-13', '2026-10-14', '2026-10-15', '2026-10-16', '2026-10-17', '2026-10-18'];
/** A start date `months` whole months before today, so tenure is stable whenever the test runs. */
const startedMonthsAgo = (months: number): string => {
  const [y, m] = todayInZone().split('-').map(Number);
  const d = new Date(Date.UTC(y, m - 1 - months, 1));
  return d.toISOString().slice(0, 10);
};

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- loose JSON bodies in assertions
type Body = Record<string, any>;

function staffingClient() {
  const user = (id: number, name: string, months: number | null, levels = ['employee']) => ({
    id, name, active: true, user_levels: levels,
    employment_start_date: months === null ? null : startedMonthsAgo(months),
    email: `u${id}@example.com`, phone: '+15550000', date_of_birth: '1990-01-01', passcode: '1234',
  });
  const users = [
    user(1, 'Avery Supervisor Stone', 60),
    user(2, 'Blake Manager Reed', 30, ['employee', 'manager']),
    user(3, 'Casey Ambassador Vale', 26),   // trainer: Ambassador + 2y2m
    user(4, 'Devon Ambassador Park', 5),    // Ambassador but under a year: not a trainer
    user(5, 'Emery Veteran Cole', 40),      // experienced cleaner, light week
    user(6, 'Finley Busy Hart', 50),        // experienced cleaner, 42 h
    user(7, 'Gray Newer Wolfe', 7),         // cleaner, lightest week
    user(8, 'Harper Rookie Lane', 1),       // trainee
    user(9, 'Indigo Nodate Moss', null),    // no start date
    user(10, 'Jules Training Frost', 18),   // trainer: TRAINING + 1y6m
  ];
  const locations = [
    { id: 100, name: 'Maple Street School' },
    { id: 200, name: 'Harbor Office Park' },
    { id: 281737, name: 'One Time Projects' },
  ];
  const departments = [
    { id: 1001, name: 'Cleaning', location_id: 100, staff: [5, 6, 7, 8, 9, 4] },
    { id: 1002, name: 'Supervisor', location_id: 100, staff: [1] },
    { id: 1003, name: 'Ambassador', location_id: 100, staff: [3, 4] },
    { id: 2001, name: 'Cleaning', location_id: 200, staff: [6] },
    { id: 2002, name: 'TRAINING', location_id: 200, staff: [10] },
  ];
  let id = 1;
  const schedules: Body[] = [];
  const add = (uid: number, dept: number, date: string, hours: number) => {
    const start = nySeconds(date, '09:00');
    schedules.push({ id: id++, user_id: uid, department_id: dept, start, finish: start + hours * 3600 });
  };
  for (const d of DAYS) {
    add(6, 2001, d, 6);             // 42 h across the week
    add(1, 1002, d, 2);             // 14 h
    add(3, 1003, d, 1);             // 7 h
    for (let n = 0; n < 9; n++) add(9, 1001, d, 0.5); // 63 short shifts: more than one 50-row page
  }
  add(5, 1001, '2026-10-12', 4);    // 4 h
  add(10, 2002, '2026-10-16', 3);   // 3 h, late in the week
  const routes: Array<[string | RegExp, RouteHandler]> = [
    ['/locations', () => locations],
    ['/departments', () => departments],
    ['/users', () => users],
    ['/schedules', (r) => schedules.filter((s) => {
      const day = new Date(s.start * 1000).toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
      return day >= r.params.from && day <= r.params.to;
    })],
  ];
  return { ...fakeTanda(routes), total: schedules.length };
}

const board = async (args: Body = {}) => {
  const { client, requests, total } = staffingClient();
  const res = await executeTool(client, 'staff_allocation_board', { week_of: WEEK.from, ...args });
  return { res, c: res.content as Body, requests, total };
};
const ids = (list: Body[]) => list.map((p) => p.id);

describe('tenure', () => {
  it('counts whole years and months from the start date', () => {
    expect(tenureFrom('2024-05-06', '2026-11-15')).toMatchObject({ years: 2, months: 6, total_months: 30, label: '2y 6m' }); // the case in #96
    expect(tenureFrom('2023-03-15', '2026-05-15')).toEqual({ years: 3, months: 2, total_months: 38, label: '3y 2m' });
    expect(tenureFrom('2023-03-15', '2026-05-14')).toMatchObject({ years: 3, months: 1, total_months: 37 });
    expect(tenureFrom('2025-11-15', '2026-11-15')).toMatchObject({ years: 1, months: 0, label: '1y' });
    expect(tenureFrom('2026-03-01', '2026-11-15')).toMatchObject({ years: 0, months: 8, label: '8m' });
    expect(tenureFrom('2026-11-01', '2026-11-15')).toMatchObject({ total_months: 0, label: 'under 1m' });
  });

  it('is null for a missing, malformed or future start date', () => {
    expect(tenureFrom(null, '2026-11-15')).toBeNull();
    expect(tenureFrom('15/03/2023', '2026-11-15')).toBeNull();
    expect(tenureFrom('2027-01-01', '2026-11-15')).toBeNull();
  });

  it('shortens names to first name + last initial', () => {
    expect(shortName('Maria Lopez Garcia')).toBe('Maria G.');
    expect(shortName('  Sam   okafor ')).toBe('Sam O.');
    expect(shortName('Cher')).toBe('Cher');
    expect(shortName(undefined)).toBe('Unnamed');
  });
});

describe('staff_allocation_board', () => {
  it('loads hours for the whole week, summing every shift past the first 50-row page', async () => {
    const { c, requests, total } = await board();
    expect(c.week).toMatchObject(WEEK);
    expect(total).toBeGreaterThan(50);
    expect(c.note).toContain(`${total} shifts`);
    const all = [...c.pools.supervisor, ...c.pools.trainer, ...c.pools.cleaner, ...c.pools.trainee];
    const hours = (id: number) => all.find((p: Body) => p.id === id).week_hours;
    expect(hours(6)).toBe(42);   // 7 days x 6 h, not one day's 6 h
    expect(hours(9)).toBe(31.5); // 63 half-hour shifts
    expect(hours(10)).toBe(3);   // a Friday-only shift is counted
    expect(requests.filter((r) => r.path === '/schedules').every((r) => r.params.from === WEEK.from && r.params.to === WEEK.to)).toBe(true);
  });

  it('gives every person tenure in years and months, and first name + last initial', async () => {
    const { c } = await board();
    const all = [...c.pools.supervisor, ...c.pools.trainer, ...c.pools.cleaner, ...c.pools.trainee];
    expect(all.length).toBeGreaterThan(0);
    for (const p of all) {
      expect(p.name).toMatch(/^\S+ [A-Z]\.$/);
      expect(typeof p.tenure_label).toBe('string');
      if (p.id !== 9) expect(p.tenure).toEqual(expect.objectContaining({ years: expect.any(Number), months: expect.any(Number), total_months: expect.any(Number) }));
    }
    expect(all.find((p: Body) => p.id === 3)).toMatchObject({ tenure: { years: 2, months: 2, total_months: 26 }, tenure_label: '2y 2m' });
    expect(all.find((p: Body) => p.id === 9)).toMatchObject({ tenure: null, tenure_label: 'start date not set' });
    expect(JSON.stringify(c)).not.toMatch(/Supervisor Stone|example\.com|\+1555|1990-01-01/);
  });

  it('sorts people into supervisor, trainer, cleaner and trainee', async () => {
    const { c } = await board();
    expect(ids(c.pools.supervisor).sort()).toEqual([1, 2]);      // Supervisor department, and a manager level
    expect(ids(c.pools.trainer).sort()).toEqual([10, 3]);        // Ambassador / TRAINING with a year or more
    expect(ids(c.pools.trainer)).not.toContain(4);               // Ambassador with 5 months
    expect(ids(c.pools.trainee)).toEqual([8]);
    expect(ids(c.pools.cleaner).sort()).toEqual([4, 5, 6, 7, 9]);
  });

  it('recommends an experienced lead cleaner, the lightest loads, and a trainer with a year or more', async () => {
    const { c, res } = await board({ cleaners_needed: 2 });
    const r = c.recommendation;
    expect(r.cleaners[0]).toMatchObject({ id: 5, lead: true });   // 40 months, 4 h: beats newer staff with 0 h
    expect(r.cleaners[1].id).toBe(7);                             // then the lightest load (0 h); a tie goes to longer tenure
    expect(r.cleaners[0].tenure.total_months).toBeGreaterThanOrEqual(12);
    expect(r.trainer).toHaveLength(1);
    expect(r.trainer[0].id).toBe(10);                             // 3 h beats 7 h
    expect(r.trainer[0].tenure.total_months).toBeGreaterThanOrEqual(12);
    expect(r.supervisor[0].id).toBe(2);                           // 0 h beats 14 h
    expect(res.summary).toContain('(lead)');
    expect(res.summary).toMatch(/Emery C\. \(lead\) \[3y 4m, 4 h\]/);
    expect(res.summary).toContain('nothing was written to Tanda');
  });

  it('suggests people who would pass 40 hours last', async () => {
    const { c } = await board({ cleaners_needed: 5, hours_per_cleaner_per_week: 10 });
    const order = ids(c.recommendation.cleaners);
    expect(order[order.length - 1]).toBe(6);                      // 42 h already
    expect(c.warnings.join(' ')).toContain('Finley H.');
  });

  it('uses TRAINER_USER_IDS as the trainer list when set, but never a trainer under a year', async () => {
    process.env.TRAINER_USER_IDS = '7, 5';
    try {
      const { c } = await board();
      expect(ids(c.pools.trainer)).toEqual([5]);                           // Gray (7 months) is dropped
      expect(ids(c.recommendation.trainer)).toEqual([5]);
      expect(ids(c.pools.cleaner)).toEqual(expect.arrayContaining([3, 7, 10])); // Ambassadors and Gray go back to cleaners
      expect(c.trainer_source).toContain('TRAINER_USER_IDS');
      expect(c.warnings.join(' ')).toMatch(/Gray W\. is on TRAINER_USER_IDS but under 12 months/);
    } finally {
      delete process.env.TRAINER_USER_IDS;
    }
  });

  it('never suggests a trainer under a year, even when that leaves no trainer', async () => {
    process.env.TRAINER_USER_IDS = '7, 4';
    try {
      const { c, res } = await board();
      expect(c.pools.trainer).toHaveLength(0);
      expect(c.recommendation.trainer).toHaveLength(0);
      expect(c.warnings.join(' ')).toMatch(/No trainer with 12\+ months tenure found/);
      expect(res.summary).toContain('trainer none');
    } finally {
      delete process.env.TRAINER_USER_IDS;
    }
  });

  it('does not suggest the same person as supervisor and trainer when another trainer exists', async () => {
    // Blake (supervisor, 0 h) is also on the TRAINER_USER_IDS list, next to Emery (4 h)
    process.env.TRAINER_USER_IDS = '2, 5';
    try {
      const { c } = await board();
      expect(ids(c.recommendation.supervisor)).toEqual([2]);
      expect(ids(c.recommendation.trainer)).toEqual([5]);
    } finally {
      delete process.env.TRAINER_USER_IDS;
    }
  });

  it('sorts and filters by tenure', async () => {
    const byTenure = (await board({ sort_by: 'tenure' })).c;
    expect(ids(byTenure.pools.cleaner).slice(0, 3)).toEqual([6, 5, 7]);
    const veterans = (await board({ min_tenure_months: 12 })).c;
    expect(ids(veterans.pools.cleaner).sort()).toEqual([5, 6]);
    expect(veterans.pools.trainee).toHaveLength(0);
  });

  it('matches the site by name and lists site load without bookkeeping sites', async () => {
    const { c } = await board({ site_name: 'maple street' });
    expect(c.focus).toMatchObject({ id: 100, name: 'Maple Street School' });
    expect(c.in_tanda).toBe(true);
    expect(c.sites.map((s: Body) => s.id)).toEqual(expect.arrayContaining([100, 200]));
    const fresh = (await board({ site_name: 'Brand New Clinic' })).c;
    expect(fresh.focus).toMatchObject({ id: null, name: 'Brand New Clinic' });
    expect(fresh.in_tanda).toBe(false);
  });

  it('rejects bad arguments', async () => {
    for (const args of [{ cleaners_needed: 0 }, { cleaners_needed: 2.5 }, { week_of: 'next week' }, { sort_by: 'age' }, { min_tenure_months: -1 }]) {
      const { res } = await board(args);
      expect(res.isError).toBe(true);
      expect(res.summary).toBeUndefined();
    }
  });

  it('stays under the 25 KB cap on an org the size of production, with the board intact', async () => {
    const { client } = fixtureClient(); // 84 sites, 70 users, 7 days of rosters
    const res = await executeTool(client, 'staff_allocation_board', { week_of: FIXTURE_FROM, cleaners_needed: 3 });
    const c = res.content as Body;
    expect(c.view).toBe('allocation');
    expect(byteSize(c)).toBeLessThanOrEqual(MAX_BYTES);
    expect(res.summary).toContain('Allocation board');
    expect(c.pools.supervisor.length).toBe(8);
    expect(c.recommendation.cleaners).toHaveLength(3);
    expect(c.pools.cleaner[0].week_hours).toBe(42); // 7 x 6 h: the whole week
  });

  it('only reads from Tanda', async () => {
    const { requests } = await board({ site_name: 'Maple Street School' });
    expect(requests.length).toBeGreaterThan(0);
    expect(requests.every((r) => r.method === 'GET')).toBe(true);
    expect(requests.map((r) => r.path).sort().filter((p, i, a) => a.indexOf(p) === i)).toEqual(['/departments', '/locations', '/schedules', '/users']);
  });
});

describe('conversation_to_site_schedule', () => {
  const schedule = async (args: Body) => {
    const { client, requests } = staffingClient();
    const res = await executeTool(client, 'conversation_to_site_schedule', { week_of: WEEK.from, ...args });
    return { res, c: res.content as Body, requests };
  };

  it('builds the weekly plan and labor hours', async () => {
    const { c, res } = await schedule({
      site_name: 'Brand New Clinic', site_address: '1 Test Way, Albany, NY 12205', days: ['Monday', 'wed', 'Fri'],
      start_time: '6:00 pm', end_time: '9:30 pm', cleaners_needed: 2, supervisor_visits_per_week: 1, notes: 'Alarm code at front desk',
    });
    expect(c.view).toBe('schedule');
    expect(c.days).toEqual(['Mon', 'Wed', 'Fri']);
    expect(c.shiftHours).toBe(3.5);
    expect(c.weeklyHours).toBe(22);          // 3 days x 2 cleaners x 3.5 h + 1 supervisor hour
    expect(c.monthlyHours).toBe(95.26);
    expect(c.shifts).toHaveLength(7);
    expect(c.site_address).toBe('1 Test Way, Albany, NY 12205');
    expect(c.tandaMatch).toBeNull();
    expect(c.suggested.trainer).toHaveLength(1); // a new site gets a trainer
    expect(c.suggested.cleaners[0]).toMatchObject({ lead: true });
    for (const p of [...c.suggested.cleaners, ...c.suggested.supervisor, ...c.suggested.trainer]) {
      expect(p.tenure_label).toBeTruthy();
      expect(p.name).toMatch(/^\S+ [A-Z]\.$/);
    }
    expect(res.summary).toContain('Draft schedule for Brand New Clinic');
    expect(res.summary).toMatch(/\[\d+y( \d+m)?, [\d.]+ h\]/);
  });

  it('matches an existing Tanda site, carries the Route location, and handles overnight shifts', async () => {
    const { c } = await schedule({
      site_name: 'Maple Street School', start_time: '22:00', end_time: '2:00 am',
      route_location: { client: 'Maple Street School', name: 'Main building', address: '9 Sample Rd, Troy, NY 12180' },
    });
    expect(c.tandaMatch).toMatchObject({ id: 100 });
    expect(c.suggested.trainer).toHaveLength(0);
    expect(c.shiftHours).toBe(4);
    expect(c.routeMatch).toMatchObject({ client: 'Maple Street School' });
    expect(c.site_address).toBe('9 Sample Rd, Troy, NY 12180');
  });

  it('rejects bad arguments and never writes', async () => {
    for (const args of [{}, { site_name: 'X', days: ['Funday'] }, { site_name: 'X', start_time: 'noonish' }, { site_name: 'X', cleaners_needed: 99 }, { site_name: 'X', route_location: 'Acme' }]) {
      const { res } = await schedule(args);
      expect(res.isError).toBe(true);
    }
    const { requests } = await schedule({ site_name: 'Maple Street School' });
    expect(requests.every((r) => r.method === 'GET')).toBe(true);
  });

  it('defaults to the week containing tomorrow', async () => {
    const { client } = staffingClient();
    const res = await executeTool(client, 'conversation_to_site_schedule', { site_name: 'X' });
    const week = (res.content as Body).week;
    const tomorrow = addDays(todayInZone(), 1);
    expect(week.from <= tomorrow && tomorrow <= week.to).toBe(true);
  });
});

describe('MCP Apps protocol', () => {
  const app = createApp();
  const rpc = (method: string, params: Body = {}) =>
    request(app).post('/mcp').set('Authorization', AUTH).send({ jsonrpc: '2.0', id: 1, method, params });

  it('lists the app tools with their ui:// resource, read-only', async () => {
    const tools = (await rpc('tools/list')).body.result.tools as Body[];
    for (const [name, view] of [['conversation_to_site_schedule', 'schedule'], ['staff_allocation_board', 'allocation']]) {
      const t = tools.find((x) => x.name === name) as Body;
      expect(t._meta.ui.resourceUri).toBe(`ui://tanda-workforce/${view}.html`);
      expect(t._meta['ui/resourceUri']).toBe(t._meta.ui.resourceUri);
      expect(t.annotations.readOnlyHint).toBe(true);
      expect(t.description).toMatch(/nothing is written to Tanda|not written to Tanda/);
    }
    expect(tools.find((x) => x.name === 'tanda_people')).not.toHaveProperty('_meta');
    expect(getAvailableTools().map((t) => t.name)).toEqual(expect.arrayContaining(['conversation_to_site_schedule', 'staff_allocation_board']));
  });

  it('serves each view as an MCP App resource with a closed CSP', async () => {
    const listed = (await rpc('resources/list')).body.result.resources as Body[];
    for (const view of ['schedule', 'allocation']) {
      const uri = `ui://tanda-workforce/${view}.html`;
      expect(listed.find((r) => r.uri === uri)).toMatchObject({ mimeType: APP_MIME_TYPE });
      const c = (await rpc('resources/read', { uri })).body.result.contents[0];
      expect(c.mimeType).toBe('text/html;profile=mcp-app');
      expect(c._meta.ui.csp).toEqual({ connectDomains: [], resourceDomains: [] });
      expect(c.text).toContain('ui/initialize');
      expect(c.text).toContain('ui/notifications/size-changed');
      expect(c.text).not.toMatch(/https?:\/\//); // loads nothing from the network
    }
    expect((await rpc('resources/read', { uri: 'ui://tanda-workforce/nope.html' })).body.error).toBeDefined();
  });

  it('requires auth for the views like every other MCP method', async () => {
    const res = await request(app).post('/mcp').send({ jsonrpc: '2.0', id: 1, method: 'resources/read', params: { uri: 'ui://tanda-workforce/schedule.html' } });
    expect(res.status).toBe(401);
  });

  it('echoes a protocol version it knows and offers the newest otherwise', async () => {
    expect((await rpc('initialize', { protocolVersion: '2025-06-18' })).body.result.protocolVersion).toBe('2025-06-18');
    expect((await rpc('initialize', { protocolVersion: '2024-11-05' })).body.result.protocolVersion).toBe('2024-11-05');
    expect((await rpc('initialize', { protocolVersion: '1999-01-01' })).body.result.protocolVersion).toBe('2025-11-25');
  });

  it('embeds data safely in a preview page', () => {
    const html = renderAppHtml('allocation', { view: 'allocation', note: '</script><script>alert(1)</script>' });
    expect(html).not.toContain('</script><script>alert(1)');
    expect(html).toContain('\\u003c/script>');
  });
});

describe('MCP App views in a browser', () => {
  let browser: Browser;
  beforeAll(async () => { browser = await chromium.launch(); }, 30000);
  afterAll(async () => { await browser?.close(); });

  /** Loads a view the way a host does (no embedded data), sends it a tool result, and collects errors and posted messages. */
  async function open(view: 'schedule' | 'allocation', structuredContent: Body) {
    const page = await browser.newPage();
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
    await page.setContent(renderAppHtml(view));
    // Strings, because the test tsconfig has no DOM types; this code runs in the page
    await page.evaluate('window.posted = []; window.addEventListener("message", (e) => window.posted.push(e.data));');
    await page.evaluate(`window.postMessage(${JSON.stringify({ jsonrpc: '2.0', method: 'ui/notifications/tool-result', params: { content: [], structuredContent } })}, '*')`);
    await page.waitForSelector('h1');
    const posted = async (): Promise<Body[]> => (await page.evaluate('window.posted')) as Body[];
    const sentToChat = async (): Promise<Body> => {
      // postMessage is delivered asynchronously
      await page.waitForFunction('window.posted.some((m) => m && m.method === "ui/message")', undefined, { timeout: 3000 }).catch(() => undefined);
      const m = (await posted()).find((x) => x.method === 'ui/message');
      if (!m) throw new Error('nothing was sent with ui/message');
      return m;
    };
    return { page, errors, sentToChat };
  }

  it('renders the schedule view without page errors', async () => {
    const { client } = staffingClient();
    const res = await executeTool(client, 'conversation_to_site_schedule', { site_name: 'Cedar Clinic', days: ['Mon', 'Wed'], cleaners_needed: 2, week_of: WEEK.from });
    const { page, errors, sentToChat } = await open('schedule', res.content as Body);
    expect(await page.textContent('h1')).toContain('Cedar Clinic');
    expect(await page.locator('table tr').count()).toBe(1 + 4 + 2); // header, 2 days x 2 cleaners, 2 supervisor checks
    expect(await page.textContent('body')).toContain('site not created');
    await page.click('#alloc');
    const sent = await sentToChat();
    expect(sent.params.content[0].text).toContain('staff allocation board for Cedar Clinic');
    expect(errors).toEqual([]);
    await page.close();
  }, 30000);

  it('renders the allocation board, taps people and sends the team to chat, without page errors', async () => {
    const { res } = await board({ cleaners_needed: 2 });
    const { page, errors, sentToChat } = await open('allocation', res.content as Body);
    expect(await page.textContent('h1')).toContain('Staff allocation');
    expect(await page.locator('#pools .chip.on').count()).toBe(4); // 2 cleaners, supervisor, trainer pre-picked
    await page.locator('#pools .chip[data-k="trainee:8"]').click();
    expect(await page.locator('#pools .chip.on').count()).toBe(5);
    await page.selectOption('#minten', '12');
    expect(await page.locator('#pools .chip[data-k="cleaner:7"]').count()).toBe(1); // picked, so kept by the filter
    expect(await page.locator('#pools .chip[data-k="cleaner:9"]').count()).toBe(0); // no start date, filtered out
    await page.selectOption('#sort', 'tenure');
    await page.click('#done');
    const sent = await sentToChat();
    expect(sent.params.role).toBe('user');
    expect(sent.params.content[0].text).toMatch(/trainers: Jules F\. \(1y 6m tenure, 3 h this week\)/);
    expect(sent.params.content[0].text).toContain('Do not write anything to Tanda');
    expect(errors).toEqual([]);
    await page.close();
  }, 30000);
});
