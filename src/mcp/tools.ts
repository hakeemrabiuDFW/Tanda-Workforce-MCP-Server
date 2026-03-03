import { TandaClient, TandaApiError } from '../tanda/client';
import { logger } from '../utils/logger';
import { config } from '../config/environment';
import { SupervisorOptimizer } from '../supervisor/optimizer';
import { OptimizationRequest } from '../supervisor/types';

// ==================== v4.0 Refactored Tools ====================
// Consolidated from 44 tools to 9 grouped tools with action parameters
// Optimized for Claude.ai context window efficiency

// v4.0: Write actions that are blocked in read-only mode
const WRITE_ACTIONS = new Set([
  'users:onboard',
  'users:invite',
  'schedules:create',
  'schedules:update',
  'schedules:delete',
  'schedules:publish',
  'timesheets:approve_shift',
  'timesheets:approve_timesheet',
  'leave:create',
  'leave:approve',
  'leave:decline',
  'leave:delete',
  'unavailability:create',
  'unavailability:delete',
  'supervisors:create_optimized',
]);

// MCP Tool Definitions
export interface MCPTool {
  name: string;
  description: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, unknown>;
    required?: string[];
  };
}

// ==================== Pagination & Validation Helpers ====================

interface PaginatedResponse<T> {
  data: T[];
  pagination: {
    page: number;
    limit: number;
    total: number;
    hasMore: boolean;
  };
}

function paginateResults<T>(data: T[], page: number = 1, limit: number = 50): PaginatedResponse<T> {
  const safeLimit = Math.min(Math.max(limit, 1), 200);
  const safePage = Math.max(page, 1);
  const start = (safePage - 1) * safeLimit;
  const paginatedData = data.slice(start, start + safeLimit);
  
  return {
    data: paginatedData,
    pagination: {
      page: safePage,
      limit: safeLimit,
      total: data.length,
      hasMore: start + safeLimit < data.length,
    },
  };
}

function validateDateRange(from: string, to: string, maxDays: number = 14): { valid: boolean; error?: string } {
  const fromDate = new Date(from);
  const toDate = new Date(to);
  
  if (isNaN(fromDate.getTime()) || isNaN(toDate.getTime())) {
    return { valid: false, error: 'Invalid date format. Use YYYY-MM-DD.' };
  }
  
  const daysDiff = (toDate.getTime() - fromDate.getTime()) / (1000 * 60 * 60 * 24);
  
  if (daysDiff < 0) {
    return { valid: false, error: 'End date must be after start date.' };
  }
  
  if (daysDiff > maxDays) {
    return { valid: false, error: `Max ${maxDays}-day range per query. Split into smaller chunks.` };
  }
  
  return { valid: true };
}

// ==================== Consolidated Tool Definitions ====================

const LITE_MODE_TOOLS = ['tanda_users', 'tanda_schedules', 'tanda_reference', 'tanda_timesheets', 'tanda_leave', 'tanda_realtime'];

