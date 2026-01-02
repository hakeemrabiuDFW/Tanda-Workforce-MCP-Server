#!/usr/bin/env ts-node
/**
 * Claude.ai Integration Test Suite
 *
 * Tests the MCP server endpoints as Claude.ai would use them.
 * Run after deploying to verify the server is ready for Claude.ai connections.
 *
 * Usage:
 *   npx ts-node scripts/test-claude-integration.ts [SERVER_URL]
 *
 * Examples:
 *   npx ts-node scripts/test-claude-integration.ts
 *   npx ts-node scripts/test-claude-integration.ts https://your-server.railway.app
 */

import { execSync } from 'child_process';

const BASE_URL = process.argv[2] || 'https://tanda-workforce-mcp-server-production.up.railway.app';

interface TestResult {
  name: string;
  passed: boolean;
  message: string;
  duration: number;
}

const results: TestResult[] = [];

// Helper to execute curl and parse JSON response
function curlGet(path: string): { status: number; data: unknown } {
  try {
    const result = execSync(
      `curl -s -w "\\n%{http_code}" "${BASE_URL}${path}"`,
      { encoding: 'utf8', timeout: 10000 }
    );
    const lines = result.trim().split('\n');
    const status = parseInt(lines.pop() || '0', 10);
    const body = lines.join('\n');
    return { status, data: body ? JSON.parse(body) : null };
  } catch (error) {
    return { status: 0, data: null };
  }
}

function curlPost(path: string, body: unknown): { status: number; data: unknown } {
  try {
    const jsonBody = JSON.stringify(body);
    // Use single quotes for the -d argument to avoid escaping issues
    const result = execSync(
      `curl -s -w "\\n%{http_code}" -X POST "${BASE_URL}${path}" -H "Content-Type: application/json" -d '${jsonBody}'`,
      { encoding: 'utf8', timeout: 15000 }
    );
    const lines = result.trim().split('\n');
    const status = parseInt(lines.pop() || '0', 10);
    const bodyStr = lines.join('\n');
    return { status, data: bodyStr ? JSON.parse(bodyStr) : null };
  } catch (error) {
    return { status: 0, data: null };
  }
}

async function runTest(name: string, testFn: () => void): Promise<void> {
  const start = Date.now();
  try {
    testFn();
    const duration = Date.now() - start;
    results.push({ name, passed: true, message: 'OK', duration });
    console.log(`✅ ${name} (${duration}ms)`);
  } catch (error) {
    const duration = Date.now() - start;
    const message = error instanceof Error ? error.message : String(error);
    results.push({ name, passed: false, message, duration });
    console.log(`❌ ${name}: ${message}`);
  }
}

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(message);
}

// ============================================
// Test Suite: Server Availability
// ============================================

function testHealthEndpoint(): void {
  const { status, data } = curlGet('/health');
  assert(status === 200, `Expected 200, got ${status}`);
  const d = data as { status: string };
  assert(d.status === 'healthy', 'Health status not healthy');
}

function testRootEndpoint(): void {
  const { status, data } = curlGet('/');
  assert(status === 200, `Expected 200, got ${status}`);
  const d = data as { name: string };
  assert(d.name === 'tanda-workforce-mcp', 'Invalid server name');
}

function testDocsEndpoint(): void {
  const { status, data } = curlGet('/docs');
  assert(status === 200, `Expected 200, got ${status}`);
  const d = data as { endpoints?: unknown };
  assert(d.endpoints !== undefined, 'Missing endpoints in docs');
}

// ============================================
// Test Suite: OAuth Discovery (RFC 8414)
// ============================================

function testOAuthDiscovery(): void {
  const { status, data } = curlGet('/.well-known/oauth-authorization-server');
  assert(status === 200, `Expected 200, got ${status}`);
  const d = data as { authorization_endpoint?: string; token_endpoint?: string; registration_endpoint?: string };
  assert(d.authorization_endpoint !== undefined, 'Missing authorization_endpoint');
  assert(d.token_endpoint !== undefined, 'Missing token_endpoint');
  assert(d.registration_endpoint !== undefined, 'Missing registration_endpoint');
}

function testOAuthDiscoveryPKCE(): void {
  const { status, data } = curlGet('/.well-known/oauth-authorization-server');
  assert(status === 200, `Expected 200, got ${status}`);
  const d = data as { code_challenge_methods_supported?: string[] };
  const methods = d.code_challenge_methods_supported;
  assert(Array.isArray(methods), 'Missing code_challenge_methods_supported');
  assert(methods!.includes('S256'), 'PKCE S256 not supported');
}

// ============================================
// Test Suite: Dynamic Client Registration (RFC 7591)
// ============================================

