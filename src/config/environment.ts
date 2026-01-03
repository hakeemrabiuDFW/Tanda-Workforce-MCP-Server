import { z } from 'zod';
import dotenv from 'dotenv';

dotenv.config();

/**
 * Detect if running on Railway and get the public URL
 * Railway provides these environment variables automatically:
 * - RAILWAY_PUBLIC_DOMAIN: The public domain (e.g., myapp.up.railway.app)
 * - RAILWAY_STATIC_URL: Full URL with protocol (e.g., https://myapp.up.railway.app)
 */
function getRailwayPublicUrl(): string | undefined {
  // RAILWAY_STATIC_URL is the full URL with protocol
  if (process.env.RAILWAY_STATIC_URL) {
    return process.env.RAILWAY_STATIC_URL;
  }
  // RAILWAY_PUBLIC_DOMAIN is just the domain, need to add https://
  if (process.env.RAILWAY_PUBLIC_DOMAIN) {
    return `https://${process.env.RAILWAY_PUBLIC_DOMAIN}`;
  }
  return undefined;
}

/**
 * Construct the OAuth redirect URI dynamically
 * Priority:
 * 1. Explicitly set TANDA_REDIRECT_URI
 * 2. Railway public URL + /auth/callback
 * 3. In development only: localhost fallback
 */
function getRedirectUri(): string | undefined {
  // Explicit configuration takes priority
  if (process.env.TANDA_REDIRECT_URI) {
    return process.env.TANDA_REDIRECT_URI;
  }

  // Auto-detect from Railway environment
  const railwayUrl = getRailwayPublicUrl();
  if (railwayUrl) {
    return `${railwayUrl}/auth/callback`;
  }

  // Development fallback only
  if (process.env.NODE_ENV !== 'production') {
    return 'http://localhost:3000/auth/callback';
  }

  // In production without Railway or explicit URI, return undefined
  // This will cause validation to fail with a clear error
  return undefined;
}

/**
 * Get CORS origins with production safety
 * In production, warn if using wildcard CORS
 */
function getCorsOrigins(): string {
  const origins = process.env.CORS_ORIGINS || '*';

  if (process.env.NODE_ENV === 'production' && origins === '*') {
    console.warn(
      '⚠️  WARNING: CORS_ORIGINS is set to "*" in production. ' +
      'Consider restricting to specific origins for security.'
    );
  }

  return origins;
}

// Pre-compute the redirect URI for validation
const computedRedirectUri = getRedirectUri();

const environmentSchema = z.object({
  // Server Configuration
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  PORT: z.string().default('3000').transform(Number),
  HOST: z.string().default('0.0.0.0'),

  // Railway Environment (auto-detected)
  RAILWAY_PUBLIC_DOMAIN: z.string().optional(),
  RAILWAY_STATIC_URL: z.string().optional(),
  RAILWAY_ENVIRONMENT: z.string().optional(),

  // Tanda OAuth Configuration
  TANDA_CLIENT_ID: z.string().min(1, 'TANDA_CLIENT_ID is required'),
  TANDA_CLIENT_SECRET: z.string().min(1, 'TANDA_CLIENT_SECRET is required'),
  TANDA_REDIRECT_URI: z.string().url('TANDA_REDIRECT_URI must be a valid URL'),
  TANDA_API_BASE_URL: z.string().url().default('https://my.tanda.co/api/v2'),
  TANDA_AUTH_URL: z.string().url().default('https://my.tanda.co/api/oauth/authorize'),
  TANDA_TOKEN_URL: z.string().url().default('https://my.tanda.co/api/oauth/token'),

  // Session Configuration
  SESSION_SECRET: z.string().min(32, 'SESSION_SECRET must be at least 32 characters'),
  JWT_SECRET: z.string().min(32, 'JWT_SECRET must be at least 32 characters'),
  JWT_EXPIRY: z.string().default('24h'),

  // Security Configuration
  CORS_ORIGINS: z.string().default('*'),
  RATE_LIMIT_WINDOW_MS: z.string().default('900000').transform(Number),
  RATE_LIMIT_MAX_REQUESTS: z.string().default('100').transform(Number),

  // MCP Configuration
  MCP_SERVER_NAME: z.string().default('tanda-workforce-mcp'),
  MCP_SERVER_VERSION: z.string().default('3.0.0'),

  // v3.0: Read-only mode - when enabled, only GET operations are allowed
  MCP_READ_ONLY_MODE: z.string().optional().transform((val) => val === 'true'),
});

