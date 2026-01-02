#!/usr/bin/env ts-node
/**
 * Integration Test: Multi-User MCP Server Testing
 *
 * This script tests the MCP server endpoints to verify:
 * 1. Server health and availability
 * 2. OAuth discovery and registration
 * 3. MCP protocol functionality
 * 4. Multi-user session handling
 *
 * Usage:
 *   npx ts-node scripts/test-user-flow.ts <SERVER_URL>
 *
 * Example:
 *   npx ts-node scripts/test-user-flow.ts https://your-app.up.railway.app
 */

import axios, { AxiosError } from 'axios';

interface TestResult {
  name: string;
  passed: boolean;
  message: string;
  data?: unknown;
}

const results: TestResult[] = [];

function log(message: string) {
  console.log(`[TEST] ${message}`);
}

function success(name: string, message: string, data?: unknown) {
  results.push({ name, passed: true, message, data });
  console.log(`✅ ${name}: ${message}`);
}

function fail(name: string, message: string, data?: unknown) {
  results.push({ name, passed: false, message, data });
  console.log(`❌ ${name}: ${message}`);
}

async function testHealthEndpoint(baseUrl: string) {
  try {
    const response = await axios.get(`${baseUrl}/health`);
    if (response.data.status === 'healthy') {
      success('Health Check', `Server is healthy (v${response.data.version})`, response.data);
    } else {
      fail('Health Check', 'Unexpected health status', response.data);
    }
  } catch (error) {
    const err = error as AxiosError;
    fail('Health Check', `Failed: ${err.message}`);
  }
}

async function testServerInfo(baseUrl: string) {
  try {
    const response = await axios.get(`${baseUrl}/`);
    if (response.data.name && response.data.endpoints) {
      success('Server Info', `${response.data.name} v${response.data.version}`, response.data.endpoints);
    } else {
      fail('Server Info', 'Missing expected fields', response.data);
    }
  } catch (error) {
    const err = error as AxiosError;
    fail('Server Info', `Failed: ${err.message}`);
  }
}

async function testOAuthDiscovery(baseUrl: string) {
  try {
    const response = await axios.get(`${baseUrl}/.well-known/oauth-authorization-server`);
    const required = ['issuer', 'authorization_endpoint', 'token_endpoint', 'registration_endpoint'];
    const missing = required.filter(key => !response.data[key]);

    if (missing.length === 0) {
      success('OAuth Discovery', 'All required endpoints present', {
        authorization: response.data.authorization_endpoint,
        token: response.data.token_endpoint,
        registration: response.data.registration_endpoint,
        pkce: response.data.code_challenge_methods_supported,
      });
    } else {
      fail('OAuth Discovery', `Missing: ${missing.join(', ')}`, response.data);
    }
  } catch (error) {
    const err = error as AxiosError;
    fail('OAuth Discovery', `Failed: ${err.message}`);
  }
}

async function testDynamicClientRegistration(baseUrl: string, userName: string) {
  try {
    const response = await axios.post(`${baseUrl}/oauth/register`, {
      client_name: `Test User: ${userName}`,
      redirect_uris: ['https://example.com/callback'],
    });

    if (response.data.client_id && response.data.client_id.startsWith('mcp-client-')) {
      success(`Client Registration (${userName})`, `Registered: ${response.data.client_id}`, response.data);
      return response.data.client_id;
    } else {
      fail(`Client Registration (${userName})`, 'Invalid client_id format', response.data);
      return null;
    }
  } catch (error) {
    const err = error as AxiosError;
    fail(`Client Registration (${userName})`, `Failed: ${err.message}`);
    return null;
  }
}

async function testMCPInitialize(baseUrl: string, clientName: string) {
  try {
    const response = await axios.post(`${baseUrl}/mcp`, {
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2024-11-05',
        clientInfo: { name: clientName, version: '1.0.0' },
        capabilities: {},
      },
    });

    if (response.data.result?.serverInfo) {
      success(`MCP Initialize (${clientName})`,
        `Connected to ${response.data.result.serverInfo.name}`,
        response.data.result.capabilities
      );
      return true;
    } else {
      fail(`MCP Initialize (${clientName})`, 'Invalid response', response.data);
      return false;
    }
  } catch (error) {
    const err = error as AxiosError;
    fail(`MCP Initialize (${clientName})`, `Failed: ${err.message}`);
    return false;
  }
}

async function testMCPToolsList(baseUrl: string) {
  try {
    const response = await axios.post(`${baseUrl}/mcp`, {
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/list',
    });

    if (response.data.result?.tools && Array.isArray(response.data.result.tools)) {
      const toolCount = response.data.result.tools.length;
      const toolNames = response.data.result.tools.slice(0, 5).map((t: { name: string }) => t.name);
      success('MCP Tools List', `${toolCount} tools available`, { count: toolCount, sample: toolNames });
      return response.data.result.tools;
    } else {
      fail('MCP Tools List', 'Invalid response', response.data);
      return [];
    }
  } catch (error) {
    const err = error as AxiosError;
    fail('MCP Tools List', `Failed: ${err.message}`);
    return [];
  }
}

