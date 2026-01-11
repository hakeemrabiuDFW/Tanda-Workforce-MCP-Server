# Tanda Workforce MCP Server - Product Requirements Document

> **Ralph Workflow Compatible** - Ready for autonomous deployment via `ralph-import`

## Overview

| Field | Value |
|-------|-------|
| **Project** | Tanda Workforce MCP Server |
| **Version** | 3.0.0 |
| **Target API** | Tanda/Workforce.com API |
| **OAuth Scopes** | `me`, `user`, `department`, `leave`, `roster`, `timesheet`, `cost` |
| **Estimated Tools** | 38 tools |
| **Priority** | P0 (Critical) |

### Problem Statement

Workforce managers need Claude to help with time & attendance tracking, shift scheduling, leave management, and team oversight. This MCP server enables Claude to interact with Tanda (Workforce.com), making workforce management conversational - from checking who's clocked in right now to approving timesheets and managing leave requests.

### Success Criteria

- [x] All P0 tools implemented and tested (38 tools)
- [x] OAuth2 authentication working with Tanda
- [x] Deployed to Railway with auto-scaling
- [x] Claude can manage schedules, leave, timesheets, and real-time attendance

---

## Technical Requirements

### Stack

```
Runtime:     Node.js 18+
Language:    TypeScript 5.3+
Framework:   Express 4.18+
Auth:        OAuth2 (Tanda doesn't require PKCE)
Validation:  Zod
Logging:     Winston
Testing:     Jest
Deployment:  Docker / Railway
```

### API Integration

| Requirement | Details |
|-------------|---------|
| Base URL | `https://my.tanda.co/api/v2` |
| Auth Type | OAuth2 Bearer Token |
| Rate Limits | Standard API limits |
| Scopes Required | `me`, `user`, `department`, `leave`, `roster`, `timesheet`, `cost` |

### OAuth Endpoints (Tanda)

| Endpoint | URL |
|----------|-----|
| Authorization | `https://my.tanda.co/api/oauth/authorize` |
| Token | `https://my.tanda.co/api/oauth/token` |
| Revoke | `https://my.tanda.co/api/oauth/revoke` |

---

## Feature Specification

### Phase 1: Core Infrastructure (P0)

#### F1.1 - OAuth2 Authentication
```
Priority: P0
Complexity: High
Dependencies: None
```

**Requirements:**
- [x] OAuth2 authorization code flow
- [x] Token storage with automatic refresh
- [x] Session management with express-session
- [x] `.well-known/oauth-authorization-server` endpoint

**Acceptance Criteria:**
- User can authenticate via browser redirect to Tanda
- Tokens refresh automatically before 2-hour expiry
- Session persists across server restarts

---

#### F1.2 - MCP Protocol Handler
```
Priority: P0
Complexity: Medium
Dependencies: F1.1
```

**Requirements:**
- [x] JSON-RPC 2.0 handler with SSE transport
- [x] Read-only mode support (`MCP_READ_ONLY_MODE=true`)
- [x] Proper error mapping from Tanda API errors
- [x] Write tool protection (14 tools blocked in read-only mode)

**Acceptance Criteria:**
- Claude Desktop connects successfully via SSE
- All MCP methods respond correctly
- Write operations blocked when read-only enabled

---

### Phase 2: Tool Categories

> **Naming Convention:** `tanda_[action]_[resource]`

#### Category: User Management (6 tools)

| Tool Name | Description | Priority | Write? |
|-----------|-------------|----------|--------|
| `tanda_get_current_user` | Get authenticated user profile | P0 | No |
| `tanda_get_users` | List all employees with filters | P0 | No |
| `tanda_get_user` | Get specific user by ID | P0 | No |
| `tanda_get_inactive_users` | Get terminated employees | P0 | No |
| `tanda_onboard_users` | Bulk staff onboarding | P0 | Yes |
| `tanda_invite_user` | Send app invitation | P1 | Yes |

**Tool Schema - tanda_get_users:**
```typescript
{
  name: 'tanda_get_users',
  description: 'Get a list of all users/employees in the Tanda organization',
  inputSchema: {
    type: 'object',
    properties: {
      active: {
        type: 'boolean',
        description: 'Filter by active status (true for active users only)'
      },
      department_ids: {
        type: 'array',
        items: { type: 'number' },
        description: 'Filter by department IDs'
      }
    }
  }
}
```

