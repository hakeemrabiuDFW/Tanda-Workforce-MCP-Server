#!/usr/bin/env ts-node
/**
 * Test Authenticated Tools
 *
 * Tests 2 Tanda tools with a valid JWT token to validate authentication works.
 *
 * Usage:
 *   npx ts-node scripts/test-authenticated-tools.ts <JWT_TOKEN> [SERVER_URL]
 *
 * To get a JWT token:
 *   1. Visit https://tanda-workforce-mcp-server-production.up.railway.app/auth/login
 *   2. Complete OAuth with Workforce.com
 *   3. Check /auth/status for your token
 */

import { execSync } from 'child_process';

const JWT_TOKEN = process.argv[2];
const BASE_URL = process.argv[3] || 'https://tanda-workforce-mcp-server-production.up.railway.app';

if (!JWT_TOKEN) {
  console.log(`
╔════════════════════════════════════════════════════════════════════╗
║  Authenticated Tools Test                                          ║
╚════════════════════════════════════════════════════════════════════╝

Usage: npx ts-node scripts/test-authenticated-tools.ts <JWT_TOKEN>

To get a JWT token:
  1. Open in browser: ${BASE_URL}/auth/login
  2. Complete OAuth authentication with Workforce.com
  3. After redirect, visit: ${BASE_URL}/auth/status
  4. Copy the token from the response

Then run:
  npx ts-node scripts/test-authenticated-tools.ts YOUR_JWT_TOKEN
`);
  process.exit(1);
}

function callTool(toolName: string, args: Record<string, unknown> = {}): { success: boolean; data: unknown } {
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
      return { success: false, data: response.error };
    }

    return { success: true, data: response.result };
  } catch (error) {
    return { success: false, data: error instanceof Error ? error.message : String(error) };
  }
}

async function main() {
  console.log(`
╔════════════════════════════════════════════════════════════════════╗
║  Testing Authenticated Tanda Tools                                 ║
╚════════════════════════════════════════════════════════════════════╝

Server: ${BASE_URL}
Token: ${JWT_TOKEN.substring(0, 20)}...
`);

  // Test 1: Get Current User
  console.log('═══════════════════════════════════════════════════════════════');
  console.log('Test 1: tanda_get_current_user');
  console.log('═══════════════════════════════════════════════════════════════');

  const userResult = callTool('tanda_get_current_user');

  if (userResult.success) {
    console.log('✅ SUCCESS - Current user retrieved');
    const content = (userResult.data as { content?: { text?: string }[] })?.content?.[0]?.text;
    if (content) {
      try {
        const userData = JSON.parse(content);
        console.log(`   User ID: ${userData.id}`);
        console.log(`   Name: ${userData.name}`);
        console.log(`   Email: ${userData.email || 'N/A'}`);
      } catch {
        console.log(`   Response: ${content.substring(0, 200)}...`);
      }
    }
  } else {
    console.log('❌ FAILED');
    console.log(`   Error: ${JSON.stringify(userResult.data)}`);
  }

  // Test 2: Get Departments
  console.log('\n═══════════════════════════════════════════════════════════════');
  console.log('Test 2: tanda_get_departments');
  console.log('═══════════════════════════════════════════════════════════════');

  const deptResult = callTool('tanda_get_departments');

  if (deptResult.success) {
    console.log('✅ SUCCESS - Departments retrieved');
    const content = (deptResult.data as { content?: { text?: string }[] })?.content?.[0]?.text;
    if (content) {
      try {
        const depts = JSON.parse(content);
        if (Array.isArray(depts)) {
          console.log(`   Found ${depts.length} department(s)`);
          depts.slice(0, 3).forEach((d: { id: number; name: string }) => {
            console.log(`   - ${d.name} (ID: ${d.id})`);
          });
          if (depts.length > 3) {
            console.log(`   ... and ${depts.length - 3} more`);
          }
        }
      } catch {
        console.log(`   Response: ${content.substring(0, 200)}...`);
      }
    }
  } else {
    console.log('❌ FAILED');
    console.log(`   Error: ${JSON.stringify(deptResult.data)}`);
  }

  // Summary
  console.log('\n═══════════════════════════════════════════════════════════════');
  console.log('Summary');
  console.log('═══════════════════════════════════════════════════════════════');

  const passed = [userResult.success, deptResult.success].filter(Boolean).length;
  const total = 2;

  if (passed === total) {
    console.log(`\n🎉 All ${total} tests passed! Authentication is working correctly.\n`);
    process.exit(0);
  } else {
    console.log(`\n⚠️  ${passed}/${total} tests passed. Check your JWT token.\n`);
    process.exit(1);
  }
}

main().catch(console.error);
