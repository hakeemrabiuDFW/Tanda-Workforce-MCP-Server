# Tanda Workforce MCP Server - Deployment Guide

This guide covers deploying the Tanda Workforce MCP Server with OAuth2 authentication for use with Claude.ai and Claude Desktop.

## Table of Contents

- [Overview](#overview)
- [Prerequisites](#prerequisites)
- [OAuth Setup with Tanda](#oauth-setup-with-tanda)
- [Deployment Options](#deployment-options)
- [Connecting Claude](#connecting-claude)
- [Team Member Setup](#team-member-setup)
- [Testing Procedures](#testing-procedures)
- [Troubleshooting](#troubleshooting)

---

## Overview

The Tanda Workforce MCP Server provides:
- OAuth2 authentication with Tanda Workforce (including PKCE support)
- Dynamic Client Registration (RFC 7591) for Claude.ai
- OAuth Discovery (RFC 8414) for automatic endpoint detection
- SSE real-time transport for MCP communication
- MCP (Model Context Protocol) endpoint for AI integrations
- Full Tanda API access for workforce management operations

### Server Endpoints

#### Core Endpoints

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/` | GET | Server info and endpoint listing |
| `/` | POST | MCP protocol endpoint (Claude compatibility) |
| `/health` | GET | Health check |
| `/docs` | GET | API documentation |
| `/stats` | GET | Server statistics and session info |

#### OAuth 2.0 Endpoints (RFC Compliant)

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/.well-known/oauth-authorization-server` | GET | OAuth discovery (RFC 8414) |
| `/oauth/register` | POST | Dynamic Client Registration (RFC 7591) |
| `/authorize` | GET | OAuth2 authorization endpoint |
| `/token` | POST | OAuth2 token endpoint (supports PKCE) |

#### Authentication Endpoints

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/auth/login` | GET | Start OAuth flow (browser) |
| `/auth/callback` | GET | OAuth callback handler |
| `/auth/status` | GET | Check authentication status |
| `/auth/logout` | POST | Logout and invalidate session |
| `/api/authenticate` | POST | Exchange code for JWT token |
| `/api/me` | GET | Get current user (protected) |

#### MCP Endpoints

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/mcp` | GET | SSE endpoint for real-time transport |
| `/mcp` | POST | MCP JSON-RPC 2.0 protocol endpoint |

---

## Prerequisites

- Node.js 18+ (for local development)
- Docker and Docker Compose (for containerized deployment)
- Tanda workforce account with API access
- A domain name with SSL (for production)

---

## OAuth Setup with Tanda

### Step 1: Create OAuth Application

1. Log in to your Tanda account at https://my.tanda.co
2. Navigate to **Settings** → **Integrations** → **Developer**
3. Click **Create Application**
4. Fill in the application details:
   - **Name**: Your MCP Server name
   - **Redirect URI**: Your callback URL (e.g., `https://your-domain.com/auth/callback`)
5. Save and note your **Client ID** and **Client Secret**

### Step 2: Configure Environment

Create a `.env` file from the template:

```bash
cp .env.example .env
```

Edit `.env` with your credentials:

```env
# Tanda OAuth Configuration
TANDA_CLIENT_ID=your_client_id_here
TANDA_CLIENT_SECRET=your_client_secret_here
TANDA_REDIRECT_URI=https://your-domain.com/auth/callback

# Security (generate secure random strings for production)
SESSION_SECRET=your_32_character_minimum_secret_here
JWT_SECRET=your_32_character_minimum_secret_here
```

Generate secure secrets:
```bash
# Generate SESSION_SECRET
node -e "console.log('SESSION_SECRET=' + require('crypto').randomBytes(32).toString('hex'))"

# Generate JWT_SECRET
node -e "console.log('JWT_SECRET=' + require('crypto').randomBytes(32).toString('hex'))"
```

---

## Deployment Options

### Option 1: Docker Deployment (Recommended)

```bash
# Build and start
docker-compose up -d --build

# View logs
docker-compose logs -f

# Stop
docker-compose down
```

### Option 2: Docker Run

```bash
# Build image
docker build -t tanda-mcp-server .

# Run container
docker run -d \
  --name tanda-mcp-server \
  -p 3000:3000 \
  --env-file .env \
  --restart unless-stopped \
  tanda-mcp-server
```

### Option 3: Local Development

```bash
# Install dependencies
npm install

# Development mode (with hot reload via ts-node)
npm run dev

# Production build
npm run build
npm start
```

### Option 4: Cloud Deployment

#### AWS (ECS/Fargate)

1. Push image to ECR:
```bash
aws ecr get-login-password --region us-east-1 | docker login --username AWS --password-stdin YOUR_ACCOUNT.dkr.ecr.us-east-1.amazonaws.com
docker tag tanda-mcp-server:latest YOUR_ACCOUNT.dkr.ecr.us-east-1.amazonaws.com/tanda-mcp-server:latest
docker push YOUR_ACCOUNT.dkr.ecr.us-east-1.amazonaws.com/tanda-mcp-server:latest
```

2. Create ECS task definition with environment variables
3. Create ECS service with Application Load Balancer

#### Google Cloud Run

```bash
# Build and deploy
gcloud run deploy tanda-mcp-server \
  --source . \
  --region us-central1 \
  --allow-unauthenticated \
  --set-env-vars "TANDA_CLIENT_ID=$TANDA_CLIENT_ID,TANDA_CLIENT_SECRET=$TANDA_CLIENT_SECRET,..."
```

#### Railway/Render/Fly.io

These platforms auto-detect the Dockerfile. Set environment variables in their dashboard.

For Railway, the server auto-detects `RAILWAY_PUBLIC_DOMAIN` to construct redirect URIs.

---

## Connecting Claude

### Claude.ai (OAuth Flow)

Claude.ai uses the full OAuth 2.0 flow with automatic discovery:

1. **Add MCP Server**: In Claude.ai settings, add your MCP server URL:
   ```
   https://your-domain.com/mcp
   ```

2. **OAuth Flow**: Claude.ai automatically:
   - Fetches `/.well-known/oauth-authorization-server` for endpoint discovery
   - Registers via `/oauth/register` (Dynamic Client Registration)
   - Initiates OAuth with PKCE via `/authorize`
   - Exchanges code for token via `/token`
   - Connects via SSE to `/mcp`

3. **Authenticate**: You'll be redirected to Tanda to log in
4. **Use Tools**: Once authenticated, all 25+ tools are available

### Claude Desktop (JWT Token)

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

### Getting Your JWT Token

1. **Browser Flow**:
   - Navigate to `https://your-domain.com/auth/login`
   - Authenticate with Tanda
   - Copy the returned JWT token

2. **API Flow**:
   ```bash
   # After user authenticates and you receive the code:
   curl -X POST https://your-domain.com/api/authenticate \
     -H "Content-Type: application/json" \
     -d '{"code": "AUTHORIZATION_CODE"}'
   ```

---

## Team Member Setup

The MCP server supports multiple team members connecting simultaneously:

### How It Works

1. **Individual Authentication**: Each team member authenticates with their own Tanda credentials
2. **Separate Sessions**: Each person gets their own session and JWT token
3. **Permission-Based Access**: Tool access depends on each user's Tanda permissions
4. **Shared Server**: All team members connect to the same MCP server URL

### Setup for Team Members

1. Share the MCP server URL with your team
2. Each member follows the authentication steps above
3. Each member uses their own JWT token (for Claude Desktop) or authenticates via OAuth (for Claude.ai)

### Production Considerations

- **Session Storage**: Default in-memory storage works for single-instance deployments
- **Multiple Instances**: For load-balanced deployments, implement Redis or database session storage
- **Token Expiry**: JWT tokens expire after 24 hours by default (configurable via `JWT_EXPIRY`)

---

## Testing Procedures

### 1. Health Check

```bash
curl https://your-domain.com/health
```

Expected response:
```json
{
  "status": "healthy",
  "timestamp": "2024-01-15T10:30:00.000Z",
  "version": "1.0.0"
}
```

### 2. OAuth Discovery

```bash
curl https://your-domain.com/.well-known/oauth-authorization-server
```

Expected response:
```json
{
  "issuer": "https://your-domain.com",
  "authorization_endpoint": "https://your-domain.com/authorize",
  "token_endpoint": "https://your-domain.com/token",
  "registration_endpoint": "https://your-domain.com/oauth/register",
  "response_types_supported": ["code"],
  "grant_types_supported": ["authorization_code"],
  "code_challenge_methods_supported": ["S256"],
  "token_endpoint_auth_methods_supported": ["none"]
}
```

### 3. Dynamic Client Registration

```bash
curl -X POST https://your-domain.com/oauth/register \
  -H "Content-Type: application/json" \
  -d '{
    "client_name": "Test Client",
    "redirect_uris": ["https://example.com/callback"]
  }'
```

Expected response:
```json
{
  "client_id": "mcp-client-1234567890-abc123",
  "client_name": "Test Client",
  "redirect_uris": ["https://example.com/callback"],
  "token_endpoint_auth_method": "none",
  "grant_types": ["authorization_code"],
  "response_types": ["code"]
}
```

### 4. MCP Protocol Test

```bash
# Initialize
curl -X POST https://your-domain.com/mcp \
  -H "Content-Type: application/json" \
  -d '{
    "jsonrpc": "2.0",
    "id": 1,
    "method": "initialize",
    "params": {
      "protocolVersion": "2024-11-05",
      "clientInfo": { "name": "test", "version": "1.0" },
      "capabilities": {}
    }
  }'

# List tools
curl -X POST https://your-domain.com/mcp \
  -H "Content-Type: application/json" \
  -d '{
    "jsonrpc": "2.0",
    "id": 2,
    "method": "tools/list"
  }'

# Call a tool (requires authentication)
curl -X POST https://your-domain.com/mcp \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer YOUR_JWT_TOKEN" \
  -d '{
    "jsonrpc": "2.0",
    "id": 3,
    "method": "tools/call",
    "params": {
      "name": "tanda_get_current_user",
      "arguments": {}
    }
  }'
```

### 5. SSE Connection Test

```bash
# Test SSE endpoint (will receive events)
curl -N https://your-domain.com/mcp \
  -H "Accept: text/event-stream"
```

### 6. Full Integration Test

```bash
#!/bin/bash
BASE_URL="https://your-domain.com"
TOKEN="your_jwt_token"

echo "Testing health..."
curl -s "$BASE_URL/health" | jq .

echo "Testing OAuth discovery..."
curl -s "$BASE_URL/.well-known/oauth-authorization-server" | jq .

echo "Testing MCP initialize..."
curl -s -X POST "$BASE_URL/mcp" \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","clientInfo":{"name":"test","version":"1.0"},"capabilities":{}}}' | jq .

echo "Testing MCP tools/list..."
curl -s -X POST "$BASE_URL/mcp" \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":2,"method":"tools/list"}' | jq .

echo "Testing authenticated endpoint..."
curl -s "$BASE_URL/api/me" \
  -H "Authorization: Bearer $TOKEN" | jq .

echo "Testing MCP tool call..."
curl -s -X POST "$BASE_URL/mcp" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $TOKEN" \
  -d '{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"tanda_get_departments","arguments":{}}}' | jq .
```

---

## Available MCP Tools

| Tool | Description |
|------|-------------|
| `tanda_get_current_user` | Get authenticated user's profile |
| `tanda_get_users` | List all users/employees |
| `tanda_get_user` | Get specific user by ID |
| `tanda_get_departments` | List all departments |
| `tanda_get_locations` | List all locations |
| `tanda_get_schedules` | Get scheduled shifts |
| `tanda_create_schedule` | Create a new shift |
| `tanda_update_schedule` | Update existing shift |
| `tanda_delete_schedule` | Delete a shift |
| `tanda_publish_schedules` | Publish schedules to staff |
| `tanda_get_shifts` | Get worked shifts (timesheet) |
| `tanda_get_timesheets` | Get timesheets with approval status |
| `tanda_approve_shift` | Approve a shift |
| `tanda_approve_timesheet` | Approve a timesheet |
| `tanda_get_leave_requests` | Get leave requests |
| `tanda_create_leave_request` | Create leave request |
| `tanda_approve_leave` | Approve leave request |
| `tanda_decline_leave` | Decline leave request |
| `tanda_get_leave_balances` | Get user's leave balances |
| `tanda_clock_in` | Clock in/out operations |
| `tanda_get_clock_ins` | Get clock records |
| `tanda_get_qualifications` | List qualification types |
| `tanda_get_user_qualifications` | Get user's qualifications |
| `tanda_get_award_interpretation` | Get pay calculations |
| `tanda_get_roster_costs` | Get labor costs |

---

## Troubleshooting

### Common Issues

#### "Invalid or expired session"
- The OAuth session has expired. Start a new login flow at `/auth/login`
- Sessions expire after 24 hours by default

#### "Authentication required"
- Include the JWT token in the Authorization header: `Bearer <token>`
- For Claude.ai, re-authenticate via the OAuth flow

#### "State mismatch"
- The OAuth state doesn't match. This could indicate a CSRF attempt or cookies not being saved properly
- The server now encodes session ID in state to survive cross-site redirects

#### "Token exchange failed"
- Verify your `TANDA_CLIENT_ID` and `TANDA_CLIENT_SECRET` are correct
- Ensure `TANDA_REDIRECT_URI` matches exactly what's configured in Tanda

#### "PKCE validation failed"
- Ensure the code_verifier matches the code_challenge sent during authorization
- Only S256 method is supported

#### SSE Connection Issues
- Ensure your reverse proxy (nginx, etc.) has buffering disabled
- Check that `X-Accel-Buffering: no` header is respected

### Logs

```bash
# Docker logs
docker-compose logs -f tanda-mcp-server

# Filter for errors
docker-compose logs -f tanda-mcp-server 2>&1 | grep -i error
```

### Debug Mode

Set `NODE_ENV=development` for verbose logging:

```bash
NODE_ENV=development npm run dev
```

---

## Security Best Practices

1. **Always use HTTPS** in production
2. **Rotate secrets** regularly
3. **Set restrictive CORS** origins for production
4. **Enable rate limiting** (enabled by default)
5. **Use secure cookie settings** (automatic in production)
6. **Store secrets** in environment variables or secret managers
7. **Monitor** the `/stats` endpoint for unusual activity
8. **Implement session storage** (Redis) for multi-instance deployments

---

## Support

For issues and feature requests, please open an issue on GitHub.

For Tanda API documentation, visit: https://my.tanda.co/api/v2/docs
