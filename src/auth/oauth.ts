import crypto from 'crypto';
import jwt from 'jsonwebtoken';
import { v4 as uuidv4 } from 'uuid';
import { config } from '../config/environment';
import { logger, describeError } from '../utils/logger';
import { TandaClient, TandaApiError, exchangeCodeForToken, buildAuthorizationUrl, refreshTandaToken } from '../tanda/client';
import { TandaTokenResponse, TandaUser } from '../tanda/types';
import { openRefreshToken, sealRefreshToken } from './refreshToken';

// In-memory session store (replace with Redis/DB in production)
interface SessionData {
  state: string;
  createdAt: number;
  lastUsedAt?: number;
  userId?: number;
  accessToken?: string;
  refreshToken?: string;
  tokenExpiresAt?: number;
  user?: TandaUser;
  // Client OAuth parameters (for Claude MCP flow)
  clientRedirectUri?: string;
  clientState?: string;
  clientCodeChallenge?: string;
  /** In-flight Tanda token refresh; Tanda refresh tokens are single-use, so only one runs at a time */
  refreshing?: Promise<void>;
}

const sessions = new Map<string, SessionData>();

/** Lifetime of the access token (JWT) issued to MCP clients by POST /token. */
export const MCP_ACCESS_TOKEN_TTL_SECONDS = 60 * 60;
// Refresh Tanda before issuing tokens if its access token would expire within this window,
// so it never expires while an issued access token is live and the sealed refresh token stays current.
const TANDA_MIN_REMAINING_MS = (MCP_ACCESS_TOKEN_TTL_SECONDS + 15 * 60) * 1000;

// jti of MCP refresh tokens already exchanged (until they expire); a used token is refused.
const usedRefreshTokens = new Map<string, number>();
setInterval(() => {
  const now = Date.now();
  for (const [jti, exp] of usedRefreshTokens.entries()) if (exp <= now) usedRefreshTokens.delete(jti);
}, 60 * 60 * 1000).unref();

// Authorization code store (code -> sessionId mapping for OAuth2 flow)
interface AuthCodeData {
  sessionId: string;
  createdAt: number;
  used: boolean;
  codeChallenge?: string;  // For PKCE validation
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
}, 60 * 1000).unref(); // Run every minute

// Session cleanup interval (remove sessions idle for 24 hours)
const SESSION_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours
setInterval(() => {
  const now = Date.now();
  for (const [sessionId, session] of sessions.entries()) {
    if (now - (session.lastUsedAt ?? session.createdAt) > SESSION_TTL_MS) {
      sessions.delete(sessionId);
      logger.debug(`Cleaned up expired session: ${sessionId}`);
    }
  }
}, 60 * 60 * 1000).unref(); // Run every hour

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

// Callbacks an MCP client may ask /authorize to return the code to. Anything else is refused,
// so a crafted link cannot send a signed-in user's code to someone else.
const DEFAULT_REDIRECT_URIS = ['https://claude.ai/api/mcp/auth_callback', 'https://claude.com/api/mcp/auth_callback'];

export function isAllowedRedirectUri(uri: unknown): boolean {
  if (typeof uri !== 'string' || !uri) return false;
  const extra = (process.env.OAUTH_ALLOWED_REDIRECT_URIS || '').split(',').map((s) => s.trim()).filter(Boolean);
  if ([...DEFAULT_REDIRECT_URIS, ...extra].includes(uri)) return true;
  try {
    // Local MCP clients (Claude Code, MCP Inspector) listen on a loopback port.
    const url = new URL(uri);
    return url.protocol === 'http:' && (url.hostname === 'localhost' || url.hostname === '127.0.0.1');
  } catch {
    return false;
  }
}

/** True when Tanda refused the grant itself (revoked, expired, wrong user), not a transient failure. */
function isTandaAuthFailure(error: unknown): boolean {
  if (error instanceof TandaApiError) return error.statusCode === 401 || error.statusCode === 403;
  const status = (error as { response?: { status?: number } })?.response?.status;
  if (status === 400 || status === 401 || status === 403) return true;
  return error instanceof Error && !(error as { isAxiosError?: boolean }).isAxiosError;
}

