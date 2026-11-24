/** WFM-012 (#59): rate-limit guard. Shared budget, 429 backoff, `rate_limited` warnings, 24h people cache. */
import { SlidingWindowLimiter, DEFAULT_TANDA_RATE_LIMIT_PER_MIN } from '../src/tanda/rateLimiter';
import { rateLimitBackoffMs, RATE_LIMIT_RETRIES, TandaApiError } from '../src/tanda/client';
import { loadPeople, USERS_TTL_MS, ORG_TTL_MS } from '../src/mcp/context';
import { executeTool } from '../src/mcp/tools';
import { soft, Warning } from '../src/mcp/warnings';
import { fakeTanda, nySeconds } from './helpers/fakeTanda';

const tooMany = { __status: 429, body: { error: 'Too many requests' } };

describe('WFM-012 shared request budget', () => {
  it('defaults to 90 requests a minute, under Tanda\'s 100', () => {
    expect(DEFAULT_TANDA_RATE_LIMIT_PER_MIN).toBe(90);
  });

  it('never lets more than the limit through in one window, then lets the next one through once the window rolls', async () => {
    const limiter = new SlidingWindowLimiter(3, 150);
    const started = Date.now();
    await Promise.all([limiter.acquire(), limiter.acquire(), limiter.acquire()]);
    expect(Date.now() - started).toBeLessThan(100);
    expect(limiter.inFlightWindow).toBe(3);
    await limiter.acquire();
    expect(Date.now() - started).toBeGreaterThanOrEqual(140);
  });
});

describe('WFM-012 429 retries with backoff', () => {
  it('uses Retry-After when Tanda sends it, else 2s, 4s, 8s, never more than 10s', () => {
    expect([1, 2, 3].map((n) => rateLimitBackoffMs(n))).toEqual([2000, 4000, 8000]);
    expect(rateLimitBackoffMs(1, 3)).toBe(3000);
    expect(rateLimitBackoffMs(1, 60)).toBe(10_000);
    expect(rateLimitBackoffMs(5)).toBe(10_000);
  });

  it('retries a 429 and returns the data once Tanda lets it through', async () => {
    let calls = 0;
    const waits: number[] = [];
    const { client, requests } = fakeTanda(
      [['/departments', () => (++calls <= 2 ? tooMany : [{ id: 1, name: 'Team' }])]],
      { sleep: async (ms) => { waits.push(ms); } }
    );
    await expect(client.getDepartments()).resolves.toEqual([{ id: 1, name: 'Team' }]);
    expect(requests.filter((r) => r.path === '/departments')).toHaveLength(3);
    expect(waits).toEqual([2000, 4000]);
  });

  it('honours Retry-After from Tanda', async () => {
    let calls = 0;
    const waits: number[] = [];
    const { client } = fakeTanda(
      [['/departments', () => (++calls === 1 ? { ...tooMany, __headers: { 'retry-after': '7' } } : [])]],
      { sleep: async (ms) => { waits.push(ms); } }
    );
    await client.getDepartments();
    expect(waits).toEqual([7000]);
  });

  it(`gives up after ${RATE_LIMIT_RETRIES} retries with a clear 429 error`, async () => {
    const { client, requests } = fakeTanda([['/departments', () => tooMany]], { sleep: async () => undefined });
    const error = await client.getDepartments().catch((e) => e);
    expect(error).toBeInstanceOf(TandaApiError);
    expect(error.statusCode).toBe(429);
    expect(error.message).toMatch(/rate limit/i);
    expect(requests.filter((r) => r.path === '/departments')).toHaveLength(RATE_LIMIT_RETRIES + 1);
  });
});

describe('WFM-012 rate_limited warnings instead of failing', () => {
  it('soft() turns a lasting 429 into a rate_limited warning and returns the fallback', async () => {
    const warnings: Warning[] = [];
    const result = await soft(warnings, 'unavailability', 'fallback', async () => {
      throw new TandaApiError('Tanda rate limit reached', 429);
    });
    expect(result).toBe('fallback');
    expect(warnings).toEqual([{ check: 'unavailability', reason: expect.stringMatching(/rate limit/i), rate_limited: true }]);
  });

  it('soft() still lets other errors through', async () => {
    await expect(soft([], 'x', null, async () => { throw new TandaApiError('Tanda is unavailable', 503); })).rejects.toThrow(/unavailable/);
  });

  it('tanda_validate_schedule keeps running when one check stays rate limited', async () => {
    const day = '2026-10-13';
    const { client } = fakeTanda(
      [
        ['/users', () => [{ id: 1, name: 'A' }]],
        ['/schedules', () => [{ id: 50, user_id: 1, start: nySeconds(day, '08:00'), finish: nySeconds(day, '12:00') }]],
        ['/leave', () => []],
        ['/unavailability', () => tooMany],
      ],
      { sleep: async () => undefined }
    );
    const res = (await executeTool(client, 'tanda_validate_schedule', {
      shifts: [{ user_id: 1, start: `${day} 10:00`, finish: `${day} 14:00` }],
    })) as { content: { warnings?: Warning[]; rows: Array<Record<string, unknown>> }; isError?: boolean };
    expect(res.isError).toBeFalsy();
    expect(res.content.warnings).toEqual([expect.objectContaining({ check: 'unavailability', rate_limited: true })]);
    expect([...(res.content.rows[0].errors as string[]), ...(res.content.rows[0].warnings as string[])].join('; ')).toMatch(/overlaps existing schedule 50/);
  });
});

describe('WFM-012 people reference data cached for 24h', () => {
  const before = process.env.TANDA_WRITES_ENABLED;
  afterAll(() => { process.env.TANDA_WRITES_ENABLED = before; });

  it('uses the same 24h freshness as org data', () => {
    expect(USERS_TTL_MS).toBe(24 * 60 * 60 * 1000);
    expect(USERS_TTL_MS).toBe(ORG_TTL_MS);
  });

  it('serves people from cache within the day, and a user write clears it', async () => {
    process.env.TANDA_WRITES_ENABLED = 'true';
    let users = [{ id: 1, name: 'A' }];
    const { client, requests } = fakeTanda([
      ['/users', (req) => (req.method === 'POST' ? { id: 2, name: 'B' } : users)],
    ]);
    const userReads = () => requests.filter((r) => r.method === 'GET' && r.path === '/users').length;

    expect((await loadPeople(client)).users).toHaveLength(1);
    await loadPeople(client);
    expect(userReads()).toBe(1);

    users = [...users, { id: 2, name: 'B' }];
    await client.createUser({ name: 'B' });
    expect((await loadPeople(client)).users).toHaveLength(2);
    expect(userReads()).toBe(2);
  });
});
