import request from 'supertest';
import { createApp } from '../src/server/app';
import { Application } from 'express';

const SECRET = process.env.MCP_SHARED_SECRET as string;

describe('MCP route authentication', () => {
  let app: Application;

  beforeAll(() => {
    app = createApp();
  });

  const methods = ['initialize', 'tools/list', 'tools/call', 'resources/read', 'prompts/list', 'ping'];

  describe.each(['/mcp', '/'])('POST %s', (path) => {
    it.each(methods)('rejects unauthenticated %s with 401', async (method) => {
      const response = await request(app)
        .post(path)
        .send({ jsonrpc: '2.0', id: 1, method, params: { name: 'tanda_users', arguments: { action: 'current' } } })
        .expect(401);

      expect(response.body.error).toBe('unauthorized');
      expect(response.headers['www-authenticate']).toMatch(/^Bearer resource_metadata=/);
    });

    it('rejects an unauthenticated tools/call without reaching Tanda', async () => {
      const response = await request(app)
        .post(path)
        .send({
          jsonrpc: '2.0',
          id: 1,
          method: 'tools/call',
          params: { name: 'tanda_users', arguments: { action: 'list' } },
        })
        .expect(401);

      expect(response.body).not.toHaveProperty('result');
    });

    it('rejects a wrong bearer secret', async () => {
      await request(app)
        .post(path)
        .set('Authorization', `Bearer ${SECRET}-wrong`)
        .send({ jsonrpc: '2.0', id: 1, method: 'tools/list' })
        .expect(401);
    });

    it('rejects a forged JWT', async () => {
      await request(app)
        .post(path)
        .set('Authorization', 'Bearer eyJhbGciOiJIUzI1NiJ9.eyJzZXNzaW9uSWQiOiJ4In0.bad')
        .send({ jsonrpc: '2.0', id: 1, method: 'tools/list' })
        .expect(401);
    });

    it('accepts MCP_SHARED_SECRET', async () => {
      const response = await request(app)
        .post(path)
        .set('Authorization', `Bearer ${SECRET}`)
        .send({ jsonrpc: '2.0', id: 1, method: 'tools/list' })
        .expect(200);

      expect(Array.isArray(response.body.result.tools)).toBe(true);
    });
  });

  it('GET /mcp (SSE) requires auth', async () => {
    await request(app).get('/mcp').expect(401);
  });

  it('other verbs on /mcp require auth', async () => {
    await request(app).delete('/mcp').expect(401);
  });

  it('GET /stats requires auth', async () => {
    await request(app).get('/stats').expect(401);
  });
});

describe('OAuth scopes', () => {
  it('advertises only the least-privilege scope set', async () => {
    const app = createApp();
    const response = await request(app).get('/.well-known/oauth-protected-resource').expect(200);
    expect(response.body.scopes_supported).toEqual([
      'me', 'roster', 'timesheet', 'department', 'user', 'cost', 'leave', 'unavailability',
    ]);
  });

  it('strips financial and personal scopes from TANDA_SCOPES', () => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { parseScopes } = require('../src/config/scopes');
    const parsed = parseScopes('me user financial personal roster');
    expect(parsed.scopes).toEqual(['me', 'user', 'roster']);
    expect(parsed.rejected).toEqual(['financial', 'personal']);
  });

  it('requests least-privilege scopes in the Tanda authorize URL', async () => {
    const app = createApp();
    const response = await request(app).get('/auth/login').expect(302);
    const url = new URL(response.headers.location);
    expect(url.searchParams.get('scope')).toBe('me roster timesheet department user cost leave unavailability');
  });
});

describe('Read-only Tanda client', () => {
  it('refuses mutating HTTP verbs', async () => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { TandaClient } = require('../src/tanda/client');
    const client = new TandaClient('token');
    await expect(client.createSchedule({ start: 'a', finish: 'b' })).rejects.toThrow(/Read-only/);
  });
});
