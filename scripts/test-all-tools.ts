#!/usr/bin/env ts-node
/**
 * Test All MCP Tools
 *
 * Tests each tool endpoint to identify which ones are working vs broken.
 * Requires authentication to test tool calls.
 *
 * Usage:
 *   npx ts-node scripts/test-all-tools.ts <SERVER_URL> [JWT_TOKEN]
 */

import axios from 'axios';

const BASE_URL = process.argv[2] || 'https://tanda-workforce-mcp-server-production.up.railway.app';
const JWT_TOKEN = process.argv[3] || '';

interface ToolTestResult {
  tool: string;
  status: 'passed' | 'failed' | 'auth_required';
  message: string;
  error?: string;
}

const results: ToolTestResult[] = [];

async function testTool(toolName: string, args: Record<string, unknown> = {}): Promise<ToolTestResult> {
  try {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
    };

    if (JWT_TOKEN) {
      headers['Authorization'] = `Bearer ${JWT_TOKEN}`;
    }

    const response = await axios.post(`${BASE_URL}/mcp`, {
      jsonrpc: '2.0',
      id: Date.now(),
      method: 'tools/call',
      params: {
        name: toolName,
        arguments: args,
      },
    }, { headers });

    if (response.data.error) {
      const errorMsg = response.data.error.message || JSON.stringify(response.data.error);

      if (errorMsg.includes('Authentication required')) {
        return {
          tool: toolName,
          status: 'auth_required',
          message: 'Needs authentication',
        };
      }

      return {
        tool: toolName,
        status: 'failed',
        message: 'API Error',
        error: errorMsg,
      };
    }

    if (response.data.result?.content?.error) {
      return {
        tool: toolName,
        status: 'failed',
        message: 'Tool Error',
        error: response.data.result.content.error,
      };
    }

    return {
      tool: toolName,
      status: 'passed',
      message: 'Working',
    };
  } catch (error) {
    const err = error as Error;
    return {
      tool: toolName,
      status: 'failed',
      message: 'Request Failed',
      error: err.message,
    };
  }
}

// Date helpers
const today = new Date().toISOString().split('T')[0];
const lastWeek = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString().split('T')[0];

// Tool test configurations
const toolTests = [
  // User Management
  { name: 'tanda_get_current_user', args: {} },
  { name: 'tanda_get_users', args: {} },
  { name: 'tanda_get_user', args: { user_id: 1 } },

  // Departments & Locations
  { name: 'tanda_get_departments', args: {} },
  { name: 'tanda_get_locations', args: {} },

  // Schedules
  { name: 'tanda_get_schedules', args: { from: lastWeek, to: today } },
  { name: 'tanda_create_schedule', args: { start: '2024-01-15T09:00:00', finish: '2024-01-15T17:00:00' } },
  { name: 'tanda_update_schedule', args: { schedule_id: 1 } },
  { name: 'tanda_delete_schedule', args: { schedule_id: 999999 } },
  { name: 'tanda_publish_schedules', args: { from: lastWeek, to: today } },

  // Shifts & Timesheets
  { name: 'tanda_get_shifts', args: { from: lastWeek, to: today } },
  { name: 'tanda_get_timesheets', args: { from: lastWeek, to: today } },
  { name: 'tanda_approve_shift', args: { shift_id: 1 } },
  { name: 'tanda_approve_timesheet', args: { timesheet_id: 1 } },

  // Leave
  { name: 'tanda_get_leave_requests', args: {} },
  { name: 'tanda_create_leave_request', args: { user_id: 1, leave_type: 'annual', start: today, finish: today } },
  { name: 'tanda_approve_leave', args: { leave_id: 1 } },
  { name: 'tanda_decline_leave', args: { leave_id: 1 } },
  { name: 'tanda_get_leave_balances', args: { user_id: 1 } },

  // Clock In/Out
  { name: 'tanda_clock_in', args: { user_id: 1, type: 'start' } },
  { name: 'tanda_get_clock_ins', args: { from: lastWeek, to: today } },

  // Qualifications
  { name: 'tanda_get_qualifications', args: {} },
  { name: 'tanda_get_user_qualifications', args: { user_id: 1 } },

  // Costs
  { name: 'tanda_get_award_interpretation', args: { from: lastWeek, to: today } },
  { name: 'tanda_get_roster_costs', args: { from: lastWeek, to: today } },
];

async function runTests() {
  console.log('\n' + '='.repeat(70));
  console.log('🧪 Tanda MCP Server - Tool Testing');
  console.log('='.repeat(70));
  console.log(`\n📍 Server: ${BASE_URL}`);
  console.log(`🔑 Auth: ${JWT_TOKEN ? 'Token provided' : 'No token (will show auth_required)'}\n`);

  for (const test of toolTests) {
    const result = await testTool(test.name, test.args);
    results.push(result);

    const icon = result.status === 'passed' ? '✅' :
                 result.status === 'auth_required' ? '🔒' : '❌';

    console.log(`${icon} ${result.tool}: ${result.message}${result.error ? ` - ${result.error.substring(0, 60)}` : ''}`);
  }

  // Summary
  console.log('\n' + '='.repeat(70));
  console.log('📊 Test Summary');
  console.log('='.repeat(70));

  const passed = results.filter(r => r.status === 'passed');
  const authRequired = results.filter(r => r.status === 'auth_required');
  const failed = results.filter(r => r.status === 'failed');

  console.log(`\n✅ Passed: ${passed.length}`);
  console.log(`🔒 Auth Required: ${authRequired.length}`);
  console.log(`❌ Failed: ${failed.length}`);
  console.log(`📈 Total: ${results.length}`);

  if (failed.length > 0) {
    console.log('\n❌ Failed Tools (need fixing):');
    failed.forEach(r => {
      console.log(`   - ${r.tool}: ${r.error}`);
    });
  }

  console.log('\n' + '='.repeat(70));

  // Return exit code based on failures
  return failed.length === 0;
}

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