---

#### Category: Real-time Attendance (4 tools)

| Tool Name | Description | Priority | Write? |
|-----------|-------------|----------|--------|
| `tanda_get_active_shifts` | Who is currently working | P0 | No |
| `tanda_get_clocked_in_users` | Currently clocked-in staff | P0 | No |
| `tanda_get_shift_breaks` | Break compliance tracking | P0 | No |
| `tanda_get_shift_limits` | Hour limit warnings | P0 | No |

**Tool Schema - tanda_get_active_shifts:**
```typescript
{
  name: 'tanda_get_active_shifts',
  description: 'Get currently active shifts - shows who is currently working in real-time',
  inputSchema: {
    type: 'object',
    properties: {}
  }
}
```

---

#### Category: Scheduling (5 tools)

| Tool Name | Description | Priority | Write? |
|-----------|-------------|----------|--------|
| `tanda_get_schedules` | Get scheduled shifts for date range | P0 | No |
| `tanda_create_schedule` | Create new scheduled shift | P0 | Yes |
| `tanda_update_schedule` | Update existing shift | P0 | Yes |
| `tanda_delete_schedule` | Delete scheduled shift | P0 | Yes |
| `tanda_publish_schedules` | Publish rosters to staff | P0 | Yes |

**Tool Schema - tanda_create_schedule:**
```typescript
{
  name: 'tanda_create_schedule',
  description: 'Create a new scheduled shift for an employee',
  inputSchema: {
    type: 'object',
    properties: {
      user_id: {
        type: 'number',
        description: 'The user ID to assign the shift to'
      },
      department_id: {
        type: 'number',
        description: 'The department ID for the shift'
      },
      start: {
        type: 'string',
        description: 'Shift start time in ISO 8601 format'
      },
      finish: {
        type: 'string',
        description: 'Shift end time in ISO 8601 format'
      },
      notes: {
        type: 'string',
        description: 'Optional notes for the shift'
      }
    },
    required: ['start', 'finish']
  }
}
```

---

#### Category: Roster Periods (3 tools)

| Tool Name | Description | Priority | Write? |
|-----------|-------------|----------|--------|
| `tanda_get_roster` | Get roster period by ID | P0 | No |
| `tanda_get_current_roster` | Get current active roster | P0 | No |
| `tanda_get_roster_by_date` | Get roster containing date | P0 | No |

---

#### Category: Timesheets & Shifts (4 tools)

| Tool Name | Description | Priority | Write? |
|-----------|-------------|----------|--------|
| `tanda_get_shifts` | Get worked shifts for date range | P0 | No |
| `tanda_get_timesheets` | Get timesheets with approval status | P0 | No |
| `tanda_approve_shift` | Approve a specific shift | P0 | Yes |
| `tanda_approve_timesheet` | Approve a timesheet | P0 | Yes |

---

#### Category: Leave Management (8 tools)

| Tool Name | Description | Priority | Write? |
|-----------|-------------|----------|--------|
| `tanda_get_leave_requests` | Get leave requests with filters | P0 | No |
| `tanda_get_leave_balances` | Get leave balances for user | P0 | No |
| `tanda_get_leave_types` | Get available leave types | P0 | No |
| `tanda_calculate_leave_hours` | Calculate leave duration | P0 | No |
| `tanda_create_leave_request` | Create new leave request | P0 | Yes |
| `tanda_approve_leave` | Approve pending leave | P0 | Yes |
| `tanda_decline_leave` | Decline pending leave | P0 | Yes |
| `tanda_delete_leave_request` | Delete leave request | P1 | Yes |

**Tool Schema - tanda_create_leave_request:**
```typescript
{
  name: 'tanda_create_leave_request',
  description: 'Create a new leave request for an employee',
  inputSchema: {
    type: 'object',
    properties: {
      user_id: {
        type: 'number',
        description: 'The user ID requesting leave'
      },
      leave_type: {
        type: 'string',
        description: 'Type of leave (e.g., "annual", "sick", "personal")'
      },
      start: {
        type: 'string',
        description: 'Leave start date in YYYY-MM-DD format'
      },
      finish: {
        type: 'string',
        description: 'Leave end date in YYYY-MM-DD format'
      },
      hours: {
        type: 'number',
        description: 'Optional: specific hours if partial day'
      },
      reason: {
        type: 'string',
        description: 'Optional reason for leave'
      },
      status: {
        type: 'string',
        enum: ['pending', 'approved'],
        description: 'Leave request status (defaults to pending)'
      }
    },
    required: ['user_id', 'leave_type', 'start', 'finish']
  }
}
```

