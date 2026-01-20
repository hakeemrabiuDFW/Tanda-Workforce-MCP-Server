# Tanda Workforce MCP Server v3.1.0

A production-ready MCP (Model Context Protocol) server for integrating Tanda Workforce API with AI assistants like Claude. Features OAuth2 authentication with PKCE support, real-time workforce tools, supervisor scheduling optimization, and comprehensive workforce management capabilities.

## What's New in v3.1.0

### Supervisor Scheduling Optimization
Strategic supervisor placement across schools with overlap prevention and evening coverage optimization:

- **Overlap Detection** - `tanda_detect_supervisor_overlaps` - Find schedule conflicts where supervisors are double-booked
- **Evening Coverage Analysis** - `tanda_analyze_evening_coverage` - Analyze evening (17:00-22:00) coverage across all locations
- **Placement Recommendations** - `tanda_get_placement_recommendations` - Get AI-powered strategic placement suggestions
- **Full Optimization** - `tanda_optimize_supervisor_schedules` - Run complete optimization with coverage gap analysis
- **Schedule Validation** - `tanda_validate_supervisor_schedules` - Validate proposed schedules before creation
- **Bulk Schedule Creation** - `tanda_create_optimized_schedules` - Create multiple optimized schedules at once

**Key Features:**
- Prevent supervisor overlaps (no double-booking)
- Ensure good visibility during evening hours at all schools
- Strategic placement to maximize coverage
- Intelligent recommendations based on supervisor availability and managed departments

## What's New in v3.0.0

### Real-time Workforce Tools (Inspired by Monday.com MCP)
- **Active Shifts** - `tanda_get_active_shifts` - See who's currently working in real-time
- **Clocked-in Users** - `tanda_get_clocked_in_users` - Real-time attendance status
- **Shift Breaks** - `tanda_get_shift_breaks` - Break compliance tracking
- **Shift Limits** - `tanda_get_shift_limits` - Overtime warnings and hour limits

### Roster Period Management
- **Current Roster** - `tanda_get_current_roster` - Get the active roster period
- **Roster by Date** - `tanda_get_roster_by_date` - Get roster for any specific date
- **Roster by ID** - `tanda_get_roster` - Get specific roster by ID

### Staff Management
- **Inactive Users** - `tanda_get_inactive_users` - View terminated employees
- **Bulk Onboarding** - `tanda_onboard_users` - Bulk employee onboarding
- **User Invitations** - `tanda_invite_user` - Send app invitations

### Leave Enhancements
- **Leave Types** - `tanda_get_leave_types` - Available leave types per user
- **Leave Calculator** - `tanda_calculate_leave_hours` - Calculate leave duration

### New Workflow Prompts
- **workforce_dashboard** - Real-time workforce overview
- **compliance_check** - Break and hour limit compliance
- **onboard_employee** - Guided onboarding workflow
- **leave_planner** - Leave balance and planning assistant

### Read-only Mode
- Set `MCP_READ_ONLY_MODE=true` to disable all write operations
- Automatically filters out write tools when listing available tools

## Features

- **OAuth2 Authentication** - Secure authentication with Tanda including PKCE (RFC 7636)
- **Claude.ai & Desktop Support** - Works with both Claude.ai (OAuth flow) and Claude Desktop (JWT tokens)
- **Dynamic Client Registration** - RFC 7591 support for Claude MCP integration
- **OAuth Protected Resource Metadata** - RFC 9728 for automatic OAuth discovery
- **SSE Real-time Transport** - Server-Sent Events for MCP remote transport
- **MCP Protocol Support** - Full JSON-RPC 2.0 implementation (protocol version 2024-11-05)
- **44 Workforce Tools** - Users, schedules, timesheets, leave, real-time attendance, supervisor optimization, and more
- **6 Workflow Prompts** - Guided workflows for common tasks
- **Read-only Mode** - Restrict to read operations only (v3.0)
- **Production Ready** - Docker support, rate limiting, security headers, logging
- **TypeScript** - Fully typed codebase

## Quick Start

### 1. Clone and Install

```bash
git clone https://github.com/hakeemrabiuDFW/Tanda-Workforce-MCP-Server.git
cd Tanda-Workforce-MCP-Server
npm install
```

### 2. Configure Environment

```bash
cp .env.example .env
# Edit .env with your Tanda OAuth credentials
```

Required environment variables:
- `TANDA_CLIENT_ID` - Your Tanda OAuth client ID
- `TANDA_CLIENT_SECRET` - Your Tanda OAuth client secret
- `TANDA_REDIRECT_URI` - OAuth callback URL (e.g., `https://your-domain.com/auth/callback`)
- `SESSION_SECRET` - Random 32+ character string
- `JWT_SECRET` - Random 32+ character string