export class OAuthManager {
  // Generate a new OAuth state and session
  // The state parameter encodes the sessionId so we can recover it from the callback
  // without relying on cookies (which may not survive cross-site redirects)
  createAuthSession(clientParams?: {
    redirectUri?: string;
    state?: string;
    codeChallenge?: string;
  }): { sessionId: string; authUrl: string; state: string } {
    const sessionId = uuidv4();
    const nonce = uuidv4();

    // Encode sessionId in state so we can recover it from callback
    // Format: base64url({ sid: sessionId, n: nonce })
    const stateData = { sid: sessionId, n: nonce };
    const state = Buffer.from(JSON.stringify(stateData)).toString('base64url');

    sessions.set(sessionId, {
      state,  // Store the full encoded state for verification
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

  // Decode sessionId from state parameter (for callback recovery)
  decodeStateSessionId(state: string): string | null {
    try {
      const decoded = Buffer.from(state, 'base64url').toString('utf8');
      const data = JSON.parse(decoded);
      if (data.sid && typeof data.sid === 'string') {
        return data.sid;
      }
      return null;
    } catch (error) {
      logger.debug(`Failed to decode state: ${describeError(error)}`);
      return null;
    }
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

      logger.info(`OAuth callback successful for user id: ${user.id}`);
      return {
        success: true,
        token: jwtToken,
        user,
      };
    } catch (error) {
      logger.error(`OAuth callback failed: ${describeError(error)}`);
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

      logger.info(`Token exchange successful for user id: ${user.id}`);
      return {
        success: true,
        data: {
          ...tokenResponse,
          jwt: jwtToken,
          user,
        },
      };
    } catch (error) {
      logger.error(`Token exchange failed: ${describeError(error)}`);
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Token exchange failed',
      };
    }
  }

  // Generate JWT token
  private generateJWT(sessionId: string, user: TandaUser, expiresIn: string | number = config.JWT_EXPIRY): string {
    const payload: JWTPayload = {
      sessionId,
      userId: user.id,
      email: user.email,
    };

    return jwt.sign(payload, config.JWT_SECRET, {
      expiresIn,
    } as jwt.SignOptions);
  }

  /**
   * Refresh the session's Tanda tokens, once at a time. Tanda refresh tokens are single-use,
   * so concurrent callers wait for the refresh in flight. A caller whose access token has
   * already been replaced gets the current one without refreshing again.
   */
  async refreshSessionTokens(sessionId: string, failedAccessToken?: string): Promise<string> {
    const session = sessions.get(sessionId);
    if (!session?.accessToken) throw new Error('Session not found');
    while (session.refreshing) await session.refreshing;
    if (failedAccessToken && session.accessToken !== failedAccessToken) return session.accessToken;
    if (!session.refreshToken) throw new Error('Session has no Tanda refresh token');

    session.refreshing = (async () => {
      const tokens = await refreshTandaToken(session.refreshToken!);
      session.accessToken = tokens.access_token;
      session.refreshToken = tokens.refresh_token;
      session.tokenExpiresAt = Date.now() + tokens.expires_in * 1000;
    })();
    try {
      await session.refreshing;
    } finally {
      session.refreshing = undefined;
    }
    return session.accessToken;
  }

  /**
   * Issue an MCP access token (1 hour) and a sealed refresh token for a signed-in session.
   * Tanda is refreshed first if its token would lapse while the access token is live, so
   * the sealed copy of the Tanda tokens is current when issued.
   */
  async issueMcpTokens(sessionId: string): Promise<{ accessToken: string; refreshToken: string; expiresIn: number }> {
    const session = sessions.get(sessionId);
    if (!session?.user || !session.accessToken) throw new Error('Session not found');
    if (session.refreshToken && (!session.tokenExpiresAt || session.tokenExpiresAt - Date.now() < TANDA_MIN_REMAINING_MS)) {
      await this.refreshSessionTokens(sessionId);
    }
    return {
      accessToken: this.generateJWT(sessionId, session.user, MCP_ACCESS_TOKEN_TTL_SECONDS),
      refreshToken: sealRefreshToken({
        sid: sessionId,
        uid: session.user.id,
        at: session.accessToken,
        rt: session.refreshToken,
        atExp: session.tokenExpiresAt,
      }),
      expiresIn: MCP_ACCESS_TOKEN_TTL_SECONDS,
    };
  }

  /**
   * refresh_token grant for POST /token. Each refresh token works once and is replaced.
   * If the server restarted, the session is rebuilt from the Tanda tokens sealed inside it.
   */
  async exchangeRefreshToken(refreshToken: unknown): Promise<{ success: boolean; accessToken?: string; refreshToken?: string; expiresIn?: number; error?: string; retryable?: boolean }> {
    const claims = openRefreshToken(refreshToken);
    if (!claims) return { success: false, error: 'Invalid or expired refresh token' };
    if (usedRefreshTokens.has(claims.jti)) {
      logger.warn(`Refresh token reused for session: ${claims.sid}`);
      return { success: false, error: 'Refresh token already used' };
    }
    usedRefreshTokens.set(claims.jti, claims.exp);

    let session = sessions.get(claims.sid);
    if (session?.accessToken && session.userId !== undefined && session.userId !== claims.uid) {
      return { success: false, error: 'Refresh token does not match the session' };
    }
    if (!session?.accessToken) {
      session = { state: '', createdAt: Date.now(), userId: claims.uid, accessToken: claims.at, refreshToken: claims.rt, tokenExpiresAt: claims.atExp };
      sessions.set(claims.sid, session);
      logger.info(`Session restored from refresh token: ${claims.sid}`);
    }

    try {
      // Confirms the Tanda grant is still valid (and refreshes it if it lapsed) before issuing tokens.
      const client = this.getTandaClient(claims.sid);
      if (!client) throw new Error('Session not found');
      const user = await client.getCurrentUser();
      if (user.id !== claims.uid) throw new Error('Tanda user does not match the refresh token');
      session.user = user;
      session.userId = user.id;
      const tokens = await this.issueMcpTokens(claims.sid);
      logger.info(`Refresh token exchanged for session: ${claims.sid}`);
      return { success: true, ...tokens };
    } catch (error) {
      logger.warn(`Refresh token exchange failed for session ${claims.sid}: ${describeError(error)}`);
      if (!isTandaAuthFailure(error)) {
        // Tanda unreachable or erroring: keep the session and let the client retry this token.
        usedRefreshTokens.delete(claims.jti);
        return { success: false, retryable: true, error: 'Tanda is unavailable; try again shortly' };
      }
      sessions.delete(claims.sid);
      return { success: false, error: 'Tanda access was revoked or expired; sign in again' };
    }
  }

  // Verify JWT and return session
  verifyJWT(token: string): JWTPayload | null {
    try {
      const payload = jwt.verify(token, config.JWT_SECRET) as JWTPayload;
      return payload;
    } catch (error) {
      logger.debug(`JWT verification failed: ${describeError(error)}`);
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
    session.lastUsedAt = Date.now();

    return new TandaClient(
      session.accessToken,
      session.refreshToken,
      session.tokenExpiresAt ? Math.floor((session.tokenExpiresAt - Date.now()) / 1000) : undefined,
      { refresh: (failed) => this.refreshSessionTokens(sessionId, failed) }
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
  generateAuthCode(sessionId: string, codeChallenge?: string): string {
    const code = uuidv4();
    authCodes.set(code, {
      sessionId,
      createdAt: Date.now(),
      used: false,
      codeChallenge,
    });
    logger.info(`Generated auth code for session: ${sessionId}, has PKCE: ${!!codeChallenge}`);
    return code;
  }

  // Exchange authorization code for JWT (for Claude MCP /token endpoint)
  async exchangeAuthCode(code: string, codeVerifier?: string): Promise<{ success: boolean; accessToken?: string; refreshToken?: string; expiresIn?: number; error?: string }> {
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

    // Validate PKCE if code_challenge was provided during authorization
    if (authCodeData.codeChallenge) {
      if (!codeVerifier) {
        logger.warn(`PKCE code_verifier required but not provided`);
        return { success: false, error: 'code_verifier required' };
      }

      // Validate code_verifier against code_challenge (S256 method)
      const expectedChallenge = crypto
        .createHash('sha256')
        .update(codeVerifier)
        .digest('base64url');

      if (expectedChallenge !== authCodeData.codeChallenge) {
        logger.warn(`PKCE validation failed`);
        return { success: false, error: 'Invalid code_verifier' };
      }
      logger.info('PKCE validation successful');
    }

    // Mark code as used
    authCodeData.used = true;

    // Get the session
    const session = sessions.get(authCodeData.sessionId);
    if (!session || !session.user) {
      logger.warn(`Session not found for auth code: ${code}`);
      return { success: false, error: 'Session not found' };
    }

    try {
      const tokens = await this.issueMcpTokens(authCodeData.sessionId);
      logger.info(`Auth code exchanged for session: ${authCodeData.sessionId}`);
      return { success: true, ...tokens };
    } catch (error) {
      logger.warn(`Auth code exchange failed for session ${authCodeData.sessionId}: ${describeError(error)}`);
      return { success: false, error: 'Tanda access could not be confirmed; sign in again' };
    }
  }
}

// Singleton instance
export const oauthManager = new OAuthManager();
