import { TandaClient, TandaApiError } from '../tanda/client';
import { logger } from '../utils/logger';

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

export const tandaTools: MCPTool[] = [
  // User Management
  {
    name: 'tanda_get_current_user',
    description: 'Get the currently authenticated Tanda user\'s profile information',
    inputSchema: {
      type: 'object',
      properties: {},
    },
  },
  {
    name: 'tanda_get_users',
    description: 'Get a list of all users/employees in the Tanda organization',
    inputSchema: {
      type: 'object',
      properties: {
        active: {
          type: 'boolean',
          description: 'Filter by active status (true for active users only)',
        },
        department_ids: {
          type: 'array',
          items: { type: 'number' },
          description: 'Filter by department IDs',
        },
      },
    },
  },
  {
    name: 'tanda_get_user',
    description: 'Get details for a specific user by their ID',
    inputSchema: {
      type: 'object',
      properties: {
        user_id: {
          type: 'number',
          description: 'The user ID to retrieve',
        },
      },
      required: ['user_id'],
    },
  },

  // Departments & Locations
  {
    name: 'tanda_get_departments',
    description: 'Get all departments in the Tanda organization',
    inputSchema: {
      type: 'object',
      properties: {},
    },
  },
  {
    name: 'tanda_get_locations',
    description: 'Get all locations/sites in the Tanda organization',
    inputSchema: {
      type: 'object',
      properties: {},
    },
  },

  // Schedule/Roster Management
  {
    name: 'tanda_get_schedules',
    description: 'Get scheduled shifts/rosters for a date range',
    inputSchema: {
      type: 'object',
      properties: {
        from: {
          type: 'string',
          description: 'Start date in YYYY-MM-DD format',
        },
        to: {
          type: 'string',
          description: 'End date in YYYY-MM-DD format',
        },
        user_ids: {
          type: 'array',
          items: { type: 'number' },
          description: 'Filter by specific user IDs',
        },
        department_ids: {
          type: 'array',
          items: { type: 'number' },
          description: 'Filter by department IDs',
        },
        show_costs: {
          type: 'boolean',
          description: 'Include cost calculations',
        },
      },
      required: ['from', 'to'],
    },
  },
  {
    name: 'tanda_create_schedule',
    description: 'Create a new scheduled shift for an employee',
    inputSchema: {
      type: 'object',
      properties: {
        user_id: {
          type: 'number',
          description: 'The user ID to assign the shift to',
        },
        department_id: {
          type: 'number',
          description: 'The department ID for the shift',
        },
        start: {
          type: 'string',
          description: 'Shift start time in ISO 8601 format',
        },
        finish: {
          type: 'string',
          description: 'Shift end time in ISO 8601 format',
        },
        notes: {
          type: 'string',
          description: 'Optional notes for the shift',
        },
      },
      required: ['start', 'finish'],
    },
  },
  {
    name: 'tanda_update_schedule',
    description: 'Update an existing scheduled shift',
    inputSchema: {
      type: 'object',
      properties: {
        schedule_id: {
          type: 'number',
          description: 'The schedule/shift ID to update',
        },
        user_id: {
          type: 'number',
          description: 'New user ID assignment',
        },
        department_id: {
          type: 'number',
          description: 'New department ID',
        },
        start: {
          type: 'string',
          description: 'New start time in ISO 8601 format',
        },
        finish: {
          type: 'string',
          description: 'New end time in ISO 8601 format',
        },
        notes: {
          type: 'string',
          description: 'Updated notes',
        },
      },
      required: ['schedule_id'],
    },
  },
  {
    name: 'tanda_delete_schedule',
    description: 'Delete a scheduled shift',
    inputSchema: {
      type: 'object',
      properties: {
        schedule_id: {
          type: 'number',
          description: 'The schedule/shift ID to delete',
        },
      },
      required: ['schedule_id'],
    },
  },
  {
    name: 'tanda_publish_schedules',
    description: 'Publish schedules/rosters for a date range (makes them visible to staff)',
    inputSchema: {
      type: 'object',
      properties: {
        from: {
          type: 'string',
          description: 'Start date in YYYY-MM-DD format',
        },
        to: {
          type: 'string',
          description: 'End date in YYYY-MM-DD format',
        },
        department_ids: {
          type: 'array',
          items: { type: 'number' },
          description: 'Optional: specific departments to publish',
        },
      },
      required: ['from', 'to'],
    },
  },

  // Shifts & Timesheets
  {
    name: 'tanda_get_shifts',
    description: 'Get actual worked shifts (timesheet data) for a date range',
    inputSchema: {
      type: 'object',
      properties: {
        from: {
          type: 'string',
          description: 'Start date in YYYY-MM-DD format',
        },
        to: {
          type: 'string',
          description: 'End date in YYYY-MM-DD format',
        },
        user_ids: {
          type: 'array',
          items: { type: 'number' },
          description: 'Filter by specific user IDs',
        },
      },
      required: ['from', 'to'],
    },
  },
  {
    name: 'tanda_get_timesheets',
    description: 'Get timesheets for a date range with approval status',
    inputSchema: {
      type: 'object',
      properties: {
        from: {
          type: 'string',
          description: 'Start date in YYYY-MM-DD format',
        },
        to: {
          type: 'string',
          description: 'End date in YYYY-MM-DD format',
        },
        user_ids: {
          type: 'array',
          items: { type: 'number' },
          description: 'Filter by specific user IDs',
        },
        approved: {
          type: 'boolean',
          description: 'Filter by approval status',
        },
        include_costs: {
          type: 'boolean',
          description: 'Include cost calculations',
        },
      },
      required: ['from', 'to'],
    },
  },
  {
    name: 'tanda_approve_shift',
    description: 'Approve a specific shift',
    inputSchema: {
      type: 'object',
      properties: {
        shift_id: {
          type: 'number',
          description: 'The shift ID to approve',
        },
      },
      required: ['shift_id'],
    },
  },
  {
    name: 'tanda_approve_timesheet',
    description: 'Approve a timesheet',
    inputSchema: {
      type: 'object',
      properties: {
        timesheet_id: {
          type: 'number',
          description: 'The timesheet ID to approve',
        },
      },
      required: ['timesheet_id'],
    },
  },

  // Leave Management
  {
    name: 'tanda_get_leave_requests',
    description: 'Get leave requests with optional filters',
    inputSchema: {
      type: 'object',
      properties: {
        from: {
          type: 'string',
          description: 'Start date in YYYY-MM-DD format',
        },
        to: {
          type: 'string',
          description: 'End date in YYYY-MM-DD format',
        },
        user_ids: {
          type: 'array',
          items: { type: 'number' },
          description: 'Filter by specific user IDs',
        },
        status: {
          type: 'string',
          enum: ['pending', 'approved', 'declined'],
          description: 'Filter by leave status',
        },
      },
    },
  },
  {
    name: 'tanda_create_leave_request',
    description: 'Create a new leave request for an employee',
    inputSchema: {
      type: 'object',
      properties: {
        user_id: {
          type: 'number',
          description: 'The user ID requesting leave',
        },
        leave_type: {
          type: 'string',
          description: 'Type of leave (e.g., "annual", "sick", "personal")',
        },
        start: {
          type: 'string',
          description: 'Leave start date in YYYY-MM-DD format',
        },
        finish: {
          type: 'string',
          description: 'Leave end date in YYYY-MM-DD format',
        },
        hours: {
          type: 'number',
          description: 'Optional: specific hours if partial day',
        },
        reason: {
          type: 'string',
          description: 'Optional reason for leave',
        },
        status: {
          type: 'string',
          enum: ['pending', 'approved'],
          description: 'Leave request status (defaults to pending)',
        },
      },
      required: ['user_id', 'leave_type', 'start', 'finish'],
    },
  },
  {
    name: 'tanda_approve_leave',
    description: 'Approve a pending leave request',
    inputSchema: {
      type: 'object',
      properties: {
        leave_id: {
          type: 'number',
          description: 'The leave request ID to approve',
        },
      },
      required: ['leave_id'],
    },
  },
  {
    name: 'tanda_decline_leave',
    description: 'Decline a pending leave request',
    inputSchema: {
      type: 'object',
      properties: {
        leave_id: {
          type: 'number',
          description: 'The leave request ID to decline',
        },
        reason: {
          type: 'string',
          description: 'Optional reason for declining',
        },
      },
      required: ['leave_id'],
    },
  },
  {
    name: 'tanda_delete_leave_request',
    description: 'Delete a leave request (use to clean up test data or cancel pending requests)',
    inputSchema: {
      type: 'object',
      properties: {
        leave_id: {
          type: 'number',
          description: 'The leave request ID to delete',
        },
      },
      required: ['leave_id'],
    },
  },
  {
    name: 'tanda_get_leave_balances',
    description: 'Get leave balances for a specific user',
    inputSchema: {
      type: 'object',
      properties: {
        user_id: {
          type: 'number',
          description: 'The user ID to get leave balances for',
        },
      },
      required: ['user_id'],
    },
  },

  // Unavailability
  {
    name: 'tanda_get_unavailability',
    description: 'Get staff unavailability records for a date range',
    inputSchema: {
      type: 'object',
      properties: {
        from: {
          type: 'string',
          description: 'Start date in YYYY-MM-DD format',
        },
        to: {
          type: 'string',
          description: 'End date in YYYY-MM-DD format',
        },
        user_ids: {
          type: 'array',
          items: { type: 'number' },
          description: 'Filter by specific user IDs',
        },
      },
      required: ['from', 'to'],
    },
  },
  {
    name: 'tanda_create_unavailability',
    description: 'Create an unavailability record for an employee',
    inputSchema: {
      type: 'object',
      properties: {
        user_id: {
          type: 'number',
          description: 'The user ID to mark as unavailable',
        },
        start: {
          type: 'string',
          description: 'Start date/time in ISO 8601 format',
        },
        finish: {
          type: 'string',
          description: 'End date/time in ISO 8601 format',
        },
        title: {
          type: 'string',
          description: 'Optional title/reason for unavailability',
        },
        repeating: {
          type: 'boolean',
          description: 'Whether this unavailability repeats',
        },
      },
      required: ['user_id', 'start', 'finish'],
    },
  },
  {
    name: 'tanda_delete_unavailability',
    description: 'Delete an unavailability record',
    inputSchema: {
      type: 'object',
      properties: {
        unavailability_id: {
          type: 'number',
          description: 'The unavailability record ID to delete',
        },
      },
      required: ['unavailability_id'],
    },
  },

  // Teams
  {
    name: 'tanda_get_teams',
    description: 'Get all teams/groups in the organization',
    inputSchema: {
      type: 'object',
      properties: {},
    },
  },

  // Staff by Department
  {
    name: 'tanda_get_staff_by_department',
    description: 'Get all staff members in a specific department',
    inputSchema: {
      type: 'object',
      properties: {
        department_id: {
          type: 'number',
          description: 'The department ID to get staff for',
        },
      },
      required: ['department_id'],
    },
  },

  // Daily Stats
  {
    name: 'tanda_get_daily_stats',
    description: 'Get daily workforce statistics (hours, headcount) for a date range',
    inputSchema: {
      type: 'object',
      properties: {
        from: {
          type: 'string',
          description: 'Start date in YYYY-MM-DD format',
        },
        to: {
          type: 'string',
          description: 'End date in YYYY-MM-DD format',
        },
        department_ids: {
          type: 'array',
          items: { type: 'number' },
          description: 'Filter by department IDs',
        },
      },
      required: ['from', 'to'],
    },
  },

  // Award Interpretation & Costs
  {
    name: 'tanda_get_award_interpretation',
    description: 'Get award interpretation (pay calculations) for a date range',
    inputSchema: {
      type: 'object',
      properties: {
        from: {
          type: 'string',
          description: 'Start date in YYYY-MM-DD format',
        },
        to: {
          type: 'string',
          description: 'End date in YYYY-MM-DD format',
        },
        user_ids: {
          type: 'array',
          items: { type: 'number' },
          description: 'Filter by specific user IDs',
        },
      },
      required: ['from', 'to'],
    },
  },
  {
    name: 'tanda_get_roster_costs',
    description: 'Get roster/labor costs for a date range',
    inputSchema: {
      type: 'object',
      properties: {
        from: {
          type: 'string',
          description: 'Start date in YYYY-MM-DD format',
        },
        to: {
          type: 'string',
          description: 'End date in YYYY-MM-DD format',
        },
        department_ids: {
          type: 'array',
          items: { type: 'number' },
          description: 'Filter by department IDs',
        },
      },
      required: ['from', 'to'],
    },
  },
];