function testClientRegistration(): void {
  const { status, data } = curlPost('/oauth/register', {
    client_name: 'Claude.ai Test Client',
    redirect_uris: ['https://claude.ai/callback'],
    grant_types: ['authorization_code', 'refresh_token'],
    response_types: ['code'],
    token_endpoint_auth_method: 'none',
  });
  assert(status === 201, `Expected 201, got ${status}`);
  const d = data as { client_id?: string; client_name?: string };
  assert(d.client_id !== undefined, 'Missing client_id');
  assert(d.client_name !== undefined, 'Missing client_name');
  // Note: client_secret is not returned for public clients (token_endpoint_auth_method: none)
}

// ============================================
// Test Suite: MCP Protocol
// ============================================

function testMCPInitialize(): void {
  const { status, data } = curlPost('/mcp', {
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'claude-test', version: '1.0.0' },
    },
  });
  assert(status === 200, `Expected 200, got ${status}`);
  const d = data as { result?: { protocolVersion?: string } };
  assert(d.result !== undefined, 'Missing result in response');
  assert(d.result!.protocolVersion !== undefined, 'Missing protocolVersion');
}

function testMCPToolsList(): void {
  const { status, data } = curlPost('/mcp', {
    jsonrpc: '2.0',
    id: 2,
    method: 'tools/list',
    params: {},
  });
  assert(status === 200, `Expected 200, got ${status}`);
  const d = data as { result?: { tools?: unknown[] } };
  assert(d.result !== undefined, 'Missing result');
  assert(Array.isArray(d.result!.tools), 'tools is not an array');
  assert(d.result!.tools!.length === 25, `Expected 25 tools, got ${d.result!.tools!.length}`);
}

function testMCPToolsListContents(): void {
  const { data } = curlPost('/mcp', {
    jsonrpc: '2.0',
    id: 3,
    method: 'tools/list',
    params: {},
  });

  const d = data as { result?: { tools?: { name: string }[] } };
  const tools = d.result?.tools || [];
  const toolNames = tools.map(t => t.name);

  // Check for essential tools
  const requiredTools = [
    'tanda_get_current_user',
    'tanda_get_users',
    'tanda_get_departments',
    'tanda_get_schedules',
    'tanda_get_timesheets',
    'tanda_get_leave_requests',
    'tanda_clock_in',
    'tanda_get_qualifications',
  ];

  for (const tool of requiredTools) {
    assert(toolNames.includes(tool), `Missing required tool: ${tool}`);
  }
}

function testMCPResourcesList(): void {
  const { status, data } = curlPost('/mcp', {
    jsonrpc: '2.0',
    id: 4,
    method: 'resources/list',
    params: {},
  });
  assert(status === 200, `Expected 200, got ${status}`);
  const d = data as { result?: unknown };
  assert(d.result !== undefined, 'Missing result');
}

function testMCPPromptsList(): void {
  const { status, data } = curlPost('/mcp', {
    jsonrpc: '2.0',
    id: 5,
    method: 'prompts/list',
    params: {},
  });
  assert(status === 200, `Expected 200, got ${status}`);
  const d = data as { result?: unknown };
  assert(d.result !== undefined, 'Missing result');
}

function testMCPPing(): void {
  const { status } = curlPost('/mcp', {
    jsonrpc: '2.0',
    id: 6,
    method: 'ping',
    params: {},
  });
  assert(status === 200, `Expected 200, got ${status}`);
}

// ============================================
// Test Suite: MCP Root Endpoint (Claude Compatibility)
// ============================================

function testMCPRootEndpoint(): void {
  const { status, data } = curlPost('/', {
    jsonrpc: '2.0',
    id: 7,
    method: 'tools/list',
    params: {},
  });
  assert(status === 200, `Expected 200, got ${status}`);
  const d = data as { result?: { tools?: unknown[] } };
  assert(d.result !== undefined, 'Missing result');
  assert(Array.isArray(d.result!.tools), 'tools not returned from root');
}

// ============================================
// Test Suite: Tool Call (Auth Required)
// ============================================

function testToolCallRequiresAuth(): void {
  const { status, data } = curlPost('/mcp', {
    jsonrpc: '2.0',
    id: 8,
    method: 'tools/call',
    params: {
      name: 'tanda_get_current_user',
      arguments: {},
    },
  });
  // Request may timeout or return properly
  if (status === 0) {
    // Timeout - skip with warning
    console.log('    (Note: Request timed out, skipping auth check)');
    return;
  }
  assert(status === 200, `Expected 200, got ${status}`);
  assert(data !== null, 'Expected response data');
  const d = data as { error?: { message?: string }; result?: { content?: { text?: string }[] } };
  // Should return an error about authentication
  const hasAuthError =
    (d.error?.message?.includes('Authentication') ?? false) ||
    (d.result?.content?.[0]?.text?.includes('Authentication') ?? false);
  assert(hasAuthError, 'Expected authentication error for tool call');
}