Optional v3.0 configuration:
- `MCP_READ_ONLY_MODE` - Set to `true` to disable write operations

### 3. Run

```bash
# Development
npm run dev

# Production
npm run build
npm start

# Docker
docker-compose up -d
```

## Connecting to Claude

### Option 1: Claude.ai (Recommended)

Claude.ai uses OAuth 2.0 with Dynamic Client Registration. Simply provide your MCP server URL:

```
https://your-domain.com/mcp
```

Claude.ai will:
1. Discover OAuth endpoints via `/.well-known/oauth-authorization-server`
2. Discover resource metadata via `/.well-known/oauth-protected-resource`
3. Register as a client via `/oauth/register`
4. Initiate OAuth flow with PKCE via `/authorize`
5. Exchange code for token via `/token`
6. Connect via SSE to `/mcp` for real-time communication

### Option 2: Claude Desktop

Add to your Claude Desktop config file:

**macOS**: `~/Library/Application Support/Claude/claude_desktop_config.json`
**Windows**: `%APPDATA%\Claude\claude_desktop_config.json`

```json
{
  "mcpServers": {
    "tanda-workforce": {
      "url": "https://your-domain.com/mcp",
      "headers": {
        "Authorization": "Bearer YOUR_JWT_TOKEN"
      }
    }
  }
}
```

#### Getting a JWT Token

1. Navigate to `https://your-domain.com/auth/login`
2. Authenticate with your Tanda account
3. Copy the returned JWT token

## Available Tools (44)

### User Management
- `tanda_get_current_user` - Get current user profile
- `tanda_get_users` - List all employees
- `tanda_get_user` - Get specific user details
- `tanda_get_inactive_users` - Get terminated employees (v3.0)
- `tanda_onboard_users` - Bulk employee onboarding (v3.0)
- `tanda_invite_user` - Send app invitation (v3.0)

### Real-time Attendance (v3.0)
- `tanda_get_active_shifts` - Who's currently working
- `tanda_get_clocked_in_users` - Currently clocked-in employees
- `tanda_get_shift_breaks` - Break records for a shift
- `tanda_get_shift_limits` - Hour limits and overtime warnings

### Scheduling
- `tanda_get_schedules` - Get scheduled shifts
- `tanda_create_schedule` - Create new shift
- `tanda_update_schedule` - Update shift
- `tanda_delete_schedule` - Delete shift
- `tanda_publish_schedules` - Publish schedules

### Roster Periods (v3.0)
- `tanda_get_roster` - Get roster by ID
- `tanda_get_current_roster` - Get current roster period
- `tanda_get_roster_by_date` - Get roster for specific date

### Timesheets
- `tanda_get_shifts` - Get worked shifts
- `tanda_get_timesheets` - Get timesheets
- `tanda_approve_shift` - Approve shift
- `tanda_approve_timesheet` - Approve timesheet

### Leave Management
- `tanda_get_leave_requests` - Get leave requests
- `tanda_create_leave_request` - Create leave request
- `tanda_approve_leave` - Approve leave
- `tanda_decline_leave` - Decline leave
- `tanda_delete_leave_request` - Delete leave request
- `tanda_get_leave_balances` - Get leave balances
- `tanda_get_leave_types` - Get available leave types (v3.0)
- `tanda_calculate_leave_hours` - Calculate leave duration (v3.0)

### Unavailability
- `tanda_get_unavailability` - Get unavailability records
- `tanda_create_unavailability` - Create unavailability
- `tanda_delete_unavailability` - Delete unavailability

### Supervisor Scheduling Optimization (v3.1)
- `tanda_detect_supervisor_overlaps` - Detect schedule overlaps for supervisors
- `tanda_analyze_evening_coverage` - Analyze evening coverage across all locations
- `tanda_get_placement_recommendations` - Get strategic placement recommendations
- `tanda_optimize_supervisor_schedules` - Run full scheduling optimization
- `tanda_validate_supervisor_schedules` - Validate proposed schedules for conflicts
- `tanda_create_optimized_schedules` - Create multiple schedules in bulk with validation

### Organization
- `tanda_get_departments` - List departments
- `tanda_get_locations` - List locations
- `tanda_get_teams` - List teams
- `tanda_get_staff_by_department` - Get staff in department

### Costs & Statistics
- `tanda_get_roster_costs` - Get labor costs
- `tanda_get_award_interpretation` - Get pay calculations
- `tanda_get_daily_stats` - Get daily workforce statistics

## Available Prompts (6)