---

#### Category: Unavailability (3 tools)

| Tool Name | Description | Priority | Write? |
|-----------|-------------|----------|--------|
| `tanda_get_unavailability` | Get staff unavailability records | P0 | No |
| `tanda_create_unavailability` | Create unavailability record | P0 | Yes |
| `tanda_delete_unavailability` | Delete unavailability record | P0 | Yes |

---

#### Category: Organization (5 tools)

| Tool Name | Description | Priority | Write? |
|-----------|-------------|----------|--------|
| `tanda_get_departments` | Get all departments | P0 | No |
| `tanda_get_locations` | Get all locations/sites | P0 | No |
| `tanda_get_teams` | Get all teams/groups | P0 | No |
| `tanda_get_staff_by_department` | Get staff in department | P0 | No |
| `tanda_get_daily_stats` | Get workforce statistics | P0 | No |

---

#### Category: Costs & Reporting (2 tools)

| Tool Name | Description | Priority | Write? |
|-----------|-------------|----------|--------|
| `tanda_get_award_interpretation` | Get pay calculations | P0 | No |
| `tanda_get_roster_costs` | Get labor costs | P0 | No |

---

## API Coverage Matrix

### OAuth Scopes → Tool Mapping

| Scope | Description | Tools |
|-------|-------------|-------|
| `me` | Current user access | 1 tool |
| `user` | Employee management | 6 tools |
| `department` | Organization structure | 5 tools |
| `roster` | Scheduling | 8 tools |
| `timesheet` | Time tracking | 8 tools |
| `leave` | Leave management | 8 tools |
| `cost` | Financial data | 2 tools |

### Fit-Gap Analysis

| Tanda Entity | Status | Tools | Priority |
|--------------|--------|-------|----------|
| Users | Full | 6 | P0 |
| Schedules | Full | 5 | P0 |
| Rosters | Full | 3 | P0 |
| Shifts/Timesheets | Full | 4 | P0 |
| Leave | Full | 8 | P0 |
| Unavailability | Full | 3 | P0 |
| Real-time Attendance | Full | 4 | P0 |
| Departments/Locations | Full | 5 | P0 |
| Costs | Full | 2 | P0 |

---

## Deployment Requirements

### Environment Variables

```bash
# Server
PORT=3000
NODE_ENV=production

# Tanda OAuth (from my.tanda.co developer settings)
TANDA_CLIENT_ID=your_client_id
TANDA_CLIENT_SECRET=your_client_secret
TANDA_REDIRECT_URI=https://your-domain.com/auth/callback

# Security (generate with: openssl rand -base64 32)
SESSION_SECRET=your_session_secret_min_32_chars
JWT_SECRET=your_jwt_secret_min_32_chars

# Optional
MCP_READ_ONLY_MODE=false
LOG_LEVEL=info
```

### Railway Configuration

```bash
# Auto-detected
RAILWAY_PUBLIC_DOMAIN  # For OAuth redirect
RAILWAY_ENVIRONMENT    # Sets NODE_ENV

# Required secrets (set in Railway dashboard)
TANDA_CLIENT_ID
TANDA_CLIENT_SECRET
SESSION_SECRET
JWT_SECRET
```

---

## Test Scenarios

### Workflow 1: Real-time Attendance Check

```markdown
**Scenario:** Manager asks "Who's working right now?"

**Steps:**
1. Claude calls `tanda_get_active_shifts` for current shifts
2. Claude calls `tanda_get_clocked_in_users` for confirmation
3. Claude presents real-time attendance summary

**Expected Result:** List of currently working employees with shift details

**Validation:** Compare with Tanda dashboard live view
```

### Workflow 2: Schedule an Employee

```markdown
**Scenario:** Manager says "Schedule John for tomorrow 9am-5pm"

**Steps:**
1. Claude calls `tanda_get_users` to find John's user ID
2. Claude calls `tanda_get_departments` to confirm department
3. Claude calls `tanda_create_schedule` with shift details
4. Claude calls `tanda_publish_schedules` to notify John

**Expected Result:** Shift created and published, John receives notification

**Validation:** Check Tanda roster view for new shift
```

