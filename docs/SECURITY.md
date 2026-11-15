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

## Read-only, with three exceptions

Which identity each write runs as is decided in [ADR 0001](adr/0001-write-tool-identity.md).

The server does not write to Tanda, with four exceptions: creating users (#84), deactivating them (#88), updating their pay rate and similar fields (#94) and approving timesheets (#86).

- The Tanda HTTP client rejects any verb other than `GET`/`HEAD` before the request leaves the process. The only exceptions are `POST /users`, `POST /users/{id}/invite`, `DELETE /users/{id}`, `PUT /users/{id}`, `PUT /timesheets/{id}` and `PUT /shifts/{id}`, listed in `src/config/writes.ts`. Tanda treats the delete as a deactivation, which rehire reverses. The client only sends `hourly_rate`, `award_template_id`, `employment_start_date`, `department_ids` and `employee_id` to users, only `status` (approved or pending, never exported) to timesheets, and only `finish` and `metadata` to shifts. All of these are refused unless `TANDA_WRITES_ENABLED=true`, which is off by default.
- The only tools that write are `tanda_create_user`, `tanda_deactivate_user`, `tanda_update_user` and `tanda_approve_timesheets`. None is listed while writes are off. All four need a preview followed by a second call with an HMAC `confirm_token` (`src/mcp/confirm.ts`). The token is signed with `JWT_SECRET`, bound to the tool, the exact arguments and the caller's Tanda token, and valid for 15 minutes.
- `tanda_create_user` refuses duplicates and sends only a fixed whitelist of fields (an optional `hourly_rate`, but no DOB, passcode, tax, bank or role fields). It can only set the `employee` level.
- `tanda_deactivate_user` refuses users with any level other than `employee` and refuses the caller's own account. It fails closed if the caller can't be identified.
- `tanda_update_user` refuses users with any level other than `employee`, inactive users and the caller's own account, and fails closed if the caller can't be identified. It rejects any field outside its five, rates outside 0–100, and more than 50 users per call. Its token covers the exact per-user change set. Its diff hides rates unless the caller opts in with `show_wages` or `fields`, as `tanda_people` does.
- `tanda_approve_timesheets` can only be applied by a person's own login, so Tanda records a person as the approver. The shared server identity may preview, which the staging release gate (#97) needs. That preview returns the same timesheet rows as `tanda_timesheets` (names, hours, cost) and no `confirm_token`, and the shared identity's apply is refused ([ADR 0001](adr/0001-write-tool-identity.md)). It never touches exported timesheets and needs `allow_past_period` for periods that ended more than 14 days ago. It changes at most 100 timesheets per call, and its token covers the exact shift and status changes.
- All four log each change with the user id, the caller and `source_ref`. Writes are never retried after a timeout or 5xx, because the change may already have happened. Only a 401 is retried, after a token refresh.

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
