import request from 'supertest';
import { createApp } from '../src/server/app';
import { Application } from 'express';

describe('OAuth Endpoints', () => {
  let app: Application;

  beforeAll(() => {
    app = createApp();
  });

  describe('GET /.well-known/oauth-authorization-server', () => {
    it('should return OAuth discovery metadata', async () => {
      const response = await request(app)
        .get('/.well-known/oauth-authorization-server')
        .expect('Content-Type', /json/)
        .expect(200);

      expect(response.body).toHaveProperty('issuer');
      expect(response.body).toHaveProperty('authorization_endpoint');
      expect(response.body).toHaveProperty('token_endpoint');
      expect(response.body).toHaveProperty('registration_endpoint');
    });

    it('should support authorization_code grant type', async () => {
      const response = await request(app)
        .get('/.well-known/oauth-authorization-server')
        .expect(200);

      expect(response.body.grant_types_supported).toContain('authorization_code');
      expect(response.body.response_types_supported).toContain('code');
    });

    it('should support PKCE with S256', async () => {
      const response = await request(app)
        .get('/.well-known/oauth-authorization-server')
        .expect(200);

      expect(response.body.code_challenge_methods_supported).toContain('S256');
    });

    it('should have correct endpoint paths', async () => {
      const response = await request(app)
        .get('/.well-known/oauth-authorization-server')
        .expect(200);

      expect(response.body.authorization_endpoint).toContain('/authorize');
      expect(response.body.token_endpoint).toContain('/token');
      expect(response.body.registration_endpoint).toContain('/oauth/register');
    });
  });

  describe('POST /oauth/register', () => {
    it('should register a new client', async () => {
      const response = await request(app)
        .post('/oauth/register')
        .send({
          client_name: 'Test Client',
          redirect_uris: ['https://example.com/callback'],
        })
        .expect('Content-Type', /json/)
        .expect(201);

      expect(response.body).toHaveProperty('client_id');
      expect(response.body.client_id).toMatch(/^mcp-client-/);
      expect(response.body).toHaveProperty('client_name', 'Test Client');
      expect(response.body.redirect_uris).toContain('https://example.com/callback');
    });

    it('should set default values for optional fields', async () => {
      const response = await request(app)
        .post('/oauth/register')
        .send({})
        .expect(201);

      expect(response.body).toHaveProperty('client_id');
      expect(response.body).toHaveProperty('client_name', 'MCP Client');
      expect(response.body).toHaveProperty('token_endpoint_auth_method', 'none');
      expect(response.body.grant_types).toContain('authorization_code');
      expect(response.body.response_types).toContain('code');
    });

    it('should generate unique client IDs', async () => {
      const response1 = await request(app)
        .post('/oauth/register')
        .send({ client_name: 'Client 1' })
        .expect(201);

      const response2 = await request(app)
        .post('/oauth/register')
        .send({ client_name: 'Client 2' })
        .expect(201);

      expect(response1.body.client_id).not.toBe(response2.body.client_id);
    });
  });

  describe('GET /authorize', () => {
    it('should redirect to Tanda OAuth', async () => {
      const response = await request(app)
        .get('/authorize')
        .query({
          redirect_uri: 'https://example.com/callback',
          state: 'test-state',
          code_challenge: 'test-challenge',
        })
        .expect(302);

      expect(response.headers.location).toContain('my.tanda.co');
    });

    it('should set session cookie', async () => {
      const response = await request(app)
        .get('/authorize')
        .query({
          redirect_uri: 'https://example.com/callback',
        })
        .expect(302);

      expect(response.headers['set-cookie']).toBeDefined();
      expect(response.headers['set-cookie'][0]).toContain('tanda_session');
    });
  });

  describe('POST /token', () => {
    it('should reject unsupported grant types', async () => {
      const response = await request(app)
        .post('/token')
        .send({
          grant_type: 'client_credentials',
          code: 'test-code',
        })
        .expect('Content-Type', /json/)
        .expect(400);

      expect(response.body).toHaveProperty('error', 'unsupported_grant_type');
    });

    it('should require authorization code', async () => {
      const response = await request(app)
        .post('/token')
        .send({
          grant_type: 'authorization_code',
        })
        .expect(400);

      expect(response.body).toHaveProperty('error', 'invalid_request');
      expect(response.body.error_description).toContain('code');
    });

    it('should reject invalid authorization code', async () => {
      const response = await request(app)
        .post('/token')
        .send({
          grant_type: 'authorization_code',
          code: 'invalid-code',
        })
        .expect(400);

      expect(response.body).toHaveProperty('error', 'invalid_grant');
    });
  });

  describe('GET /auth/login', () => {
    it('should redirect to Tanda OAuth', async () => {
      const response = await request(app)
        .get('/auth/login')
        .expect(302);

      expect(response.headers.location).toContain('my.tanda.co');
      expect(response.headers.location).toContain('oauth');
    });

    it('should set session cookie', async () => {
      const response = await request(app)
        .get('/auth/login')
        .expect(302);

      expect(response.headers['set-cookie']).toBeDefined();
      expect(response.headers['set-cookie'][0]).toContain('tanda_session');
    });
  });

  describe('GET /auth/callback', () => {
    it('should handle missing code parameter', async () => {
      const response = await request(app)
        .get('/auth/callback')
        .expect('Content-Type', /json/)
        .expect(400);

      expect(response.body).toHaveProperty('error', 'Bad Request');
      expect(response.body.message).toContain('code');
    });

    it('should handle OAuth errors', async () => {
      const response = await request(app)
        .get('/auth/callback')
        .query({
          error: 'access_denied',
          error_description: 'User denied access',
        })
        .expect(400);

      expect(response.body).toHaveProperty('error', 'OAuth Error');
    });
  });

  describe('GET /auth/status', () => {
    it('should return unauthenticated without token', async () => {
      const response = await request(app)
        .get('/auth/status')
        .expect('Content-Type', /json/)
        .expect(200);

      expect(response.body).toHaveProperty('authenticated', false);
      expect(response.body.message).toContain('No token');
    });

    it('should reject invalid token', async () => {
      const response = await request(app)
        .get('/auth/status')
        .set('Authorization', 'Bearer invalid-token')
        .expect(200);

      expect(response.body).toHaveProperty('authenticated', false);
      expect(response.body.message).toContain('Invalid');
    });
  });

  describe('POST /auth/logout', () => {
    it('should return success even without session', async () => {
      const response = await request(app)
        .post('/auth/logout')
        .expect('Content-Type', /json/)
        .expect(200);

      expect(response.body).toHaveProperty('success', true);
    });

    it('should clear session cookie', async () => {
      const response = await request(app)
        .post('/auth/logout')
        .expect(200);

      expect(response.headers['set-cookie']).toBeDefined();
      expect(response.headers['set-cookie'][0]).toContain('tanda_session=;');
    });
  });

  describe('POST /api/authenticate', () => {
    it('should require authorization code', async () => {
      const response = await request(app)
        .post('/api/authenticate')
        .send({})
        .expect('Content-Type', /json/)
        .expect(400);

      expect(response.body).toHaveProperty('error', 'Bad Request');
      expect(response.body.message).toContain('code');
    });
  });

  describe('GET /api/me', () => {
    it('should require authentication', async () => {
      const response = await request(app)
        .get('/api/me')
        .expect('Content-Type', /json/)
        .expect(401);

      expect(response.body).toHaveProperty('error');
    });

    it('should reject invalid token', async () => {
      const response = await request(app)
        .get('/api/me')
        .set('Authorization', 'Bearer invalid-token')
        .expect(401);

      expect(response.body).toHaveProperty('error');
    });
  });
});
