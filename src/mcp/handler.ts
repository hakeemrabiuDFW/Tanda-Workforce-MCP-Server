import { Request, Response } from 'express';
import { config } from '../config/environment';
import { logger } from '../utils/logger';
import { tandaTools, executeTool, getAvailableTools } from './tools';
import { TandaClient } from '../tanda/client';

// MCP Protocol Types
interface MCPRequest {
  jsonrpc: '2.0';
  id: string | number;
  method: string;
  params?: Record<string, unknown>;
}

interface MCPResponse {
  jsonrpc: '2.0';
  id: string | number;
  result?: unknown;
  error?: {
    code: number;
    message: string;
    data?: unknown;
  };
}

// MCP Error Codes
const MCP_ERROR_CODES = {
  PARSE_ERROR: -32700,
  INVALID_REQUEST: -32600,
  METHOD_NOT_FOUND: -32601,
  INVALID_PARAMS: -32602,
  INTERNAL_ERROR: -32603,
};

export class MCPHandler {
  private serverName: string;
  private serverVersion: string;

  constructor() {
    this.serverName = config.MCP_SERVER_NAME;
    this.serverVersion = config.MCP_SERVER_VERSION;
  }

  // Handle incoming MCP request
  async handleRequest(
    request: MCPRequest,
    tandaClient: TandaClient | null
  ): Promise<MCPResponse> {
    logger.debug(`MCP Request: ${request.method}`, { id: request.id, params: request.params });

    try {
      switch (request.method) {
        case 'initialize':
          return this.handleInitialize(request);

        case 'tools/list':
          return this.handleListTools(request);

        case 'tools/call':
          return this.handleCallTool(request, tandaClient);

        case 'resources/list':
          return this.handleListResources(request);

        case 'resources/read':
          return this.handleReadResource(request, tandaClient);

        case 'prompts/list':
          return this.handleListPrompts(request);

        case 'prompts/get':
          return this.handleGetPrompt(request);

        case 'ping':
          return this.handlePing(request);

        default:
          return this.createErrorResponse(
            request.id,
            MCP_ERROR_CODES.METHOD_NOT_FOUND,
            `Method not found: ${request.method}`
          );
      }
    } catch (error) {
      logger.error('MCP request failed:', error);
      return this.createErrorResponse(
        request.id,
        MCP_ERROR_CODES.INTERNAL_ERROR,
        error instanceof Error ? error.message : 'Internal error'
      );
    }
  }

  // Initialize handshake
  private handleInitialize(request: MCPRequest): MCPResponse {
    return {
      jsonrpc: '2.0',
      id: request.id,
      result: {
        protocolVersion: '2024-11-05',
        serverInfo: {
          name: this.serverName,
          version: this.serverVersion,
        },
        capabilities: {
          tools: {
            listChanged: false,
          },
          resources: {
            subscribe: false,
            listChanged: false,
          },
          prompts: {
            listChanged: false,
          },
        },
      },
    };
  }

  // List available tools (v3.0: respects read-only mode)
  private handleListTools(request: MCPRequest): MCPResponse {
    return {
      jsonrpc: '2.0',
      id: request.id,
      result: {
        tools: getAvailableTools(),
      },
    };
  }

  // Call a tool
  private async handleCallTool(
    request: MCPRequest,
    tandaClient: TandaClient | null
  ): Promise<MCPResponse> {
    const params = request.params as { name: string; arguments?: Record<string, unknown> } | undefined;

    if (!params?.name) {
      return this.createErrorResponse(
        request.id,
        MCP_ERROR_CODES.INVALID_PARAMS,
        'Tool name is required'
      );
    }

    if (!tandaClient) {
      return this.createErrorResponse(
        request.id,
        MCP_ERROR_CODES.INVALID_REQUEST,
        'Authentication required. Please authenticate with Tanda first.'
      );
    }

    const tool = tandaTools.find((t) => t.name === params.name);
    if (!tool) {
      return this.createErrorResponse(
        request.id,
        MCP_ERROR_CODES.METHOD_NOT_FOUND,
        `Tool not found: ${params.name}`
      );
    }

    const result = await executeTool(tandaClient, params.name, params.arguments || {});

    return {
      jsonrpc: '2.0',
      id: request.id,
      result: {
        content: [
          {
            type: 'text',
            text: JSON.stringify(result.content, null, 2),
          },
        ],
        isError: result.isError,
      },
    };
  }

  // List resources
  private handleListResources(request: MCPRequest): MCPResponse {
    return {
      jsonrpc: '2.0',
      id: request.id,
      result: {
        resources: [
          {
            uri: 'tanda://organization/info',
            name: 'Organization Info',
            description: 'Basic information about the Tanda organization',
            mimeType: 'application/json',
          },
          {
            uri: 'tanda://user/current',
            name: 'Current User',
            description: 'Information about the currently authenticated user',
            mimeType: 'application/json',
          },
        ],
      },
    };
  }

