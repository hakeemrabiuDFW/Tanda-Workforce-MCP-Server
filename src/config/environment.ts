import { z } from 'zod';
import dotenv from 'dotenv';

dotenv.config();

const environmentSchema = z.object({
  // Server Configuration
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  PORT: z.string().default('3000').transform(Number),
  HOST: z.string().default('0.0.0.0'),

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
  MCP_SERVER_VERSION: z.string().default('1.0.0'),
});

function loadEnvironment() {
  const result = environmentSchema.safeParse(process.env);

  if (!result.success) {
    console.error('Environment validation failed:');
    result.error.issues.forEach((issue) => {
      console.error(`  - ${issue.path.join('.')}: ${issue.message}`);
    });

    if (process.env.NODE_ENV === 'production') {
      process.exit(1);
    }

    // Return partial config for development
    return {
      NODE_ENV: 'development' as const,
      PORT: 3000,
      HOST: '0.0.0.0',
      TANDA_CLIENT_ID: process.env.TANDA_CLIENT_ID || '',
      TANDA_CLIENT_SECRET: process.env.TANDA_CLIENT_SECRET || '',
      TANDA_REDIRECT_URI: process.env.TANDA_REDIRECT_URI || 'http://localhost:3000/auth/callback',
      TANDA_API_BASE_URL: 'https://my.tanda.co/api/v2',
      TANDA_AUTH_URL: 'https://my.tanda.co/api/oauth/authorize',
      TANDA_TOKEN_URL: 'https://my.tanda.co/api/oauth/token',
      SESSION_SECRET: process.env.SESSION_SECRET || 'development-secret-change-in-production-32chars',
      JWT_SECRET: process.env.JWT_SECRET || 'development-jwt-secret-change-in-production-32',
      JWT_EXPIRY: '24h',
      CORS_ORIGINS: '*',
      RATE_LIMIT_WINDOW_MS: 900000,
      RATE_LIMIT_MAX_REQUESTS: 100,
      MCP_SERVER_NAME: 'tanda-workforce-mcp',
      MCP_SERVER_VERSION: '1.0.0',
    };
  }

  return result.data;
}

export const config = loadEnvironment();

export type Environment = typeof config;
