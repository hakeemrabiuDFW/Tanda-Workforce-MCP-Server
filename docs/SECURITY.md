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

## Read-only, with two exceptions

The server does not write to Tanda, with two exceptions: creating users (#84) and deactivating them (#88).

- The Tanda HTTP client rejects any verb other than `GET`/`HEAD` before the request leaves the process. The only exceptions are `POST /users`, `POST /users/{id}/invite` and `DELETE /users/{id}`, listed in `src/config/writes.ts`. Tanda treats the delete as a deactivation, which rehire reverses. All three are refused unless `TANDA_WRITES_ENABLED=true`, which is off by default.
- The only tools that write are `tanda_create_user` and `tanda_deactivate_user`. Neither is listed while writes are off. Both need a preview followed by a second call with an HMAC `confirm_token` (`src/mcp/confirm.ts`). The token is signed with `JWT_SECRET`, bound to the tool, the exact arguments and the caller's Tanda token, and valid for 15 minutes.
- `tanda_create_user` refuses duplicates and sends only a fixed whitelist of fields (no wage, DOB, passcode, tax, bank or role fields). It can only set the `employee` level.
- `tanda_deactivate_user` refuses users with any level other than `employee` and refuses the caller's own account. It fails closed if the caller can't be identified.
- Both log each change with the user id, the caller and `source_ref`. Writes are never retried after a timeout or 5xx, because the change may already have happened. Only a 401 is retried, after a token refresh.

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
