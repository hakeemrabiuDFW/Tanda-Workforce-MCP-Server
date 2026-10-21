# Security Model

## MCP route authentication

Every MCP route requires authentication. This covers `POST /mcp`, `GET /mcp` (SSE), `POST /` (root
JSON-RPC), any other verb on `/mcp`, and `GET /stats`. Every JSON-RPC method is covered, including
`initialize`, `tools/list` and `tools/call`. An unauthenticated request gets:

```
HTTP/1.1 401 Unauthorized
WWW-Authenticate: Bearer resource_metadata="https://<host>/.well-known/oauth-protected-resource"
{"error":"unauthorized","error_description":"..."}
```

Two credentials are accepted as `Authorization: Bearer <token>`:

| Method | When to use | Configuration |
|--------|-------------|---------------|
| OAuth JWT | Claude.ai / remote MCP clients. The 401 + `WWW-Authenticate` header starts the OAuth flow automatically. | `TANDA_CLIENT_ID`, `TANDA_CLIENT_SECRET`, `JWT_SECRET` |
| Shared secret | Server-to-server, Claude Desktop, smoke tests. | `MCP_SHARED_SECRET` (≥ 32 chars) **and** `TANDA_ACCESS_TOKEN` (the Tanda identity used for those calls) |

Shared-secret auth is off unless both variables are set. The comparison is constant-time.

## Read-only

The server never writes to Tanda:

- The Tanda HTTP client rejects any verb other than `GET`/`HEAD` before the request leaves the process.
- No tool exposes a write action.

## Tanda OAuth scopes (least privilege)

Scopes come from `TANDA_SCOPES` (space or comma separated). The default is the least-privilege set:

| Scope | Used for |
|-------|----------|
| `me` | Identify the authenticated user |
| `roster` | Schedules / rosters |
| `timesheet` | Shifts, timesheets, active shifts |
| `department` | Locations and departments |
| `user` | Staff directory (privacy-filtered) |
| `cost` | Schedule and timesheet costs |
| `leave` | Leave requests and balances |
| `unavailability` | Staff unavailability |

`financial` and `personal` are never requested. If they appear in `TANDA_SCOPES` they are dropped
and a warning is logged. The same list is advertised in `/.well-known/oauth-*` metadata.
