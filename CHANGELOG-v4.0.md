# Tanda MCP Server v4.0.0 - Context Window Optimization

**Deployed:** 2026-03-02  
**Goal:** Fix context window explosion for Claude.ai users

## Summary

Consolidated 44 individual tools into 9 grouped tools with action parameters, reducing context window usage by ~80%.

## Tool Consolidation (44 → 9)

| New Tool | Actions | Replaces |
|----------|---------|----------|
| `tanda_users` | list, get, inactive, onboard, invite, by_department, current | 7 user tools |
| `tanda_schedules` | list, get, create, update, delete, publish | 5 schedule tools |
| `tanda_timesheets` | shifts, timesheets, approve_shift, approve_timesheet, breaks | 5 timesheet tools |
| `tanda_leave` | list, create, approve, decline, delete, balances, types, calculate_hours | 8 leave tools |
| `tanda_rosters` | get, current, by_date | 3 roster tools |
| `tanda_reference` | departments, locations, teams, daily_stats | 4 reference tools |
| `tanda_realtime` | active_shifts, clocked_in, shift_limits, award_interpretation, roster_costs | 5 real-time tools |
| `tanda_unavailability` | list, create, delete | 3 unavailability tools |
| `tanda_supervisors` | detect_overlaps, evening_coverage, recommendations, optimize, validate, create_optimized | 6 supervisor tools |

## New Features

### Response Pagination
All list operations now support:
```json
{
  "limit": 50,   // Max records (default 50, max 200)
  "page": 1     // Page number
}
```

Response includes pagination metadata:
```json
{
  "data": [...],
  "pagination": {
    "page": 1,
    "limit": 50,
    "total": 150,
    "hasMore": true
  }
}
```

### Date Range Validation
Maximum 14-day range enforced on all date-based queries:
```json
// Returns error:
{ "from": "2026-01-01", "to": "2026-02-01" }
// Error: "Max 14-day range per query. Split into smaller chunks."
```

### MCP_LITE_MODE
New environment variable for simple use cases. When `MCP_LITE_MODE=true`, only 6 essential tools are exposed:
- tanda_users
- tanda_schedules
- tanda_reference
- tanda_timesheets
- tanda_leave
- tanda_realtime

### Shortened Descriptions
All tool descriptions now < 150 characters for reduced context usage.

## Migration Guide

### Before (v3.x)
```javascript
// Old: 44 separate tools
tanda_get_users({ active: true })
tanda_get_user({ user_id: 123 })
tanda_get_inactive_users()
tanda_onboard_users({ users: [...] })
```

### After (v4.0)
```javascript
// New: 1 tool with action parameter
tanda_users({ action: "list", active: true })
tanda_users({ action: "get", user_id: 123 })
tanda_users({ action: "inactive" })
tanda_users({ action: "onboard", users: [...] })
```

## Deployment

- **Repository:** https://github.com/hakeemrabiuDFW/Tanda-Workforce-MCP-Server
- **Railway:** Auto-deploys on push to main
- **Health Check:** GET /health

## Test Results

| Test | Status |
|------|--------|
| Build (tsc) | ✅ Pass |
| Initialize endpoint | ✅ Pass |
| Tool definitions | ✅ Correct |
| Prompts updated | ✅ v4.0 tool names |
| Integration tests | ⚠️ Require auth (expected) |

## Files Changed

- `src/mcp/tools.ts` - Consolidated tool definitions + execution handlers
- `src/mcp/handler.ts` - Updated prompts with v4.0 tool references
- `src/config/environment.ts` - Added MCP_LITE_MODE, updated version to 4.0.0
- `package.json` - Version bump to 4.0.0
- `tests/mcp.test.ts` - Updated for v4.0 tool structure
