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
        expect(response.body.result.serverInfo.version).toBe('4.0.0');
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

      it('should return exactly 9 consolidated tools (v4.0)', async () => {
        const response = await request(app)
          .post('/mcp')
          .send({
            jsonrpc: '2.0',
            id: 2,
            method: 'tools/list',
          })
          .expect(200);

        // v4.0 consolidated to 9 tools
        expect(response.body.result.tools.length).toBe(9);
      });

      it('should include expected v4.0 consolidated tools', async () => {
        const response = await request(app)
          .post('/mcp')
          .send({
            jsonrpc: '2.0',
            id: 2,
            method: 'tools/list',
          })
          .expect(200);

        const toolNames = response.body.result.tools.map((t: { name: string }) => t.name);
        expect(toolNames).toContain('tanda_users');
        expect(toolNames).toContain('tanda_schedules');
        expect(toolNames).toContain('tanda_timesheets');
        expect(toolNames).toContain('tanda_leave');
        expect(toolNames).toContain('tanda_rosters');
        expect(toolNames).toContain('tanda_reference');
        expect(toolNames).toContain('tanda_realtime');
        expect(toolNames).toContain('tanda_unavailability');
        expect(toolNames).toContain('tanda_supervisors');
      });

      it('should have tool definitions with action enum', async () => {
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
        expect(tool.inputSchema.properties).toHaveProperty('action');
        expect(tool.inputSchema.properties.action).toHaveProperty('enum');
      });

      it('should have pagination params on list tools', async () => {
        const response = await request(app)
          .post('/mcp')
          .send({
            jsonrpc: '2.0',
            id: 2,
            method: 'tools/list',
          })
          .expect(200);

        const usersTool = response.body.result.tools.find((t: { name: string }) => t.name === 'tanda_users');
        expect(usersTool.inputSchema.properties).toHaveProperty('limit');
        expect(usersTool.inputSchema.properties).toHaveProperty('page');
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
              name: 'tanda_users',
              arguments: { action: 'current' },
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
});

describe('MCP v4.0 Consolidated Tool Definitions', () => {
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

  const v4Tools = [
    { name: 'tanda_users', actions: ['list', 'get', 'inactive', 'onboard', 'invite', 'by_department', 'current'] },
    { name: 'tanda_schedules', actions: ['list', 'get', 'create', 'update', 'delete', 'publish'] },
    { name: 'tanda_timesheets', actions: ['shifts', 'timesheets', 'approve_shift', 'approve_timesheet', 'breaks'] },
    { name: 'tanda_leave', actions: ['list', 'create', 'approve', 'decline', 'delete', 'balances', 'types', 'calculate_hours'] },
    { name: 'tanda_rosters', actions: ['get', 'current', 'by_date'] },
    { name: 'tanda_reference', actions: ['departments', 'locations', 'teams', 'daily_stats'] },
    { name: 'tanda_realtime', actions: ['active_shifts', 'clocked_in', 'shift_limits', 'award_interpretation', 'roster_costs'] },
    { name: 'tanda_unavailability', actions: ['list', 'create', 'delete'] },
    { name: 'tanda_supervisors', actions: ['detect_overlaps', 'evening_coverage', 'recommendations', 'optimize', 'validate', 'create_optimized'] },
  ];

  v4Tools.forEach(({ name, actions }) => {
    it(`should have ${name} tool with correct actions`, async () => {
      const response = await request(app)
        .post('/mcp')
        .send({
          jsonrpc: '2.0',
          id: 1,
          method: 'tools/list',
        })
        .expect(200);

      const tool = response.body.result.tools.find((t: { name: string }) => t.name === name);
      expect(tool).toBeDefined();
      expect(tool.inputSchema.properties.action.enum).toEqual(actions);
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
        .send({
          jsonrpc: '2.0',
          id: 1,
          method: 'prompts/list',
        })
        .expect(200);

      const promptNames = response.body.result.prompts.map((p: { name: string }) => p.name);
      expect(promptNames).toContain('workforce_dashboard');
      expect(promptNames).toContain('compliance_check');
      expect(promptNames).toContain('onboard_employee');
      expect(promptNames).toContain('leave_planner');
    });

    it('should get workforce_dashboard prompt with v4.0 tool references', async () => {
      const response = await request(app)
        .post('/mcp')
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
      expect(response.body.result.messages[0].content.text).toContain('tanda_realtime');
      expect(response.body.result.messages[0].content.text).toContain('action=active_shifts');
    });
  });

  describe('Tool Count', () => {
    it('should have exactly 9 consolidated tools in v4.0', async () => {
      const response = await request(app)
        .post('/mcp')
        .send({
          jsonrpc: '2.0',
          id: 1,
          method: 'tools/list',
        })
        .expect(200);

      expect(response.body.result.tools.length).toBe(9);
    });

    it('should have 6 prompts', async () => {
      const response = await request(app)
        .post('/mcp')
        .send({
          jsonrpc: '2.0',
          id: 1,
          method: 'prompts/list',
        })
        .expect(200);

      expect(response.body.result.prompts.length).toBe(6);
    });
  });

  describe('Short Descriptions', () => {
    it('should have short descriptions (< 150 chars)', async () => {
      const response = await request(app)
        .post('/mcp')
        .send({
          jsonrpc: '2.0',
          id: 1,
          method: 'tools/list',
        })
        .expect(200);

      response.body.result.tools.forEach((tool: { name: string; description: string }) => {
        expect(tool.description.length).toBeLessThan(150);
      });
    });
  });
});
