# Tanda Workforce MCP Server

A production-ready MCP (Model Context Protocol) server for integrating Tanda Workforce API with AI assistants like Claude. Features OAuth2 authentication with PKCE support and comprehensive workforce management tools.

## Features

- **OAuth2 Authentication** - Secure authentication with Tanda including PKCE (RFC 7636)
- **Claude.ai & Desktop Support** - Works with both Claude.ai (OAuth flow) and Claude Desktop (JWT tokens)
- **Dynamic Client Registration** - RFC 7591 support for Claude MCP integration
- **SSE Real-time Transport** - Server-Sent Events for MCP remote transport
- **MCP Protocol Support** - Full JSON-RPC 2.0 implementation (protocol version 2024-11-05)
- **25+ Workforce Tools** - Users, schedules, timesheets, leave, clock-in/out, and more
- **Production Ready** - Docker support, rate limiting, security headers, logging
- **TypeScript** - Fully typed codebase

## Quick Start

### 1. Clone and Install

```bash
git clone https://github.com/hakeemrabiuDFW/Tanda-Workforce-MCP-Server.git
cd Tanda-Workforce-MCP-Server
npm install
```

### 2. Configure Environment

```bash
cp .env.example .env
# Edit .env with your Tanda OAuth credentials
```

Required environment variables:
- `TANDA_CLIENT_ID` - Your Tanda OAuth client ID
- `TANDA_CLIENT_SECRET` - Your Tanda OAuth client secret
- `TANDA_REDIRECT_URI` - OAuth callback URL (e.g., `https://your-domain.com/auth/callback`)
- `SESSION_SECRET` - Random 32+ character string
- `JWT_SECRET` - Random 32+ character string

### 3. Run

```bash
# Development
npm run dev

# Production
npm run build
npm start

# Docker
docker-compose up -d
```

## Connecting to Claude

### Option 1: Claude.ai (Recommended)

Claude.ai uses OAuth 2.0 with Dynamic Client Registration. Simply provide your MCP server URL:

```
https://your-domain.com/mcp
```

Claude.ai will:
1. Discover OAuth endpoints via `/.well-known/oauth-authorization-server`
2. Register as a client via `/oauth/register`
3. Initiate OAuth flow with PKCE via `/authorize`
4. Exchange code for token via `/token`
5. Connect via SSE to `/mcp` for real-time communication

### Option 2: Claude Desktop

Add to your Claude Desktop config file:

**macOS**: `~/Library/Application Support/Claude/claude_desktop_config.json`
**Windows**: `%APPDATA%\Claude\claude_desktop_config.json`

```json
{
  "mcpServers": {
    "tanda-workforce": {
      "url": "https://your-domain.com/mcp",
      "headers": {
        "Authorization": "Bearer YOUR_JWT_TOKEN"
      }
    }
  }
}
```

#### Getting a JWT Token

1. Navigate to `https://your-domain.com/auth/login`
2. Authenticate with your Tanda account
3. Copy the returned JWT token

## Team Member Access

Each team member can connect to the same MCP server:

1. **Individual Authentication**: Each person authenticates with their own Tanda credentials
2. **Separate Sessions**: Each authenticated user gets their own session
3. **Permission-Based Access**: Tool access depends on each user's Tanda permissions

> **Note**: Sessions are stored in-memory. For production deployments with multiple server instances, consider implementing a shared session store (e.g., Redis).

## API Endpoints

### Core Endpoints

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/` | GET | Server info and endpoint listing |
| `/health` | GET | Health check |
| `/docs` | GET | API documentation |
| `/stats` | GET | Server statistics |

### OAuth 2.0 Endpoints

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/.well-known/oauth-authorization-server` | GET | OAuth discovery (RFC 8414) |
| `/oauth/register` | POST | Dynamic Client Registration (RFC 7591) |
| `/authorize` | GET | OAuth2 authorization endpoint |
| `/token` | POST | OAuth2 token endpoint (supports PKCE) |

### Authentication Endpoints

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/auth/login` | GET | Start OAuth flow (browser) |
| `/auth/callback` | GET | OAuth callback handler |
| `/auth/status` | GET | Check authentication status |
| `/auth/logout` | POST | Logout and invalidate session |
| `/api/authenticate` | POST | Exchange code for JWT token |
| `/api/me` | GET | Get current user (protected) |

### MCP Endpoints

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/mcp` | GET | SSE endpoint for real-time transport |
| `/mcp` | POST | MCP JSON-RPC 2.0 endpoint |
| `/` | POST | MCP endpoint (Claude compatibility) |

## Available Tools

### User Management
- `tanda_get_current_user` - Get current user profile
- `tanda_get_users` - List all employees
- `tanda_get_user` - Get specific user details

### Scheduling
- `tanda_get_schedules` - Get scheduled shifts
- `tanda_create_schedule` - Create new shift
- `tanda_update_schedule` - Update shift
- `tanda_delete_schedule` - Delete shift
- `tanda_publish_schedules` - Publish schedules

### Timesheets
- `tanda_get_shifts` - Get worked shifts
- `tanda_get_timesheets` - Get timesheets
- `tanda_approve_shift` - Approve shift
- `tanda_approve_timesheet` - Approve timesheet

### Leave Management
- `tanda_get_leave_requests` - Get leave requests
- `tanda_create_leave_request` - Create leave request
- `tanda_approve_leave` - Approve leave
- `tanda_decline_leave` - Decline leave
- `tanda_get_leave_balances` - Get leave balances

### Clock In/Out
- `tanda_clock_in` - Clock operations
- `tanda_get_clock_ins` - Get clock records

### Organization
- `tanda_get_departments` - List departments
- `tanda_get_locations` - List locations
- `tanda_get_qualifications` - List qualifications
- `tanda_get_user_qualifications` - Get user qualifications

### Costs & Awards
- `tanda_get_roster_costs` - Get labor costs
- `tanda_get_award_interpretation` - Get pay calculations

## Docker Deployment

```bash
# Build and run
docker-compose up -d --build

# View logs
docker-compose logs -f

# Stop
docker-compose down
```

## Development

```bash
# Install dependencies
npm install

# Run in development mode
npm run dev

# Build for production
npm run build

# Run linter
npm run lint

# Run tests
npm test
```

## Project Structure

```
├── src/
│   ├── auth/           # OAuth and authentication
│   │   ├── middleware.ts
│   │   └── oauth.ts
│   ├── config/         # Environment configuration
│   │   └── environment.ts
│   ├── mcp/            # MCP protocol handlers
│   │   ├── handler.ts
│   │   └── tools.ts
│   ├── server/         # Express server setup
│   │   └── app.ts
│   ├── tanda/          # Tanda API client
│   │   ├── client.ts
│   │   └── types.ts
│   ├── utils/          # Utilities
│   │   └── logger.ts
│   └── index.ts        # Entry point
├── tests/              # Test files
├── Dockerfile
├── docker-compose.yml
├── DEPLOYMENT.md       # Full deployment guide
└── package.json
```

## Documentation

See [DEPLOYMENT.md](./DEPLOYMENT.md) for comprehensive deployment instructions including:
- OAuth setup with Tanda
- Cloud deployment guides (AWS, GCP, Railway)
- Testing procedures
- Troubleshooting

## License

MIT License - see [LICENSE](./LICENSE) file

## Author

hakeemrabiuDFW
