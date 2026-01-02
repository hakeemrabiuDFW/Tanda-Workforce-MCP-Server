# Claude.ai MCP Server Test Cases

These test cases are designed to be run through Claude.ai after connecting to the Tanda Workforce MCP Server.

## Prerequisites

1. Connect the MCP server in Claude.ai:
   - Go to Claude.ai Settings → MCP Servers
   - Add server URL: `https://tanda-workforce-mcp-server-production.up.railway.app/mcp`
   - Complete OAuth authentication when prompted

2. Verify connection shows "Connected" status

---

## Test Suite 1: Connection & Discovery

### Test 1.1: List Available Tools
**Prompt**: "What Tanda tools are available?"

**Expected**: Claude should list all 25 Tanda tools:
- User tools (get_current_user, get_users, get_user)
- Department/Location tools
- Schedule tools (CRUD operations)
- Shift/Timesheet tools
- Leave management tools
- Clock in/out tools
- Qualification tools
- Cost reporting tools

### Test 1.2: Tool Details
**Prompt**: "Describe the tanda_get_timesheets tool and its parameters"

**Expected**: Claude should describe:
- Tool purpose (fetch timesheet data)
- Required parameters (from, to dates)
- Optional parameters (user_ids, approved, include_costs)

---

## Test Suite 2: User Management

### Test 2.1: Get Current User
**Prompt**: "Get my current Tanda user profile"

**Expected**: Returns authenticated user's profile including:
- User ID
- Name
- Email
- Department associations

### Test 2.2: List All Users
**Prompt**: "List all users in my Tanda organization"

**Expected**: Returns array of users with their basic information

### Test 2.3: Get Specific User
**Prompt**: "Get details for Tanda user ID 12345" (use a valid ID from Test 2.2)

**Expected**: Returns detailed user profile

---

## Test Suite 3: Organization Structure

### Test 3.1: Get Departments
**Prompt**: "Show me all departments in Tanda"

**Expected**: Returns list of departments with:
- Department IDs
- Names
- Any nested structure

### Test 3.2: Get Locations
**Prompt**: "List all work locations"

**Expected**: Returns location data with addresses and details

---

## Test Suite 4: Schedule Management

### Test 4.1: View Schedules
**Prompt**: "Show me schedules for the past week"

**Expected**: Returns schedule data with:
- Start/end times
- Assigned users
- Department info

### Test 4.2: Create Schedule (if authorized)
**Prompt**: "Create a schedule for tomorrow from 9am to 5pm for user [ID]"

**Expected**: Either:
- Successfully creates schedule and returns confirmation
- Returns permission error if user lacks create rights

### Test 4.3: View Schedule Costs
**Prompt**: "Show me roster costs for this week with cost breakdown"

**Expected**: Returns cost data if show_costs parameter is supported

---

## Test Suite 5: Timesheet Operations

### Test 5.1: Get Timesheets
**Prompt**: "Get all timesheets from the last 7 days"

**Expected**: Returns timesheet entries with:
- User assignments
- Hours worked
- Approval status

### Test 5.2: Get Shifts
**Prompt**: "Show me all shifts for this week"

**Expected**: Returns shift data with clock in/out times

### Test 5.3: Approve Timesheet (Manager Only)
**Prompt**: "Approve timesheet ID [ID]" (use valid ID from Test 5.1)

**Expected**: Either:
- Successfully approves and returns updated timesheet
- Returns permission error if not a manager

---

## Test Suite 6: Leave Management

### Test 6.1: View Leave Requests
**Prompt**: "Show me all pending leave requests"

**Expected**: Returns leave requests with:
- Request dates
- Leave type
- Status (pending/approved/declined)
- Requesting user

### Test 6.2: Get Leave Balances
**Prompt**: "What are my leave balances?"

**Expected**: Returns balance for each leave type:
- Annual leave
- Sick leave
- Other leave types

### Test 6.3: Create Leave Request
**Prompt**: "Submit a leave request for annual leave on [future date]"

**Expected**: Creates leave request and returns confirmation

### Test 6.4: Approve/Decline Leave (Manager Only)
**Prompt**: "Approve leave request ID [ID]"

**Expected**: Either:
- Successfully updates leave status
- Returns permission error if not authorized

---

## Test Suite 7: Clock In/Out

### Test 7.1: View Clock Ins
**Prompt**: "Show me clock in records for today"

**Expected**: Returns clock in/out entries with timestamps

### Test 7.2: Clock In
**Prompt**: "Clock me in now"

**Expected**: Creates clock in entry with current timestamp

---

## Test Suite 8: Qualifications

### Test 8.1: List Qualifications
**Prompt**: "What qualifications are tracked in the system?"

**Expected**: Returns list of qualification types

### Test 8.2: User Qualifications
**Prompt**: "Show my qualifications and their expiry dates"

**Expected**: Returns user's qualifications with:
- Qualification name
- Status
- Expiry date (if applicable)

---

## Test Suite 9: Reporting & Costs

### Test 9.1: Award Interpretation
**Prompt**: "Get award interpretation data for the past pay period"

**Expected**: Returns wage/award calculation data

### Test 9.2: Roster Costs
**Prompt**: "What are the roster costs for this week by department?"

**Expected**: Returns cost breakdown by department

---

## Test Suite 10: Error Handling

### Test 10.1: Invalid Date Range
**Prompt**: "Get timesheets from 2099-01-01 to 2099-12-31"

**Expected**: Returns empty array or appropriate message (not an error)

### Test 10.2: Invalid User ID
**Prompt**: "Get details for user ID 999999999"

**Expected**: Returns appropriate error message about user not found

### Test 10.3: Missing Required Parameters
**Prompt**: "Get schedules" (without specifying date range)

**Expected**: Claude should either:
- Ask for required date range
- Use sensible defaults
- Return validation error

---

## Quick Verification Script

Run these prompts in sequence for a quick health check:

1. "List all available Tanda tools" → Should show 25 tools
2. "Get my current user profile" → Should return your user data
3. "Show departments" → Should return organization structure
4. "Get timesheets for the last 7 days" → Should return data or empty array
5. "What are my leave balances?" → Should return balance information

---

## Troubleshooting

### "Authentication required" error
- Re-authenticate through the OAuth flow
- Check that your Workforce.com credentials are valid

### "Tool not found" error
- Verify MCP server is connected in Claude.ai settings
- Check server URL is correct

### Empty results
- Verify date ranges are valid
- Check that data exists in your Tanda organization

### Permission errors
- Some operations require manager/admin roles
- Contact your Tanda administrator for access

---

## Reporting Issues

If tests fail unexpectedly, note:
1. The exact prompt used
2. The error message received
3. Your user role in Tanda (employee/manager/admin)

Report issues at: https://github.com/hakeemrabiuDFW/Tanda-Workforce-MCP-Server/issues
