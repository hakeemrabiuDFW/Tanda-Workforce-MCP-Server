import { Request, Response, NextFunction } from 'express';
import { oauthManager, JWTPayload } from './oauth';
import { apiKeyManager } from './apikey';
import { logger } from '../utils/logger';
import { TandaClient } from '../tanda/client';

// Auth type for tracking authentication method
export type AuthType = 'jwt' | 'apikey' | 'none';

// Extend Express Request type to include auth info
declare global {
  namespace Express {
    interface Request {
      auth?: {
        payload: JWTPayload;
        sessionId: string;
        tandaClient: TandaClient;
        authType?: AuthType;
      };
    }
  }
}

export function extractBearerToken(req: Request): string | null {
  const authHeader = req.headers.authorization;
  if (!authHeader) return null;

  const parts = authHeader.split(' ');
  if (parts.length !== 2 || parts[0].toLowerCase() !== 'bearer') {
    return null;
  }

  return parts[1];
}

/**
 * Extract API key from X-API-Key header
 */
export function extractApiKey(req: Request): string | null {
  const apiKey = req.headers['x-api-key'];
  if (apiKey && typeof apiKey === 'string') {
    return apiKey;
  }
  return null;
}

/**
 * Extract auth credentials from request (supports both JWT and API key)
 */
export function extractAuthCredentials(req: Request): {
  type: AuthType;
  credential: string | null;
} {
  // Check for Bearer token first
  const bearerToken = extractBearerToken(req);
  if (bearerToken) {
    return { type: 'jwt', credential: bearerToken };
  }

  // Check for API key
  const apiKey = extractApiKey(req);
  if (apiKey) {
    return { type: 'apikey', credential: apiKey };
  }

  return { type: 'none', credential: null };
}

// Middleware that requires authentication (supports JWT and API key)
export function requireAuth(req: Request, res: Response, next: NextFunction): void {
  const { type, credential } = extractAuthCredentials(req);

  // Try JWT authentication first
  if (type === 'jwt' && credential) {
    const payload = oauthManager.verifyJWT(credential);
    if (payload) {
      const tandaClient = oauthManager.getTandaClient(payload.sessionId);
      if (tandaClient) {
        req.auth = {
          payload,
          sessionId: payload.sessionId,
          tandaClient,
          authType: 'jwt',
        };
        next();
        return;
      }
    }
    // JWT provided but invalid
    res.status(401).json({
      error: 'Unauthorized',
      message: 'Invalid or expired token',
    });
    return;
  }

  // Try API key authentication
  if (type === 'apikey' && credential) {
    const tandaClient = apiKeyManager.validateApiKey(credential);
    if (tandaClient) {
      // Create a pseudo-payload for API key auth
      const pseudoPayload: JWTPayload = {
        sessionId: 'service-account',
        userId: 0,
        email: 'service-account@workforce.mcp',
      };
      req.auth = {
        payload: pseudoPayload,
        sessionId: 'service-account',
        tandaClient,
        authType: 'apikey',
      };
      logger.debug('Authenticated via service API key');
      next();
      return;
    }
    // API key provided but invalid
    res.status(401).json({
      error: 'Unauthorized',
      message: 'Invalid API key',
    });
    return;
  }

  // No authentication provided
  res.status(401).json({
    error: 'Unauthorized',
    message: 'No authentication provided. Use Bearer token or X-API-Key header.',
  });
}

// Middleware that optionally extracts auth (doesn't fail if not present)
export function optionalAuth(req: Request, res: Response, next: NextFunction): void {
  const { type, credential } = extractAuthCredentials(req);

  // Try JWT authentication
  if (type === 'jwt' && credential) {
    const payload = oauthManager.verifyJWT(credential);
    if (payload) {
      const tandaClient = oauthManager.getTandaClient(payload.sessionId);
      if (tandaClient) {
        req.auth = {
          payload,
          sessionId: payload.sessionId,
          tandaClient,
          authType: 'jwt',
        };
      }
    }
  }

  // Try API key authentication
  if (type === 'apikey' && credential) {
    const tandaClient = apiKeyManager.validateApiKey(credential);
    if (tandaClient) {
      const pseudoPayload: JWTPayload = {
        sessionId: 'service-account',
        userId: 0,
        email: 'service-account@workforce.mcp',
      };
      req.auth = {
        payload: pseudoPayload,
        sessionId: 'service-account',
        tandaClient,
        authType: 'apikey',
      };
    }
  }

  next();
}

// Rate limiting by session
const requestCounts = new Map<string, { count: number; resetAt: number }>();

export function sessionRateLimit(maxRequests: number, windowMs: number) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const sessionId = req.auth?.sessionId || req.ip || 'anonymous';
    const now = Date.now();

    let record = requestCounts.get(sessionId);

    if (!record || now > record.resetAt) {
      record = { count: 0, resetAt: now + windowMs };
      requestCounts.set(sessionId, record);
    }

    record.count++;

    if (record.count > maxRequests) {
      logger.warn(`Rate limit exceeded for session: ${sessionId}`);
      res.status(429).json({
        error: 'Too Many Requests',
        message: 'Rate limit exceeded. Please try again later.',
        retryAfter: Math.ceil((record.resetAt - now) / 1000),
      });
      return;
    }

    next();
  };
}

// Error handling middleware
export function errorHandler(
  err: Error,
  req: Request,
  res: Response,
  next: NextFunction
): void {
  logger.error('Unhandled error:', err);

  if (res.headersSent) {
    next(err);
    return;
  }

  res.status(500).json({
    error: 'Internal Server Error',
    message: process.env.NODE_ENV === 'production'
      ? 'An unexpected error occurred'
      : err.message,
  });
}