export const tandaTools: MCPTool[] = [
  // 1. USER MANAGEMENT
  {
    name: 'tanda_users',
    description: 'Manage users. Actions: list|get|inactive|onboard|invite|by_department|current',
    inputSchema: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['list', 'get', 'inactive', 'onboard', 'invite', 'by_department', 'current'],
          description: 'Action to perform',
        },
        user_id: { type: 'number', description: 'User ID (for get, invite)' },
        department_id: { type: 'number', description: 'Department ID (for by_department)' },
        department_ids: { type: 'array', items: { type: 'number' }, description: 'Filter by departments (for list)' },
        active: { type: 'boolean', description: 'Filter by active status (for list)' },
        users: {
          type: 'array',
          description: 'Users to onboard (for onboard action)',
          items: {
            type: 'object',
            properties: {
              email: { type: 'string' },
              name: { type: 'string' },
              phone: { type: 'string' },
              department_ids: { type: 'array', items: { type: 'number' } },
              employment_start_date: { type: 'string' },
              send_invite: { type: 'boolean' },
            },
            required: ['email', 'name'],
          },
        },
        limit: { type: 'number', description: 'Max records (default 50, max 200)' },
        page: { type: 'number', description: 'Page number' },
      },
      required: ['action'],
    },
  },

  // 2. SCHEDULES
  {
    name: 'tanda_schedules',
    description: 'Manage schedules. Actions: list|get|create|update|delete|publish. Max 14-day range.',
    inputSchema: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['list', 'get', 'create', 'update', 'delete', 'publish'],
          description: 'Action to perform',
        },
        schedule_id: { type: 'number', description: 'Schedule ID (for get, update, delete)' },
        from: { type: 'string', description: 'Start date YYYY-MM-DD (for list, publish)' },
        to: { type: 'string', description: 'End date YYYY-MM-DD (for list, publish)' },
        user_id: { type: 'number', description: 'User ID (for create, update)' },
        user_ids: { type: 'array', items: { type: 'number' }, description: 'Filter by users (for list)' },
        department_id: { type: 'number', description: 'Department ID (for create, update)' },
        department_ids: { type: 'array', items: { type: 'number' }, description: 'Filter by depts (for list, publish)' },
        start: { type: 'string', description: 'Shift start ISO 8601 (for create, update)' },
        finish: { type: 'string', description: 'Shift end ISO 8601 (for create, update)' },
        notes: { type: 'string', description: 'Notes (for create, update)' },
        show_costs: { type: 'boolean', description: 'Include costs (for list)' },
        limit: { type: 'number', description: 'Max records (default 50, max 200)' },
        page: { type: 'number', description: 'Page number' },
      },
      required: ['action'],
    },
  },

  // 3. TIMESHEETS & SHIFTS
  {
    name: 'tanda_timesheets',
    description: 'Manage timesheets/shifts. Actions: shifts|timesheets|approve_shift|approve_timesheet|breaks. Max 14-day range.',
    inputSchema: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['shifts', 'timesheets', 'approve_shift', 'approve_timesheet', 'breaks'],
          description: 'Action to perform',
        },
        shift_id: { type: 'number', description: 'Shift ID (for approve_shift, breaks)' },
        timesheet_id: { type: 'number', description: 'Timesheet ID (for approve_timesheet)' },
        from: { type: 'string', description: 'Start date YYYY-MM-DD' },
        to: { type: 'string', description: 'End date YYYY-MM-DD' },
        user_ids: { type: 'array', items: { type: 'number' }, description: 'Filter by users' },
        approved: { type: 'boolean', description: 'Filter by approval status' },
        include_costs: { type: 'boolean', description: 'Include costs' },
        limit: { type: 'number', description: 'Max records (default 50, max 200)' },
        page: { type: 'number', description: 'Page number' },
      },
      required: ['action'],
    },
  },

  // 4. LEAVE MANAGEMENT
  {
    name: 'tanda_leave',
    description: 'Manage leave. Actions: list|create|approve|decline|delete|balances|types|calculate_hours. Max 14-day range for list.',
    inputSchema: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['list', 'create', 'approve', 'decline', 'delete', 'balances', 'types', 'calculate_hours'],
          description: 'Action to perform',
        },
        leave_id: { type: 'number', description: 'Leave ID (for approve, decline, delete)' },
        user_id: { type: 'number', description: 'User ID (for create, balances, types, calculate_hours)' },
        user_ids: { type: 'array', items: { type: 'number' }, description: 'Filter by users (for list)' },
        from: { type: 'string', description: 'Start date YYYY-MM-DD' },
        to: { type: 'string', description: 'End date YYYY-MM-DD' },
        leave_type: { type: 'string', description: 'Leave type (for create, calculate_hours)' },
        start: { type: 'string', description: 'Leave start YYYY-MM-DD (for create)' },
        finish: { type: 'string', description: 'Leave end YYYY-MM-DD (for create)' },
        hours: { type: 'number', description: 'Partial day hours (for create)' },
        reason: { type: 'string', description: 'Reason (for create, decline)' },
        status: { type: 'string', enum: ['pending', 'approved', 'declined'], description: 'Filter/set status' },
        limit: { type: 'number', description: 'Max records (default 50, max 200)' },
        page: { type: 'number', description: 'Page number' },
      },
      required: ['action'],
    },
  },

  // 5. ROSTERS
  {
    name: 'tanda_rosters',
    description: 'Manage roster periods. Actions: get|current|by_date',
    inputSchema: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['get', 'current', 'by_date'],
          description: 'Action to perform',
        },
        roster_id: { type: 'number', description: 'Roster ID (for get)' },
        date: { type: 'string', description: 'Date YYYY-MM-DD (for by_date)' },
        show_costs: { type: 'boolean', description: 'Include costs' },
      },
      required: ['action'],
    },
  },

  // 6. REFERENCE DATA
  {
    name: 'tanda_reference',
    description: 'Get reference data. Actions: departments|locations|teams|daily_stats. Max 14-day range for daily_stats.',
    inputSchema: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['departments', 'locations', 'teams', 'daily_stats'],
          description: 'Action to perform',
        },
        from: { type: 'string', description: 'Start date YYYY-MM-DD (for daily_stats)' },
        to: { type: 'string', description: 'End date YYYY-MM-DD (for daily_stats)' },
        department_ids: { type: 'array', items: { type: 'number' }, description: 'Filter by depts (for daily_stats)' },
        limit: { type: 'number', description: 'Max records (default 50, max 200)' },
        page: { type: 'number', description: 'Page number' },
      },
      required: ['action'],
    },
  },

  // 7. REAL-TIME & COSTS
  {
    name: 'tanda_realtime',
    description: 'Real-time data. Actions: active_shifts|clocked_in|shift_limits|award_interpretation|roster_costs. Max 14-day range where applicable.',
    inputSchema: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['active_shifts', 'clocked_in', 'shift_limits', 'award_interpretation', 'roster_costs'],
          description: 'Action to perform',
        },
        from: { type: 'string', description: 'Start date YYYY-MM-DD (for award_interpretation, roster_costs)' },
        to: { type: 'string', description: 'End date YYYY-MM-DD (for award_interpretation, roster_costs)' },
        user_ids: { type: 'array', items: { type: 'number' }, description: 'Filter by users' },
        department_ids: { type: 'array', items: { type: 'number' }, description: 'Filter by depts (for roster_costs)' },
        limit: { type: 'number', description: 'Max records (default 50, max 200)' },
        page: { type: 'number', description: 'Page number' },
      },
      required: ['action'],
    },
  },

  // 8. UNAVAILABILITY
  {
    name: 'tanda_unavailability',
    description: 'Manage unavailability. Actions: list|create|delete. Max 14-day range for list.',
    inputSchema: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['list', 'create', 'delete'],
          description: 'Action to perform',
        },
        unavailability_id: { type: 'number', description: 'Unavailability ID (for delete)' },
        user_id: { type: 'number', description: 'User ID (for create)' },
        user_ids: { type: 'array', items: { type: 'number' }, description: 'Filter by users (for list)' },
        from: { type: 'string', description: 'Start date YYYY-MM-DD (for list)' },
        to: { type: 'string', description: 'End date YYYY-MM-DD (for list)' },
        start: { type: 'string', description: 'Start ISO 8601 (for create)' },
        finish: { type: 'string', description: 'End ISO 8601 (for create)' },
        title: { type: 'string', description: 'Title/reason (for create)' },
        repeating: { type: 'boolean', description: 'Repeating (for create)' },
        limit: { type: 'number', description: 'Max records (default 50, max 200)' },
        page: { type: 'number', description: 'Page number' },
      },
      required: ['action'],
    },
  },

  // 9. SUPERVISOR OPTIMIZATION
  {
    name: 'tanda_supervisors',
    description: 'Supervisor scheduling optimization. Actions: detect_overlaps|evening_coverage|recommendations|optimize|validate|create_optimized. Max 14-day range.',
    inputSchema: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['detect_overlaps', 'evening_coverage', 'recommendations', 'optimize', 'validate', 'create_optimized'],
          description: 'Action to perform',
        },
        from: { type: 'string', description: 'Start date YYYY-MM-DD' },
        to: { type: 'string', description: 'End date YYYY-MM-DD' },
        date: { type: 'string', description: 'Single date YYYY-MM-DD (for evening_coverage)' },
        supervisor_ids: { type: 'array', items: { type: 'number' }, description: 'Supervisor user IDs' },
        location_ids: { type: 'array', items: { type: 'number' }, description: 'Location/dept IDs' },
        prioritize_evening: { type: 'boolean', description: 'Prioritize 17:00-22:00 coverage' },
        max_overlaps_allowed: { type: 'number', description: 'Max overlaps before flagging' },
        schedules: {
          type: 'array',
          description: 'Schedules to validate/create',
          items: {
            type: 'object',
            properties: {
              supervisor_id: { type: 'number' },
              department_id: { type: 'number' },
              start: { type: 'string' },
              finish: { type: 'string' },
              notes: { type: 'string' },
            },
            required: ['supervisor_id', 'department_id', 'start', 'finish'],
          },
        },
        validate_only: { type: 'boolean', description: 'Only validate (for create_optimized)' },
        skip_conflicts: { type: 'boolean', description: 'Skip conflicts (for create_optimized)' },
      },
      required: ['action'],
    },
  },
];

