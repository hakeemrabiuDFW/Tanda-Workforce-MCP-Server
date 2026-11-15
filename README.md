# Tanda Workforce MCP Server v4.0.1

A read-only MCP (Model Context Protocol) server for the Tanda / Workforce.com API, with four guarded exceptions: creating employees, deactivating them, updating their pay rate and similar fields, and approving timesheets. It exposes 12 consolidated read tools, plus four write tools (`tanda_create_user`, `tanda_deactivate_user`, `tanda_update_user`, `tanda_approve_timesheets`) when `TANDA_WRITES_ENABLED=true`. Every tool is privacy-filtered and returns at most 25 KB, so assistants like Claude can answer workforce questions without overflowing their context.

## Security

- **Auth on every MCP route.** `POST /mcp`, `GET /mcp` and `POST /` require an OAuth JWT or `Authorization: Bearer <MCP_SHARED_SECRET>`. Unauthenticated calls get `401`.
- **Read-only, with four guarded exceptions.** The Tanda client refuses any non-GET request except `POST /users`, `POST /users/{id}/invite`, `DELETE /users/{id}`, `PUT /users/{id}`, `PUT /timesheets/{id}` and `PUT /shifts/{id}`, and refuses those too unless `TANDA_WRITES_ENABLED=true` (off by default).
- **Least-privilege scopes.** The server requests `me roster timesheet department user cost leave`. It never requests `financial` or `personal`. `unavailability` is off by default because Workforce.com's OAuth fails when it is requested; add it to `TANDA_SCOPES` only if your OAuth app supports it.
- **Privacy by default.** User records are whitelisted, and `date_of_birth`, `phone`, `email`, `legal_*` and `hourly_rate` are returned only when the `fields` parameter names them. `passcode`, `tax_*`, `bank_*` and `super_*` are never returned.

See [docs/SECURITY.md](docs/SECURITY.md).

Which Tanda identity each write tool may run as is set by [ADR 0001](docs/adr/0001-write-tool-identity.md).

## Tools (12)

Every list tool returns `{ summary, rows, page }`. `rows` holds at most 50 entries and the whole response is at most 25 KB. When rows are cut, the response sets `truncated: true` and includes `page.next_offset` and a `how_to_page` hint. Time fields come as unix seconds plus `*_iso` strings in `America/New_York`, and `hours` is a decimal. `from`/`to` ranges up to 62 days are split into 7-day Tanda calls internally.

| Tool | Returns / when to use |
|------|----------------------|
| `tanda_org` | Locations with departments nested, staff counts, bookkeeping and Supervisor flags. Use it first to resolve names to ids. Cached for 24h, then revalidated with ETag. |
| `tanda_people` | Privacy-filtered staff, filtered by department, site, status or name. `me: true` returns the authenticated user. Supports `updated_after`. `fields: ["hourly_rate"]` (or `show_wages: true`) adds wages when the token has the `cost` scope. Requested fields that can't be returned are listed in `ignored_fields` with a reason: `unknown_field`, `needs_scope:cost` or `not_exposed_by_policy`. |
| `tanda_schedules` | Rostered shifts (`include_names=true`, optional `show_costs`) with totals by site and day. `view=location_day` returns site × day rows. |
| `tanda_timesheets` | Worked time from `/timesheets/on/{date}?show_costs&show_award_interpretation`, with shifts embedded. De-duplicated, with totals by status and site. `view=shifts` returns pay codes per shift. |
| `tanda_live` | Who is clocked in now (`/shifts/active`), with name, site and elapsed hours. Flags shifts open more than 12h. |
| `tanda_time_off` | `kind=leave`, `unavailability` or `balances`. Balances include leave types and say which case applies: `no_accrual_configured` (`balances_configured: false`, with a hint), `zero_balance` or `has_balance`. |
| `tanda_labor_summary` | Scheduled vs actual hours and cost, with variance, grouped by `location`, `day`, `department` or `user`. |
| `tanda_coverage` | Supervisor coverage. `mode=gaps` lists times staff are on site with no supervisor; `mode=overlaps` lists two supervisors at one site or one supervisor double-booked. `supervision_model=site` (default) needs a supervisor at every staffed site; `roving` lets one supervisor on duty cover `sites_per_supervisor` sites. Up to 10 suggested moves, which only name users with the `employee` level who are rostered that day or confirmed available, and never anyone in `COVERAGE_EXCLUDE_USER_IDS`. Returns `assumptions[]`. Optional `window_start`/`window_end` (e.g. 17:00–22:00). |
| `tanda_validate_schedule` | Checks proposed shifts against rosters, leave, unavailability, the 12h shift limit, the 40h week and double-booking. Each check fails soft: a missing scope skips that check and adds `warnings: [{ check, reason }]` instead of failing the call. Weekly hours use the same calendar workweek as `tanda_exceptions` (`workweek_start`, echoed as `week_basis`). Nothing is written. |
| `tanda_exceptions` | Audit list: shifts open more than 12h, zero-length shifts, pending leave already in the past, unapproved timesheet $ by site, active staff with no award template, calendar workweeks over 40h, and `projected_over_40` for the current week (worked + still rostered). Weekly checks echo `week_basis` and each week's range. Unapproved cost is reported for the window (`window_unapproved_cost`) and for every pay period that has ended or is current (`all_open_periods_unapproved_cost`, `pending_open_periods`; looks back `OPEN_PERIOD_LOOKBACK_DAYS`, default 42). |
| `tanda_export_preview` | Payroll export preview with `approved_only=true` and a hard-coded `skip_status_update=true`. Returns row count, totals and rows missing a pay code. Never returns the raw file. |
| `tanda_change_history` | Version history from `/shifts/{id}/versions` or `/schedules/{id}/versions`. |