| Prompt | Description |
|--------|-------------|
| `schedule_overview` | Get schedule overview for a date range |
| `team_availability` | Check team availability for a date |
| `workforce_dashboard` | Real-time workforce dashboard (v3.0) |
| `compliance_check` | Check break and hour compliance (v3.0) |
| `onboard_employee` | Guided onboarding workflow (v3.0) |
| `leave_planner` | Leave balance and planning (v3.0) |

## Read-only Mode (v3.0)

Enable read-only mode to restrict the server to read operations only:

```bash
MCP_READ_ONLY_MODE=true
```

When enabled:
- Write tools are hidden from the tools list
- Attempts to execute write tools return an error
- Useful for dashboards and reporting integrations

## Docker Deployment

```bash
# Build and run
docker-compose up -d --build

# View logs
docker-compose logs -f

# Stop
docker-compose down
```

## Development

```bash
# Install dependencies
npm install

# Run in development mode
npm run dev

# Build for production
npm run build

# Run linter
npm run lint

# Run tests
npm test

# Test all tools
npm run test:tools

# Test authenticated tools
npm run test:auth
```

## Project Structure

```
src/
  auth/           # OAuth and authentication
    middleware.ts
    oauth.ts
  config/         # Environment configuration
    environment.ts
  mcp/            # MCP protocol handlers
    handler.ts
    tools.ts
  server/         # Express server setup
    app.ts
  supervisor/     # Supervisor scheduling optimization (v3.1)
    optimizer.ts  # Optimization algorithms
    types.ts      # Type definitions
    index.ts
  tanda/          # Tanda API client
    client.ts
    types.ts
  utils/          # Utilities
    logger.ts
  index.ts        # Entry point
tests/              # Test files
scripts/            # Test and utility scripts
docs/               # Documentation
  FIT_GAP_ANALYSIS.md
Dockerfile
docker-compose.yml
DEPLOYMENT.md       # Full deployment guide
package.json
```

## Documentation

See [DEPLOYMENT.md](./DEPLOYMENT.md) for comprehensive deployment instructions including:
- OAuth setup with Tanda
- Cloud deployment guides (AWS, GCP, Railway)
- Testing procedures
- Troubleshooting

## Changelog

### v3.1.0
- **NEW**: Supervisor Scheduling Optimization module
  - `tanda_detect_supervisor_overlaps` - Detect double-bookings and schedule conflicts
  - `tanda_analyze_evening_coverage` - Analyze evening visibility at all schools
  - `tanda_get_placement_recommendations` - AI-powered strategic placement suggestions
  - `tanda_optimize_supervisor_schedules` - Full optimization with coverage gap analysis
  - `tanda_validate_supervisor_schedules` - Validate schedules before creation
  - `tanda_create_optimized_schedules` - Bulk schedule creation with validation
- **NEW**: 44 total tools (6 new supervisor optimization tools)
- Strategic supervisor placement across schools without overlaps
- Evening coverage optimization (17:00-22:00)
- Intelligent recommendations based on supervisor availability

### v3.0.0
- **NEW**: Real-time attendance tools (active shifts, clocked-in users, shift breaks, shift limits)
- **NEW**: Roster period management (current roster, roster by date)
- **NEW**: Staff management (inactive users, bulk onboarding, user invitations)
- **NEW**: Leave enhancements (leave types, leave hours calculator)
- **NEW**: 4 workflow prompts (workforce_dashboard, compliance_check, onboard_employee, leave_planner)
- **NEW**: Read-only mode (`MCP_READ_ONLY_MODE=true`)
- **NEW**: 38 total tools (13 new tools added)
- Inspired by Monday.com MCP server architecture

### v2.0.1
- **BREAKING**: Removed clock in/out tools - require `device` OAuth scope not supported by Workforce.com
- **BREAKING**: Removed qualifications tools - require `qualifications` OAuth scope not supported by Workforce.com
- Added Fit-Gap Analysis documentation

### v2.0.0
- Added OAuth Protected Resource Metadata (RFC 9728) for Claude.ai compatibility
- Added delete leave request tool for complete CRUD operations
- Improved SSE connection stability with 1-hour idle timeout
- Updated API endpoints to match Tanda/Workforce.com documentation

### v1.0.0
- Initial release with 25+ workforce management tools
- OAuth2 with PKCE support
- Dynamic Client Registration (RFC 7591)
- SSE real-time transport for MCP
- Docker support

## License

MIT License - see [LICENSE](./LICENSE) file

## Author

hakeemrabiuDFW

## Acknowledgments

- Inspired by [Monday.com MCP Server](https://github.com/mondaycom/mcp)
- Built with [Model Context Protocol](https://modelcontextprotocol.io/)
