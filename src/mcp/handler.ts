import { Request, Response } from 'express';
import { config } from '../config/environment';
import { logger } from '../utils/logger';
import { tandaTools, executeTool } from './tools';
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

  // List available tools
  private handleListTools(request: MCPRequest): MCPResponse {
    return {
      jsonrpc: '2.0',
      id: request.id,
      result: {
        tools: tandaTools,
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

  // List prompts
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