async function testMCPToolCallWithoutAuth(baseUrl: string) {
  try {
    const response = await axios.post(`${baseUrl}/mcp`, {
      jsonrpc: '2.0',
      id: 3,
      method: 'tools/call',
      params: {
        name: 'tanda_get_current_user',
        arguments: {},
      },
    });

    if (response.data.error?.message?.includes('Authentication required')) {
      success('Auth Required Check', 'Tool calls correctly require authentication');
    } else if (response.data.error) {
      success('Auth Required Check', `Correctly rejected: ${response.data.error.message}`);
    } else {
      fail('Auth Required Check', 'Tool call should require authentication', response.data);
    }
  } catch (error) {
    const err = error as AxiosError;
    fail('Auth Required Check', `Failed: ${err.message}`);
  }
}

async function testMCPPing(baseUrl: string) {
  try {
    const response = await axios.post(`${baseUrl}/mcp`, {
      jsonrpc: '2.0',
      id: 4,
      method: 'ping',
    });

    if (response.data.result !== undefined) {
      success('MCP Ping', 'Server responded to ping');
    } else {
      fail('MCP Ping', 'Invalid response', response.data);
    }
  } catch (error) {
    const err = error as AxiosError;
    fail('MCP Ping', `Failed: ${err.message}`);
  }
}

async function testMCPAtRootEndpoint(baseUrl: string) {
  try {
    const response = await axios.post(`${baseUrl}/`, {
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/list',
    });

    if (response.data.result?.tools) {
      success('MCP at Root (/)', 'Claude compatibility endpoint working');
    } else {
      fail('MCP at Root (/)', 'Invalid response', response.data);
    }
  } catch (error) {
    const err = error as AxiosError;
    fail('MCP at Root (/)', `Failed: ${err.message}`);
  }
}

async function testStats(baseUrl: string) {
  try {
    const response = await axios.get(`${baseUrl}/stats`);
    if (response.data.server && response.data.sessions !== undefined) {
      success('Server Stats', `Uptime: ${Math.round(response.data.server.uptime)}s`, {
        sessions: response.data.sessions,
        memory: `${Math.round(response.data.server.memory.heapUsed / 1024 / 1024)}MB`,
      });
    } else {
      fail('Server Stats', 'Invalid response', response.data);
    }
  } catch (error) {
    const err = error as AxiosError;
    fail('Server Stats', `Failed: ${err.message}`);
  }
}

async function runTests(baseUrl: string) {
  console.log('\n' + '='.repeat(60));
  console.log('🧪 Tanda Workforce MCP Server - Integration Tests');
  console.log('='.repeat(60));
  console.log(`\n📍 Testing: ${baseUrl}\n`);

  // Core endpoint tests
  console.log('\n--- Core Endpoints ---');
  await testHealthEndpoint(baseUrl);
  await testServerInfo(baseUrl);
  await testStats(baseUrl);

  // OAuth tests
  console.log('\n--- OAuth 2.0 Endpoints ---');
  await testOAuthDiscovery(baseUrl);

  // Simulate multiple users registering
  console.log('\n--- Multi-User Registration ---');
  const user1ClientId = await testDynamicClientRegistration(baseUrl, 'Alice');
  const user2ClientId = await testDynamicClientRegistration(baseUrl, 'Bob');
  const user3ClientId = await testDynamicClientRegistration(baseUrl, 'Charlie');

  // MCP Protocol tests
  console.log('\n--- MCP Protocol ---');
  await testMCPInitialize(baseUrl, 'test-client-alice');
  await testMCPInitialize(baseUrl, 'test-client-bob');
  await testMCPToolsList(baseUrl);
  await testMCPPing(baseUrl);
  await testMCPToolCallWithoutAuth(baseUrl);
  await testMCPAtRootEndpoint(baseUrl);

  // Summary
  console.log('\n' + '='.repeat(60));
  console.log('📊 Test Summary');
  console.log('='.repeat(60));

  const passed = results.filter(r => r.passed).length;
  const failed = results.filter(r => !r.passed).length;

  console.log(`\n✅ Passed: ${passed}`);
  console.log(`❌ Failed: ${failed}`);
  console.log(`📈 Total:  ${results.length}`);

  if (failed > 0) {
    console.log('\n❌ Failed Tests:');
    results.filter(r => !r.passed).forEach(r => {
      console.log(`   - ${r.name}: ${r.message}`);
    });
  }

  console.log('\n' + '='.repeat(60));

  if (failed === 0) {
    console.log('🎉 All tests passed! Server is ready for Claude integration.');
  } else {
    console.log('⚠️  Some tests failed. Check the server configuration.');
  }

  console.log('='.repeat(60) + '\n');

  // Claude Code configuration hint
  console.log('📋 To use with Claude Code, add this MCP server:');
  console.log(`   URL: ${baseUrl}/mcp`);
  console.log('   The server will handle OAuth authentication automatically.\n');

  return failed === 0;
}

// Main
const args = process.argv.slice(2);
const serverUrl = args[0] || 'http://localhost:3000';

runTests(serverUrl)
  .then(success => process.exit(success ? 0 : 1))
  .catch(err => {
    console.error('Fatal error:', err);
    process.exit(1);
  });