  // Read a resource
  private async handleReadResource(
    request: MCPRequest,
    tandaClient: TandaClient | null
  ): Promise<MCPResponse> {
    const params = request.params as { uri: string } | undefined;

    if (!params?.uri) {
      return this.createErrorResponse(
        request.id,
        MCP_ERROR_CODES.INVALID_PARAMS,
        'Resource URI is required'
      );
    }

    if (!tandaClient) {
      return this.createErrorResponse(
        request.id,
        MCP_ERROR_CODES.INVALID_REQUEST,
        'Authentication required'
      );
    }

    try {
      let content: unknown;

      switch (params.uri) {
        case 'tanda://user/current':
          content = await tandaClient.getCurrentUser();
          break;

        case 'tanda://organization/info':
          // Return basic org info (departments and locations)
          const [departments, locations] = await Promise.all([
            tandaClient.getDepartments(),
            tandaClient.getLocations(),
          ]);
          content = {
            departments,
            locations,
            departmentCount: departments.length,
            locationCount: locations.length,
          };
          break;

        default:
          return this.createErrorResponse(
            request.id,
            MCP_ERROR_CODES.INVALID_PARAMS,
            `Unknown resource: ${params.uri}`
          );
      }

      return {
        jsonrpc: '2.0',
        id: request.id,
        result: {
          contents: [
            {
              uri: params.uri,
              mimeType: 'application/json',
              text: JSON.stringify(content, null, 2),
            },
          ],
        },
      };
    } catch (error) {
      return this.createErrorResponse(
        request.id,
        MCP_ERROR_CODES.INTERNAL_ERROR,
        error instanceof Error ? error.message : 'Failed to read resource'
      );
    }
  }

  // List prompts (v3.0: includes new workflow prompts)
  private handleListPrompts(request: MCPRequest): MCPResponse {
    return {
      jsonrpc: '2.0',
      id: request.id,
      result: {
        prompts: [
          {
            name: 'schedule_overview',
            description: 'Get an overview of the schedule for a specific date range',
            arguments: [
              {
                name: 'from',
                description: 'Start date (YYYY-MM-DD)',
                required: true,
              },
              {
                name: 'to',
                description: 'End date (YYYY-MM-DD)',
                required: true,
              },
            ],
          },
          {
            name: 'team_availability',
            description: 'Check team availability including leave and scheduled shifts',
            arguments: [
              {
                name: 'date',
                description: 'Date to check (YYYY-MM-DD)',
                required: true,
              },
              {
                name: 'department_id',
                description: 'Department ID to filter by',
                required: false,
              },
            ],
          },
          // v3.0 New Prompts
          {
            name: 'workforce_dashboard',
            description: 'Real-time workforce overview with active shifts, attendance, and alerts',
            arguments: [],
          },
          {
            name: 'compliance_check',
            description: 'Check compliance status: breaks taken, hour limits, award requirements',
            arguments: [
              {
                name: 'date',
                description: 'Date to check (YYYY-MM-DD, defaults to today)',
                required: false,
              },
              {
                name: 'user_id',
                description: 'Specific user ID to check (optional)',
                required: false,
              },
            ],
          },
          {
            name: 'onboard_employee',
            description: 'Step-by-step guided employee onboarding workflow',
            arguments: [
              {
                name: 'email',
                description: 'New employee email address',
                required: true,
              },
              {
                name: 'name',
                description: 'New employee full name',
                required: true,
              },
            ],
          },
          {
            name: 'leave_planner',
            description: 'Check leave balances, available types, and plan leave requests',
            arguments: [
              {
                name: 'user_id',
                description: 'User ID to plan leave for',
                required: true,
              },
            ],
          },
        ],
      },
    };
  }

