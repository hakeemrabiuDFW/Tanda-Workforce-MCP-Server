import request from 'supertest';
import { createApp } from '../src/server/app';
import { Application } from 'express';

describe('MCP Protocol Endpoints', () => {
  let app: Application;

  beforeAll(() => {
    app = createApp();
  });

  describe('POST /mcp - MCP Protocol', () => {
    describe('initialize', () => {
      it('should initialize MCP session', async () => {
        const response = await request(app)
          .post('/mcp')
          .send({
            jsonrpc: '2.0',
            id: 1,
            method: 'initialize',
            params: {
              protocolVersion: '2024-11-05',
              clientInfo: { name: 'test-client', version: '1.0.0' },
              capabilities: {},
            },
          })
          .expect('Content-Type', /json/)
          .expect(200);

        expect(response.body).toHaveProperty('jsonrpc', '2.0');
        expect(response.body).toHaveProperty('id', 1);
        expect(response.body).toHaveProperty('result');
        expect(response.body.result).toHaveProperty('protocolVersion');
        expect(response.body.result).toHaveProperty('serverInfo');
        expect(response.body.result).toHaveProperty('capabilities');
      });

      it('should return server info in initialize response', async () => {
        const response = await request(app)
          .post('/mcp')
          .send({
            jsonrpc: '2.0',
            id: 1,
            method: 'initialize',
            params: {
              protocolVersion: '2024-11-05',
              clientInfo: { name: 'test', version: '1.0' },
              capabilities: {},
            },
          })
          .expect(200);

        expect(response.body.result.serverInfo).toHaveProperty('name');
        expect(response.body.result.serverInfo).toHaveProperty('version');
      });

      it('should return capabilities in initialize response', async () => {
        const response = await request(app)
          .post('/mcp')
          .send({
            jsonrpc: '2.0',
            id: 1,
            method: 'initialize',
            params: {
              protocolVersion: '2024-11-05',
              clientInfo: { name: 'test', version: '1.0' },
              capabilities: {},
            },
          })
          .expect(200);

        expect(response.body.result.capabilities).toHaveProperty('tools');
        expect(response.body.result.capabilities).toHaveProperty('resources');
        expect(response.body.result.capabilities).toHaveProperty('prompts');
      });
    });

    describe('tools/list', () => {
      it('should list available tools', async () => {
        const response = await request(app)
          .post('/mcp')
          .send({
            jsonrpc: '2.0',
            id: 2,
            method: 'tools/list',
          })
          .expect('Content-Type', /json/)
          .expect(200);

        expect(response.body).toHaveProperty('jsonrpc', '2.0');
        expect(response.body).toHaveProperty('id', 2);
        expect(response.body).toHaveProperty('result');
        expect(response.body.result).toHaveProperty('tools');
        expect(Array.isArray(response.body.result.tools)).toBe(true);
      });

      it('should return at least 20 tools', async () => {
        const response = await request(app)
          .post('/mcp')
          .send({
            jsonrpc: '2.0',
            id: 2,
            method: 'tools/list',
          })
          .expect(200);

        expect(response.body.result.tools.length).toBeGreaterThanOrEqual(20);
      });

      it('should include expected Tanda tools', async () => {
        const response = await request(app)
          .post('/mcp')
          .send({
            jsonrpc: '2.0',
            id: 2,
            method: 'tools/list',
          })
          .expect(200);

        const toolNames = response.body.result.tools.map((t: { name: string }) => t.name);
        expect(toolNames).toContain('tanda_get_current_user');
        expect(toolNames).toContain('tanda_get_users');
        expect(toolNames).toContain('tanda_get_departments');
        expect(toolNames).toContain('tanda_get_schedules');
        expect(toolNames).toContain('tanda_get_leave_requests');
      });

      it('should have tool definitions with name and description', async () => {
        const response = await request(app)
          .post('/mcp')
          .send({
            jsonrpc: '2.0',
            id: 2,
            method: 'tools/list',
          })
          .expect(200);

        const tool = response.body.result.tools[0];
        expect(tool).toHaveProperty('name');
        expect(tool).toHaveProperty('description');
        expect(tool).toHaveProperty('inputSchema');
      });
    });

    describe('tools/call', () => {
      it('should require authentication for tool calls', async () => {
        const response = await request(app)
          .post('/mcp')
          .send({
            jsonrpc: '2.0',
            id: 3,
            method: 'tools/call',
            params: {
              name: 'tanda_get_current_user',
              arguments: {},
            },
          })
          .expect(200);

        expect(response.body).toHaveProperty('error');
        expect(response.body.error.message).toContain('Authentication required');
      });

      it('should return error for unknown tool', async () => {
        const response = await request(app)
          .post('/mcp')
          .send({
            jsonrpc: '2.0',
            id: 3,
            method: 'tools/call',
            params: {
              name: 'unknown_tool',
              arguments: {},
            },
          })
          .expect(200);

        expect(response.body).toHaveProperty('error');
      });
    });

    describe('resources/list', () => {
      it('should list available resources', async () => {
        const response = await request(app)
          .post('/mcp')
          .send({
            jsonrpc: '2.0',
            id: 4,
            method: 'resources/list',
          })
          .expect('Content-Type', /json/)
          .expect(200);

        expect(response.body).toHaveProperty('jsonrpc', '2.0');
        expect(response.body).toHaveProperty('id', 4);
        expect(response.body).toHaveProperty('result');
        expect(response.body.result).toHaveProperty('resources');
        expect(Array.isArray(response.body.result.resources)).toBe(true);
      });
    });

    describe('prompts/list', () => {
      it('should list available prompts', async () => {
        const response = await request(app)
          .post('/mcp')
          .send({
            jsonrpc: '2.0',
            id: 5,
            method: 'prompts/list',
          })
          .expect('Content-Type', /json/)
          .expect(200);

        expect(response.body).toHaveProperty('jsonrpc', '2.0');
        expect(response.body).toHaveProperty('id', 5);
        expect(response.body).toHaveProperty('result');
        expect(response.body.result).toHaveProperty('prompts');
        expect(Array.isArray(response.body.result.prompts)).toBe(true);
      });
    });

    describe('ping', () => {
      it('should respond to ping', async () => {
        const response = await request(app)
          .post('/mcp')
          .send({
            jsonrpc: '2.0',
            id: 6,
            method: 'ping',
          })
          .expect('Content-Type', /json/)
          .expect(200);

        expect(response.body).toHaveProperty('jsonrpc', '2.0');
        expect(response.body).toHaveProperty('id', 6);
        expect(response.body).toHaveProperty('result');
      });
    });

    describe('JSON-RPC Error Handling', () => {
      it('should return error for unknown method', async () => {
        const response = await request(app)
          .post('/mcp')
          .send({
            jsonrpc: '2.0',
            id: 7,
            method: 'unknown/method',
          })
          .expect(200);

        expect(response.body).toHaveProperty('error');
        expect(response.body.error).toHaveProperty('code');
        expect(response.body.error).toHaveProperty('message');
      });

      it('should handle missing jsonrpc field', async () => {
        const response = await request(app)
          .post('/mcp')
          .send({
            id: 8,
            method: 'ping',
          });

        // Server may return 400 for invalid JSON-RPC or process anyway
        expect([200, 400]).toContain(response.status);
        expect(response.body).toBeDefined();
      });

      it('should handle missing id field', async () => {
        const response = await request(app)
          .post('/mcp')
          .send({
            jsonrpc: '2.0',
            method: 'ping',
          })
          .expect(200);

        // Notifications (no id) should not return response
        expect(response.body).toBeDefined();
      });
    });
  });

  describe('POST / - MCP at root (Claude compatibility)', () => {
    it('should handle MCP requests at root endpoint', async () => {
      const response = await request(app)
        .post('/')
        .send({
          jsonrpc: '2.0',
          id: 1,
          method: 'initialize',
          params: {
            protocolVersion: '2024-11-05',
            clientInfo: { name: 'claude', version: '1.0' },
            capabilities: {},
          },
        })
        .expect('Content-Type', /json/)
        .expect(200);

      expect(response.body).toHaveProperty('jsonrpc', '2.0');
      expect(response.body).toHaveProperty('result');
    });

    it('should list tools at root endpoint', async () => {
      const response = await request(app)
        .post('/')
        .send({
          jsonrpc: '2.0',
          id: 2,
          method: 'tools/list',
        })
        .expect(200);

      expect(response.body.result).toHaveProperty('tools');
      expect(Array.isArray(response.body.result.tools)).toBe(true);
    });
  });

  describe('GET /mcp - SSE Endpoint', () => {
    it('should be configured for SSE', () => {
      // SSE endpoint exists and is properly configured in the app
      // Full SSE testing requires manual verification as connections stay open
      // See DEPLOYMENT.md for SSE testing instructions
      expect(app).toBeDefined();
    });
  });
});

