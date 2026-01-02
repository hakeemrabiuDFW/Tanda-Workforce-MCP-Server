# Tanda Workforce MCP Server - Architecture Documentation

## High-Level Architecture Diagram

```
┌─────────────────────────────────────────────────────────────────────────────────────────┐
│                              TANDA WORKFORCE MCP SERVER                                  │
│                                   (Node.js/Express)                                      │
└─────────────────────────────────────────────────────────────────────────────────────────┘

                    ┌──────────────────────────────────────────┐
                    │              CLIENTS                      │
                    │  ┌─────────┐  ┌─────────┐  ┌──────────┐  │
                    │  │ Claude  │  │ Browser │  │  Other   │  │
                    │  │   AI    │  │   App   │  │ MCP Apps │  │
                    │  └────┬────┘  └────┬────┘  └────┬─────┘  │
                    └───────┼────────────┼───────────┼─────────┘
                            │            │           │
                            ▼            ▼           ▼
┌─────────────────────────────────────────────────────────────────────────────────────────┐
│                              TRANSPORT LAYER                                             │
│  ┌────────────────────┐  ┌────────────────────┐  ┌────────────────────────────────────┐ │
│  │    HTTP/HTTPS      │  │   Server-Sent      │  │       OAuth2 Endpoints             │ │
│  │   POST /mcp        │  │   Events (SSE)     │  │  GET  /authorize                   │ │
│  │   (JSON-RPC 2.0)   │  │   GET /mcp         │  │  POST /token                       │ │
│  └────────────────────┘  └────────────────────┘  │  GET  /.well-known/oauth-*         │ │
│                                                   └────────────────────────────────────┘ │
└─────────────────────────────────────────────────────────────────────────────────────────┘
                                        │
                                        ▼
┌─────────────────────────────────────────────────────────────────────────────────────────┐
│                              SECURITY LAYER                                              │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐  ┌──────────────────────────────┐ │
│  │   Helmet     │  │    CORS      │  │ Rate Limiter │  │      JWT Validation          │ │
│  │  (Headers)   │  │  (Origins)   │  │ (100/15min)  │  │   (Bearer Token Auth)        │ │
│  └──────────────┘  └──────────────┘  └──────────────┘  └──────────────────────────────┘ │
└─────────────────────────────────────────────────────────────────────────────────────────┘
                                        │
                                        ▼
┌─────────────────────────────────────────────────────────────────────────────────────────┐
│                              AUTHENTICATION LAYER                                        │
│                                                                                          │
│  ┌────────────────────────────────────────────────────────────────────────────────────┐ │
│  │                           OAuthManager                                              │ │
│  │  ┌─────────────────┐  ┌──────────────────┐  ┌─────────────────────────────────────┐│ │
│  │  │ Session Store   │  │  Auth Code Store │  │         PKCE Support               ││ │
│  │  │  (In-Memory)    │  │   (10min TTL)    │  │  (code_challenge/code_verifier)   ││ │
│  │  │  24hr TTL       │  │   Single-Use     │  │       SHA256 Validation           ││ │
│  │  └─────────────────┘  └──────────────────┘  └─────────────────────────────────────┘│ │
│  └────────────────────────────────────────────────────────────────────────────────────┘ │
│                                                                                          │
│  ┌────────────────────────────────────────────────────────────────────────────────────┐ │
│  │                        OAuth Flow Support                                           │ │
│  │   ┌──────────────────┐  ┌──────────────────┐  ┌──────────────────────────────────┐ │ │
│  │   │  Browser Login   │  │  Claude MCP Flow │  │     Direct API Auth              │ │ │
│  │   │  /auth/login     │  │  /authorize      │  │     /api/authenticate            │ │ │
│  │   │  /auth/callback  │  │  /token          │  │     POST code exchange           │ │ │
│  │   └──────────────────┘  └──────────────────┘  └──────────────────────────────────┘ │ │
│  └────────────────────────────────────────────────────────────────────────────────────┘ │
└─────────────────────────────────────────────────────────────────────────────────────────┘
                                        │
                                        ▼
┌─────────────────────────────────────────────────────────────────────────────────────────┐
│                              MCP PROTOCOL LAYER                                          │
│                                                                                          │
│  ┌────────────────────────────────────────────────────────────────────────────────────┐ │
│  │                           MCPHandler (JSON-RPC 2.0)                                 │ │
│  │                                                                                      │ │
│  │   Methods:                                                                           │ │
│  │   ├── initialize          → Protocol handshake, capabilities                        │ │
│  │   ├── tools/list          → Return 25+ tool definitions                             │ │
│  │   ├── tools/call          → Execute tool with TandaClient                           │ │
│  │   ├── resources/list      → Return tanda:// resources                               │ │
│  │   ├── resources/read      → Fetch resource data                                     │ │
│  │   ├── prompts/list        → List prompt templates                                   │ │
│  │   ├── prompts/get         → Get prompt with arguments                               │ │
│  │   └── ping                → Connection health check                                 │ │
│  └────────────────────────────────────────────────────────────────────────────────────┘ │
└─────────────────────────────────────────────────────────────────────────────────────────┘
                                        │
                                        ▼
┌─────────────────────────────────────────────────────────────────────────────────────────┐
│                              MCP TOOLS (25+ Tools)                                       │
│                                                                                          │
│  ┌─────────────────┐  ┌─────────────────┐  ┌─────────────────┐  ┌─────────────────────┐ │
│  │     USERS       │  │   SCHEDULING    │  │     LEAVE       │  │    TIMESHEETS       │ │
│  │                 │  │                 │  │                 │  │                     │ │
│  │ • get_current   │  │ • get_schedules │  │ • get_requests  │  │ • get_shifts        │ │
│  │ • get_users     │  │ • create        │  │ • create        │  │ • get_timesheets    │ │
│  │ • get_user      │  │ • update        │  │ • approve       │  │ • approve_shift     │ │
│  │                 │  │ • delete        │  │ • decline       │  │ • approve_timesheet │ │
│  │                 │  │ • publish       │  │ • get_balances  │  │                     │ │
│  └─────────────────┘  └─────────────────┘  └─────────────────┘  └─────────────────────┘ │
│                                                                                          │
│  ┌─────────────────┐  ┌─────────────────┐  ┌─────────────────┐  ┌─────────────────────┐ │
│  │  ORGANIZATION   │  │   CLOCK IN/OUT  │  │ QUALIFICATIONS  │  │   COSTS/AWARDS      │ │
│  │                 │  │                 │  │                 │  │                     │ │
│  │ • departments   │  │ • clock_in      │  │ • get_all       │  │ • award_interpret   │ │
│  │ • locations     │  │ • get_clock_ins │  │ • get_user      │  │ • roster_costs      │ │
│  └─────────────────┘  └─────────────────┘  └─────────────────┘  └─────────────────────┘ │
└─────────────────────────────────────────────────────────────────────────────────────────┘
                                        │
                                        ▼
┌─────────────────────────────────────────────────────────────────────────────────────────┐
│                              TANDA API CLIENT                                            │
│                                                                                          │
│  ┌────────────────────────────────────────────────────────────────────────────────────┐ │
│  │                           TandaClient (Axios)                                       │ │
│  │                                                                                      │ │
│  │   ┌─────────────────────┐        ┌─────────────────────────────────────────────┐   │ │
│  │   │  Request Interceptor│        │           Response Interceptor              │   │ │
│  │   │  • Add Bearer Token │        │  • Handle 401 → Auto Token Refresh          │   │ │
│  │   │  • Log Requests     │        │  • Retry with New Token                     │   │ │
│  │   └─────────────────────┘        │  • Throw TandaApiError on Failure           │   │ │
│  │                                   └─────────────────────────────────────────────┘   │ │
│  └────────────────────────────────────────────────────────────────────────────────────┘ │
└─────────────────────────────────────────────────────────────────────────────────────────┘
                                        │
                                        ▼
┌─────────────────────────────────────────────────────────────────────────────────────────┐
│                              EXTERNAL SERVICE                                            │
│                                                                                          │
│                        ┌─────────────────────────────────────┐                          │
│                        │         TANDA WORKFORCE API          │                          │
│                        │       https://my.tanda.co/api/v2     │                          │
│                        │                                      │                          │
│                        │   OAuth:  /api/oauth/authorize       │                          │
│                        │           /api/oauth/token           │                          │
│                        │                                      │                          │
│                        │   API:    /users, /schedules,        │                          │
│                        │           /shifts, /leave, etc.      │                          │
│                        └─────────────────────────────────────┘                          │
└─────────────────────────────────────────────────────────────────────────────────────────┘


## Directory Structure

```
tanda-workforce-mcp-server/
├── src/
│   ├── index.ts                 # Entry point - Express server bootstrap
│   ├── server/
│   │   └── app.ts               # Express app setup, routing, middleware
│   ├── auth/
│   │   ├── oauth.ts             # OAuthManager - sessions, tokens, PKCE
│   │   └── middleware.ts        # Auth middleware (requireAuth, optionalAuth)
│   ├── config/
│   │   └── environment.ts       # Zod-validated environment configuration
│   ├── mcp/
│   │   ├── handler.ts           # MCP JSON-RPC protocol handler
│   │   └── tools.ts             # Tool definitions and execution logic
│   ├── tanda/
│   │   ├── client.ts            # Axios-based Tanda API client
│   │   └── types.ts             # TypeScript interfaces for Tanda API
│   └── utils/
│       └── logger.ts            # Winston logging configuration
├── docs/
│   └── ARCHITECTURE.md          # This file
├── Dockerfile                   # Multi-stage Docker build
├── railway.toml                 # Railway deployment config
├── package.json                 # Dependencies and scripts
└── tsconfig.json                # TypeScript configuration
```


## Data Flow Diagram

```
┌────────────┐                                                              ┌────────────┐
│   Claude   │                                                              │   Tanda    │
│    AI      │                                                              │    API     │
└─────┬──────┘                                                              └──────┬─────┘
      │                                                                            │
      │  1. Initialize MCP                                                         │
      │─────────────────────────►┌────────────────────────────────────────┐        │
      │                          │                                        │        │
      │  2. Start OAuth          │         MCP SERVER                     │        │
      │─────────────────────────►│                                        │        │
      │                          │  ┌──────────────────────────────────┐  │        │
      │  3. Redirect to Tanda    │  │        OAuthManager              │  │        │
      │◄─────────────────────────│  │                                  │──┼────────►
      │                          │  │  • Create session                │  │  4. OAuth
      │                          │  │  • Store PKCE challenge          │  │        │
      │                          │  │  • Exchange tokens               │  │        │
      │                          │  │  • Generate JWT                  │  │        │
      │  5. Return JWT           │  └──────────────────────────────────┘  │        │
      │◄─────────────────────────│                                        │        │
      │                          │  ┌──────────────────────────────────┐  │        │
      │  6. MCP Tool Call        │  │         MCPHandler               │  │        │
      │  (with Bearer Token)     │  │                                  │  │        │
      │─────────────────────────►│  │  • Validate JWT                  │  │        │
      │                          │  │  • Route to tool                 │  │        │
      │                          │  │  • Execute via TandaClient       │──┼────────►
      │                          │  └──────────────────────────────────┘  │  7. API
      │                          │                                        │        │
      │                          │  ┌──────────────────────────────────┐  │        │
      │  9. Tool Result          │  │         TandaClient              │  │        │
      │  (JSON-RPC Response)     │  │                                  │◄─┼────────┤
      │◄─────────────────────────│  │  • Auto token refresh            │  │  8.Data│
      │                          │  │  • Error handling                │  │        │
      │                          │  └──────────────────────────────────┘  │        │
      │                          │                                        │        │
      │                          └────────────────────────────────────────┘        │
      │                                                                            │
