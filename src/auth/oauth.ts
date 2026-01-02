import jwt from 'jsonwebtoken';
import { v4 as uuidv4 } from 'uuid';
import { config } from '../config/environment';
import { logger } from '../utils/logger';
import { TandaClient, exchangeCodeForToken, buildAuthorizationUrl } from '../tanda/client';
import { TandaTokenResponse, TandaUser } from '../tanda/types';

// In-memory session store (replace with Redis/DB in production)
interface SessionData {
  state: string;
  createdAt: number;
  userId?: number;
  accessToken?: string;
  refreshToken?: string;
  tokenExpiresAt?: number;
  user?: TandaUser;
}

const sessions = new Map<string, SessionData>();

// Session cleanup interval (remove expired sessions)
const SESSION_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours
setInterval(() => {
  const now = Date.now();
  for (const [sessionId, session] of sessions.entries()) {
    if (now - session.createdAt > SESSION_TTL_MS) {
      sessions.delete(sessionId);
      logger.debug(`Cleaned up expired session: ${sessionId}`);
    }
  }
}, 60 * 60 * 1000); // Run every hour

export interface JWTPayload {
  sessionId: string;
  userId?: number;
  email?: string;
  exp?: number;
  iat?: number;
}

export interface AuthResult {
  success: boolean;
  token?: string;
  user?: TandaUser;
  error?: string;
}

export class OAuthManager {
  // Generate a new OAuth state and session
  createAuthSession(): { sessionId: string; authUrl: string } {
    const sessionId = uuidv4();
    const state = uuidv4();

    sessions.set(sessionId, {
      state,
      createdAt: Date.now(),
    });

    const authUrl = buildAuthorizationUrl(state);
    logger.info(`Created new OAuth session: ${sessionId}`);

    return { sessionId, authUrl };
  }

  // Validate OAuth callback and exchange code for tokens
  async handleCallback(
    sessionId: string,
    code: string,
    returnedState: string
  ): Promise<AuthResult> {
    const session = sessions.get(sessionId);

    if (!session) {
      logger.warn(`Session not found: ${sessionId}`);
      return { success: false, error: 'Invalid or expired session' };
    }

    if (session.state !== returnedState) {
      logger.warn(`State mismatch for session: ${sessionId}`);
      return { success: false, error: 'State mismatch - possible CSRF attack' };
    }

    try {
      // Exchange code for tokens
      const tokenResponse = await exchangeCodeForToken(code);

      // Create Tanda client and fetch user info
      const client = new TandaClient(
        tokenResponse.access_token,
        tokenResponse.refresh_token,
        tokenResponse.expires_in
      );

      const user = await client.getCurrentUser();

      // Update session with tokens and user info
      session.accessToken = tokenResponse.access_token;
      session.refreshToken = tokenResponse.refresh_token;
      session.tokenExpiresAt = Date.now() + tokenResponse.expires_in * 1000;
      session.userId = user.id;
      session.user = user;

      // Generate JWT for the client
      const jwtToken = this.generateJWT(sessionId, user);

      logger.info(`OAuth callback successful for user: ${user.email}`);
      return {
        success: true,
        token: jwtToken,
        user,
      };
    } catch (error) {
      logger.error('OAuth callback failed:', error);
      return {
        success: false,
        error: error instanceof Error ? error.message : 'OAuth callback failed',
      };
    }
  }

  // Exchange authorization code for token (API endpoint version)
  async exchangeCodeForToken(code: string): Promise<{
    success: boolean;
    data?: TandaTokenResponse & { jwt: string; user: TandaUser };
    error?: string;
  }> {
    try {
      const tokenResponse = await exchangeCodeForToken(code);

      // Create Tanda client and fetch user info
      const client = new TandaClient(
        tokenResponse.access_token,
        tokenResponse.refresh_token,
        tokenResponse.expires_in
      );

      const user = await client.getCurrentUser();

      // Create a new session
      const sessionId = uuidv4();
      sessions.set(sessionId, {
        state: '',
        createdAt: Date.now(),
        accessToken: tokenResponse.access_token,
        refreshToken: tokenResponse.refresh_token,
        tokenExpiresAt: Date.now() + tokenResponse.expires_in * 1000,
        userId: user.id,
        user,
      });

      // Generate JWT
      const jwtToken = this.generateJWT(sessionId, user);

      logger.info(`Token exchange successful for user: ${user.email}`);
      return {
        success: true,
        data: {
          ...tokenResponse,
          jwt: jwtToken,
          user,
        },
      };
    } catch (error) {
      logger.error('Token exchange failed:', error);
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Token exchange failed',
      };
    }
  }

  // Generate JWT token
  private generateJWT(sessionId: string, user: TandaUser): string {
    const payload: JWTPayload = {
      sessionId,
      userId: user.id,
      email: user.email,
    };

    return jwt.sign(payload, config.JWT_SECRET, {
      expiresIn: config.JWT_EXPIRY,
    });
  }

  // Verify JWT and return session
  verifyJWT(token: string): JWTPayload | null {
    try {
      const payload = jwt.verify(token, config.JWT_SECRET) as JWTPayload;
      return payload;
    } catch (error) {
      logger.debug('JWT verification failed:', error);
      return null;
    }
  }

  // Get session by ID
  getSession(sessionId: string): SessionData | undefined {
    return sessions.get(sessionId);
  }

  // Get Tanda client for session
  getTandaClient(sessionId: string): TandaClient | null {
    const session = sessions.get(sessionId);
    if (!session?.accessToken) {
      return null;
    }

    return new TandaClient(
      session.accessToken,
      session.refreshToken,
      session.tokenExpiresAt ? Math.floor((session.tokenExpiresAt - Date.now()) / 1000) : undefined
    );
  }

  // Invalidate session (logout)
  invalidateSession(sessionId: string): boolean {
    const existed = sessions.has(sessionId);
    sessions.delete(sessionId);
    if (existed) {
      logger.info(`Session invalidated: ${sessionId}`);
    }
    return existed;
  }

  // Get session stats (for monitoring)
  getStats(): { activeSessions: number; oldestSession: number | null } {
    let oldestSession: number | null = null;
    for (const session of sessions.values()) {
      if (oldestSession === null || session.createdAt < oldestSession) {
        oldestSession = session.createdAt;
      }
    }
    return {
      activeSessions: sessions.size,
      oldestSession,
    };
  }
}

// Singleton instance
export const oauthManager = new OAuthManager();
