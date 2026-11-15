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

## Read-only, with one exception

The server does not write to Tanda, with one exception, user creation (#84):

- The Tanda HTTP client rejects any verb other than `GET`/`HEAD` before the request leaves the process. The only exceptions are `POST /users` and `POST /users/{id}/invite`, listed in `src/config/writes.ts`. Those are refused as well unless `TANDA_WRITES_ENABLED=true`, which is off by default.
- The only tool that writes is `tanda_create_user`. It is not listed while writes are off. It needs a preview followed by a second call with an HMAC `confirm_token` (signed with `JWT_SECRET`, bound to the arguments and the caller's Tanda token, valid for 15 minutes). It refuses duplicates, sends only a fixed whitelist of fields (no wage, DOB, passcode, tax, bank or role fields), can only set the `employee` level, and logs each creation with the caller and `source_ref`.
- Writes are never retried after a timeout or 5xx, because the record may already exist. Only a 401 is retried, after a token refresh.

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