### Workflow 3: Process Leave Request

```markdown
**Scenario:** Manager says "Show me pending leave requests and approve Sarah's"

**Steps:**
1. Claude calls `tanda_get_leave_requests` with status='pending'
2. Claude presents pending requests to manager
3. Claude calls `tanda_approve_leave` for Sarah's request
4. Claude confirms approval

**Expected Result:** Leave request approved, Sarah notified

**Validation:** Check leave request status in Tanda
```

### Workflow 4: Weekly Timesheet Approval

```markdown
**Scenario:** Manager says "Show me timesheets for last week that need approval"

**Steps:**
1. Claude calls `tanda_get_current_roster` to get date range
2. Claude calls `tanda_get_timesheets` with approved=false
3. Claude presents unapproved timesheets with hours
4. Manager approves, Claude calls `tanda_approve_timesheet` for each

**Expected Result:** All selected timesheets approved

**Validation:** Check timesheet status in Tanda
```

### Workflow 5: Bulk Staff Onboarding

```markdown
**Scenario:** HR says "Onboard these 5 new hires and add them to the Warehouse team"

**Steps:**
1. Claude calls `tanda_get_departments` to find Warehouse ID
2. Claude calls `tanda_onboard_users` with user array and department_ids
3. Claude confirms each user created and invited

**Expected Result:** 5 new users created with app invitations sent

**Validation:** Check Tanda user list for new employees
```

---

## Task Breakdown for @fix_plan.md

### Infrastructure Tasks

```
- [x] [P0] Initialize TypeScript project with Express
- [x] [P0] Configure Zod environment validation with Tanda variables
- [x] [P0] Implement OAuth2 flow for Tanda
- [x] [P0] Create MCP JSON-RPC handler with SSE
- [x] [P0] Set up Winston logging
- [x] [P0] Implement read-only mode with WRITE_TOOLS set
- [x] [P1] Add rate limiting
- [x] [P1] Configure Helmet security headers
- [x] [P1] Add token refresh interceptor
```

### API Client Tasks

```
- [x] [P0] Create TandaClient class with axios
- [x] [P0] Add request interceptor for Bearer token
- [x] [P0] Add error handling with TandaApiError class
- [x] [P0] Implement automatic token refresh on 401
```

### Tool Implementation Tasks - User Management

```
- [x] [P0] Implement tanda_get_current_user tool
- [x] [P0] Implement tanda_get_users tool
- [x] [P0] Implement tanda_get_user tool
- [x] [P0] Implement tanda_get_inactive_users tool
- [x] [P0] Implement tanda_onboard_users tool
- [x] [P1] Implement tanda_invite_user tool
```

### Tool Implementation Tasks - Real-time Attendance

```
- [x] [P0] Implement tanda_get_active_shifts tool
- [x] [P0] Implement tanda_get_clocked_in_users tool
- [x] [P0] Implement tanda_get_shift_breaks tool
- [x] [P0] Implement tanda_get_shift_limits tool
```

### Tool Implementation Tasks - Scheduling

```
- [x] [P0] Implement tanda_get_schedules tool
- [x] [P0] Implement tanda_create_schedule tool
- [x] [P0] Implement tanda_update_schedule tool
- [x] [P0] Implement tanda_delete_schedule tool
- [x] [P0] Implement tanda_publish_schedules tool
```

### Tool Implementation Tasks - Rosters

```
- [x] [P0] Implement tanda_get_roster tool
- [x] [P0] Implement tanda_get_current_roster tool
- [x] [P0] Implement tanda_get_roster_by_date tool
```

### Tool Implementation Tasks - Timesheets

```
- [x] [P0] Implement tanda_get_shifts tool
- [x] [P0] Implement tanda_get_timesheets tool
- [x] [P0] Implement tanda_approve_shift tool
- [x] [P0] Implement tanda_approve_timesheet tool
```

### Tool Implementation Tasks - Leave

```
- [x] [P0] Implement tanda_get_leave_requests tool
- [x] [P0] Implement tanda_get_leave_balances tool
- [x] [P0] Implement tanda_get_leave_types tool
- [x] [P0] Implement tanda_calculate_leave_hours tool
- [x] [P0] Implement tanda_create_leave_request tool
- [x] [P0] Implement tanda_approve_leave tool
- [x] [P0] Implement tanda_decline_leave tool
- [x] [P1] Implement tanda_delete_leave_request tool
```