### Creating employees (`tanda_create_user`, off by default)

Only listed and callable when `TANDA_WRITES_ENABLED=true`. It creates a plain employee (`POST /users`, `user` scope) in two calls:

1. Call with `name`, `email` and optionally `phone`, `employment_start_date`, `department_ids`, `award_template_id` (default 42, or `TANDA_DEFAULT_AWARD_TEMPLATE_ID`), `send_invite` and `source_ref` (e.g. the Monday item id). Nothing is created. The response is `status: "preview"` with the exact `payload` and a `confirm_token` valid for 15 minutes. Add `fields: ["email","phone"]` to see those in the preview.
2. Call again with the same arguments plus `confirm_token`. The response is `status: "created"` with `user_id`, the user as `tanda_people` returns it, and `invite` (`not_requested`, `sent` or `failed`; a failed invite is a warning, not an error).

The token is bound to the arguments and to the Tanda identity that asked for the preview. Changed arguments, another identity or an expired token are refused. Both calls first check for duplicates among active and inactive users. A user with the same email, or with the same name and start date, returns `status: "exists"` with `existing_user_id` and creates nothing. Unknown `department_ids` are refused. Only the `employee` level can be set, and date of birth, passcode, tax, bank and role fields are never sent. `hourly_rate` (above 0, at most 100; needs the `cost` scope) is optional, but without it the user's timesheets cost $0, so the preview warns when it's missing. The preview echoes the rate as `pay_rate`, because wage keys are redacted from responses. Each creation is logged with the new user id, the caller's Tanda user id and `source_ref`. Calls made with the shared server token (scheduled tasks) must pass `source_ref`; see [ADR 0001](docs/adr/0001-write-tool-identity.md).

### Deactivating employees (`tanda_deactivate_user`, off by default)

Tanda's `DELETE /users/{id}` does not erase anyone. It marks the user inactive, and Tanda's rehire reverses it. Use this tool to remove test hires and leavers from the active, billed headcount. It works in the same two steps as `tanda_create_user`: call with `user_id` (plus `source_ref`, which is required under the shared server token; see [ADR 0001](docs/adr/0001-write-tool-identity.md)) to preview the user and get a `confirm_token`, then repeat the call with the token. An inactive user returns `status: "already_inactive"`. The tool refuses anyone with a level other than `employee`, and it refuses the caller's own account; it fails closed if the caller can't be identified. Each deactivation is logged with the user id, the caller and `source_ref`.

### Updating employees (`tanda_update_user`, off by default)

