# Tanda Workforce MCP Server v4.0.1

A read-only MCP (Model Context Protocol) server for the Tanda / Workforce.com API, with four guarded exceptions: creating employees, deactivating them, updating their pay rate and similar fields, and approving timesheets. It exposes 13 consolidated read tools and two read-only staffing apps (interactive MCP App views), plus four write tools (`tanda_create_user`, `tanda_deactivate_user`, `tanda_update_user`, `tanda_approve_timesheets`) when `TANDA_WRITES_ENABLED=true`. Every tool is privacy-filtered and returns at most 25 KB, so assistants like Claude can answer workforce questions without overflowing their context.

## Security

- **Auth on every MCP route.** `POST /mcp`, `GET /mcp` and `POST /` require an OAuth JWT or `Authorization: Bearer <MCP_SHARED_SECRET>`. Unauthenticated calls get `401`.
- **Read-only, with four guarded exceptions.** The Tanda client refuses any non-GET request except `POST /users`, `POST /users/{id}/invite`, `DELETE /users/{id}`, `PUT /users/{id}`, `PUT /timesheets/{id}` and `PUT /shifts/{id}`, and refuses those too unless `TANDA_WRITES_ENABLED=true` (off by default).
- **Least-privilege scopes.** The server requests `me roster timesheet department user cost leave`. It never requests `financial` or `personal`. `unavailability` is off by default because Workforce.com's OAuth fails when it is requested; add it to `TANDA_SCOPES` only if your OAuth app supports it.
- **Privacy by default.** User records are whitelisted, and `date_of_birth`, `phone`, `email`, `legal_*` and `hourly_rate` are returned only when the `fields` parameter names them. `passcode`, `tax_*`, `bank_*` and `super_*` are never returned.
- **Inside Tanda's rate limit.** Every tool shares one budget of 90 Tanda requests per rolling minute (Tanda allows 100). A `429` is retried up to 3 times (Tanda's `Retry-After`, else 2s, 4s, 8s). If it still fails, a check that can fail soft returns a `warnings` entry with `rate_limited: true` instead of failing the tool. Sites and teams are cached for 24 hours, and so are people, except that a user write clears the people cache straight away.

See [docs/SECURITY.md](docs/SECURITY.md).

Which Tanda identity each write tool may run as is set by [ADR 0001](docs/adr/0001-write-tool-identity.md).

## Tools (14)

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
| `tanda_exceptions` | Audit list: shifts open more than 12h, zero-length shifts, `micro_shift` (shifts under `MIN_SHIFT_MINUTES`, default 5, or `min_shift_minutes`; each row has `seconds`, `device_match`, `likely_accidental_clockout` for a same-device clock-out within 60s, and the change-history `created_by` / `last_changed_by` for the first 10. Device data needs the `device` scope; without it the check warns once and judges by duration alone), pending leave already in the past, unapproved timesheet $ by site, active staff with no award template, calendar workweeks over 40h, and `projected_over_40` for the current week (worked + still rostered). Weekly checks echo `week_basis` and each week's range. Unapproved cost is reported for the window (`window_unapproved_cost`) and for every pay period that has ended or is current (`all_open_periods_unapproved_cost`, `pending_open_periods`; looks back `OPEN_PERIOD_LOOKBACK_DAYS`, default 42). |
| `tanda_export_preview` | Payroll export preview with `approved_only=true` and a hard-coded `skip_status_update=true`. Returns row count, totals and rows missing a pay code. Never returns the raw file. |
| `tanda_change_history` | Version history from `/shifts/{id}/versions` or `/schedules/{id}/versions`. |
| `tanda_data_audit` | Data-quality audit in one call (at most 12 Tanda reads). For each check, a count plus up to 20 sample ids: active staff with no award template, no `position_title`, or no shifts in the last `days` (default 14, max 35); sites with worked hours but $0 cost, or a cost per worked hour below `min_effective_rate` (default `MIN_EFFECTIVE_RATE`, 16.00); Supervisor-department staff who are in `COVERAGE_EXCLUDE_USER_IDS` or lack the `employee` level (the `tanda_coverage` rule); and pending leave whose start date has passed (looks back 28 days). Bookkeeping sites are left out. Each check fails soft: a missing scope sets that check's `count` to `null` and adds a `warnings` entry. Nothing is written. |
| `tanda_pay_periods` | Current and prior pay periods (`prior_periods`, default 1, max 4) from `PAY_CALENDAR`, including the biweekly-to-weekly cutover (last biweekly period 2026-12-14..2026-12-27, first weekly 2026-12-28..2027-01-03), plus the next period and any `cadence_changes`. Each period row has a pending / approved / exported rollup with timesheets, hours and $ by status, and `unapproved_cost`. Warns (`tanda_period_alignment`) when Tanda's own timesheet periods don't match the calendar, and (`pay_calendar`) when `PAY_CALENDAR` is malformed. Nothing is written. |

