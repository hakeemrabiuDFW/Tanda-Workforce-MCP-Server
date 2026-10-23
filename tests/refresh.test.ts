import crypto from 'crypto';
import request from 'supertest';
import { Application } from 'express';

jest.mock('../src/tanda/client', () => {
  const actual = jest.requireActual('../src/tanda/client');
  return { ...actual, exchangeCodeForToken: jest.fn(), refreshTandaToken: jest.fn() };
});

import { createApp } from '../src/server/app';
import { oauthManager, MCP_ACCESS_TOKEN_TTL_SECONDS } from '../src/auth/oauth';
import { openRefreshToken, sealRefreshToken } from '../src/auth/refreshToken';
import { TandaApiError, TandaClient, exchangeCodeForToken, refreshTandaToken } from '../src/tanda/client';

const exchangeMock = exchangeCodeForToken as jest.MockedFunction<typeof exchangeCodeForToken>;
const refreshMock = refreshTandaToken as jest.MockedFunction<typeof refreshTandaToken>;
const USER = { id: 42, name: 'Test Manager', email: 'manager@example.com' };
const tandaTokens = (n: number, expiresIn = 7200) => ({
  access_token: `A${n}`, refresh_token: `R${n}`, expires_in: expiresIn, token_type: 'bearer', scope: 'me', created_at: 0,
});

/** Run the OAuth flow up to an authorization code, with Tanda stubbed. */
async function signIn(expiresIn = 7200): Promise<{ sessionId: string; code: string; verifier: string }> {
  const verifier = crypto.randomBytes(32).toString('base64url');
  const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
  const { sessionId, state } = oauthManager.createAuthSession({ redirectUri: 'https://claude.ai/api/mcp/auth_callback', state: 's', codeChallenge: challenge });
  exchangeMock.mockResolvedValueOnce(tandaTokens(1, expiresIn));
  const result = await oauthManager.handleCallback(sessionId, 'tanda-code', state);
  expect(result.success).toBe(true);
  return { sessionId, code: oauthManager.generateAuthCode(sessionId, challenge), verifier };
}