// v4.0: Check if action is allowed based on read-only mode
export function isToolAllowed(toolName: string, action?: string): boolean {
  if (!config.MCP_READ_ONLY_MODE) return true;
  
  if (action) {
    const key = `${toolName.replace('tanda_', '')}:${action}`;
    return !WRITE_ACTIONS.has(key);
  }
  
  return true;
}

// v4.0: Get filtered tools list based on read-only mode and lite mode
export function getAvailableTools(): MCPTool[] {
  if (config.MCP_LITE_MODE) {
    return tandaTools.filter(tool => LITE_MODE_TOOLS.includes(tool.name));
  }
  return tandaTools;
}

// ==================== Tool Execution Handler ====================

export async function executeTool(
  client: TandaClient,
  toolName: string,
  args: Record<string, unknown>
): Promise<{ content: unknown; isError?: boolean }> {
  const action = args.action as string;
  logger.debug(`Executing tool: ${toolName}`, { action, args });

  // Check read-only mode
  if (config.MCP_READ_ONLY_MODE && !isToolAllowed(toolName, action)) {
    return {
      content: { error: `Action '${action}' not available in read-only mode.` },
      isError: true,
    };
  }

  try {
    switch (toolName) {
      case 'tanda_users':
        return await executeUsersTool(client, action, args);

      case 'tanda_schedules':
        return await executeSchedulesTool(client, action, args);

      case 'tanda_timesheets':
        return await executeTimesheetsTool(client, action, args);

      case 'tanda_leave':
        return await executeLeaveTool(client, action, args);

      case 'tanda_rosters':
        return await executeRostersTool(client, action, args);

      case 'tanda_reference':
        return await executeReferenceTool(client, action, args);

      case 'tanda_realtime':
        return await executeRealtimeTool(client, action, args);

      case 'tanda_unavailability':
        return await executeUnavailabilityTool(client, action, args);

      case 'tanda_supervisors':
        return await executeSupervisorsTool(client, action, args);

      default:
        return { content: { error: `Unknown tool: ${toolName}` }, isError: true };
    }
  } catch (error) {
    logger.error(`Tool execution failed: ${toolName}`, error);

    if (error instanceof TandaApiError) {
      return {
        content: { error: error.message, statusCode: error.statusCode },
        isError: true,
      };
    }

    return {
      content: { error: error instanceof Error ? error.message : 'Unknown error' },
      isError: true,
    };
  }
}