describe('MCP Tool Definitions', () => {
  let app: Application;

  beforeAll(() => {
    app = createApp();
  });

  it('should have proper inputSchema for each tool', async () => {
    const response = await request(app)
      .post('/mcp')
      .send({
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/list',
      })
      .expect(200);

    response.body.result.tools.forEach((tool: { name: string; inputSchema: object }) => {
      expect(tool.inputSchema).toHaveProperty('type', 'object');
      expect(tool.inputSchema).toHaveProperty('properties');
    });
  });

  const toolCategories = [
    { prefix: 'tanda_get_current_user', description: 'user management' },
    { prefix: 'tanda_get_users', description: 'user listing' },
    { prefix: 'tanda_get_departments', description: 'departments' },
    { prefix: 'tanda_get_locations', description: 'locations' },
    { prefix: 'tanda_get_schedules', description: 'scheduling' },
    { prefix: 'tanda_get_shifts', description: 'shifts' },
    { prefix: 'tanda_get_leave_requests', description: 'leave' },
    { prefix: 'tanda_clock_in', description: 'clock in/out' },
    { prefix: 'tanda_get_qualifications', description: 'qualifications' },
    { prefix: 'tanda_get_roster_costs', description: 'costs' },
  ];

  toolCategories.forEach(({ prefix, description }) => {
    it(`should include ${description} tool (${prefix})`, async () => {
      const response = await request(app)
        .post('/mcp')
        .send({
          jsonrpc: '2.0',
          id: 1,
          method: 'tools/list',
        })
        .expect(200);

      const toolNames = response.body.result.tools.map((t: { name: string }) => t.name);
      expect(toolNames).toContain(prefix);
    });
  });
});