// Tool execution handler
export async function executeTool(
  client: TandaClient,
  toolName: string,
  args: Record<string, unknown>
): Promise<{ content: unknown; isError?: boolean }> {
  logger.debug(`Executing tool: ${toolName}`, { args });

  try {
    switch (toolName) {
      // User Management
      case 'tanda_get_current_user':
        return { content: await client.getCurrentUser() };

      case 'tanda_get_users':
        return {
          content: await client.getUsers({
            active: args.active as boolean | undefined,
            department_ids: args.department_ids as number[] | undefined,
          }),
        };

      case 'tanda_get_user':
        return { content: await client.getUser(args.user_id as number) };

      // Departments & Locations
      case 'tanda_get_departments':
        return { content: await client.getDepartments() };

      case 'tanda_get_locations':
        return { content: await client.getLocations() };

      // Schedule Management
      case 'tanda_get_schedules':
        return {
          content: await client.getSchedules({
            from: args.from as string,
            to: args.to as string,
            user_ids: args.user_ids as number[] | undefined,
            department_ids: args.department_ids as number[] | undefined,
            show_costs: args.show_costs as boolean | undefined,
          }),
        };

      case 'tanda_create_schedule':
        return {
          content: await client.createSchedule({
            user_id: args.user_id as number | undefined,
            department_id: args.department_id as number | undefined,
            start: args.start as string,
            finish: args.finish as string,
            notes: args.notes as string | undefined,
          }),
        };

      case 'tanda_update_schedule':
        return {
          content: await client.updateSchedule(args.schedule_id as number, {
            user_id: args.user_id as number | undefined,
            department_id: args.department_id as number | undefined,
            start: args.start as string | undefined,
            finish: args.finish as string | undefined,
            notes: args.notes as string | undefined,
          }),
        };

      case 'tanda_delete_schedule':
        await client.deleteSchedule(args.schedule_id as number);
        return { content: { success: true, message: 'Schedule deleted successfully' } };

      case 'tanda_publish_schedules':
        await client.publishSchedules(
          args.from as string,
          args.to as string,
          args.department_ids as number[] | undefined
        );
        return { content: { success: true, message: 'Schedules published successfully' } };

      // Shifts & Timesheets
      case 'tanda_get_shifts':
        return {
          content: await client.getShifts({
            from: args.from as string,
            to: args.to as string,
            user_ids: args.user_ids as number[] | undefined,
          }),
        };

      case 'tanda_get_timesheets':
        return {
          content: await client.getTimesheets({
            from: args.from as string,
            to: args.to as string,
            user_ids: args.user_ids as number[] | undefined,
            approved: args.approved as boolean | undefined,
            include_costs: args.include_costs as boolean | undefined,
          }),
        };

      case 'tanda_approve_shift':
        return { content: await client.approveShift(args.shift_id as number) };

      case 'tanda_approve_timesheet':
        return { content: await client.approveTimesheet(args.timesheet_id as number) };

      // Leave Management
      case 'tanda_get_leave_requests': {
        // API requires at least one parameter, provide defaults if none given
        const today = new Date();
        const thirtyDaysAgo = new Date(today.getTime() - 30 * 24 * 60 * 60 * 1000);
        const defaultFrom = thirtyDaysAgo.toISOString().split('T')[0];
        const defaultTo = today.toISOString().split('T')[0];

        return {
          content: await client.getLeaveRequests({
            from: (args.from as string | undefined) || defaultFrom,
            to: (args.to as string | undefined) || defaultTo,
            user_ids: args.user_ids as number[] | undefined,
            status: args.status as string | undefined,
          }),
        };
      }

      case 'tanda_create_leave_request':
        return {
          content: await client.createLeaveRequest({
            user_id: args.user_id as number,
            leave_type: args.leave_type as string,
            start: args.start as string,
            finish: args.finish as string,
            hours: args.hours as number | undefined,
            reason: args.reason as string | undefined,
            status: (args.status as 'pending' | 'approved' | undefined) || 'pending',
          }),
        };

      case 'tanda_approve_leave':
        return { content: await client.approveLeaveRequest(args.leave_id as number) };

      case 'tanda_decline_leave':
        return {
          content: await client.declineLeaveRequest(
            args.leave_id as number,
            args.reason as string | undefined
          ),
        };

      case 'tanda_delete_leave_request':
        await client.deleteLeaveRequest(args.leave_id as number);
        return { content: { success: true, message: 'Leave request deleted successfully' } };

      case 'tanda_get_leave_balances':
        return { content: await client.getLeaveBalances(args.user_id as number) };

      // Unavailability
      case 'tanda_get_unavailability':
        return {
          content: await client.getUnavailability({
            from: args.from as string,
            to: args.to as string,
            user_ids: args.user_ids as number[] | undefined,
          }),
        };

      case 'tanda_create_unavailability':
        return {
          content: await client.createUnavailability({
            user_id: args.user_id as number,
            start: args.start as string,
            finish: args.finish as string,
            title: args.title as string | undefined,
            repeating: args.repeating as boolean | undefined,
          }),
        };

      case 'tanda_delete_unavailability':
        await client.deleteUnavailability(args.unavailability_id as number);
        return { content: { success: true, message: 'Unavailability deleted successfully' } };

      // Teams
      case 'tanda_get_teams':
        return { content: await client.getTeams() };

      // Staff by Department
      case 'tanda_get_staff_by_department':
        return { content: await client.getStaffByDepartment(args.department_id as number) };

      // Daily Stats
      case 'tanda_get_daily_stats':
        return {
          content: await client.getDailyStats({
            from: args.from as string,
            to: args.to as string,
            department_ids: args.department_ids as number[] | undefined,
          }),
        };

      // Award Interpretation & Costs
      case 'tanda_get_award_interpretation':
        return {
          content: await client.getAwardInterpretation({
            from: args.from as string,
            to: args.to as string,
            user_ids: args.user_ids as number[] | undefined,
          }),
        };

      case 'tanda_get_roster_costs':
        return {
          content: await client.getRosterCosts({
            from: args.from as string,
            to: args.to as string,
            department_ids: args.department_ids as number[] | undefined,
          }),
        };

      default:
        return {
          content: { error: `Unknown tool: ${toolName}` },
          isError: true,
        };
    }
  } catch (error) {
    logger.error(`Tool execution failed: ${toolName}`, error);

    if (error instanceof TandaApiError) {
      return {
        content: {
          error: error.message,
          statusCode: error.statusCode,
        },
        isError: true,
      };
    }

    return {
      content: {
        error: error instanceof Error ? error.message : 'Unknown error occurred',
      },
      isError: true,
    };
  }
}
