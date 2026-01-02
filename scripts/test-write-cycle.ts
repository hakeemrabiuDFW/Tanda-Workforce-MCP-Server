#!/usr/bin/env ts-node
/**
 * Write Cycle Test
 *
 * Tests write operations by creating, verifying, and deleting records.
 * Waits for user confirmation between steps.
 *
 * Usage:
 *   npx ts-node scripts/test-write-cycle.ts <JWT_TOKEN> [SERVER_URL]
 */

import { execSync } from 'child_process';
import * as readline from 'readline';

const JWT_TOKEN = process.argv[2];
const BASE_URL = process.argv[3] || 'https://tanda-workforce-mcp-server-production.up.railway.app';

if (!JWT_TOKEN) {
  console.log(`
Usage: npx ts-node scripts/test-write-cycle.ts <JWT_TOKEN> [SERVER_URL]

This test will:
1. Create an unavailability record for tomorrow
2. Wait for you to verify it in the Workforce.com app
3. Delete the record after your confirmation
`);
  process.exit(1);
}

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
});

function ask(question: string): Promise<string> {
  return new Promise((resolve) => {
    rl.question(question, resolve);
  });
}

function callTool(toolName: string, args: Record<string, unknown>): { success: boolean; data: unknown; error?: string } {
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

    const result = execSync(
      `curl -s -X POST "${BASE_URL}/mcp" \
        -H "Content-Type: application/json" \
        -H "Authorization: Bearer ${JWT_TOKEN}" \
        -d '${body}'`,
      { encoding: 'utf8', timeout: 30000 }
    );

    const response = JSON.parse(result);

    if (response.error) {
      return { success: false, data: null, error: response.error.message || JSON.stringify(response.error) };
    }

    const content = response.result?.content?.[0]?.text;
    if (content) {
      try {
        const parsed = JSON.parse(content);
        if (parsed.error) {
          return { success: false, data: parsed, error: parsed.error };
        }
        return { success: true, data: parsed };
      } catch {
        return { success: true, data: content };
      }
    }

    return { success: true, data: response.result };
  } catch (error) {
    return { success: false, data: null, error: error instanceof Error ? error.message : String(error) };
  }
}

async function main() {
  console.log(`
╔════════════════════════════════════════════════════════════════════╗
║  Write Cycle Test - Create, Verify, Delete                        ║
╚════════════════════════════════════════════════════════════════════╝

Server: ${BASE_URL}
Token: ${JWT_TOKEN.substring(0, 20)}...
`);

  // Step 1: Get current user
  console.log('Step 1: Getting current user...');
  const userResult = callTool('tanda_get_current_user', {});

  if (!userResult.success) {
    console.log(`❌ Failed to get current user: ${userResult.error}`);
    rl.close();
    process.exit(1);
  }

  const user = userResult.data as { id: number; name: string };
  console.log(`✅ Logged in as: ${user.name} (ID: ${user.id})\n`);

  // Step 2: Create unavailability for tomorrow
  const tomorrow = new Date();
  tomorrow.setDate(tomorrow.getDate() + 1);
  const startDate = tomorrow.toISOString().split('T')[0];
  const startTime = `${startDate}T09:00:00`;
  const finishTime = `${startDate}T10:00:00`;

  console.log('Step 2: Creating test unavailability...');
  console.log(`   User: ${user.id}`);
  console.log(`   Date: ${startDate}`);
  console.log(`   Time: 09:00 - 10:00`);
  console.log(`   Title: "MCP Test - Please Delete"\n`);

  const createResult = callTool('tanda_create_unavailability', {
    user_id: user.id,
    start: startTime,
    finish: finishTime,
    title: 'MCP Test - Please Delete',
  });

  if (!createResult.success) {
    console.log(`❌ Failed to create unavailability: ${createResult.error}`);
    console.log('\nThis may be due to:');
    console.log('  - The unavailability endpoint not being available');
    console.log('  - Insufficient permissions');
    console.log('  - The API requiring different parameters\n');
    rl.close();
    process.exit(1);
  }

  const created = createResult.data as { id: number };
  console.log(`✅ Created unavailability with ID: ${created.id}\n`);

  // Step 3: Wait for user verification
  console.log('═══════════════════════════════════════════════════════════════');
  console.log('Please verify the unavailability in your Workforce.com app:');
  console.log(`  - Check your schedule for ${startDate}`);
  console.log('  - Look for "MCP Test - Please Delete" from 09:00-10:00');
  console.log('═══════════════════════════════════════════════════════════════\n');

  const response = await ask('Did you see the unavailability? (y/n): ');

  if (response.toLowerCase() !== 'y') {
    console.log('\n⚠️  Keeping the unavailability for manual inspection.');
    console.log(`   ID: ${created.id}`);
    console.log('   You can delete it manually in the Workforce.com app.\n');
    rl.close();
    process.exit(0);
  }

  // Step 4: Delete the unavailability
  console.log('\nStep 4: Deleting test unavailability...');

  const deleteResult = callTool('tanda_delete_unavailability', {
    unavailability_id: created.id,
  });

  if (!deleteResult.success) {
    console.log(`❌ Failed to delete unavailability: ${deleteResult.error}`);
    console.log(`   Please delete ID ${created.id} manually.\n`);
  } else {
    console.log(`✅ Successfully deleted unavailability ID: ${created.id}\n`);
  }

  // Summary
  console.log('═══════════════════════════════════════════════════════════════');
  console.log('Write Cycle Test Complete!');
  console.log('═══════════════════════════════════════════════════════════════');
  console.log('\nResults:');
  console.log(`  ✅ Create: ${createResult.success ? 'Success' : 'Failed'}`);
  console.log(`  ✅ Verify: User confirmed`);
  console.log(`  ${deleteResult.success ? '✅' : '❌'} Delete: ${deleteResult.success ? 'Success' : 'Failed'}`);
  console.log('');

  rl.close();
}

main().catch((err) => {
  console.error('Fatal error:', err);
  rl.close();
  process.exit(1);
});
