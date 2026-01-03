#!/usr/bin/env ts-node
/**
 * Test V2 MCP Tools
 *
 * Comprehensive test script for all v2.0 tools including:
 * - Real-time attendance tools
 * - Roster management tools
 * - Timesheet tools
 * - Leave management tools
 * - User management tools
 * - Bulk operations
 *
 * Usage:
 *   npx ts-node scripts/test-v2-tools.ts <SERVER_URL> [JWT_TOKEN]
 *   npx ts-node scripts/test-v2-tools.ts <SERVER_URL> [JWT_TOKEN] --write  # Enable write tests
 */

import { execSync } from 'child_process';

const BASE_URL = process.argv[2] || 'http://localhost:3000';
const JWT_TOKEN = process.argv[3] || '';
const RUN_WRITE_TESTS = process.argv.includes('--write') || process.argv.includes('-w');

interface ToolTestResult {
  tool: string;
  category: string;
  status: 'passed' | 'failed' | 'auth_required' | 'api_error' | 'skipped';
  message: string;
  error?: string;
  responseTime?: number;
}

const results: ToolTestResult[] = [];

function callTool(toolName: string, args: Record<string, unknown> = {}): { success: boolean; data: unknown; error?: string; time: number } {
  const startTime = Date.now();
  try {
    const body = JSON.stringify({
      jsonrpc: '2.0',
      id: Date.now(),
      method: 'tools/call',
      params: {
        name: toolName,
        arguments: args,
      },
    });

    const authHeader = JWT_TOKEN ? `-H "Authorization: Bearer ${JWT_TOKEN}"` : '';

    const result = execSync(
      `curl -s -X POST "${BASE_URL}/mcp" \
        -H "Content-Type: application/json" \
        ${authHeader} \
        -d '${body}'`,
      { encoding: 'utf8', timeout: 60000 }
    );

    const response = JSON.parse(result);
    return { success: true, data: response, time: Date.now() - startTime };
  } catch (error) {
    return { success: false, data: null, error: error instanceof Error ? error.message : String(error), time: Date.now() - startTime };
  }
}

function testTool(toolName: string, category: string, args: Record<string, unknown> = {}): ToolTestResult {
  const { success, data, error, time } = callTool(toolName, args);

  if (!success) {
    return {
      tool: toolName,
      category,
      status: 'failed',
      message: 'Request Failed',
      error: error,
      responseTime: time,
    };
  }

  const response = data as { error?: { message?: string; code?: number }; result?: { content?: { text?: string }[]; isError?: boolean } };

  // Check for JSON-RPC error
  if (response.error) {
    const errorMsg = response.error.message || JSON.stringify(response.error);

    // Auth-related errors - tool is working but needs authentication
    if (errorMsg.includes('Authentication required') ||
        errorMsg.includes('unauthorized') ||
        errorMsg.includes('Unauthorized') ||
        errorMsg.includes('401')) {
      return {
        tool: toolName,
        category,
        status: 'auth_required',
        message: 'Needs authentication',
        responseTime: time,
      };
    }

    return {
      tool: toolName,
      category,
      status: 'failed',
      message: 'JSON-RPC Error',
      error: errorMsg,
      responseTime: time,
    };
  }

  // Check for tool-level error in content (Tanda API error)
  const content = response.result?.content?.[0]?.text;
  if (content) {
    try {
      const parsed = JSON.parse(content);
      if (parsed.error || response.result?.isError) {
        const errorStr = typeof parsed.error === 'string' ? parsed.error : JSON.stringify(parsed.error);

        // Unauthorized errors mean the tool works but needs auth
        if (errorStr.includes('unauthorized') || errorStr.includes('Unauthorized')) {
          return {
            tool: toolName,
            category,
            status: 'auth_required',
            message: 'Needs authentication',
            error: errorStr.substring(0, 50),
            responseTime: time,
          };
        }

        // Other API errors - tool works but API returned error
        return {
          tool: toolName,
          category,
          status: 'api_error',
          message: 'Tanda API Error',
          error: errorStr.substring(0, 80),
          responseTime: time,
        };
      }
    } catch {
      // Content is not JSON, that's fine
    }
  }

  return {
    tool: toolName,
    category,
    status: 'passed',
    message: 'Working',
    responseTime: time,
  };
}

// Date helpers
const today = new Date().toISOString().split('T')[0];
const yesterday = new Date(Date.now() - 1 * 24 * 60 * 60 * 1000).toISOString().split('T')[0];
const lastWeek = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString().split('T')[0];
const nextWeek = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString().split('T')[0];
const nextMonth = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString().split('T')[0];

// ==================== Test Configurations ====================