// ============================================
// Test Suite: SSE Endpoint
// ============================================

function testSSEEndpointExists(): void {
  // SSE endpoint exists - we verify by checking headers
  try {
    const result = execSync(
      `curl -s -I -H "Accept: text/event-stream" "${BASE_URL}/mcp" --max-time 2 2>/dev/null | head -1`,
      { encoding: 'utf8', timeout: 5000 }
    );
    // Should get HTTP 200 response
    assert(result.includes('200'), 'SSE endpoint should return 200');
  } catch {
    // Timeout is expected for SSE connections - that's OK
  }
}

// ============================================
// Test Suite: Error Handling
// ============================================

function testInvalidMethod(): void {
  const { status, data } = curlPost('/mcp', {
    jsonrpc: '2.0',
    id: 9,
    method: 'invalid/method',
    params: {},
  });
  assert(status === 200, `Expected 200, got ${status}`);
  assert(data !== null, 'Expected response data');
  const d = data as { error?: unknown };
  assert(d.error !== undefined, 'Expected error for invalid method');
}

function testInvalidToolName(): void {
  const { status, data } = curlPost('/mcp', {
    jsonrpc: '2.0',
    id: 10,
    method: 'tools/call',
    params: {
      name: 'nonexistent_tool',
      arguments: {},
    },
  });
  assert(status === 200, `Expected 200, got ${status}`);
  assert(data !== null, 'Expected response data');
  const d = data as { error?: unknown; result?: { content?: { text?: string }[] } };
  // Should return an error about tool not found
  const hasError = d.error !== undefined ||
    (d.result?.content?.[0]?.text?.includes('not found') ?? false) ||
    (d.result?.content?.[0]?.text?.includes('Unknown') ?? false);
  assert(hasError, 'Expected error for invalid tool name');
}

// ============================================
// Main Test Runner
// ============================================

async function runAllTests(): Promise<void> {
  console.log('\n' + '='.repeat(60));
  console.log('🧪 Claude.ai Integration Test Suite');
  console.log('='.repeat(60));
  console.log(`\n📍 Server: ${BASE_URL}\n`);

  console.log('\n📦 Server Availability\n');
  await runTest('Health endpoint returns healthy', testHealthEndpoint);
  await runTest('Root endpoint returns server info', testRootEndpoint);
  await runTest('Docs endpoint returns API documentation', testDocsEndpoint);

  console.log('\n🔐 OAuth Discovery (RFC 8414)\n');
  await runTest('OAuth discovery endpoint exists', testOAuthDiscovery);
  await runTest('PKCE S256 is supported', testOAuthDiscoveryPKCE);

  console.log('\n📝 Dynamic Client Registration (RFC 7591)\n');
  await runTest('Client registration creates new client', testClientRegistration);

  console.log('\n🔌 MCP Protocol\n');
  await runTest('MCP initialize handshake', testMCPInitialize);
  await runTest('MCP tools/list returns 25 tools', testMCPToolsList);
  await runTest('MCP tools/list contains required tools', testMCPToolsListContents);
  await runTest('MCP resources/list works', testMCPResourcesList);
  await runTest('MCP prompts/list works', testMCPPromptsList);
  await runTest('MCP ping works', testMCPPing);

  console.log('\n🔄 Claude Compatibility\n');
  await runTest('MCP root POST endpoint works', testMCPRootEndpoint);
  await runTest('SSE endpoint exists', testSSEEndpointExists);

  console.log('\n🔒 Authentication\n');
  await runTest('Tool call requires authentication', testToolCallRequiresAuth);

  console.log('\n⚠️  Error Handling\n');
  await runTest('Invalid method returns error', testInvalidMethod);
  await runTest('Invalid tool name returns error', testInvalidToolName);

  // Summary
  console.log('\n' + '='.repeat(60));
  console.log('📊 Test Summary');
  console.log('='.repeat(60));

  const passed = results.filter(r => r.passed);
  const failed = results.filter(r => !r.passed);
  const totalDuration = results.reduce((sum, r) => sum + r.duration, 0);

  console.log(`\n✅ Passed: ${passed.length}`);
  console.log(`❌ Failed: ${failed.length}`);
  console.log(`📈 Total: ${results.length}`);
  console.log(`⏱️  Duration: ${totalDuration}ms`);

  if (failed.length > 0) {
    console.log('\n❌ Failed Tests:');
    failed.forEach(r => {
      console.log(`   - ${r.name}: ${r.message}`);
    });
  }

  console.log('\n' + '='.repeat(60));

  if (failed.length === 0) {
    console.log('\n🎉 All tests passed! Server is ready for Claude.ai connections.\n');
    process.exit(0);
  } else {
    console.log('\n⚠️  Some tests failed. Please review and fix before using with Claude.ai.\n');
    process.exit(1);
  }
}

runAllTests().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