```


## Security Architecture

```
┌─────────────────────────────────────────────────────────────────────────────────────────┐
│                              SECURITY LAYERS                                             │
│                                                                                          │
│   LAYER 1: Transport Security                                                           │
│   ┌───────────────────────────────────────────────────────────────────────────────────┐ │
│   │  • HTTPS via reverse proxy (Railway/nginx)                                        │ │
│   │  • HTTP-only, Secure, SameSite cookies                                            │ │
│   └───────────────────────────────────────────────────────────────────────────────────┘ │
│                                                                                          │
│   LAYER 2: Request Security                                                             │
│   ┌───────────────────────────────────────────────────────────────────────────────────┐ │
│   │  • Helmet security headers (CSP, X-Frame-Options, HSTS)                           │ │
│   │  • CORS origin validation                                                         │ │
│   │  • Rate limiting (100 requests / 15 minutes)                                      │ │
│   └───────────────────────────────────────────────────────────────────────────────────┘ │
│                                                                                          │
│   LAYER 3: Authentication                                                               │
│   ┌───────────────────────────────────────────────────────────────────────────────────┐ │
│   │  • OAuth2 with Tanda (authorization code flow)                                    │ │
│   │  • PKCE (Proof Key for Code Exchange) for Claude                                  │ │
│   │  • JWT tokens with configurable expiry                                            │ │
│   │  • State parameter for CSRF protection                                            │ │
│   └───────────────────────────────────────────────────────────────────────────────────┘ │
│                                                                                          │
│   LAYER 4: Authorization                                                                │
│   ┌───────────────────────────────────────────────────────────────────────────────────┐ │
│   │  • Bearer token validation on protected routes                                    │ │
│   │  • Session-based Tanda token management                                           │ │
│   │  • Single-use authorization codes                                                 │ │
│   └───────────────────────────────────────────────────────────────────────────────────┘ │
│                                                                                          │
│   LAYER 5: Validation                                                                   │
│   ┌───────────────────────────────────────────────────────────────────────────────────┐ │
│   │  • Zod schema validation for environment                                          │ │
│   │  • JSON-RPC request structure validation                                          │ │
│   │  • Tool parameter type checking                                                   │ │
│   └───────────────────────────────────────────────────────────────────────────────────┘ │
└─────────────────────────────────────────────────────────────────────────────────────────┘
```


## Deployment Architecture (Railway)

```
┌─────────────────────────────────────────────────────────────────────────────────────────┐
│                              RAILWAY DEPLOYMENT                                          │
│                                                                                          │
│   ┌─────────────────────────────────────────────────────────────────────────────────┐   │
│   │                           Railway Platform                                       │   │
│   │                                                                                  │   │
│   │   ┌───────────────────┐     ┌─────────────────────────────────────────────────┐ │   │
│   │   │   Reverse Proxy   │     │              Node.js Container                  │ │   │
│   │   │                   │     │                                                 │ │   │
│   │   │  • SSL Termination│────►│  ┌───────────────────────────────────────────┐  │ │   │
│   │   │  • Load Balancing │     │  │          Express Server                   │  │ │   │
│   │   │                   │     │  │          PORT: 3000                       │  │ │   │
│   │   │                   │     │  │                                           │  │ │   │
│   │   └───────────────────┘     │  │  Environment Variables:                   │  │ │   │
│   │                              │  │  • TANDA_CLIENT_ID                        │  │ │   │
│   │   Environment Auto-Detection │  │  • TANDA_CLIENT_SECRET                    │  │ │   │
│   │   • RAILWAY_PUBLIC_DOMAIN    │  │  • SESSION_SECRET                         │  │ │   │
│   │   • RAILWAY_STATIC_URL       │  │  • JWT_SECRET                             │  │ │   │
│   │   • RAILWAY_ENVIRONMENT      │  │  • (auto-detected redirect URI)           │  │ │   │
│   │                              │  └───────────────────────────────────────────┘  │ │   │
│   │                              └─────────────────────────────────────────────────┘ │   │
│   │                                                                                  │   │
│   └─────────────────────────────────────────────────────────────────────────────────┘   │
│                                                                                          │
│   Build Process: Nixpacks → Node.js 20 → TypeScript Compile → Production Binary         │
│                                                                                          │
└─────────────────────────────────────────────────────────────────────────────────────────┘
```

---

## Technology Stack Summary

| Layer | Technology | Purpose |
|-------|------------|---------|
| Runtime | Node.js 18+ | JavaScript execution environment |
| Language | TypeScript 5.x | Type-safe development |
| Framework | Express.js 4.x | HTTP server and routing |
| Auth | JWT + OAuth2 | Token-based authentication |
| HTTP Client | Axios | Tanda API communication |
| Validation | Zod | Schema validation |
| Logging | Winston | Structured logging |
| Security | Helmet, CORS, Rate Limit | Request security |
| Deployment | Railway + Docker | Cloud hosting |

---

*Generated: January 2, 2026*