Sets `hourly_rate`, `award_template_id`, `employment_start_date`, `department_ids` (replaces the user's teams) or `employee_id` through Tanda's `PUT /users/{id}`. No other field can be sent. Use it to backfill pay rates for staff created without one: `tanda_exceptions` lists them under `missing_pay_rate`. Pass one user (`user_id` plus fields) or up to 50 in `updates: [{user_id, hourly_rate, ...}]`. The first call returns a before/after diff per user and a `confirm_token`. Repeat the call with the token to apply it. Each user's outcome is reported as `updated`, `not_applied` (Tanda kept the old value), `failed`, `unchanged` or `refused`. Rates must be above 0 and at most 100, and a change of more than 25% against the current rate is flagged in the preview. The tool refuses managers, admins, inactive users and the caller, and fails closed if the caller can't be identified. Current rates are visible only with the `cost` scope. Each update is logged with the user id, the changed field names, the caller and `source_ref`, which is required under the shared server token ([ADR 0001](docs/adr/0001-write-tool-identity.md)).

### Approving timesheets (`tanda_approve_timesheets`, off by default)

Approves Tanda timesheets for a pay period, or returns them to pending (`action: "unapprove"`). It needs a person's own Tanda login: calls made with the shared server token (`MCP_SHARED_SECRET` + `TANDA_ACCESS_TOKEN`) are refused, so Tanda's history always shows who approved.

1. Call with `from`/`to` (the pay period) and optionally `timesheet_ids`, `user_ids` or `location_ids`. Nothing changes. Each timesheet row shows `will_change` or a `skip_reason`, any data-quality `flags`, and the `shift_changes` that would be made. A `confirm_token` comes back with the preview.
2. Repeat the call with `confirm_token`. Each timesheet's shift changes are applied first, then its status. A failure on one timesheet is reported in its row (`outcome: "failed"`), and the others carry on.

Data-quality handling:
- **Missing clock-out:** the finish is filled from the user's rostered finish that day when exactly one roster entry matches (`fill_missing_clock_out`, default true).
- **Flags:** a missing clock-out that couldn't be filled, a zero-length shift, a shift over 12h, a shift with no pay code, or a workweek over 40h. Flagged timesheets are still approved, and each affected shift gets an `MCP-EXCEPTION <date>: <reasons>` note in its `metadata`, which is visible in Workforce. Existing metadata is kept.
- **Skipped:** exported timesheets are never touched. Periods that ended more than 14 days ago need `allow_past_period: true`. At most 100 timesheets change per call.
- **Token:** it covers the exact changes. If the data changes between preview and confirm, the token is refused and you preview again.

A **supervisor** is any user rostered to a department named `Supervisor` or `Supervisors` (case-insensitive). The **bookkeeping sites** 281737 (One Time Projects), 301754 (Floater) and 396358 (MCP Test) are flagged, and analytics tools exclude them by default.

### Deprecated names (one release)

The v3 tool names (for example `tanda_get_daily_stats`, `tanda_get_staff_by_department`, `tanda_get_timesheets`) and the interim action-based names (`tanda_users`, `tanda_reference`, …) still work. They are translated to the new tools, and the response carries a `deprecation` notice. Each use is logged, and the counts appear under `deprecated_alias_usage` in `GET /stats`. Aliases are not listed in `tools/list` unless `MCP_LIST_ALIASES=true`.

`tanda_get_shift_limits` is **removed**: Tanda's endpoint returns first/last shifts, not limits. Use `tanda_exceptions` instead.

## Quick Start

```bash
git clone https://github.com/hakeemrabiuDFW/Tanda-Workforce-MCP-Server.git
cd Tanda-Workforce-MCP-Server
npm install
cp .env.example .env   # fill in values
npm run build && npm start
```

### Environment

| Variable | Required | Purpose |
|----------|----------|---------|
| `TANDA_CLIENT_ID`, `TANDA_CLIENT_SECRET` | yes | Tanda OAuth app |
| `TANDA_REDIRECT_URI` | prod | OAuth callback (auto-detected on Railway) |
| `SESSION_SECRET`, `JWT_SECRET` | yes | ≥ 32 chars |
| `TANDA_SCOPES` | no | Default `me roster timesheet department user cost leave` |
| `MCP_SHARED_SECRET` + `TANDA_ACCESS_TOKEN` | no | Bearer-secret auth for server-to-server, Claude Desktop and the smoke test |
| `TANDA_EXPORT_FORMAT` | for export preview | Payroll export format name |
| `TANDA_TIMEZONE` | no | Default `America/New_York` |
| `COVERAGE_EXCLUDE_USER_IDS` | no | Comma-separated user ids never counted or suggested as supervisors (e.g. bookkeeping and admin-only users) |
| `COVERAGE_SUPERVISION_MODEL` | no | Default `supervision_model` for `tanda_coverage`: `site` (default) or `roving` |
| `COVERAGE_ROVING_SITES` | no | Sites one roving supervisor covers at once. Default 5 |
| `WORKWEEK_START` | no | First day of the overtime workweek (`SUN`…`SAT`). Default `MON` |
| `OPEN_PERIOD_LOOKBACK_DAYS` | no | How far back `tanda_exceptions` looks for still-pending pay periods. Default 42 |
| `TANDA_BOOKKEEPING_LOCATION_IDS` | no | Default `281737,301754,396358` |
| `TANDA_RATE_LIMIT_PER_MIN` | no | Client-side limit, default 80 (Tanda allows 100/min shared across password tokens) |
| `MCP_LIST_ALIASES` | no | `true` lists the deprecated names in `tools/list` |
| `TANDA_WRITES_ENABLED` | no | `true` turns on the write tools (`tanda_create_user`, `tanda_deactivate_user`, `tanda_update_user`, `tanda_approve_timesheets`). Off by default |
| `TANDA_DEFAULT_AWARD_TEMPLATE_ID` | no | Award template for new users when none is given. Default 42 |

## Connecting to Claude

**Claude.ai:** add `https://your-domain.com/mcp` as a connector. The `401` response with `WWW-Authenticate: Bearer resource_metadata=…` starts the OAuth flow (discovery, dynamic registration, PKCE).

**Claude Desktop / scripts:**

```json
{
  "mcpServers": {
    "tanda-workforce": {
      "url": "https://your-domain.com/mcp",
      "headers": { "Authorization": "Bearer <MCP_SHARED_SECRET or JWT from /auth/login>" }
    }
  }
}
```

## Development

```bash
npm test          # unit + integration tests (Tanda stubbed; includes an 84-site / 70-user size check)
npm run build
MCP_URL=https://your-domain.com/mcp MCP_TOKEN=<secret> npm run smoke [from] [to]
```

`npm run smoke` calls all 12 read tools against a running server and prints only the shape and size of each response (no row values). It exits non-zero if a tool errors, exceeds 25 KB, or returns `date_of_birth`/`passcode`.

## Releasing

Changes reach production through `staging` first:

1. Open a pull request into `staging`. CI runs typecheck, tests and build.
2. Merge it. **Build and deploy** (`.github/workflows/deploy.yml`) tests again, pushes the image as `:staging` and `:<commit>`, redeploys the `tanda-mcp-stage` Railway service, and waits until its `/health` reports the new commit.
3. Check staging (`https://tanda-mcp-stage-production.up.railway.app`), for example with `npm run smoke`.
4. Merge the release pull request from `staging` into `main`. The **Release PR** workflow (`.github/workflows/release-pr.yml`) opens it as soon as `staging` has changes `main` lacks, lists the change PRs it carries, and keeps it updated; each release gets its own PR. Merging it ships `:production` to the production service.

The deploy step needs a Railway project token as the `RAILWAY_TOKEN` repository secret; without it the image is pushed but not deployed. To require approval for production, add reviewers to the `production` environment in the repository's settings. To roll back, redeploy an earlier deployment in Railway, or point the service at an earlier `:<commit>` image.

## Project Structure

```
src/
  auth/          OAuth + MCP route auth (JWT or shared secret)
  config/        environment, scopes
  mcp/
    handler.ts   JSON-RPC (initialize, tools/*, resources/*, prompts/*)
    tools/       one file per tool + aliases.ts + index.ts
    guard.ts     50-row / 25 KB response guard
    privacy.ts   user field whitelist + recursive redaction
    context.ts   cached org/people lookups
  tanda/         read-only client (ETag cache, rate limiter, 7-day chunking)
  utils/         logger, time (unix seconds <-> America/New_York)
scripts/smoke.mjs
```

See [CHANGELOG-v4.0.md](CHANGELOG-v4.0.md) and [DEPLOYMENT.md](DEPLOYMENT.md).
