# Tanda Workforce MCP Server - Fit-Gap Analysis

## Executive Summary

This document analyzes the current MCP server tools against the Tanda/Workforce.com API capabilities, focusing on OAuth-supported endpoints only.

**OAuth Scopes Supported:** `me`, `user`, `department`, `leave`, `roster`, `timesheet`, `cost`

**Not Supported (removed in previous PRs):** `device`, `qualification`

---

## Current State: 27 Tools Implemented

| Category | Tool Count | Status |
|----------|------------|--------|
| User Management | 3 | Partial coverage |
| Organization (Dept/Location) | 2 | Partial coverage |
| Scheduling | 5 | Good coverage |
| Timesheets/Shifts | 4 | Partial coverage |
| Leave Management | 6 | Good coverage |
| Unavailability | 3 | Good coverage |
| Teams | 2 | Complete |
| Statistics/Costs | 3 | Partial coverage |

---

## Detailed Gap Analysis by OAuth Scope

### `me` Scope

| Endpoint | Method | Current Status | Priority |
|----------|--------|----------------|----------|
| `/users/me` | GET | ✅ IMPLEMENTED | - |

**Gap:** None - fully covered.

---

### `user` Scope

| Endpoint | Method | Current Status | Priority | Use Case |
|----------|--------|----------------|----------|----------|
| `/users` | GET | ✅ IMPLEMENTED | - | List employees |
| `/users/{id}` | GET | ✅ IMPLEMENTED | - | Get employee details |
| `/users/inactive` | GET | ❌ MISSING | HIGH | View terminated employees |
| `/users/{id}/invite` | POST | ❌ MISSING | MEDIUM | Send app invitation |
| `/users/onboarding` | POST | ❌ MISSING | **CRITICAL** | Bulk staff onboarding |
| `/users/clocked_in` | GET | ❌ MISSING | HIGH | Real-time attendance |
| `/users/{id}/versions` | GET | ❌ MISSING | LOW | Audit trail |
| `/user_pay_fields` | GET | ❌ MISSING | MEDIUM | Payroll fields |
| `/user_pay_fields/user/{user_id}` | GET | ❌ MISSING | MEDIUM | Employee pay details |
| `/award_tags` | GET | ❌ MISSING | LOW | Pay classification |

**Gaps to Address:**
1. `POST /users/onboarding` - **CRITICAL** for bulk staff import
2. `GET /users/inactive` - Important for HR reporting
3. `GET /users/clocked_in` - Real-time attendance visibility

---

### `roster` Scope

| Endpoint | Method | Current Status | Priority | Use Case |
|----------|--------|----------------|----------|----------|
| `/schedules` | GET | ✅ IMPLEMENTED | - | View schedules |
| `/schedules` | POST | ✅ IMPLEMENTED | - | Create schedule |
| `/schedules/{id}` | PUT | ✅ IMPLEMENTED | - | Update schedule |
| `/schedules/{id}` | DELETE | ✅ IMPLEMENTED | - | Delete schedule |
| `/schedules/publish` | POST | ✅ IMPLEMENTED | - | Publish rosters |
| `/rosters/{id}` | GET | ❌ MISSING | HIGH | Get roster period |
| `/rosters/current` | GET | ❌ MISSING | HIGH | Current roster period |
| `/rosters/on/{date}` | GET | ❌ MISSING | HIGH | Roster for specific date |
| `/schedules/{id}` | GET | ❌ MISSING | MEDIUM | Single schedule detail |
| `/schedules/{id}/versions` | GET | ❌ MISSING | LOW | Schedule audit |

**Gaps to Address:**
1. Roster period endpoints for better roster management
2. Single schedule retrieval for detailed views

---

### `timesheet` Scope

| Endpoint | Method | Current Status | Priority | Use Case |
|----------|--------|----------------|----------|----------|
| `/shifts` | GET | ✅ IMPLEMENTED | - | View worked shifts |
| `/shifts/{id}/approve` | POST | ✅ IMPLEMENTED | - | Approve shifts |
| `/timesheets/current` | GET | ✅ IMPLEMENTED | - | Current period |
| `/timesheets/{id}/approve` | POST | ✅ IMPLEMENTED | - | Approve timesheets |
| `/timesheets/for/{user_id}/current` | GET | ❌ MISSING | HIGH | Employee's current timesheet |
| `/timesheets/for/{user_id}/on/{date}` | GET | ❌ MISSING | HIGH | Employee timesheet by date |
| `/shifts/active` | GET | ❌ MISSING | **CRITICAL** | Who's currently working |
| `/shifts/{id}/breaks` | GET | ❌ MISSING | MEDIUM | Break compliance |
| `/shifts/limits` | GET | ❌ MISSING | MEDIUM | Hour limit warnings |
| `/shifts/{id}/applicable_allowances` | GET | ❌ MISSING | LOW | Pay allowances |

**Gaps to Address:**
1. `GET /shifts/active` - **CRITICAL** for real-time workforce visibility
2. Per-employee timesheet access for individual management
3. Break tracking for compliance

---

### `department` Scope

| Endpoint | Method | Current Status | Priority | Use Case |
|----------|--------|----------------|----------|----------|
| `/departments` | GET | ✅ IMPLEMENTED | - | List departments |
| `/locations` | GET | ✅ IMPLEMENTED | - | List locations |
| `/departments/{id}` | GET | ❌ MISSING | MEDIUM | Department details |
| `/locations/{id}` | GET | ❌ MISSING | MEDIUM | Location details |
| `/locations/{id}/versions` | GET | ❌ MISSING | LOW | Audit trail |

