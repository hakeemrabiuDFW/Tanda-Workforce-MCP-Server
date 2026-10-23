import request from 'supertest';
import { createApp } from '../src/server/app';
import { Application } from 'express';

const AUTH = `Bearer ${process.env.MCP_SHARED_SECRET}`;

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
          .set('Authorization', AUTH)
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
          .set('Authorization', AUTH)
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
        expect(response.body.result.serverInfo.version).toBe('4.0.1');
      });

      it('should return capabilities in initialize response', async () => {
        const response = await request(app)
          .post('/mcp')
          .set('Authorization', AUTH)
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
          .set('Authorization', AUTH)
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

      it('should return exactly 12 tools (v4.0)', async () => {
        const response = await request(app)
          .post('/mcp')
          .set('Authorization', AUTH)
          .send({
            jsonrpc: '2.0',
            id: 2,
            method: 'tools/list',
          })
          .expect(200);

        expect(response.body.result.tools.length).toBe(12);
      });

      it('should include expected v4.0 consolidated tools', async () => {
        const response = await request(app)
          .post('/mcp')
          .set('Authorization', AUTH)
          .send({
            jsonrpc: '2.0',
            id: 2,
            method: 'tools/list',
          })
          .expect(200);

        const toolNames = response.body.result.tools.map((t: { name: string }) => t.name);
        expect(toolNames).toEqual([
          'tanda_org', 'tanda_people', 'tanda_schedules', 'tanda_timesheets', 'tanda_live', 'tanda_time_off',
          'tanda_labor_summary', 'tanda_coverage', 'tanda_validate_schedule', 'tanda_exceptions',
          'tanda_export_preview', 'tanda_change_history',
        ]);
      });

      it('should have paging params on list tools', async () => {
        const response = await request(app)
          .post('/mcp')
          .set('Authorization', AUTH)
          .send({ jsonrpc: '2.0', id: 2, method: 'tools/list' })
          .expect(200);

        const tool = response.body.result.tools.find((t: { name: string }) => t.name === 'tanda_people');
        expect(tool.inputSchema.properties).toHaveProperty('offset');
        expect(tool.inputSchema.properties).toHaveProperty('limit');
      });
    });

    describe('tools/call', () => {
      it('should reject unauthenticated tool calls with 401', async () => {
        const response = await request(app)
          .post('/mcp')
          .send({
            jsonrpc: '2.0',
            id: 3,
            method: 'tools/call',
            params: {
              name: 'tanda_people',
              arguments: { me: true },
            },
          })
          .expect(401);

        expect(response.body).toHaveProperty('error', 'unauthorized');
        expect(response.headers['www-authenticate']).toContain('resource_metadata');
      });

      it('should return error for unknown tool', async () => {
        const response = await request(app)
          .post('/mcp')
          .set('Authorization', AUTH)
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
          .set('Authorization', AUTH)
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
          .set('Authorization', AUTH)
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
          .set('Authorization', AUTH)
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
          .set('Authorization', AUTH)
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
    });
  });

  describe('POST / - MCP at root (Claude compatibility)', () => {
    it('should handle MCP requests at root endpoint', async () => {
      const response = await request(app)
        .post('/')
        .set('Authorization', AUTH)
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
        .set('Authorization', AUTH)
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
});

describe('MCP v4.0 Consolidated Tool Definitions', () => {
  let app: Application;

  beforeAll(() => {
    app = createApp();
  });

  it('should have proper inputSchema for each tool', async () => {
    const response = await request(app)
      .post('/mcp')
          .set('Authorization', AUTH)
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

});

describe('MCP v4.0 Features', () => {
  let app: Application;

  beforeAll(() => {
    app = createApp();
  });

  describe('Prompts', () => {
    it('should list prompts', async () => {
      const response = await request(app)
        .post('/mcp')
          .set('Authorization', AUTH)
        .send({
          jsonrpc: '2.0',
          id: 1,
          method: 'prompts/list',
        })
        .expect(200);

      const promptNames = response.body.result.prompts.map((p: { name: string }) => p.name);
      expect(promptNames).toContain('workforce_dashboard');
      expect(promptNames).toContain('compliance_check');
      expect(promptNames).not.toContain('onboard_employee');
      expect(promptNames).toContain('leave_planner');
    });

    it('should get workforce_dashboard prompt with v4.0 tool references', async () => {
      const response = await request(app)
        .post('/mcp')
          .set('Authorization', AUTH)
        .send({
          jsonrpc: '2.0',
          id: 1,
          method: 'prompts/get',
          params: {
            name: 'workforce_dashboard',
          },
        })
        .expect(200);

      expect(response.body.result).toHaveProperty('messages');
      // v4.0 uses consolidated tool names with action parameter
      expect(response.body.result.messages[0].content.text).toContain('tanda_live');
      expect(response.body.result.messages[0].content.text).toContain('tanda_exceptions');
    });
  });

  describe('Tool Count', () => {
    it('should have exactly 12 tools in v4.0', async () => {
      const response = await request(app)
        .post('/mcp')
          .set('Authorization', AUTH)
        .send({
          jsonrpc: '2.0',
          id: 1,
          method: 'tools/list',
        })
        .expect(200);

      expect(response.body.result.tools.length).toBe(12);
    });

    it('should have 5 read-only prompts', async () => {
      const response = await request(app)
        .post('/mcp')
          .set('Authorization', AUTH)
        .send({
          jsonrpc: '2.0',
          id: 1,
          method: 'prompts/list',
        })
        .expect(200);

      expect(response.body.result.prompts.length).toBe(5);
    });
  });

  describe('Short Descriptions', () => {
    it('should have concise descriptions (< 330 chars)', async () => {
      const response = await request(app)
        .post('/mcp')
          .set('Authorization', AUTH)
        .send({
          jsonrpc: '2.0',
          id: 1,
          method: 'tools/list',
        })
        .expect(200);

      response.body.result.tools.forEach((tool: { name: string; description: string }) => {
        expect(tool.description.length).toBeLessThan(330);
      });
    });
  });
});
