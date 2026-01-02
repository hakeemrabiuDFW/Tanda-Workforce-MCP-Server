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
  // Client OAuth parameters (for Claude MCP flow)
  clientRedirectUri?: string;
  clientState?: string;
  clientCodeChallenge?: string;
}

const sessions = new Map<string, SessionData>();

// Authorization code store (code -> sessionId mapping for OAuth2 flow)
interface AuthCodeData {
  sessionId: string;
  createdAt: number;
  used: boolean;
}
const authCodes = new Map<string, AuthCodeData>();

// Auth code cleanup interval (codes expire after 10 minutes)
const AUTH_CODE_TTL_MS = 10 * 60 * 1000; // 10 minutes
setInterval(() => {
  const now = Date.now();
  for (const [code, data] of authCodes.entries()) {
    if (now - data.createdAt > AUTH_CODE_TTL_MS) {
      authCodes.delete(code);
    }
  }
}, 60 * 1000); // Run every minute

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
  createAuthSession(clientParams?: {
    redirectUri?: string;
    state?: string;
    codeChallenge?: string;
  }): { sessionId: string; authUrl: string; state: string } {
    const sessionId = uuidv4();
    const state = uuidv4();

    sessions.set(sessionId, {
      state,
      createdAt: Date.now(),
      // Store client OAuth parameters for later retrieval
      clientRedirectUri: clientParams?.redirectUri,
      clientState: clientParams?.state,
      clientCodeChallenge: clientParams?.codeChallenge,
    });

    const authUrl = buildAuthorizationUrl(state);
    logger.info(`Created new OAuth session: ${sessionId}, clientRedirectUri: ${clientParams?.redirectUri}`);

    return { sessionId, authUrl, state };
  }

  // Get client OAuth parameters from session
  getClientParams(sessionId: string): {
    redirectUri?: string;
    state?: string;
    codeChallenge?: string;
  } | null {
    const session = sessions.get(sessionId);
    if (!session) return null;
    return {
      redirectUri: session.clientRedirectUri,
      state: session.clientState,
      codeChallenge: session.clientCodeChallenge,
    };
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
    } as jwt.SignOptions);
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

  // Generate an authorization code for OAuth2 flow (for Claude MCP)
  generateAuthCode(sessionId: string): string {
    const code = uuidv4();
    authCodes.set(code, {
      sessionId,
      createdAt: Date.now(),
      used: false,
    });
    logger.info(`Generated auth code for session: ${sessionId}`);
    return code;
  }

  // Exchange authorization code for JWT (for Claude MCP /token endpoint)
  exchangeAuthCode(code: string): { success: boolean; accessToken?: string; error?: string } {
    const authCodeData = authCodes.get(code);

    if (!authCodeData) {
      logger.warn(`Auth code not found: ${code}`);
      return { success: false, error: 'Invalid authorization code' };
    }

    if (authCodeData.used) {
      logger.warn(`Auth code already used: ${code}`);
      // Delete the code to prevent replay attacks
      authCodes.delete(code);
      return { success: false, error: 'Authorization code already used' };
    }

    // Check if code is expired (10 minutes)
    if (Date.now() - authCodeData.createdAt > AUTH_CODE_TTL_MS) {
      logger.warn(`Auth code expired: ${code}`);
      authCodes.delete(code);
      return { success: false, error: 'Authorization code expired' };
    }

    // Mark code as used
    authCodeData.used = true;

    // Get the session
    const session = sessions.get(authCodeData.sessionId);
    if (!session || !session.user) {
      logger.warn(`Session not found for auth code: ${code}`);
      return { success: false, error: 'Session not found' };
    }

    // Generate JWT for the client
    const accessToken = this.generateJWT(authCodeData.sessionId, session.user);

    logger.info(`Auth code exchanged for session: ${authCodeData.sessionId}`);
    return { success: true, accessToken };
  }
}

// Singleton instance
export const oauthManager = new OAuthManager();