// ==================== Individual Tool Handlers ====================

async function executeUsersTool(
  client: TandaClient,
  action: string,
  args: Record<string, unknown>
): Promise<{ content: unknown; isError?: boolean }> {
  const page = (args.page as number) || 1;
  const limit = (args.limit as number) || 50;

  switch (action) {
    case 'current':
      return { content: await client.getCurrentUser() };

    case 'list': {
      const users = await client.getUsers({
        active: args.active as boolean | undefined,
        department_ids: args.department_ids as number[] | undefined,
      });
      return { content: paginateResults(users, page, limit) };
    }

    case 'get':
      if (!args.user_id) return { content: { error: 'user_id required' }, isError: true };
      return { content: await client.getUser(args.user_id as number) };

    case 'inactive': {
      const users = await client.getInactiveUsers();
      return { content: paginateResults(users, page, limit) };
    }

    case 'by_department':
      if (!args.department_id) return { content: { error: 'department_id required' }, isError: true };
      const staff = await client.getStaffByDepartment(args.department_id as number);
      return { content: paginateResults(staff, page, limit) };

    case 'onboard':
      if (!args.users) return { content: { error: 'users array required' }, isError: true };
      return { content: await client.onboardUsers(args.users as any[]) };

    case 'invite':
      if (!args.user_id) return { content: { error: 'user_id required' }, isError: true };
      return { content: await client.inviteUser(args.user_id as number) };

    default:
      return { content: { error: `Unknown action: ${action}` }, isError: true };
  }
}