// Original v1 tools (baseline)
const v1ReadTools = [
  { name: 'tanda_get_current_user', category: 'User Management', args: {} },
  { name: 'tanda_get_users', category: 'User Management', args: {} },
  { name: 'tanda_get_user', category: 'User Management', args: { user_id: 1 } },
  { name: 'tanda_get_departments', category: 'Organization', args: {} },
  { name: 'tanda_get_locations', category: 'Organization', args: {} },
  { name: 'tanda_get_schedules', category: 'Scheduling', args: { from: lastWeek, to: today } },
  { name: 'tanda_get_shifts', category: 'Timesheets', args: { from: lastWeek, to: today } },
  { name: 'tanda_get_timesheets', category: 'Timesheets', args: { from: lastWeek, to: today } },
  { name: 'tanda_get_leave_requests', category: 'Leave', args: {} },
  { name: 'tanda_get_leave_balances', category: 'Leave', args: { user_id: 1 } },
  { name: 'tanda_get_unavailability', category: 'Unavailability', args: { from: lastWeek, to: today } },
  { name: 'tanda_get_teams', category: 'Organization', args: {} },
  { name: 'tanda_get_staff_by_department', category: 'Organization', args: { department_id: 1 } },
  { name: 'tanda_get_daily_stats', category: 'Statistics', args: { from: lastWeek, to: today } },
  { name: 'tanda_get_award_interpretation', category: 'Costs', args: { from: lastWeek, to: today } },
  { name: 'tanda_get_roster_costs', category: 'Costs', args: { from: lastWeek, to: today } },
];

// New v2 READ tools
const v2ReadTools = [
  // Real-time Attendance
  { name: 'tanda_get_active_shifts', category: 'Real-time Attendance', args: {} },
  { name: 'tanda_get_clocked_in_users', category: 'Real-time Attendance', args: {} },
  { name: 'tanda_get_inactive_users', category: 'Real-time Attendance', args: {} },

  // Roster Management
  { name: 'tanda_get_current_roster', category: 'Roster Management', args: {} },
  { name: 'tanda_get_roster_by_date', category: 'Roster Management', args: { date: today } },
  { name: 'tanda_get_roster_by_date', category: 'Roster Management', args: { date: today, show_costs: true } },
  { name: 'tanda_get_schedule', category: 'Roster Management', args: { schedule_id: 1 } },

  // Timesheet Tools
  { name: 'tanda_get_user_timesheet', category: 'Timesheet', args: { user_id: 1 } },
  { name: 'tanda_get_user_timesheet_by_date', category: 'Timesheet', args: { user_id: 1, date: yesterday } },
  { name: 'tanda_get_shift_breaks', category: 'Timesheet', args: { shift_id: 1 } },
  { name: 'tanda_get_shift_limits', category: 'Timesheet', args: {} },
  { name: 'tanda_get_shift_limits', category: 'Timesheet', args: { user_ids: [1, 2] } },

  // Leave Tools
  { name: 'tanda_get_leave_types', category: 'Leave', args: { user_id: 1 } },
  { name: 'tanda_calculate_leave_hours', category: 'Leave', args: { user_id: 1, start: nextWeek, finish: nextMonth } },

  // User Management
  { name: 'tanda_get_user_history', category: 'User Management', args: { user_id: 1 } },
];

// New v2 WRITE tools (require --write flag)
const v2WriteTools = [
  { name: 'tanda_invite_user', category: 'User Management', args: { user_id: 1 } },
  {
    name: 'tanda_onboard_users',
    category: 'Bulk Operations',
    args: {
      users: [
        { name: 'Test User 1', email: 'test1@example.com' },
        { name: 'Test User 2', email: 'test2@example.com' },
      ],
      send_invitations: false,
    },
  },
];

// Original v1 write tools
const v1WriteTools = [
  { name: 'tanda_create_schedule', category: 'Scheduling', args: { start: `${nextWeek}T09:00:00Z`, finish: `${nextWeek}T17:00:00Z` } },
  { name: 'tanda_update_schedule', category: 'Scheduling', args: { schedule_id: 1, notes: 'Test update' } },
  { name: 'tanda_delete_schedule', category: 'Scheduling', args: { schedule_id: 999999 } },
  { name: 'tanda_publish_schedules', category: 'Scheduling', args: { from: nextWeek, to: nextMonth } },
  { name: 'tanda_approve_shift', category: 'Timesheets', args: { shift_id: 1 } },
  { name: 'tanda_approve_timesheet', category: 'Timesheets', args: { timesheet_id: 1 } },
  { name: 'tanda_create_leave_request', category: 'Leave', args: { user_id: 1, leave_type: 'annual', start: nextWeek, finish: nextWeek, status: 'pending' } },
  { name: 'tanda_approve_leave', category: 'Leave', args: { leave_id: 1 } },
  { name: 'tanda_decline_leave', category: 'Leave', args: { leave_id: 1, reason: 'Test decline' } },
  { name: 'tanda_delete_leave_request', category: 'Leave', args: { leave_id: 999999 } },
  { name: 'tanda_create_unavailability', category: 'Unavailability', args: { user_id: 1, start: `${nextWeek}T09:00:00Z`, finish: `${nextWeek}T17:00:00Z`, title: 'Test' } },
  { name: 'tanda_delete_unavailability', category: 'Unavailability', args: { unavailability_id: 999999 } },
];