**Gaps to Address:**
1. Single entity retrieval for departments and locations

---

### `leave` Scope

| Endpoint | Method | Current Status | Priority | Use Case |
|----------|--------|----------------|----------|----------|
| `/leave` | GET | ✅ IMPLEMENTED | - | List leave requests |
| `/leave` | POST | ✅ IMPLEMENTED | - | Create leave |
| `/leave/{id}` | GET | ❌ MISSING | MEDIUM | Leave details |
| `/leave/{id}` | DELETE | ✅ IMPLEMENTED | - | Delete leave |
| `/leave/{id}/approve` | POST | ✅ IMPLEMENTED | - | Approve leave |
| `/leave/{id}/decline` | POST | ✅ IMPLEMENTED | - | Decline leave |
| `/leave_balances` | GET | ✅ IMPLEMENTED | - | Leave balances |
| `/leave/types_for/{user_id}` | GET | ❌ MISSING | HIGH | Available leave types |
| `/leave/hours_between` | GET | ❌ MISSING | MEDIUM | Calculate leave hours |
| `/leave_balances/{id}/predict` | GET | ❌ MISSING | MEDIUM | Forecast balances |
| `/leave_balances/user/{user_id}` | PUT | ❌ MISSING | LOW | Adjust balances |

**Gaps to Address:**
1. Leave types endpoint for proper leave request creation
2. Leave hours calculation for accurate requests

---

### `cost` Scope

| Endpoint | Method | Current Status | Priority | Use Case |
|----------|--------|----------------|----------|----------|
| `?show_costs=true` params | GET | ✅ IMPLEMENTED | - | Cost visibility |
| `?show_award_interpretation=true` | GET | ✅ IMPLEMENTED | - | Pay calculations |

**Gap:** None - cost parameters are supported on existing endpoints.

---

## Recommended New Tools (Priority Order)

### CRITICAL - Must Have

| Tool Name | API Endpoint | Description |
|-----------|--------------|-------------|
| `tanda_onboard_users` | POST /users/onboarding | Bulk staff import/onboarding |
| `tanda_get_active_shifts` | GET /shifts/active | Who's currently working |
| `tanda_get_clocked_in_users` | GET /users/clocked_in | Currently clocked-in staff |

### HIGH Priority

| Tool Name | API Endpoint | Description |
|-----------|--------------|-------------|
| `tanda_get_inactive_users` | GET /users/inactive | Terminated employees |
| `tanda_get_current_roster` | GET /rosters/current | Current roster period |
| `tanda_get_roster_by_date` | GET /rosters/on/{date} | Roster for specific date |
| `tanda_get_user_timesheet` | GET /timesheets/for/{user_id}/current | Employee's timesheet |
| `tanda_get_leave_types` | GET /leave/types_for/{user_id} | Available leave types |

### MEDIUM Priority

| Tool Name | API Endpoint | Description |
|-----------|--------------|-------------|
| `tanda_invite_user` | POST /users/{id}/invite | Send app invitation |
| `tanda_get_shift_breaks` | GET /shifts/{id}/breaks | Break compliance |
| `tanda_get_shift_limits` | GET /shifts/limits | Hour limit tracking |
| `tanda_calculate_leave_hours` | GET /leave/hours_between | Calculate leave duration |
| `tanda_predict_leave_balance` | GET /leave_balances/{id}/predict | Balance forecasting |
| `tanda_get_schedule` | GET /schedules/{id} | Single schedule detail |
| `tanda_get_department` | GET /departments/{id} | Department details |
| `tanda_get_location` | GET /locations/{id} | Location details |

---

## Management-Focused Read Tools for v2

Based on the use case (time & attendance, leave management, scheduling), here are the **15 recommended new read tools**:

### Time & Attendance (Real-time)
1. `tanda_get_active_shifts` - Who's currently working
2. `tanda_get_clocked_in_users` - Currently clocked-in staff
3. `tanda_get_shift_breaks` - Break compliance tracking

### Scheduling & Rostering
4. `tanda_get_current_roster` - Current roster period with metadata
5. `tanda_get_roster_by_date` - Roster for any specific date
6. `tanda_get_schedule` - Single schedule with full details
7. `tanda_get_shift_limits` - Hour limit warnings

### Staff Management
8. `tanda_get_inactive_users` - Terminated/inactive employees
9. `tanda_get_user_versions` - Staff change history (audit)
10. `tanda_invite_user` - Send app invitation

### Leave Management
11. `tanda_get_leave_types` - Available leave types per user
12. `tanda_calculate_leave_hours` - Calculate leave duration
13. `tanda_get_user_timesheet` - Individual employee timesheet

### Onboarding (Write)
14. `tanda_onboard_users` - Bulk staff import with template
15. `tanda_create_location` - Add new locations (if supported)

---

## MCP Prompts for Optimized Queries

The MCP server should include prompts that help Claude:
1. **Batch operations** - Combine related queries efficiently
2. **Date range optimization** - Use appropriate date ranges
3. **Filter guidance** - Apply correct filters for performance
4. **Pagination** - Handle large datasets properly

---

## Conversational Flow Requirements

Claude should guide users through:
1. **Required parameters** - What's mandatory vs optional
2. **Valid values** - Enum options, date formats
3. **Related actions** - Suggest follow-up operations
4. **Error recovery** - Help fix invalid inputs

---

## Next Steps

1. Implement CRITICAL tools first (onboarding, active shifts)
2. Add HIGH priority read tools
3. Create MCP prompts for optimization
4. Build conversational flow guidance
5. Test all tools with OAuth authentication