describe('MCP refresh tokens', () => {
  let app: Application;
  let userSpy: jest.SpyInstance;

  beforeAll(() => {
    app = createApp();
  });

  beforeEach(() => {
    exchangeMock.mockReset();
    refreshMock.mockReset();
    userSpy = jest.spyOn(TandaClient.prototype, 'getCurrentUser').mockResolvedValue(USER as never);
  });

  afterEach(() => userSpy.mockRestore());

  describe('sealed token', () => {
    it('round-trips its claims', () => {
      const token = sealRefreshToken({ sid: 's1', uid: 7, at: 'A', rt: 'R', atExp: 123 });
      expect(token.startsWith('rt1.')).toBe(true);
      expect(openRefreshToken(token)).toMatchObject({ sid: 's1', uid: 7, at: 'A', rt: 'R', atExp: 123 });
    });

    it('does not reveal the Tanda tokens', () => {
      const token = sealRefreshToken({ sid: 's1', uid: 7, at: 'tanda-access-secret', rt: 'tanda-refresh-secret' });
      const decoded = Buffer.from(token.slice(4), 'base64url').toString('latin1');
      expect(decoded).not.toContain('tanda-access-secret');
      expect(decoded).not.toContain('tanda-refresh-secret');
    });

    it('rejects a tampered, foreign or expired token', () => {
      const token = sealRefreshToken({ sid: 's1', uid: 7, at: 'A' });
      const flipped = token.slice(0, -2) + (token.endsWith('A') ? 'B' : 'A') + token.slice(-1);
      expect(openRefreshToken(flipped)).toBeNull();
      expect(openRefreshToken('not-a-token')).toBeNull();
      expect(openRefreshToken(undefined)).toBeNull();
      expect(openRefreshToken(token, Date.now() + 31 * 24 * 60 * 60 * 1000)).toBeNull();
    });
  });

  describe('POST /token', () => {
    it('returns a 1-hour access token and a refresh token for an authorization code', async () => {
      const { code, verifier } = await signIn();
      const res = await request(app).post('/token').send({ grant_type: 'authorization_code', code, code_verifier: verifier }).expect(200);

      expect(res.body.expires_in).toBe(MCP_ACCESS_TOKEN_TTL_SECONDS);
      expect(res.body.refresh_token).toMatch(/^rt1\./);
      expect(res.headers['cache-control']).toBe('no-store');
      expect(oauthManager.verifyJWT(res.body.access_token)?.userId).toBe(42);
    });

    it('swaps a refresh token for a new pair, and refuses it a second time', async () => {
      const { code, verifier } = await signIn();
      const first = await request(app).post('/token').send({ grant_type: 'authorization_code', code, code_verifier: verifier }).expect(200);

      const second = await request(app).post('/token').send({ grant_type: 'refresh_token', refresh_token: first.body.refresh_token }).expect(200);
      expect(second.body.access_token).toBeTruthy();
      expect(second.body.refresh_token).not.toBe(first.body.refresh_token);

      const reused = await request(app).post('/token').send({ grant_type: 'refresh_token', refresh_token: first.body.refresh_token }).expect(400);
      expect(reused.body.error).toBe('invalid_grant');
    });

    it('rebuilds the session after a restart from the sealed Tanda tokens', async () => {
      const { sessionId, code, verifier } = await signIn();
      const first = await request(app).post('/token').send({ grant_type: 'authorization_code', code, code_verifier: verifier }).expect(200);

      oauthManager.invalidateSession(sessionId); // what a restart does to the in-memory store
      expect(oauthManager.getTandaClient(sessionId)).toBeNull();

      const res = await request(app).post('/token').send({ grant_type: 'refresh_token', refresh_token: first.body.refresh_token }).expect(200);
      const payload = oauthManager.verifyJWT(res.body.access_token);
      expect(payload?.sessionId).toBe(sessionId);
      expect(oauthManager.getTandaClient(sessionId)).not.toBeNull();
    });

    it('refreshes Tanda before issuing tokens when its access token is about to lapse', async () => {
      const { sessionId, code, verifier } = await signIn(600); // Tanda token has 10 minutes left
      refreshMock.mockResolvedValueOnce(tandaTokens(2));
      const res = await request(app).post('/token').send({ grant_type: 'authorization_code', code, code_verifier: verifier }).expect(200);

      expect(refreshMock).toHaveBeenCalledWith('R1');
      expect(oauthManager.getSession(sessionId)?.accessToken).toBe('A2');
      expect(openRefreshToken(res.body.refresh_token)).toMatchObject({ at: 'A2', rt: 'R2' });
    });

    it('signs the user out when Tanda access was revoked', async () => {
      const { sessionId, code, verifier } = await signIn();
      const first = await request(app).post('/token').send({ grant_type: 'authorization_code', code, code_verifier: verifier }).expect(200);

      userSpy.mockRejectedValueOnce(new Error('Tanda session expired or was revoked.'));
      const res = await request(app).post('/token').send({ grant_type: 'refresh_token', refresh_token: first.body.refresh_token }).expect(400);
      expect(res.body.error).toBe('invalid_grant');
      expect(oauthManager.getSession(sessionId)).toBeUndefined();
    });

    it('keeps the session and the refresh token when Tanda is briefly unreachable', async () => {
      const { sessionId, code, verifier } = await signIn();
      const first = await request(app).post('/token').send({ grant_type: 'authorization_code', code, code_verifier: verifier }).expect(200);

      userSpy.mockRejectedValueOnce(new TandaApiError('Tanda did not respond.', 502));
      const res = await request(app).post('/token').send({ grant_type: 'refresh_token', refresh_token: first.body.refresh_token }).expect(503);
      expect(res.body.error).toBe('temporarily_unavailable');
      expect(oauthManager.getSession(sessionId)).toBeDefined();

      await request(app).post('/token').send({ grant_type: 'refresh_token', refresh_token: first.body.refresh_token }).expect(200);
    });

    it('requires a refresh_token for the refresh grant', async () => {
      const res = await request(app).post('/token').send({ grant_type: 'refresh_token' }).expect(400);
      expect(res.body.error).toBe('invalid_request');
    });
  });

  describe('Tanda token rotation', () => {
    it('spends the single-use Tanda refresh token once for concurrent callers', async () => {
      const { sessionId } = await signIn();
      let release!: () => void;
      refreshMock.mockImplementationOnce(() => new Promise((resolve) => { release = () => resolve(tandaTokens(2)); }));

      const a = oauthManager.refreshSessionTokens(sessionId, 'A1');
      const b = oauthManager.refreshSessionTokens(sessionId, 'A1');
      await new Promise((r) => setImmediate(r));
      release();

      expect(await a).toBe('A2');
      expect(await b).toBe('A2');
      expect(refreshMock).toHaveBeenCalledTimes(1);
      expect(oauthManager.getSession(sessionId)).toMatchObject({ accessToken: 'A2', refreshToken: 'R2' });
    });

    it('never runs two Tanda refreshes at once when several callers queue behind one', async () => {
      const { sessionId } = await signIn();
      let inFlight = 0;
      let maxInFlight = 0;
      let n = 1;
      refreshMock.mockImplementation(async () => {
        inFlight++;
        maxInFlight = Math.max(maxInFlight, inFlight);
        await new Promise((r) => setTimeout(r, 5));
        inFlight--;
        n++;
        return tandaTokens(n);
      });

      // No failed token: each caller asks for a fresh refresh, so they must run one after another.
      await Promise.all([1, 2, 3].map(() => oauthManager.refreshSessionTokens(sessionId)));
      expect(maxInFlight).toBe(1);
      expect(refreshMock).toHaveBeenCalledTimes(3);
      expect(refreshMock.mock.calls.map((c) => c[0])).toEqual(['R1', 'R2', 'R3']);
    });
  });
});