  // Get a specific prompt
  private handleGetPrompt(request: MCPRequest): MCPResponse {
    const params = request.params as { name: string; arguments?: Record<string, string> } | undefined;

    if (!params?.name) {
      return this.createErrorResponse(
        request.id,
        MCP_ERROR_CODES.INVALID_PARAMS,
        'Prompt name is required'
      );
    }

    const promptArgs = params.arguments || {};

    switch (params.name) {
      case 'schedule_overview':
        return {
          jsonrpc: '2.0',
          id: request.id,
          result: {
            description: 'Get schedule overview',
            messages: [
              {
                role: 'user',
                content: {
                  type: 'text',
                  text: `Please provide an overview of the schedule from ${promptArgs.from || '[start date]'} to ${promptArgs.to || '[end date]'}. Include:
1. Total scheduled shifts
2. Coverage by department
3. Any gaps or understaffing
4. Pending leave requests that might affect coverage`,
                },
              },
            ],
          },
        };

      case 'team_availability':
        return {
          jsonrpc: '2.0',
          id: request.id,
          result: {
            description: 'Check team availability',
            messages: [
              {
                role: 'user',
                content: {
                  type: 'text',
                  text: `Check team availability for ${promptArgs.date || '[date]'}${promptArgs.department_id ? ` in department ${promptArgs.department_id}` : ''}. Show:
1. Who is scheduled to work
2. Who is on leave
3. Who is available but not scheduled
4. Any qualification requirements that might affect assignments`,
                },
              },
            ],
          },
        };

      // v3.0 New Prompt Handlers
      case 'workforce_dashboard':
        return {
          jsonrpc: '2.0',
          id: request.id,
          result: {
            description: 'Real-time workforce dashboard',
            messages: [
              {
                role: 'user',
                content: {
                  type: 'text',
                  text: `Generate a real-time workforce dashboard showing:
1. Currently active shifts - who is working right now (use tanda_get_active_shifts)
2. Clocked-in employees - real-time attendance status (use tanda_get_clocked_in_users)
3. Current roster period overview (use tanda_get_current_roster)
4. Any shift limit warnings or compliance alerts (use tanda_get_shift_limits)
5. Pending leave requests that need attention

Format the dashboard with clear sections and highlight any items requiring immediate attention.`,
                },
              },
            ],
          },
        };

      case 'compliance_check':
        return {
          jsonrpc: '2.0',
          id: request.id,
          result: {
            description: 'Compliance status check',
            messages: [
              {
                role: 'user',
                content: {
                  type: 'text',
                  text: `Perform a compliance check${promptArgs.date ? ` for ${promptArgs.date}` : ' for today'}${promptArgs.user_id ? ` for user ${promptArgs.user_id}` : ' for all active users'}:

1. Check shift hour limits and overtime warnings (use tanda_get_shift_limits)
2. Review break compliance for active shifts (use tanda_get_shift_breaks for each shift)
3. Verify award interpretation requirements are met (use tanda_get_award_interpretation)
4. Flag any violations or warnings

Provide a summary with:
- ✅ Compliant items
- ⚠️ Warnings that need attention
- ❌ Violations that require immediate action`,
                },
              },
            ],
          },
        };

      case 'onboard_employee':
        return {
          jsonrpc: '2.0',
          id: request.id,
          result: {
            description: 'Employee onboarding workflow',
            messages: [
              {
                role: 'user',
                content: {
                  type: 'text',
                  text: `Guide me through onboarding a new employee:
- Email: ${promptArgs.email || '[employee email]'}
- Name: ${promptArgs.name || '[employee name]'}

Steps:
1. First, list available departments (use tanda_get_departments) so I can assign them
2. Then use tanda_onboard_users to create the user account with:
   - Email and name as provided
   - Suggested department assignment
   - Send invitation email
3. Confirm the onboarding was successful
4. Suggest next steps (scheduling their first shift, adding to roster, etc.)`,
                },
              },
            ],
          },
        };

      case 'leave_planner':
        return {
          jsonrpc: '2.0',
          id: request.id,
          result: {
            description: 'Leave planning assistant',
            messages: [
              {
                role: 'user',
                content: {
                  type: 'text',
                  text: `Help plan leave for user ${promptArgs.user_id || '[user_id]'}:

1. Get their current leave balances (use tanda_get_leave_balances)
2. Show available leave types (use tanda_get_leave_types)
3. If they want to request specific dates, calculate the hours needed (use tanda_calculate_leave_hours)
4. Check team coverage for the requested dates (use tanda_get_schedules for that period)
5. Help create the leave request if there's sufficient balance and coverage`,
                },
              },
            ],
          },
        };

      default:
        return this.createErrorResponse(
          request.id,
          MCP_ERROR_CODES.INVALID_PARAMS,
          `Unknown prompt: ${params.name}`
        );
    }
  }

  // Ping handler
  private handlePing(request: MCPRequest): MCPResponse {
    return {
      jsonrpc: '2.0',
      id: request.id,
      result: {
        status: 'ok',
        timestamp: new Date().toISOString(),
      },
    };
  }

  // Create error response
  private createErrorResponse(
    id: string | number,
    code: number,
    message: string,
    data?: unknown
  ): MCPResponse {
    return {
      jsonrpc: '2.0',
      id,
      error: {
        code,
        message,
        data,
      },
    };
  }
}

// Express route handler for MCP endpoint
export function createMCPRouter() {
  const mcpHandler = new MCPHandler();

  return async (req: Request, res: Response): Promise<void> => {
    // Validate JSON-RPC request
    const request = req.body as MCPRequest;

    if (!request || request.jsonrpc !== '2.0' || !request.method) {
      res.status(400).json({
        jsonrpc: '2.0',
        id: request?.id ?? null,
        error: {
          code: MCP_ERROR_CODES.INVALID_REQUEST,
          message: 'Invalid JSON-RPC 2.0 request',
        },
      });
      return;
    }

    // Get Tanda client from auth middleware (may be null for unauthenticated requests)
    const tandaClient = req.auth?.tandaClient || null;

    const response = await mcpHandler.handleRequest(request, tandaClient);
    res.json(response);
  };
}

export const mcpHandler = new MCPHandler();
