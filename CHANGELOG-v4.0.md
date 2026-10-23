# v4.0.1: OAuth that stays connected

## Fixed
- Sign-in through Workforce.com works. The default scopes are `me roster timesheet department user cost leave`; `unavailability` made Workforce.com's authorize page fail and is now opt-in through `TANDA_SCOPES`. `tanda_validate_schedule` skips the unavailability check, and says so, when the scope is missing.
- Sessions no longer break after about 2 hours. Tanda's single-use refresh tokens are now rotated once per session and saved, instead of each request refreshing with a stale copy.
- A restart or deploy no longer signs everyone out. Refresh tokens carry the Tanda tokens (sealed with AES-256-GCM), so a lost session is rebuilt on the next refresh.

## Added
- `POST /token` accepts `grant_type=refresh_token`. Access tokens last 1 hour; refresh tokens work once and are replaced on each use. A transient Tanda failure returns `503 temporarily_unavailable` and keeps the session; a revoked grant signs the user out.
- `/health` reports `revision`, the commit the running image was built from.
- Staging-first releases: pushes to `staging` deploy the `tanda-mcp-stage` service and pushes to `main` deploy production, each waiting until `/health` reports the new commit (`.github/workflows/deploy.yml`).

## Security
- Errors are logged without their request, so the OAuth client secret and users' bearer tokens no longer reach the logs. Sign-in logs record the user id, not the email.
- `/authorize` accepts only the claude.ai and claude.com MCP callbacks, loopback callbacks for local clients, and any listed in `OAUTH_ALLOWED_REDIRECT_URIS`, and requires PKCE.

# v4.0.0: Secure, read-only, 12 tools

## Phase 0: Security
- Every MCP route (`POST /mcp`, `GET /mcp`, `POST /`, other `/mcp` verbs, `/stats`) requires an OAuth JWT or `MCP_SHARED_SECRET`. Every JSON-RPC method is covered, including `initialize`, `tools/list` and `tools/call`; unauthenticated calls return `401`.
- Tanda scopes come from `TANDA_SCOPES`. The default is the least-privilege set (`me roster timesheet department user cost leave`; `unavailability` is opt-in because Workforce.com OAuth fails on it), and `financial`/`personal` are always stripped.
- Read-only: the Tanda client rejects any non-GET verb, and write actions and the onboarding prompt are removed.

## Phase 1: Correctness and privacy
- Daily stats `actual_hours` was about 1000x too low because unix seconds were treated as milliseconds. Fixed, and breaks are now subtracted.
- Staff by department now filters on `department.staff`.
- Timesheets: one call per pay period, de-duplicated by id. Timesheets with no shifts and $0 cost are dropped unless `include_empty=true`.
- User field whitelist plus recursive redaction of `date_of_birth`, `passcode`, `phone`, `email` and `legal_*`.
- Response guard: summary plus at most 50 rows, a hard 25 KB cap, `truncated` and offset paging.
- `*_iso` times in America/New_York and decimal `hours`.
- Ranges are split into 7-day calls, so Tanda's 7-day error is never shown.

## Phase 2: 12 tools
- New tools: `tanda_org`, `tanda_people`, `tanda_schedules`, `tanda_timesheets`, `tanda_live`, `tanda_time_off`, `tanda_labor_summary`, `tanda_coverage`, `tanda_validate_schedule`, `tanda_exceptions`, `tanda_export_preview`, `tanda_change_history`.
- The old v3 names and the interim action-based names are aliases for one release; each use is logged and counted in `/stats`.
- `tanda_get_shift_limits` is deleted. The supervisor optimizer module is replaced by `tanda_coverage` and `tanda_validate_schedule`.
- Cross-cutting:
  - ETag/If-None-Match cache, with a 24h fresh window for org data
  - `updated_after` on list tools
  - client-side limit of 80 requests/min
  - actionable errors with no upstream stack traces
  - compact JSON output
- `npm run smoke` calls all 12 tools and prints shape and size only.

## Breaking
- Tool names and response shapes changed (the aliases cover one release).
- `MCP_READ_ONLY_MODE` and `MCP_LITE_MODE` have no effect; the server is always read-only.