function loadEnvironment() {
  // Inject computed redirect URI into process.env for validation
  // This allows Railway auto-detection to work with the schema
  if (computedRedirectUri && !process.env.TANDA_REDIRECT_URI) {
    process.env.TANDA_REDIRECT_URI = computedRedirectUri;
  }

  const result = environmentSchema.safeParse(process.env);

  if (!result.success) {
    console.error('❌ Environment validation failed:');
    result.error.issues.forEach((issue) => {
      console.error(`  - ${issue.path.join('.')}: ${issue.message}`);
    });

    // Provide helpful guidance for common issues
    if (result.error.issues.some(i => i.path.includes('TANDA_REDIRECT_URI'))) {
      console.error('\n💡 Hint: TANDA_REDIRECT_URI is required in production.');
      console.error('   On Railway, this is auto-detected from RAILWAY_PUBLIC_DOMAIN.');
      console.error('   Otherwise, set it explicitly: TANDA_REDIRECT_URI=https://your-domain.com/auth/callback');
    }

    if (process.env.NODE_ENV === 'production') {
      console.error('\n🛑 Exiting: Cannot start in production with invalid configuration.');
      process.exit(1);
    }

    console.warn('\n⚠️  Running in development mode with partial configuration.');
    console.warn('   Some features may not work correctly.\n');

    // Return partial config for development only
    // Use computed redirect URI (which includes localhost fallback for dev)
    return {
      NODE_ENV: 'development' as const,
      PORT: 3000,
      HOST: '0.0.0.0',
      RAILWAY_PUBLIC_DOMAIN: process.env.RAILWAY_PUBLIC_DOMAIN,
      RAILWAY_STATIC_URL: process.env.RAILWAY_STATIC_URL,
      RAILWAY_ENVIRONMENT: process.env.RAILWAY_ENVIRONMENT,
      TANDA_CLIENT_ID: process.env.TANDA_CLIENT_ID || '',
      TANDA_CLIENT_SECRET: process.env.TANDA_CLIENT_SECRET || '',
      TANDA_REDIRECT_URI: computedRedirectUri || 'http://localhost:3000/auth/callback',
      TANDA_API_BASE_URL: 'https://my.tanda.co/api/v2',
      TANDA_AUTH_URL: 'https://my.tanda.co/api/oauth/authorize',
      TANDA_TOKEN_URL: 'https://my.tanda.co/api/oauth/token',
      SESSION_SECRET: process.env.SESSION_SECRET || 'development-secret-change-in-production-32chars',
      JWT_SECRET: process.env.JWT_SECRET || 'development-jwt-secret-change-in-production-32',
      JWT_EXPIRY: '24h',
      CORS_ORIGINS: getCorsOrigins(),
      RATE_LIMIT_WINDOW_MS: 900000,
      RATE_LIMIT_MAX_REQUESTS: 100,
      MCP_SERVER_NAME: 'tanda-workforce-mcp',
      MCP_SERVER_VERSION: '3.0.0',
      MCP_READ_ONLY_MODE: process.env.MCP_READ_ONLY_MODE === 'true',
    };
  }

  // Log Railway detection in production
  if (result.data.RAILWAY_PUBLIC_DOMAIN) {
    console.log(`✅ Railway environment detected: ${result.data.RAILWAY_PUBLIC_DOMAIN}`);
  }

  // Apply CORS safety check
  getCorsOrigins();

  return result.data;
}

export const config = loadEnvironment();

export type Environment = typeof config;
