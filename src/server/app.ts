import express, { Application, Request, Response, NextFunction } from 'express';
import cors from 'cors';
import helmet from 'helmet';
import cookieParser from 'cookie-parser';
import rateLimit from 'express-rate-limit';
import { config } from '../config/environment';
import { logger } from '../utils/logger';
import { oauthManager } from '../auth/oauth';
import { requireAuth, optionalAuth, errorHandler, extractBearerToken } from '../auth/middleware';
import { createMCPRouter } from '../mcp/handler';
import { exchangeCodeForToken, TandaClient } from '../tanda/client';

export function createApp(): Application {
  const app = express();

  // Trust proxy for rate limiting behind reverse proxy
  app.set('trust proxy', 1);

  // Security middleware
  app.use(helmet({
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'"],
        styleSrc: ["'self'", "'unsafe-inline'"],
        imgSrc: ["'self'", 'data:', 'https:'],
      },
    },
  }));

  // CORS configuration
  const corsOptions: cors.CorsOptions = {
    origin: config.CORS_ORIGINS === '*'
      ? true
      : config.CORS_ORIGINS.split(',').map((o) => o.trim()),
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'X-Session-ID'],
  };
  app.use(cors(corsOptions));

  // Parse JSON and cookies
  app.use(express.json({ limit: '10mb' }));
  app.use(express.urlencoded({ extended: true }));
  app.use(cookieParser());

  // Global rate limiting
  const limiter = rateLimit({
    windowMs: config.RATE_LIMIT_WINDOW_MS,
    max: config.RATE_LIMIT_MAX_REQUESTS,
    message: {
      error: 'Too Many Requests',
      message: 'Rate limit exceeded. Please try again later.',
    },
    standardHeaders: true,
    legacyHeaders: false,
  });
  app.use(limiter);

  // Request logging
  app.use((req: Request, res: Response, next: NextFunction) => {
    const start = Date.now();
    res.on('finish', () => {
      const duration = Date.now() - start;
      logger.info(`${req.method} ${req.path} ${res.statusCode} ${duration}ms`);
    });
    next();
  });

  // Health check endpoint
  app.get('/health', (req: Request, res: Response) => {
    res.json({
      status: 'healthy',
      timestamp: new Date().toISOString(),
      version: config.MCP_SERVER_VERSION,
    });
  });

  // Server info endpoint
  app.get('/', (req: Request, res: Response) => {
    res.json({
      name: config.MCP_SERVER_NAME,
      version: config.MCP_SERVER_VERSION,
      description: 'Tanda Workforce MCP Server with OAuth2 authentication',
      endpoints: {
        health: '/health',
        oauth: {
          authorize: '/authorize',
          token: '/token',
          discovery: '/.well-known/oauth-authorization-server',
        },
        auth: {
          login: '/auth/login',
          callback: '/auth/callback',
          logout: '/auth/logout',
          status: '/auth/status',
        },
        api: {
          authenticate: '/api/authenticate',
        },
        mcp: '/mcp',
      },
      documentation: '/docs',
    });
  });

  // POST / - Handle MCP requests at root (Claude sends here after SSE connection)
  // Authentication required except for 'initialize' (protocol handshake)
  app.post('/', optionalAuth, (req: Request, res: Response, next: NextFunction) => {
    const method = req.body?.method;

    // Allow 'initialize' without auth for protocol handshake
    // All other methods require authentication to trigger OAuth flow
    if (method !== 'initialize' && !req.auth?.tandaClient) {
      const baseUrl = `${req.protocol}://${req.get('host')}`;
      res.setHeader('WWW-Authenticate', `Bearer resource_metadata="${baseUrl}/.well-known/oauth-protected-resource"`);
      res.status(401).json({
        error: 'unauthorized',
        error_description: 'Authentication required. Please complete OAuth flow.',
      });
      return;
    }

    next();
  }, createMCPRouter());

  // ==================== OAuth Routes ====================

  // OAuth 2.0 Protected Resource Metadata (RFC 9728)
  // This tells Claude.ai where to find the authorization server
  app.get('/.well-known/oauth-protected-resource', (req: Request, res: Response) => {
    const baseUrl = `${req.protocol}://${req.get('host')}`;
    res.json({
      resource: baseUrl,
      authorization_servers: [baseUrl],
      bearer_methods_supported: ['header'],
      scopes_supported: ['user', 'department', 'leave', 'roster', 'timesheet', 'cost'],
    });
  });

  // OAuth 2.0 Authorization Server Metadata (RFC 8414)
  app.get('/.well-known/oauth-authorization-server', (req: Request, res: Response) => {
    const baseUrl = `${req.protocol}://${req.get('host')}`;
    res.json({
      issuer: baseUrl,
      authorization_endpoint: `${baseUrl}/authorize`,
      token_endpoint: `${baseUrl}/token`,
      registration_endpoint: `${baseUrl}/oauth/register`,
      response_types_supported: ['code'],
      grant_types_supported: ['authorization_code', 'refresh_token'],
      code_challenge_methods_supported: ['S256'],
      // Claude.ai requires client_secret_post support
      token_endpoint_auth_methods_supported: ['none', 'client_secret_post'],
      scopes_supported: ['user', 'department', 'leave', 'roster', 'timesheet', 'cost'],
    });
  });

  // POST /oauth/register - Dynamic Client Registration (RFC 7591)
  // Required for Claude.ai MCP integration
  app.post('/oauth/register', (req: Request, res: Response) => {
    const { redirect_uris, client_name, token_endpoint_auth_method } = req.body;

    // Generate a client_id for this registration
    const clientId = `mcp-client-${Date.now()}-${Math.random().toString(36).substring(7)}`;

    logger.info(`Dynamic client registration: ${client_name}, redirect_uris: ${JSON.stringify(redirect_uris)}`);

    // Return client credentials per RFC 7591
    res.status(201).json({
      client_id: clientId,
      client_name: client_name || 'MCP Client',
      redirect_uris: redirect_uris || [],
      token_endpoint_auth_method: token_endpoint_auth_method || 'none',
      grant_types: ['authorization_code'],
      response_types: ['code'],
    });
  });

  // GET /authorize - Standard OAuth2 authorize endpoint (for Claude MCP)
  app.get('/authorize', (req: Request, res: Response) => {
    // Capture OAuth2 parameters from Claude
    const clientRedirectUri = req.query.redirect_uri as string;
    const clientState = req.query.state as string;
    const codeChallenge = req.query.code_challenge as string;

    // Create session with client OAuth parameters stored server-side
    // This avoids cookie issues with cross-site redirects
    const { sessionId, authUrl } = oauthManager.createAuthSession({
      redirectUri: clientRedirectUri,
      state: clientState,
      codeChallenge: codeChallenge,
    });

    // Set session cookie (this is same-site, so should work)
    res.cookie('tanda_session', sessionId, {
      httpOnly: true,
      secure: config.NODE_ENV === 'production',
      sameSite: 'lax',
      maxAge: 24 * 60 * 60 * 1000, // 24 hours
    });

    logger.info(`OAuth authorize initiated for redirect_uri: ${clientRedirectUri}, session: ${sessionId}`);
    res.redirect(authUrl);
  });

  // POST /token - Standard OAuth2 token endpoint (for Claude MCP)
  app.post('/token', async (req: Request, res: Response) => {
    const { code, grant_type, code_verifier } = req.body;

    if (grant_type !== 'authorization_code') {
      res.status(400).json({
        error: 'unsupported_grant_type',
        error_description: 'Only authorization_code grant type is supported',
      });
      return;
    }

    if (!code) {
      res.status(400).json({
        error: 'invalid_request',
        error_description: 'Authorization code is required',
      });
      return;
    }

    // Exchange our authorization code (not Tanda's) for a JWT
    // Pass code_verifier for PKCE validation
    const result = oauthManager.exchangeAuthCode(code, code_verifier);

    if (!result.success) {
      res.status(400).json({
        error: 'invalid_grant',
        error_description: result.error,
      });
      return;
    }

    // Return OAuth2 standard token response
    res.json({
      access_token: result.accessToken,
      token_type: 'Bearer',
      expires_in: 86400, // 24 hours
    });
  });

  // GET /auth/login - Initiate OAuth flow
  app.get('/auth/login', (req: Request, res: Response) => {
    const { sessionId, authUrl } = oauthManager.createAuthSession();

    // Set session cookie
    res.cookie('tanda_session', sessionId, {
      httpOnly: true,
      secure: config.NODE_ENV === 'production',
      sameSite: 'lax',
      maxAge: 24 * 60 * 60 * 1000, // 24 hours
    });

    logger.info(`OAuth login initiated, redirecting to Tanda`);
    res.redirect(authUrl);
  });

  // GET /auth/callback - Handle OAuth callback
  app.get('/auth/callback', async (req: Request, res: Response) => {
    const { code, state, error, error_description } = req.query;

    // Try to get sessionId from state parameter first (more reliable than cookies)
    // This survives cross-site redirects where cookies may not be sent
    let sessionId = state ? oauthManager.decodeStateSessionId(state as string) : null;

    // Only fall back to cookie if we have a state but couldn't decode it
    // Don't use stale cookies for direct tests (no state parameter)
    if (!sessionId && state) {
      sessionId = req.cookies.tanda_session;
    }

    // Get client OAuth params from session
    const clientParams = sessionId ? oauthManager.getClientParams(sessionId) : null;
    const clientRedirectUri = clientParams?.redirectUri;
    const clientState = clientParams?.state;

    if (error) {
      logger.error(`OAuth callback error: ${error} - ${error_description}`);

      // If Claude flow, redirect back with error
      if (clientRedirectUri) {
        const errorUrl = new URL(clientRedirectUri);
        errorUrl.searchParams.set('error', error as string);
        if (error_description) {
          errorUrl.searchParams.set('error_description', error_description as string);
        }
        if (clientState) {
          errorUrl.searchParams.set('state', clientState);
        }
        res.redirect(errorUrl.toString());
        return;
      }

      res.status(400).json({
        error: 'OAuth Error',
        message: error_description || error,
      });
      return;
    }

    if (!code) {
      res.status(400).json({
        error: 'Bad Request',
        message: 'Missing code parameter',
      });
      return;
    }

    // If no state/session but we have code, this is a direct test from Workforce.com
    // Exchange the code directly and show success
    if (!sessionId) {
      try {
        const tokenResponse = await exchangeCodeForToken(code as string);
        const tandaClient = new TandaClient(
          tokenResponse.access_token,
          tokenResponse.refresh_token,
          tokenResponse.expires_in
        );
        const user = await tandaClient.getCurrentUser();

        res.json({
          success: true,
          message: 'OAuth flow completed successfully (direct test)',
          user: {
            id: user.id,
            name: user.name,
            email: user.email,
          },
        });
        return;
      } catch (err) {
        const errorMessage = err instanceof Error ? err.message : 'Failed to exchange code for token';
        logger.error(`Direct OAuth test failed: ${errorMessage}`);
        res.status(400).json({
          error: 'Authentication Failed',
          message: errorMessage,
        });
        return;
      }
    }

    const result = await oauthManager.handleCallback(
      sessionId,
      code as string,
      state as string
    );

    if (!result.success) {
      // If Claude flow, redirect back with error
      if (clientRedirectUri) {
        const errorUrl = new URL(clientRedirectUri);
        errorUrl.searchParams.set('error', 'access_denied');
        errorUrl.searchParams.set('error_description', result.error || 'Authentication failed');
        if (clientState) {
          errorUrl.searchParams.set('state', clientState);
        }
        res.redirect(errorUrl.toString());
        return;
      }

      res.status(400).json({
        error: 'Authentication Failed',
        message: result.error,
      });
      return;
    }

    // If this is a Claude MCP OAuth flow, redirect back to Claude with auth code
    if (clientRedirectUri) {
      // Generate an authorization code for Claude to exchange (include code_challenge for PKCE)
      const clientCodeChallenge = clientParams?.codeChallenge;
      const authCode = oauthManager.generateAuthCode(sessionId, clientCodeChallenge);

      const redirectUrl = new URL(clientRedirectUri);
      redirectUrl.searchParams.set('code', authCode);
      if (clientState) {
        redirectUrl.searchParams.set('state', clientState);
      }

      logger.info(`OAuth successful, redirecting to Claude: ${clientRedirectUri}`);
      res.redirect(redirectUrl.toString());
      return;
    }

    // For direct API clients, return the token as JSON
    res.json({
      success: true,
      token: result.token,
      user: {
        id: result.user?.id,
        name: result.user?.name,
        email: result.user?.email,
      },
      message: 'Authentication successful. Use the token in the Authorization header for API requests.',
    });
  });

  // POST /api/authenticate - Exchange code for token (API version)
  app.post('/api/authenticate', async (req: Request, res: Response) => {
    const { code } = req.body;

    if (!code) {
      res.status(400).json({
        error: 'Bad Request',
        message: 'Authorization code is required',
      });
      return;
    }

    const result = await oauthManager.exchangeCodeForToken(code);

    if (!result.success) {
      res.status(400).json({
        error: 'Authentication Failed',
        message: result.error,
      });
      return;
    }

    res.json({
      success: true,
      access_token: result.data?.access_token,
      token_type: result.data?.token_type,
      expires_in: result.data?.expires_in,
      jwt: result.data?.jwt,
      user: result.data?.user,
    });
  });

  // GET /auth/status - Check authentication status
  app.get('/auth/status', (req: Request, res: Response) => {
    const token = extractBearerToken(req);

    if (!token) {
      res.json({
        authenticated: false,
        message: 'No token provided',
      });
      return;
    }

    const payload = oauthManager.verifyJWT(token);
    if (!payload) {
      res.json({
        authenticated: false,
        message: 'Invalid or expired token',
      });
      return;
    }

    const session = oauthManager.getSession(payload.sessionId);
    res.json({
      authenticated: true,
      userId: payload.userId,
      email: payload.email,
      sessionActive: !!session,
      user: session?.user ? {
        id: session.user.id,
        name: session.user.name,
        email: session.user.email,
      } : null,
    });
  });

  // POST /auth/logout - Logout and invalidate session
  app.post('/auth/logout', (req: Request, res: Response) => {
    const token = extractBearerToken(req);
    const sessionId = req.cookies.tanda_session;

    let invalidated = false;

    if (token) {
      const payload = oauthManager.verifyJWT(token);
      if (payload) {
        invalidated = oauthManager.invalidateSession(payload.sessionId);
      }
    }

    if (sessionId && !invalidated) {
      invalidated = oauthManager.invalidateSession(sessionId);
    }

    res.clearCookie('tanda_session');
    res.json({
      success: true,
      message: invalidated ? 'Logged out successfully' : 'No active session found',
    });
  });

  // ==================== MCP Endpoint ====================

  // GET /mcp - SSE endpoint for server-to-client messages (required for remote MCP)
  // This endpoint REQUIRES authentication to trigger OAuth flow in Claude.ai
  app.get('/mcp', optionalAuth, (req: Request, res: Response) => {
    // Check if user is authenticated - if not, return 401 to trigger OAuth flow
    if (!req.auth?.tandaClient) {
      const baseUrl = `${req.protocol}://${req.get('host')}`;
      // Include resource_metadata per RFC 9728 to help Claude.ai discover OAuth
      res.setHeader('WWW-Authenticate', `Bearer resource_metadata="${baseUrl}/.well-known/oauth-protected-resource"`);
      res.status(401).json({
        error: 'unauthorized',
        error_description: 'Authentication required. Please complete OAuth flow.',
      });
      return;
    }

    // Set comprehensive SSE headers for proxy compatibility
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('Keep-Alive', 'timeout=600'); // 10 minute timeout hint
    res.setHeader('X-Accel-Buffering', 'no'); // Disable nginx buffering
    res.setHeader('X-Content-Type-Options', 'nosniff');
    // Disable any response compression that might buffer
    res.setHeader('Content-Encoding', 'identity');
    res.flushHeaders();

    let connectionClosed = false;
    let pingInterval: NodeJS.Timeout | null = null;

    // Helper to safely write to the response
    const safeWrite = (data: string): boolean => {
      if (connectionClosed || res.writableEnded || res.destroyed) {
        return false;
      }
      try {
        res.write(data, (err) => {
          if (err) {
            logger.warn('SSE write error:', err.message);
            cleanup();
          }
        });
        return true;
      } catch (err) {
        logger.warn('SSE write exception:', err instanceof Error ? err.message : 'Unknown error');
        cleanup();
        return false;
      }
    };

    // Cleanup function to clear interval and mark connection as closed
    const cleanup = () => {
      if (connectionClosed) return;
      connectionClosed = true;
      if (pingInterval) {
        clearInterval(pingInterval);
        pingInterval = null;
      }
      logger.info('SSE client disconnected');
    };

    // Send initial connection event
    if (!safeWrite(`event: open\ndata: {"status":"connected"}\n\n`)) {
      return;
    }

    // Keep connection alive with aggressive pings every 15 seconds
    // This helps prevent proxy timeouts (Railway default is ~30s)
    pingInterval = setInterval(() => {
      if (!safeWrite(`: ping\n\n`)) {
        cleanup();
      }
    }, 15000);

    // Handle client disconnect
    req.on('close', cleanup);
    req.on('error', (err) => {
      logger.warn('SSE request error:', err.message);
      cleanup();
    });

    // Handle response errors
    res.on('error', (err) => {
      logger.warn('SSE response error:', err.message);
      cleanup();
    });

    res.on('close', cleanup);

    logger.info('SSE client connected to /mcp');
  });

  // POST /mcp - MCP protocol endpoint
  // Authentication required except for 'initialize' (protocol handshake)
  app.post('/mcp', optionalAuth, (req: Request, res: Response, next: NextFunction) => {
    const method = req.body?.method;

    // Allow 'initialize' without auth for protocol handshake
    // All other methods require authentication to trigger OAuth flow
    if (method !== 'initialize' && !req.auth?.tandaClient) {
      const baseUrl = `${req.protocol}://${req.get('host')}`;
      res.setHeader('WWW-Authenticate', `Bearer resource_metadata="${baseUrl}/.well-known/oauth-protected-resource"`);
      res.status(401).json({
        error: 'unauthorized',
        error_description: 'Authentication required. Please complete OAuth flow.',
      });
      return;
    }

    next();
  }, createMCPRouter());

  // ==================== Protected API Routes ====================

  // GET /api/me - Get current user (protected)
  app.get('/api/me', requireAuth, async (req: Request, res: Response) => {
    try {
      const user = await req.auth!.tandaClient.getCurrentUser();
      res.json(user);
    } catch (error) {
      res.status(500).json({
        error: 'API Error',
        message: error instanceof Error ? error.message : 'Failed to fetch user',
      });
    }
  });

  // Monitoring endpoint
  app.get('/stats', (req: Request, res: Response) => {
    const stats = oauthManager.getStats();
    res.json({
      server: {
        name: config.MCP_SERVER_NAME,
        version: config.MCP_SERVER_VERSION,
        uptime: process.uptime(),
        memory: process.memoryUsage(),
      },
      sessions: stats,
    });
  });

  // Documentation endpoint
  app.get('/docs', (req: Request, res: Response) => {
    res.json({
      title: 'Tanda Workforce MCP Server API',
      version: config.MCP_SERVER_VERSION,
      authentication: {
        description: 'This server uses OAuth2 for authentication with Tanda',
        flows: {
          browserFlow: {
            step1: 'Navigate to /auth/login to start OAuth flow',
            step2: 'User authenticates with Tanda',
            step3: 'Callback returns JWT token',
            step4: 'Use JWT in Authorization header for subsequent requests',
          },
          apiFlow: {
            step1: 'Redirect user to Tanda OAuth URL with your client_id',
            step2: 'User authenticates and is redirected back with code',
            step3: 'POST code to /api/authenticate',
            step4: 'Use returned JWT in Authorization header',
          },
        },
        headers: {
          Authorization: 'Bearer <jwt_token>',
        },
      },
      endpoints: {
        '/': { method: 'GET', description: 'Server info', auth: false },
        '/health': { method: 'GET', description: 'Health check', auth: false },
        '/auth/login': { method: 'GET', description: 'Start OAuth flow', auth: false },
        '/auth/callback': { method: 'GET', description: 'OAuth callback', auth: false },
        '/auth/status': { method: 'GET', description: 'Check auth status', auth: false },
        '/auth/logout': { method: 'POST', description: 'Logout', auth: false },
        '/api/authenticate': { method: 'POST', description: 'Exchange code for token', auth: false },
        '/api/me': { method: 'GET', description: 'Get current user', auth: true },
        '/mcp': { method: 'POST', description: 'MCP protocol endpoint', auth: 'optional' },
        '/stats': { method: 'GET', description: 'Server statistics', auth: false },
      },
      mcp: {
        description: 'MCP (Model Context Protocol) endpoint for AI integrations',
        protocol: 'JSON-RPC 2.0',
        methods: [
          'initialize',
          'tools/list',
          'tools/call',
          'resources/list',
          'resources/read',
          'prompts/list',
          'prompts/get',
          'ping',
        ],
      },
    });
  });

  // 404 handler
  app.use((req: Request, res: Response) => {
    res.status(404).json({
      error: 'Not Found',
      message: `Cannot ${req.method} ${req.path}`,
    });
  });

  // Error handler
  app.use(errorHandler);

  return app;
}