async function executeSchedulesTool(
  client: TandaClient,
  action: string,
  args: Record<string, unknown>
): Promise<{ content: unknown; isError?: boolean }> {
  const page = (args.page as number) || 1;
  const limit = (args.limit as number) || 50;

  switch (action) {
    case 'list': {
      if (!args.from || !args.to) return { content: { error: 'from and to dates required' }, isError: true };
      const validation = validateDateRange(args.from as string, args.to as string);
      if (!validation.valid) return { content: { error: validation.error }, isError: true };

      const schedules = await client.getSchedules({
        from: args.from as string,
        to: args.to as string,
        user_ids: args.user_ids as number[] | undefined,
        department_ids: args.department_ids as number[] | undefined,
        show_costs: args.show_costs as boolean | undefined,
      });
      return { content: paginateResults(schedules, page, limit) };
    }

    case 'get':
      if (!args.schedule_id) return { content: { error: 'schedule_id required' }, isError: true };
      return { content: await client.getSchedule(args.schedule_id as number) };

    case 'create':
      if (!args.start || !args.finish) return { content: { error: 'start and finish required' }, isError: true };
      return {
        content: await client.createSchedule({
          user_id: args.user_id as number | undefined,
          department_id: args.department_id as number | undefined,
          start: args.start as string,
          finish: args.finish as string,
          notes: args.notes as string | undefined,
        }),
      };

    case 'update':
      if (!args.schedule_id) return { content: { error: 'schedule_id required' }, isError: true };
      return {
        content: await client.updateSchedule(args.schedule_id as number, {
          user_id: args.user_id as number | undefined,
          department_id: args.department_id as number | undefined,
          start: args.start as string | undefined,
          finish: args.finish as string | undefined,
          notes: args.notes as string | undefined,
        }),
      };

    case 'delete':
      if (!args.schedule_id) return { content: { error: 'schedule_id required' }, isError: true };
      await client.deleteSchedule(args.schedule_id as number);
      return { content: { success: true, message: 'Schedule deleted' } };

    case 'publish':
      if (!args.from || !args.to) return { content: { error: 'from and to dates required' }, isError: true };
      const validation = validateDateRange(args.from as string, args.to as string);
      if (!validation.valid) return { content: { error: validation.error }, isError: true };
      await client.publishSchedules(args.from as string, args.to as string, args.department_ids as number[] | undefined);
      return { content: { success: true, message: 'Schedules published' } };

    default:
      return { content: { error: `Unknown action: ${action}` }, isError: true };
  }
}

