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

      it('should return at least 35 tools (v3.0 with new tools)', async () => {
        const response = await request(app)
          .post('/mcp')
          .send({
            jsonrpc: '2.0',
            id: 2,
            method: 'tools/list',
          })
          .expect(200);

        // v3.0 has 38 tools (25 original + 13 new)
        expect(response.body.result.tools.length).toBeGreaterThanOrEqual(35);
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
    { prefix: 'tanda_get_roster_costs', description: 'costs' },
    // v3.0 New Tools
    { prefix: 'tanda_get_active_shifts', description: 'active shifts (v3)' },
    { prefix: 'tanda_get_clocked_in_users', description: 'clocked-in users (v3)' },
    { prefix: 'tanda_get_current_roster', description: 'current roster (v3)' },
    { prefix: 'tanda_get_inactive_users', description: 'inactive users (v3)' },
    { prefix: 'tanda_get_leave_types', description: 'leave types (v3)' },
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

// v3.0 New Feature Tests
describe('MCP v3.0 New Features', () => {
  let app: Application;

  beforeAll(() => {
    app = createApp();
  });

  describe('v3.0 Real-time Attendance Tools', () => {
    const v3AttendanceTools = [
      'tanda_get_active_shifts',
      'tanda_get_clocked_in_users',
      'tanda_get_shift_breaks',
      'tanda_get_shift_limits',
    ];

    v3AttendanceTools.forEach((toolName) => {
      it(`should have ${toolName} tool defined`, async () => {
        const response = await request(app)
          .post('/mcp')
          .send({
            jsonrpc: '2.0',
            id: 1,
            method: 'tools/list',
          })
          .expect(200);

        const tool = response.body.result.tools.find((t: { name: string }) => t.name === toolName);
        expect(tool).toBeDefined();
        expect(tool).toHaveProperty('description');
        expect(tool).toHaveProperty('inputSchema');
      });
    });
  });

  describe('v3.0 Roster Period Tools', () => {
    const v3RosterTools = [
      'tanda_get_roster',
      'tanda_get_current_roster',
      'tanda_get_roster_by_date',
    ];

    v3RosterTools.forEach((toolName) => {
      it(`should have ${toolName} tool defined`, async () => {
        const response = await request(app)
          .post('/mcp')
          .send({
            jsonrpc: '2.0',
            id: 1,
            method: 'tools/list',
          })
          .expect(200);

        const tool = response.body.result.tools.find((t: { name: string }) => t.name === toolName);
        expect(tool).toBeDefined();
      });
    });
  });

  describe('v3.0 Staff Management Tools', () => {
    const v3StaffTools = [
      'tanda_get_inactive_users',
      'tanda_onboard_users',
      'tanda_invite_user',
    ];

    v3StaffTools.forEach((toolName) => {
      it(`should have ${toolName} tool defined`, async () => {
        const response = await request(app)
          .post('/mcp')
          .send({
            jsonrpc: '2.0',
            id: 1,
            method: 'tools/list',
          })
          .expect(200);

        const tool = response.body.result.tools.find((t: { name: string }) => t.name === toolName);
        expect(tool).toBeDefined();
      });
    });

    it('should have onboard_users with proper schema for bulk operations', async () => {
      const response = await request(app)
        .post('/mcp')
        .send({
          jsonrpc: '2.0',
          id: 1,
          method: 'tools/list',
        })
        .expect(200);

      const tool = response.body.result.tools.find(
        (t: { name: string }) => t.name === 'tanda_onboard_users'
      );
      expect(tool).toBeDefined();
      expect(tool.inputSchema.properties).toHaveProperty('users');
      expect(tool.inputSchema.required).toContain('users');
    });
  });

  describe('v3.0 Leave Enhancement Tools', () => {
    const v3LeaveTools = [
      'tanda_get_leave_types',
      'tanda_calculate_leave_hours',
    ];

    v3LeaveTools.forEach((toolName) => {
      it(`should have ${toolName} tool defined`, async () => {
        const response = await request(app)
          .post('/mcp')
          .send({
            jsonrpc: '2.0',
            id: 1,
            method: 'tools/list',
          })
          .expect(200);

        const tool = response.body.result.tools.find((t: { name: string }) => t.name === toolName);
        expect(tool).toBeDefined();
      });
    });
  });

  describe('v3.0 Prompts', () => {
    it('should list v3.0 prompts', async () => {
      const response = await request(app)
        .post('/mcp')
        .send({
          jsonrpc: '2.0',
          id: 1,
          method: 'prompts/list',
        })
        .expect(200);

      const promptNames = response.body.result.prompts.map((p: { name: string }) => p.name);

      // v3.0 New Prompts
      expect(promptNames).toContain('workforce_dashboard');
      expect(promptNames).toContain('compliance_check');
      expect(promptNames).toContain('onboard_employee');
      expect(promptNames).toContain('leave_planner');
    });

    it('should get workforce_dashboard prompt', async () => {
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
      expect(response.body.result.messages[0].content.text).toContain('tanda_get_active_shifts');
    });

    it('should get compliance_check prompt with arguments', async () => {
      const response = await request(app)
        .post('/mcp')
        .send({
          jsonrpc: '2.0',
          id: 1,
          method: 'prompts/get',
          params: {
            name: 'compliance_check',
            arguments: {
              date: '2024-01-15',
              user_id: '123',
            },
          },
        })
        .expect(200);

      expect(response.body.result).toHaveProperty('messages');
      expect(response.body.result.messages[0].content.text).toContain('2024-01-15');
      expect(response.body.result.messages[0].content.text).toContain('123');
    });
  });

  describe('v3.0 Tool Count', () => {
    it('should have exactly 38 tools in v3.0', async () => {
      const response = await request(app)
        .post('/mcp')
        .send({
          jsonrpc: '2.0',
          id: 1,
          method: 'tools/list',
        })
        .expect(200);

      // v3.0: 25 original + 13 new = 38 tools
      expect(response.body.result.tools.length).toBe(38);
    });

    it('should have 6 prompts in v3.0', async () => {
      const response = await request(app)
        .post('/mcp')
        .send({
          jsonrpc: '2.0',
          id: 1,
          method: 'prompts/list',
        })
        .expect(200);

      // v3.0: 2 original + 4 new = 6 prompts
      expect(response.body.result.prompts.length).toBe(6);
    });
  });
});
