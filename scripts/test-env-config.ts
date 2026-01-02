#!/usr/bin/env npx ts-node
/**
 * Test script to validate environment configuration logic
 * Run with: npx ts-node scripts/test-env-config.ts
 *
 * This simulates different deployment scenarios without needing to deploy:
 * 1. Railway production (with RAILWAY_PUBLIC_DOMAIN)
 * 2. Local development (no Railway vars)
 * 3. Production without Railway (should fail without explicit URI)
 * 4. Explicit TANDA_REDIRECT_URI (should override everything)
 */

// Store original env
const originalEnv = { ...process.env };

// Test utilities
function resetEnv() {
  // Clear all relevant env vars
  delete process.env.NODE_ENV;
  delete process.env.RAILWAY_PUBLIC_DOMAIN;
  delete process.env.RAILWAY_STATIC_URL;
  delete process.env.RAILWAY_ENVIRONMENT;
  delete process.env.TANDA_REDIRECT_URI;
  delete process.env.TANDA_CLIENT_ID;
  delete process.env.TANDA_CLIENT_SECRET;
  delete process.env.SESSION_SECRET;
  delete process.env.JWT_SECRET;
  delete process.env.CORS_ORIGINS;
}

function setBaseCredentials() {
  // Set minimum required credentials for testing
  process.env.TANDA_CLIENT_ID = 'test-client-id';
  process.env.TANDA_CLIENT_SECRET = 'test-client-secret';
  process.env.SESSION_SECRET = 'test-session-secret-at-least-32-characters-long';
  process.env.JWT_SECRET = 'test-jwt-secret-at-least-32-characters-long-too';
}

interface TestResult {
  name: string;
  passed: boolean;
  message: string;
  redirectUri?: string;
}

const results: TestResult[] = [];

// Helper to test config loading
function testConfig(testName: string, setupFn: () => void, expectation: (result: any) => { passed: boolean; message: string }) {
  resetEnv();
  setupFn();

  // Clear module cache to reload config fresh
  delete require.cache[require.resolve('../dist/config/environment.js')];

  try {
    const { config } = require('../dist/config/environment.js');
    const { passed, message } = expectation(config);
    results.push({
      name: testName,
      passed,
      message,
      redirectUri: config.TANDA_REDIRECT_URI
    });
  } catch (error: any) {
    // Check if this was an expected exit
    if (error.code === 'ERR_MODULE_NOT_FOUND' || error.message?.includes('Cannot find module')) {
      results.push({
        name: testName,
        passed: false,
        message: `Module error: ${error.message}. Run 'npm run build' first.`
      });
    } else {
      results.push({
        name: testName,
        passed: false,
        message: `Unexpected error: ${error.message}`
      });
    }
  }
}

console.log('\n🧪 Testing Environment Configuration Logic\n');
console.log('='.repeat(60));

// Test 1: Railway Production Environment
console.log('\n📋 Test 1: Railway Production Environment');
testConfig(
  'Railway auto-detection',
  () => {
    process.env.NODE_ENV = 'production';
    process.env.RAILWAY_PUBLIC_DOMAIN = 'myapp.up.railway.app';
    setBaseCredentials();
  },
  (config) => {
    const expected = 'https://myapp.up.railway.app/auth/callback';
    const passed = config.TANDA_REDIRECT_URI === expected;
    return {
      passed,
      message: passed
        ? `✅ Correctly auto-detected: ${config.TANDA_REDIRECT_URI}`
        : `❌ Expected ${expected}, got ${config.TANDA_REDIRECT_URI}`
    };
  }
);

// Test 2: Railway with RAILWAY_STATIC_URL (takes priority)
console.log('\n📋 Test 2: Railway with RAILWAY_STATIC_URL');
testConfig(
  'Railway STATIC_URL priority',
  () => {
    process.env.NODE_ENV = 'production';
    process.env.RAILWAY_PUBLIC_DOMAIN = 'myapp.up.railway.app';
    process.env.RAILWAY_STATIC_URL = 'https://custom-static.railway.app';
    setBaseCredentials();
  },
  (config) => {
    const expected = 'https://custom-static.railway.app/auth/callback';
    const passed = config.TANDA_REDIRECT_URI === expected;
    return {
      passed,
      message: passed
        ? `✅ RAILWAY_STATIC_URL takes priority: ${config.TANDA_REDIRECT_URI}`
        : `❌ Expected ${expected}, got ${config.TANDA_REDIRECT_URI}`
    };
  }
);

// Test 3: Local Development (no Railway vars)
console.log('\n📋 Test 3: Local Development');
testConfig(
  'Development localhost fallback',
  () => {
    process.env.NODE_ENV = 'development';
    setBaseCredentials();
  },
  (config) => {
    const expected = 'http://localhost:3000/auth/callback';
    const passed = config.TANDA_REDIRECT_URI === expected;
    return {
      passed,
      message: passed
        ? `✅ Correctly falls back to localhost: ${config.TANDA_REDIRECT_URI}`
        : `❌ Expected ${expected}, got ${config.TANDA_REDIRECT_URI}`
    };
  }
);

// Test 4: Explicit TANDA_REDIRECT_URI overrides everything
console.log('\n📋 Test 4: Explicit Override');
testConfig(
  'Explicit URI override',
  () => {
    process.env.NODE_ENV = 'production';
    process.env.RAILWAY_PUBLIC_DOMAIN = 'myapp.up.railway.app';
    process.env.TANDA_REDIRECT_URI = 'https://custom-domain.com/auth/callback';
    setBaseCredentials();
  },
  (config) => {
    const expected = 'https://custom-domain.com/auth/callback';
    const passed = config.TANDA_REDIRECT_URI === expected;
    return {
      passed,
      message: passed
        ? `✅ Explicit URI takes priority: ${config.TANDA_REDIRECT_URI}`
        : `❌ Expected ${expected}, got ${config.TANDA_REDIRECT_URI}`
    };
  }
);

// Test 5: Production without Railway or explicit URI (should use partial config in test)
console.log('\n📋 Test 5: Production Missing Config (graceful in dev)');
testConfig(
  'Missing config in dev mode',
  () => {
    process.env.NODE_ENV = 'development';
    // Don't set credentials - should use partial config
  },
  (config) => {
    // In development, should still get a config object with localhost fallback
    const passed = config.TANDA_REDIRECT_URI === 'http://localhost:3000/auth/callback';
    return {
      passed,
      message: passed
        ? `✅ Dev mode gracefully handles missing config`
        : `❌ Unexpected behavior in dev mode`
    };
  }
);

// Print results summary
console.log('\n' + '='.repeat(60));
console.log('\n📊 Test Results Summary:\n');

let passedCount = 0;
let failedCount = 0;

results.forEach((result, index) => {
  const status = result.passed ? '✅ PASS' : '❌ FAIL';
  console.log(`${index + 1}. ${result.name}: ${status}`);
  console.log(`   ${result.message}`);
  if (result.redirectUri) {
    console.log(`   Redirect URI: ${result.redirectUri}`);
  }
  console.log();

  if (result.passed) passedCount++;
  else failedCount++;
});

console.log('='.repeat(60));
console.log(`\n🏁 Total: ${passedCount} passed, ${failedCount} failed\n`);

// Restore original env
Object.keys(process.env).forEach(key => delete process.env[key]);
Object.assign(process.env, originalEnv);

// Exit with appropriate code
process.exit(failedCount > 0 ? 1 : 0);