async function executeTimesheetsTool(
  client: TandaClient,
  action: string,
  args: Record<string, unknown>
): Promise<{ content: unknown; isError?: boolean }> {
  const page = (args.page as number) || 1;
  const limit = (args.limit as number) || 50;

  switch (action) {
    case 'shifts': {
      if (!args.from || !args.to) return { content: { error: 'from and to dates required' }, isError: true };
      const validation = validateDateRange(args.from as string, args.to as string);
      if (!validation.valid) return { content: { error: validation.error }, isError: true };

      const shifts = await client.getShifts({
        from: args.from as string,
        to: args.to as string,
        user_ids: args.user_ids as number[] | undefined,
      });
      return { content: paginateResults(shifts, page, limit) };
    }

    case 'timesheets': {
      if (!args.from || !args.to) return { content: { error: 'from and to dates required' }, isError: true };
      const validation = validateDateRange(args.from as string, args.to as string);
      if (!validation.valid) return { content: { error: validation.error }, isError: true };

      const timesheets = await client.getTimesheets({
        from: args.from as string,
        to: args.to as string,
        user_ids: args.user_ids as number[] | undefined,
        approved: args.approved as boolean | undefined,
        include_costs: args.include_costs as boolean | undefined,
      });
      return { content: paginateResults(timesheets, page, limit) };
    }

    case 'approve_shift':
      if (!args.shift_id) return { content: { error: 'shift_id required' }, isError: true };
      return { content: await client.approveShift(args.shift_id as number) };

    case 'approve_timesheet':
      if (!args.timesheet_id) return { content: { error: 'timesheet_id required' }, isError: true };
      return { content: await client.approveTimesheet(args.timesheet_id as number) };

    case 'breaks':
      if (!args.shift_id) return { content: { error: 'shift_id required' }, isError: true };
      return { content: await client.getShiftBreaks(args.shift_id as number) };

    default:
      return { content: { error: `Unknown action: ${action}` }, isError: true };
  }
}

async function executeLeaveTool(
  client: TandaClient,
  action: string,
  args: Record<string, unknown>
): Promise<{ content: unknown; isError?: boolean }> {
  const page = (args.page as number) || 1;
  const limit = (args.limit as number) || 50;

  switch (action) {
    case 'list': {
      const today = new Date();
      const thirtyDaysAgo = new Date(today.getTime() - 30 * 24 * 60 * 60 * 1000);
      const from = (args.from as string) || thirtyDaysAgo.toISOString().split('T')[0];
      const to = (args.to as string) || today.toISOString().split('T')[0];

      if (args.from && args.to) {
        const validation = validateDateRange(from, to);
        if (!validation.valid) return { content: { error: validation.error }, isError: true };
      }

      const requests = await client.getLeaveRequests({
        from,
        to,
        user_ids: args.user_ids as number[] | undefined,
        status: args.status as string | undefined,
      });
      return { content: paginateResults(requests, page, limit) };
    }

    case 'create':
      if (!args.user_id || !args.leave_type || !args.start || !args.finish) {
        return { content: { error: 'user_id, leave_type, start, and finish required' }, isError: true };
      }
      return {
        content: await client.createLeaveRequest({
          user_id: args.user_id as number,
          leave_type: args.leave_type as string,
          start: args.start as string,
          finish: args.finish as string,
          hours: args.hours as number | undefined,
          reason: args.reason as string | undefined,
          status: (args.status as 'pending' | 'approved') || 'pending',
        }),
      };

    case 'approve':
      if (!args.leave_id) return { content: { error: 'leave_id required' }, isError: true };
      return { content: await client.approveLeaveRequest(args.leave_id as number) };

    case 'decline':
      if (!args.leave_id) return { content: { error: 'leave_id required' }, isError: true };
      return { content: await client.declineLeaveRequest(args.leave_id as number, args.reason as string | undefined) };

    case 'delete':
      if (!args.leave_id) return { content: { error: 'leave_id required' }, isError: true };
      await client.deleteLeaveRequest(args.leave_id as number);
      return { content: { success: true, message: 'Leave request deleted' } };

    case 'balances':
      if (!args.user_id) return { content: { error: 'user_id required' }, isError: true };
      return { content: await client.getLeaveBalances(args.user_id as number) };

    case 'types':
      if (!args.user_id) return { content: { error: 'user_id required' }, isError: true };
      return { content: await client.getLeaveTypes(args.user_id as number) };

    case 'calculate_hours':
      if (!args.user_id || !args.start || !args.finish || !args.leave_type) {
        return { content: { error: 'user_id, start, finish, and leave_type required' }, isError: true };
      }
      return {
        content: await client.calculateLeaveHours(
          args.user_id as number,
          args.start as string,
          args.finish as string,
          args.leave_type as string
        ),
      };

    default:
      return { content: { error: `Unknown action: ${action}` }, isError: true };
  }
}

