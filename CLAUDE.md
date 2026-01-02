# Tanda Workforce MCP Server

## Project Overview
Production-ready MCP (Model Context Protocol) server for the Tanda Workforce API with OAuth2 authentication, PKCE support, and 25+ tools for workforce management.

## Tech Stack
- **Runtime**: Node.js 18+
- **Language**: TypeScript 5.x
- **Framework**: Express.js 4.x
- **Auth**: OAuth2 + JWT + PKCE
- **Deployment**: Railway (Nixpacks)

## Project Structure
```
src/
├── index.ts           # Entry point
├── server/app.ts      # Express setup
├── auth/
│   ├── oauth.ts       # OAuthManager (sessions, tokens, PKCE)
│   └── middleware.ts  # Auth middleware
├── config/environment.ts  # Zod validation
├── mcp/
│   ├── handler.ts     # MCP JSON-RPC handler
│   └── tools.ts       # 25+ tool definitions
├── tanda/
│   ├── client.ts      # Tanda API client
│   └── types.ts       # TypeScript interfaces
└── utils/logger.ts    # Winston logging
```

## Commands
```bash
npm run build          # Compile TypeScript
npm run start          # Run production server
npm run dev            # Development mode
npm run lint           # ESLint check
npm run test           # Run tests
```

## Development Workflow

### Autonomous Operations (No Approval Needed)
- Reading/editing source code in `src/` and `tests/`
- Running build, test, lint commands
- Git status, diff, log operations
- Creating branches and adding files

### Requires User Approval
- `git push` - Deploy to remote
- `git commit` - Committing changes
- `railway deploy` - Production deployment
- `gh pr create` - Creating pull requests

## Architecture Decisions
1. **In-memory sessions** - Simple, stateless deployment (trade-off: lost on restart)
2. **PKCE support** - Required for Claude MCP OAuth flow
3. **SSE endpoint** - Enables remote MCP transport
4. **Zod validation** - Runtime environment validation

## Environment Variables
Required in production:
- `TANDA_CLIENT_ID` / `TANDA_CLIENT_SECRET`
- `SESSION_SECRET` / `JWT_SECRET` (32+ chars)
- `TANDA_REDIRECT_URI`

## Testing Changes
After any code edit, run:
```bash
npm run build && npm run start
```

## MCP Endpoints
- `POST /mcp` - JSON-RPC 2.0 protocol handler
- `GET /mcp` - SSE stream for remote transport
- `GET /authorize` - OAuth2 authorization
- `POST /token` - Token exchange