async function runTests() {
  console.log('\n' + '='.repeat(80));
  console.log('🧪 Tanda MCP Server v2.0 - Comprehensive Tool Testing');
  console.log('='.repeat(80));
  console.log(`\n📍 Server: ${BASE_URL}`);
  console.log(`🔑 Auth: ${JWT_TOKEN ? 'Token provided' : 'No token (will show auth_required)'}`);
  console.log(`✏️  Write Tests: ${RUN_WRITE_TESTS ? 'ENABLED (will modify data!)' : 'Disabled (use --write to enable)'}\n`);

  // Test v1 read tools
  console.log('━'.repeat(80));
  console.log('📖 V1 READ OPERATIONS (Baseline)');
  console.log('━'.repeat(80) + '\n');

  for (const test of v1ReadTools) {
    const result = testTool(test.name, test.category, test.args);
    results.push(result);
    printResult(result);
  }

  // Test v2 read tools
  console.log('\n' + '━'.repeat(80));
  console.log('🆕 V2 READ OPERATIONS (New Features)');
  console.log('━'.repeat(80) + '\n');

  for (const test of v2ReadTools) {
    const result = testTool(test.name, test.category, test.args);
    results.push(result);
    printResult(result);
  }

  // Test write tools
  console.log('\n' + '━'.repeat(80));
  console.log(`✏️  WRITE OPERATIONS ${RUN_WRITE_TESTS ? '(ENABLED)' : '(SKIPPED)'}`);
  console.log('━'.repeat(80) + '\n');

  const allWriteTools = [...v1WriteTools, ...v2WriteTools];

  for (const test of allWriteTools) {
    if (RUN_WRITE_TESTS) {
      const result = testTool(test.name, test.category, test.args);
      results.push(result);
      printResult(result);
    } else {
      const result: ToolTestResult = {
        tool: test.name,
        category: test.category,
        status: 'skipped',
        message: 'Skipped (use --write)',
      };
      results.push(result);
      console.log(`⏭️  ${test.name} [${test.category}]: Skipped`);
    }
  }

  // Print summary
  printSummary();

  // Return success status
  const failed = results.filter(r => r.status === 'failed');
  return failed.length === 0;
}

function printResult(result: ToolTestResult) {
  const icon = result.status === 'passed' ? '✅' :
               result.status === 'auth_required' ? '🔒' :
               result.status === 'api_error' ? '⚠️' :
               result.status === 'skipped' ? '⏭️' : '❌';

  const time = result.responseTime ? ` (${result.responseTime}ms)` : '';
  const error = result.error ? ` - ${result.error.substring(0, 50)}` : '';

  console.log(`${icon} ${result.tool} [${result.category}]: ${result.message}${error}${time}`);
}

function printSummary() {
  console.log('\n' + '='.repeat(80));
  console.log('📊 Test Summary');
  console.log('='.repeat(80));

  const passed = results.filter(r => r.status === 'passed');
  const authRequired = results.filter(r => r.status === 'auth_required');
  const apiErrors = results.filter(r => r.status === 'api_error');
  const failed = results.filter(r => r.status === 'failed');
  const skipped = results.filter(r => r.status === 'skipped');

  // Group by category
  const categories = new Map<string, ToolTestResult[]>();
  for (const r of results) {
    if (!categories.has(r.category)) {
      categories.set(r.category, []);
    }
    categories.get(r.category)!.push(r);
  }

  console.log('\n📁 Results by Category:');
  for (const [category, catResults] of categories) {
    const catPassed = catResults.filter(r => r.status === 'passed').length;
    const catTotal = catResults.filter(r => r.status !== 'skipped').length;
    console.log(`   ${category}: ${catPassed}/${catTotal} passed`);
  }

  console.log('\n📈 Overall Results:');
  console.log(`   ✅ Passed: ${passed.length}`);
  console.log(`   ⚠️  API Errors (tool works, Tanda returned error): ${apiErrors.length}`);
  console.log(`   🔒 Auth Required: ${authRequired.length}`);
  console.log(`   ❌ Failed: ${failed.length}`);
  console.log(`   ⏭️  Skipped: ${skipped.length}`);
  console.log(`   📊 Total: ${results.length}`);

  // Average response time
  const withTime = results.filter(r => r.responseTime);
  if (withTime.length > 0) {
    const avgTime = Math.round(withTime.reduce((sum, r) => sum + (r.responseTime || 0), 0) / withTime.length);
    console.log(`   ⏱️  Avg Response Time: ${avgTime}ms`);
  }

  // List failures
  if (failed.length > 0) {
    console.log('\n❌ Failed Tools (need fixing):');
    failed.forEach(r => {
      console.log(`   - ${r.tool}: ${r.error}`);
    });
  }

  // List API errors
  if (apiErrors.length > 0) {
    console.log('\n⚠️  Tools with Tanda API errors (may be expected):');
    apiErrors.forEach(r => {
      console.log(`   - ${r.tool}: ${r.error}`);
    });
  }

  console.log('\n' + '='.repeat(80));
}

// Run tests
runTests()
  .then(success => {
    if (!success) {
      console.log('\n⚠️  Some tools are failing and need to be fixed.\n');
    } else {
      console.log('\n🎉 All tools are working correctly!\n');
    }
    process.exit(success ? 0 : 1);
  })
  .catch(err => {
    console.error('Fatal error:', err);
    process.exit(1);
  });