async function executeRostersTool(
  client: TandaClient,
  action: string,
  args: Record<string, unknown>
): Promise<{ content: unknown; isError?: boolean }> {
  switch (action) {
    case 'get':
      if (!args.roster_id) return { content: { error: 'roster_id required' }, isError: true };
      return { content: await client.getRoster(args.roster_id as number) };

    case 'current':
      return { content: await client.getCurrentRoster(args.show_costs as boolean | undefined) };

    case 'by_date':
      if (!args.date) return { content: { error: 'date required' }, isError: true };
      return { content: await client.getRosterByDate(args.date as string, args.show_costs as boolean | undefined) };

    default:
      return { content: { error: `Unknown action: ${action}` }, isError: true };
  }
}

async function executeReferenceTool(
  client: TandaClient,
  action: string,
  args: Record<string, unknown>
): Promise<{ content: unknown; isError?: boolean }> {
  const page = (args.page as number) || 1;
  const limit = (args.limit as number) || 50;

  switch (action) {
    case 'departments': {
      const depts = await client.getDepartments();
      return { content: paginateResults(depts, page, limit) };
    }

    case 'locations': {
      const locs = await client.getLocations();
      return { content: paginateResults(locs, page, limit) };
    }

    case 'teams': {
      const teams = await client.getTeams();
      return { content: paginateResults(teams, page, limit) };
    }

    case 'daily_stats': {
      if (!args.from || !args.to) return { content: { error: 'from and to dates required' }, isError: true };
      const validation = validateDateRange(args.from as string, args.to as string);
      if (!validation.valid) return { content: { error: validation.error }, isError: true };

      const stats = await client.getDailyStats({
        from: args.from as string,
        to: args.to as string,
        department_ids: args.department_ids as number[] | undefined,
      });
      return { content: paginateResults(stats, page, limit) };
    }

    default:
      return { content: { error: `Unknown action: ${action}` }, isError: true };
  }
}

async function executeRealtimeTool(
  client: TandaClient,
  action: string,
  args: Record<string, unknown>
): Promise<{ content: unknown; isError?: boolean }> {
  const page = (args.page as number) || 1;
  const limit = (args.limit as number) || 50;

  switch (action) {
    case 'active_shifts': {
      const shifts = await client.getActiveShifts();
      return { content: paginateResults(shifts, page, limit) };
    }

    case 'clocked_in': {
      const users = await client.getClockedInUsers();
      return { content: paginateResults(users, page, limit) };
    }

    case 'shift_limits': {
      const limits = await client.getShiftLimits(args.user_ids as number[] | undefined);
      return { content: paginateResults(limits, page, limit) };
    }

    case 'award_interpretation': {
      if (!args.from || !args.to) return { content: { error: 'from and to dates required' }, isError: true };
      const validation = validateDateRange(args.from as string, args.to as string);
      if (!validation.valid) return { content: { error: validation.error }, isError: true };

      const awards = await client.getAwardInterpretation({
        from: args.from as string,
        to: args.to as string,
        user_ids: args.user_ids as number[] | undefined,
      });
      return { content: paginateResults(awards, page, limit) };
    }

    case 'roster_costs': {
      if (!args.from || !args.to) return { content: { error: 'from and to dates required' }, isError: true };
      const validation = validateDateRange(args.from as string, args.to as string);
      if (!validation.valid) return { content: { error: validation.error }, isError: true };

      const costs = await client.getRosterCosts({
        from: args.from as string,
        to: args.to as string,
        department_ids: args.department_ids as number[] | undefined,
      });
      return { content: paginateResults(costs, page, limit) };
    }

    default:
      return { content: { error: `Unknown action: ${action}` }, isError: true };
  }
}

