import { Request, Response, NextFunction } from 'express';
import { oauthManager, JWTPayload } from './oauth';
import { logger } from '../utils/logger';
import { TandaClient } from '../tanda/client';

// Extend Express Request type to include auth info
declare global {
  namespace Express {
    interface Request {
      auth?: {
        payload: JWTPayload;
        sessionId: string;
        tandaClient: TandaClient;
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

// Middleware that requires authentication
export function requireAuth(req: Request, res: Response, next: NextFunction): void {
  const token = extractBearerToken(req);

  if (!token) {
    res.status(401).json({
      error: 'Unauthorized',
      message: 'No authentication token provided',
    });
    return;
  }

  const payload = oauthManager.verifyJWT(token);
  if (!payload) {
    res.status(401).json({
      error: 'Unauthorized',
      message: 'Invalid or expired token',
    });
    return;
  }

  const tandaClient = oauthManager.getTandaClient(payload.sessionId);
  if (!tandaClient) {
    res.status(401).json({
      error: 'Unauthorized',
      message: 'Session expired or invalid',
    });
    return;
  }

  req.auth = {
    payload,
    sessionId: payload.sessionId,
    tandaClient,
  };

  next();
}

// Middleware that optionally extracts auth (doesn't fail if not present)
export function optionalAuth(req: Request, res: Response, next: NextFunction): void {
  const token = extractBearerToken(req);

  if (token) {
    const payload = oauthManager.verifyJWT(token);
    if (payload) {
      const tandaClient = oauthManager.getTandaClient(payload.sessionId);
      if (tandaClient) {
        req.auth = {
          payload,
          sessionId: payload.sessionId,
          tandaClient,
        };
      }
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