### Tool Implementation Tasks - Organization

```
- [x] [P0] Implement tanda_get_departments tool
- [x] [P0] Implement tanda_get_locations tool
- [x] [P0] Implement tanda_get_teams tool
- [x] [P0] Implement tanda_get_staff_by_department tool
- [x] [P0] Implement tanda_get_daily_stats tool
```

### Tool Implementation Tasks - Other

```
- [x] [P0] Implement tanda_get_unavailability tool
- [x] [P0] Implement tanda_create_unavailability tool
- [x] [P0] Implement tanda_delete_unavailability tool
- [x] [P0] Implement tanda_get_award_interpretation tool
- [x] [P0] Implement tanda_get_roster_costs tool
```

### Testing Tasks

```
- [x] [P1] Write unit tests for TandaClient
- [x] [P1] Write integration tests for OAuth flow
- [x] [P1] Create tool execution test suite
- [x] [P1] Test with live Tanda account
- [x] [P2] Add end-to-end workflow tests
```

### Documentation Tasks

```
- [x] [P1] Write README with OAuth setup guide
- [x] [P1] Document all environment variables
- [x] [P1] Add Tanda developer portal setup instructions
- [x] [P1] Create Railway deployment guide (DEPLOYMENT.md)
- [x] [P1] Add FIT_GAP_ANALYSIS.md
- [x] [P1] Create Claude AI test cases documentation
```

---

## Tanda API Reference

### Common Entities

```typescript
interface TandaUser {
  id: number;
  name: string;
  email: string;
  phone?: string;
  photo?: string;
  department_ids: number[];
  active: boolean;
  employment_start_date?: string;
  hourly_rate?: number;
}

interface TandaSchedule {
  id: number;
  user_id: number;
  department_id: number;
  start: string;  // ISO 8601
  finish: string; // ISO 8601
  breaks?: TandaBreak[];
  notes?: string;
  published: boolean;
}

interface TandaShift {
  id: number;
  user_id: number;
  department_id: number;
  start: string;
  finish: string;
  breaks: TandaBreak[];
  approved: boolean;
  cost?: number;
}

interface TandaLeaveRequest {
  id: number;
  user_id: number;
  leave_type: string;
  start: string;
  finish: string;
  hours: number;
  status: 'pending' | 'approved' | 'declined';
  reason?: string;
}

interface TandaTimesheet {
  id: number;
  user_id: number;
  roster_id: number;
  start: string;
  finish: string;
  shifts: TandaShift[];
  approved: boolean;
  total_hours: number;
  total_cost?: number;
}
```

### Error Codes

| Code | Meaning | Action |
|------|---------|--------|
| 401 | Invalid/expired token | Refresh token |
| 403 | Insufficient scope | Check OAuth scopes |
| 404 | Resource not found | Verify ID exists |
| 422 | Validation error | Check request format |
| 429 | Rate limited | Retry with backoff |
| 500 | Tanda server error | Retry later |

---

## Write Tools (Blocked in Read-Only Mode)

These 14 tools are blocked when `MCP_READ_ONLY_MODE=true`:

```typescript
const WRITE_TOOLS = new Set([
  'tanda_create_schedule',
  'tanda_update_schedule',
  'tanda_delete_schedule',
  'tanda_publish_schedules',
  'tanda_approve_shift',
  'tanda_approve_timesheet',
  'tanda_create_leave_request',
  'tanda_approve_leave',
  'tanda_decline_leave',
  'tanda_delete_leave_request',
  'tanda_create_unavailability',
  'tanda_delete_unavailability',
  'tanda_onboard_users',
  'tanda_invite_user',
]);
```

---

## Appendix

### Tanda Developer Setup

1. Log into your Tanda account at https://my.tanda.co
2. Navigate to Settings → Integrations → API
3. Create a new OAuth application
4. Configure redirect URI for your deployment
5. Note Client ID and Client Secret

### Version History

| Version | Date | Changes |
|---------|------|---------|
| 1.0.0 | Initial | Core tools (27 tools) |
| 2.0.0 | - | Added real-time attendance, roster periods |
| 3.0.0 | Current | 38 tools, v3.0 enhancements |

---

*Generated for Ralph Claude Code workflow - Tanda MCP Server v3.0*