async function executeUnavailabilityTool(
  client: TandaClient,
  action: string,
  args: Record<string, unknown>
): Promise<{ content: unknown; isError?: boolean }> {
  const page = (args.page as number) || 1;
  const limit = (args.limit as number) || 50;

  switch (action) {
    case 'list': {
      if (!args.from || !args.to) return { content: { error: 'from and to dates required' }, isError: true };
      const validation = validateDateRange(args.from as string, args.to as string);
      if (!validation.valid) return { content: { error: validation.error }, isError: true };

      const unavail = await client.getUnavailability({
        from: args.from as string,
        to: args.to as string,
        user_ids: args.user_ids as number[] | undefined,
      });
      return { content: paginateResults(unavail, page, limit) };
    }

    case 'create':
      if (!args.user_id || !args.start || !args.finish) {
        return { content: { error: 'user_id, start, and finish required' }, isError: true };
      }
      return {
        content: await client.createUnavailability({
          user_id: args.user_id as number,
          start: args.start as string,
          finish: args.finish as string,
          title: args.title as string | undefined,
          repeating: args.repeating as boolean | undefined,
        }),
      };

    case 'delete':
      if (!args.unavailability_id) return { content: { error: 'unavailability_id required' }, isError: true };
      await client.deleteUnavailability(args.unavailability_id as number);
      return { content: { success: true, message: 'Unavailability deleted' } };

    default:
      return { content: { error: `Unknown action: ${action}` }, isError: true };
  }
}

async function executeSupervisorsTool(
  client: TandaClient,
  action: string,
  args: Record<string, unknown>
): Promise<{ content: unknown; isError?: boolean }> {
  const optimizer = new SupervisorOptimizer(client);

  switch (action) {
    case 'detect_overlaps': {
      if (!args.from || !args.to) return { content: { error: 'from and to dates required' }, isError: true };
      const validation = validateDateRange(args.from as string, args.to as string);
      if (!validation.valid) return { content: { error: validation.error }, isError: true };

      return {
        content: await optimizer.detectOverlaps(
          args.from as string,
          args.to as string,
          args.supervisor_ids as number[] | undefined
        ),
      };
    }

    case 'evening_coverage':
      if (!args.date) return { content: { error: 'date required' }, isError: true };
      return { content: await optimizer.analyzeEveningCoverage(args.date as string) };

    case 'recommendations': {
      if (!args.from || !args.to) return { content: { error: 'from and to dates required' }, isError: true };
      const validation = validateDateRange(args.from as string, args.to as string);
      if (!validation.valid) return { content: { error: validation.error }, isError: true };

      const request: OptimizationRequest = {
        dateRange: { from: args.from as string, to: args.to as string },
        prioritizeEvening: args.prioritize_evening !== false,
        specificLocationIds: args.location_ids as number[] | undefined,
        specificSupervisorIds: args.supervisor_ids as number[] | undefined,
      };
      return { content: await optimizer.generatePlacementRecommendations(request) };
    }

    case 'optimize': {
      if (!args.from || !args.to) return { content: { error: 'from and to dates required' }, isError: true };
      const validation = validateDateRange(args.from as string, args.to as string);
      if (!validation.valid) return { content: { error: validation.error }, isError: true };

      const request: OptimizationRequest = {
        dateRange: { from: args.from as string, to: args.to as string },
        prioritizeEvening: args.prioritize_evening !== false,
        maxOverlapsAllowed: args.max_overlaps_allowed as number | undefined,
        specificLocationIds: args.location_ids as number[] | undefined,
        specificSupervisorIds: args.supervisor_ids as number[] | undefined,
      };
      return { content: await optimizer.optimize(request) };
    }

    case 'validate': {
      if (!args.schedules) return { content: { error: 'schedules array required' }, isError: true };
      const schedules = (args.schedules as any[]).map(s => ({
        supervisorId: s.supervisor_id,
        departmentId: s.department_id,
        start: s.start,
        finish: s.finish,
      }));
      return { content: await optimizer.validateSchedules(schedules) };
    }

    case 'create_optimized': {
      if (!args.schedules) return { content: { error: 'schedules array required' }, isError: true };
      const schedules = (args.schedules as any[]).map(s => ({
        supervisorId: s.supervisor_id,
        departmentId: s.department_id,
        start: s.start,
        finish: s.finish,
        notes: s.notes,
      }));
      return {
        content: await optimizer.createBulkSchedules({
          schedules,
          validateOnly: args.validate_only as boolean | undefined,
          skipConflicts: args.skip_conflicts as boolean | undefined,
        }),
      };
    }

    default:
      return { content: { error: `Unknown action: ${action}` }, isError: true };
  }
}
