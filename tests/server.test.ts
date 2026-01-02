import request from 'supertest';
import { createApp } from '../src/server/app';
import { Application } from 'express';

describe('Server Endpoints', () => {
  let app: Application;

  beforeAll(() => {
    app = createApp();
  });

  describe('GET /health', () => {
    it('should return healthy status', async () => {
      const response = await request(app)
        .get('/health')
        .expect('Content-Type', /json/)
        .expect(200);

      expect(response.body).toHaveProperty('status', 'healthy');
      expect(response.body).toHaveProperty('timestamp');
      expect(response.body).toHaveProperty('version');
    });
  });

  describe('GET /', () => {
    it('should return server info', async () => {
      const response = await request(app)
        .get('/')
        .expect('Content-Type', /json/)
        .expect(200);

      expect(response.body).toHaveProperty('name');
      expect(response.body).toHaveProperty('version');
      expect(response.body).toHaveProperty('description');
      expect(response.body).toHaveProperty('endpoints');
    });

    it('should include all endpoint categories', async () => {
      const response = await request(app)
        .get('/')
        .expect(200);

      const endpoints = response.body.endpoints;
      expect(endpoints).toHaveProperty('health');
      expect(endpoints).toHaveProperty('oauth');
      expect(endpoints).toHaveProperty('auth');
      expect(endpoints).toHaveProperty('api');
      expect(endpoints).toHaveProperty('mcp');
    });

    it('should include OAuth endpoints', async () => {
      const response = await request(app)
        .get('/')
        .expect(200);

      const oauthEndpoints = response.body.endpoints.oauth;
      expect(oauthEndpoints).toHaveProperty('authorize');
      expect(oauthEndpoints).toHaveProperty('token');
      expect(oauthEndpoints).toHaveProperty('discovery');
    });
  });

  describe('GET /docs', () => {
    it('should return API documentation', async () => {
      const response = await request(app)
        .get('/docs')
        .expect('Content-Type', /json/)
        .expect(200);

      expect(response.body).toHaveProperty('title');
      expect(response.body).toHaveProperty('version');
      expect(response.body).toHaveProperty('authentication');
      expect(response.body).toHaveProperty('endpoints');
      expect(response.body).toHaveProperty('mcp');
    });

    it('should document MCP methods', async () => {
      const response = await request(app)
        .get('/docs')
        .expect(200);

      const mcpMethods = response.body.mcp.methods;
      expect(mcpMethods).toContain('initialize');
      expect(mcpMethods).toContain('tools/list');
      expect(mcpMethods).toContain('tools/call');
      expect(mcpMethods).toContain('ping');
    });
  });

  describe('GET /stats', () => {
    it('should return server statistics', async () => {
      const response = await request(app)
        .get('/stats')
        .expect('Content-Type', /json/)
        .expect(200);

      expect(response.body).toHaveProperty('server');
      expect(response.body.server).toHaveProperty('name');
      expect(response.body.server).toHaveProperty('version');
      expect(response.body.server).toHaveProperty('uptime');
      expect(response.body.server).toHaveProperty('memory');
      expect(response.body).toHaveProperty('sessions');
    });
  });

  describe('404 Handler', () => {
    it('should return 404 for unknown routes', async () => {
      const response = await request(app)
        .get('/unknown-endpoint')
        .expect('Content-Type', /json/)
        .expect(404);

      expect(response.body).toHaveProperty('error', 'Not Found');
      expect(response.body).toHaveProperty('message');
    });
  });
});
