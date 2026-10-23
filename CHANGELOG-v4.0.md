# v4.1.0: Backlog P0–P2 from the 2026-10-22 smoke test

Still read-only: no new write path to Tanda.

## Fixed
- **WFM-001** `tanda_export_preview`: when `TANDA_EXPORT_FORMAT` is missing, the error now names the Tanda setup step (build an isolved format under Settings › Integrations › "Build Your Own"), not just the variable. Previews still always send `approved_only=true` and `skip_status_update=true`.
- **WFM-002** `tanda_validate_schedule`: each check (roster conflicts, leave, unavailability, active user) fails soft. A 403 skips that check and adds `warnings: [{check, reason: "missing scope: …"}]` instead of failing the call.
- **WFM-004** `tanda_exceptions` `unapproved_timesheet_cost`: adds `all_open_periods_unapproved_cost` and `pending_open_periods`, covering every unapproved timesheet in a pay period that has ended or is current, whatever the window. The window figure is now `window_unapproved_cost`; `unapproved_cost_total` is kept.
- **WFM-005** Weekly-hour checks use explicit calendar workweeks (`WORKWEEK_START`, default `MON`, or `workweek_start`). Responses echo `week_basis` and each week's range. New `projected_over_40` check for the current week (worked + still rostered).
- **WFM-006** `tanda_coverage`: `COVERAGE_EXCLUDE_USER_IDS` users are never counted or suggested as supervisors. Suggestions only name users with the `employee` level who are rostered that day or confirmed available. New `supervision_model` (`site` or `roving`, with `sites_per_supervisor`). Every response includes `assumptions[]`.
- **WFM-007** `tanda_people`: requested fields that cannot be returned are listed in `ignored_fields` (`unknown_field`, `needs_scope:cost`, `not_exposed_by_policy`). `hourly_rate` comes back with `show_wages` when the token has `cost`. `passcode`, `tax_*`, `bank_*` and `super_*` are never returned, even on request.
- **WFM-008** Leave balances say whether accruals are configured: `balances_configured`, `case` and a hint.

## Added
- **WFM-009** `tanda_data_audit`: a one-call data-quality audit (fewer than 20 Tanda requests).
- **WFM-010** `micro_shift` check in `tanda_exceptions`: shifts under `MIN_SHIFT_MINUTES`, with device match from `/clockins`, change-history authors and `likely_accidental_clockout`.
- **WFM-011** `tanda_pay_periods`: pay periods from `PAY_CALENDAR`, including the biweekly-to-weekly cutover (last biweekly 2026-12-14..12-27, first weekly 2026-12-28..2027-01-03), with a status rollup and $ by status.
- **WFM-012** A shared 90/min token bucket across tools (burst 5, so never more than 95 in a minute). 429s are retried 3 times with exponential backoff, and a check that is still rate limited reports `rate_limited: true` in `warnings[]`. People reference data is cached for 24h, like org data.

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