### Staffing apps (`conversation_to_site_schedule`, `staff_allocation_board`)

Two read-only tools that render an interactive view in hosts that support [MCP Apps](https://github.com/modelcontextprotocol/ext-apps) (Claude does). Each returns a plain-text summary in `content` and the data in `structuredContent`; a host without MCP Apps still gets the summary. They only `GET` `/locations`, `/departments`, `/users` and `/schedules`. Nothing is written to Tanda, no shift is published and nobody is notified.

| Tool | Returns / when to use |
|------|----------------------|
| `conversation_to_site_schedule` | A draft weekly plan for a site from the fields of a client conversation: days, start and end time, cleaners per shift, supervisor checks, weekly and monthly labor hours, the Tanda site it matches by name, and suggested cleaners, supervisor and trainer. `route_location` carries the matching Route location when the assistant looked it up with a Route connector (this server cannot reach Route). |
| `staff_allocation_board` | A board of supervisors, trainers, cleaners and trainees to assign to a site, with a suggested team. `sort_by` (`load`, `tenure`, `name`) and `min_tenure_months` order and filter it; the view has the same controls. |

How people are described and chosen:

- **Tenure** is whole years and months since `employment_start_date`, shown on every person as `tenure` (`years`, `months`, `total_months`) and `tenure_label` (for example `3y 2m`). Someone with no start date has `tenure: null` and is never counted as experienced.
- **Load** is the hours rostered for the whole target workweek (`WORKWEEK_START`), read from every shift in that week, not one day or one page. The week is the one containing `week_of`, or the one containing tomorrow.
- **Supervisor**: on the staff list of a `Supervisor`/`Supervisors` department, or with a user level containing `manager` or `supervisor`. `COVERAGE_EXCLUDE_USER_IDS` are left out.
- **Trainer**: the users in `TRAINER_USER_IDS` when it is set, otherwise staff of an `Ambassador` or `TRAINING` department; either way only those with 12 or more months of tenure.
- **Trainee**: under 3 months of tenure. Everyone else is a **cleaner**.
- **Left out of every list**: people whose only site is `Administrative Office` (unless listed in `STAFFING_OFFICE_ALLOW_USER_IDS`), and test users (name starting `ZZ ` or `Test `) or anyone with no `employment_start_date`. `warnings` says how many were left out.
- **Suggestions**: the lowest load first, and people the new site would push past 40 hours last. The first cleaner is the **lead** and has 12 or more months of tenure when anyone does. The trainer always has 12 or more months: a `TRAINER_USER_IDS` person with less is left off the trainer list and named in `warnings`. A site that already exists in Tanda gets no trainer in `conversation_to_site_schedule`.
- **Names** are first name plus last initial.

The views are served as `ui://tanda-workforce/schedule.html` and `ui://tanda-workforce/allocation.html` (`text/html;profile=mcp-app`). They contain no Tanda data, load nothing from the network (their CSP declares no domains) and need the same auth as every other MCP method.

### Creating employees (`tanda_create_user`, off by default)

Only listed and callable when `TANDA_WRITES_ENABLED=true`. It creates a plain employee (`POST /users`, `user` scope) in two calls:

1. Call with `name`, `email` and optionally `phone`, `employment_start_date`, `department_ids`, `award_template_id` (default 42, or `TANDA_DEFAULT_AWARD_TEMPLATE_ID`), `send_invite` and `source_ref` (e.g. the Monday item id). Nothing is created. The response is `status: "preview"` with the exact `payload` and a `confirm_token` valid for 15 minutes. Add `fields: ["email","phone"]` to see those in the preview.
2. Call again with the same arguments plus `confirm_token`. The response is `status: "created"` with `user_id`, the user as `tanda_people` returns it, and `invite` (`not_requested`, `sent` or `failed`; a failed invite is a warning, not an error).

The token is bound to the arguments and to the Tanda identity that asked for the preview. Changed arguments, another identity or an expired token are refused. Both calls first check for duplicates among active and inactive users. A user with the same email, or with the same name and start date, returns `status: "exists"` with `existing_user_id` and `active`, and creates nothing. Tanda hides an inactive user's email (it comes back `null`) but still refuses to create a second user with it, so an inactive user with the same name and a hidden email also returns `exists` (`matched_on: "name_inactive"`). Rehire that person in Tanda, or pass `not_a_rehire: true` if it is someone else. The tool never reactivates anyone. Unknown `department_ids` are refused. Only the `employee` level can be set, and date of birth, passcode, tax, bank and role fields are never sent. `hourly_rate` (above 0, at most 100; needs the `cost` scope) is optional, but without it the user's timesheets cost $0, so the preview warns when it's missing. The preview only says `pay_rate_set: true`; the value is never echoed. Each creation is logged with the new user id, the caller's Tanda user id and `source_ref`. Calls made with the shared server token (scheduled tasks) must pass `source_ref`; see [ADR 0001](docs/adr/0001-write-tool-identity.md).

### Deactivating employees (`tanda_deactivate_user`, off by default)

Tanda's `DELETE /users/{id}` does not erase anyone. It marks the user inactive, and Tanda's rehire reverses it. Use this tool to remove test hires and leavers from the active, billed headcount. It works in the same two steps as `tanda_create_user`: call with `user_id` (plus `source_ref`, which is required under the shared server token; see [ADR 0001](docs/adr/0001-write-tool-identity.md)) to preview the user and get a `confirm_token`, then repeat the call with the token. An inactive user returns `status: "already_inactive"`. The tool refuses anyone with a level other than `employee`, and it refuses the caller's own account; it fails closed if the caller can't be identified. Each deactivation is logged with the user id, the caller and `source_ref`.

### Updating employees (`tanda_update_user`, off by default)

Sets `hourly_rate`, `award_template_id`, `employment_start_date`, `department_ids` (replaces the user's teams) or `employee_id` through Tanda's `PUT /users/{id}`. No other field can be sent. Use it to backfill pay rates for staff created without one: `tanda_exceptions` lists them under `missing_pay_rate`. Pass one user (`user_id` plus fields) or up to 50 in `updates: [{user_id, hourly_rate, ...}]`. The first call returns a before/after diff per user and a `confirm_token`. Repeat the call with the token to apply it. Each user's outcome is reported as `updated`, `not_applied` (Tanda kept the old value), `failed`, `unchanged` or `refused`. Rates must be above 0 and at most 100, and a change of more than 25% against the current rate is flagged in the preview. The tool refuses managers, admins, inactive users and the caller, and fails closed if the caller can't be identified. Rates in the diff show as `hidden` unless the call passes `show_wages: true` or `fields: ["hourly_rate"]`, the same opt-in as `tanda_people`, and current rates are visible only with the `cost` scope. Each update is logged with the user id, the changed field names, the caller and `source_ref`, which is required under the shared server token ([ADR 0001](docs/adr/0001-write-tool-identity.md)).

### Approving timesheets (`tanda_approve_timesheets`, off by default)

Approves Tanda timesheets for a pay period, or returns them to pending (`action: "unapprove"`). Applying needs a person's own Tanda login, so Tanda's history always shows who approved. The shared server token (`MCP_SHARED_SECRET` + `TANDA_ACCESS_TOKEN`) can only preview: it gets no `confirm_token`, and an apply is refused. The staging release gate uses that preview ([ADR 0001](docs/adr/0001-write-tool-identity.md)).

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
| `TRAINER_USER_IDS` | no | Comma-separated Tanda user ids who may train at a new site (`conversation_to_site_schedule`, `staff_allocation_board`). Unset: Ambassador/TRAINING department staff with 12+ months of tenure |
| `STAFFING_OFFICE_ALLOW_USER_IDS` | no | Comma-separated Tanda user ids of office-only staff (`Administrative Office`) who may still be suggested by the staffing apps, e.g. operations staff who do site checks. Unset: office-only staff are left out |
| `WORKWEEK_START` | no | First day of the overtime workweek (`SUN`…`SAT`). Default `MON` |
| `MIN_EFFECTIVE_RATE` | no | `tanda_data_audit` flags sites whose cost per worked hour is below this. Default 16.00 |
| `OPEN_PERIOD_LOOKBACK_DAYS` | no | How far back `tanda_exceptions` looks for still-pending pay periods. Default 42 |
| `MIN_SHIFT_MINUTES` | no | `tanda_exceptions` flags finished shifts shorter than this as `micro_shift`. Default 5 |
| `PAY_CALENDAR` | no | Pay period segments for `tanda_pay_periods`, as comma-separated `first-period-start:days`. Default `2026-12-14:14,2026-12-28:7` (biweekly until 2026-12-27, then weekly). Each segment runs until the next starts; dates before the first extrapolate back with its length |
| `TANDA_BOOKKEEPING_LOCATION_IDS` | no | Default `281737,301754,396358` |
| `TANDA_RATE_LIMIT_PER_MIN` | no | Client-side limit per rolling minute, shared by every tool, default 90 (Tanda allows 100/min shared across password tokens) |
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
npx playwright install chromium   # once: the MCP App view tests render the pages headless
npm test          # unit + integration tests (Tanda stubbed; includes an 84-site / 70-user size check)
npm run build
MCP_URL=https://your-domain.com/mcp MCP_TOKEN=<secret> npm run smoke [from] [to]
MCP_URL=https://your-domain.com/mcp MCP_TOKEN=<secret> npm run smoke:writes
```

`npm run smoke` calls all 13 read tools and the two staffing apps against a running server and prints only the shape and size of each response (no row values). It exits non-zero if a tool errors, exceeds 25 KB, or returns `date_of_birth`/`passcode`.

`npm run smoke:writes` exercises every write tool with the shared secret. Each run creates its own test hire ("ZZ MCP Smoke <run id>", `zz.mcp.smoke.<run id>@example.com`, no invite). It then checks that a duplicate is caught, updates and deactivates the hire, previews approval on an old pay period (`SMOKE_FROM`/`SMOKE_TO`), and checks that the shared token can't apply an approval. It prints step results only. The hire always ends inactive, even when a step fails, so it never counts towards the billed headcount. Each run leaves one inactive test user, because Tanda refuses to reuse an email even for an inactive user.

## Releasing

Changes reach production through `staging` first:

1. Open a pull request into `staging`. CI runs typecheck, tests and build.
2. Merge it. **Build and deploy** (`.github/workflows/deploy.yml`) tests again, pushes the image as `:staging` and `:<commit>`, redeploys the `tanda-mcp-stage` Railway service, and waits until its `/health` reports the new commit.
3. Check staging (`https://tanda-mcp-stage-production.up.railway.app`) with `npm run smoke` and `npm run smoke:writes`.
4. **Hard requirement:** the **Staging gate** check (`.github/workflows/staging-gate.yml`) must be green on the release pull request. It waits until staging serves the release commit, checks that auth is enforced, then runs both smoke tests against staging. It needs the `STAGING_MCP_TOKEN` repository secret (the staging `MCP_SHARED_SECRET`). Mark `staging-gate` as a required check for `main` in branch protection.
5. Merge the release pull request from `staging` into `main`. The **Release PR** workflow (`.github/workflows/release-pr.yml`) opens it as soon as `staging` has changes `main` lacks, lists the change PRs it carries, and keeps it updated; each release gets its own PR. Merging it ships `:production` to the production service.

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
