# Ralph Workflow Guide for MCP Server Development

> Build MCP servers autonomously with PRD → Claude Code loops

## Quick Start

### Prerequisites

```bash
# Install Ralph CLI
git clone https://github.com/frankbria/ralph-claude-code.git
cd ralph-claude-code
./install.sh

# Verify installation
ralph --version
```

### Create New MCP Server from PRD

```bash
# 1. Create your PRD from the template
cp docs/ralph/PRD_TEMPLATE.md my-service-prd.md
# Edit my-service-prd.md with your API details

# 2. Import PRD to Ralph project structure
ralph-import my-service-prd.md my-service-mcp-server

# 3. Enter project and start autonomous loop
cd my-service-mcp-server
ralph --monitor
```

---

## How Ralph Works

### The Loop

```
┌─────────────────────────────────────────────────────────┐
│                                                         │
│  ┌──────────┐    ┌──────────┐    ┌──────────┐          │
│  │  Read    │    │  Claude  │    │  Write   │          │
│  │  Files   │ -> │  Code    │ -> │  Code    │          │
│  └──────────┘    └──────────┘    └──────────┘          │
│       ↑                               │                 │
│       │                               │                 │
│       │         ┌──────────┐          │                 │
│       └─────────│   Git    │<─────────┘                 │
│                 │  Commit  │                            │
│                 └──────────┘                            │
│                                                         │
└─────────────────────────────────────────────────────────┘
```

### Memory Persistence

Ralph maintains context across iterations via:

1. **Git History** - Claude sees recent commits
2. **@fix_plan.md** - Task checklist with completion status
3. **progress.txt** - Iteration notes and blockers
4. **File Diffs** - Modified files since last run

### Exit Detection

Ralph stops automatically when:

| Condition | Description |
|-----------|-------------|
| Tasks Complete | All `[ ]` in `@fix_plan.md` become `[x]` |
| Done Signals | 2+ consecutive iterations say "done" |
| Test-Only Loops | 3+ iterations only running tests |
| Circuit Breaker | Stuck in same state for 5+ iterations |

---

## Project Structure After ralph-import

```
my-service-mcp-server/
├── PROMPT.md              # Claude instructions (from template)
├── @fix_plan.md           # Task checklist (from PRD)
├── specs/
│   └── requirements.md    # Technical requirements (from PRD)
├── progress.txt           # Ralph iteration log
├── package.json           # Generated with dependencies
├── tsconfig.json          # TypeScript config
└── src/                   # Scaffolded from template
```

---

## Commands Reference

### Core Commands

| Command | Description |
|---------|-------------|
| `ralph` | Run single iteration |
| `ralph --monitor` | Continuous loop with dashboard |
| `ralph --timeout 60` | Set 60-minute execution window |
| `ralph --calls 100` | Rate limit to 100 API calls/hour |
| `ralph --verbose` | Show detailed progress output |
| `ralph --dry-run` | Preview without executing |

### Import Commands

| Command | Description |
|---------|-------------|
| `ralph-import PRD.md NAME` | Create project from PRD |
| `ralph-import --template mcp` | Use MCP server template |
| `ralph-import --validate` | Check PRD format |

---

## MCP-Specific Workflow

### Phase 1: Infrastructure (Iterations 1-10)

Ralph handles these automatically:

```
Iteration 1:  Initialize TypeScript project
Iteration 2:  Configure environment validation
Iteration 3:  Set up Express server
Iteration 4:  Implement OAuth2 flow
Iteration 5:  Create MCP handler skeleton
Iteration 6:  Add health/status endpoints
Iteration 7:  Configure logging
Iteration 8:  Add security middleware
Iteration 9:  Test OAuth flow
Iteration 10: Fix any issues
```

### Phase 2: Tools (Iterations 11-30)

Each tool typically takes 1-2 iterations:

```
Iteration 11: Add API client class
Iteration 12: Define first tool schema
Iteration 13: Implement tool execution
Iteration 14: Test tool manually
Iteration 15: Add next tool...
...
```

### Phase 3: Polish (Iterations 31-50)

```
Iteration 31: Write unit tests
Iteration 32: Add integration tests
Iteration 33: Update documentation
Iteration 34: Fix edge cases
Iteration 35: Final testing
...
```

---

## @fix_plan.md Format

Ralph parses this specific format:

```markdown
# Fix Plan

## P0 - Critical
- [ ] Initialize TypeScript project with Express
- [x] Configure Zod environment validation
- [ ] Implement OAuth2 flow with PKCE

## P1 - High
- [ ] Add rate limiting middleware
- [ ] Write unit tests

## P2 - Medium
- [ ] Add webhook support
- [ ] Create deployment guide
```

### Task Syntax

```
- [ ] Incomplete task
- [x] Completed task
- [-] Blocked task (add note in progress.txt)
```

---

## Customizing for Your MCP Server

### 1. Edit PRD_TEMPLATE.md

Replace placeholders:

```markdown
[PROJECT_NAME]     → "QuickBooks"
[API_NAME]         → "QuickBooks Online API"
[SERVICE]          → "quickbooks" or "qbo"
[REQUIRED_SCOPES]  → "com.intuit.quickbooks.accounting"
```

### 2. Define Your Tools

Use consistent naming:

```
[service]_get_[resource]      → quickbooks_get_invoice
[service]_list_[resources]    → quickbooks_list_customers
[service]_create_[resource]   → quickbooks_create_payment
[service]_update_[resource]   → quickbooks_update_estimate
[service]_delete_[resource]   → quickbooks_delete_item
```

### 3. Specify OAuth Details

```markdown
### OAuth Configuration
- Authorization URL: https://appcenter.intuit.com/connect/oauth2
- Token URL: https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer
- Scopes: com.intuit.quickbooks.accounting
- PKCE: Required
```

---

## Monitoring Dashboard

When using `ralph --monitor`:

```
┌─────────────────────────────────────────────────────────┐
│  RALPH MONITOR - QuickBooks MCP Server                 │
├─────────────────────────────────────────────────────────┤
│  Iteration: 15/50 (est)    Time: 00:23:45              │
│  Status: RUNNING           API Calls: 234/500          │
├─────────────────────────────────────────────────────────┤
│  Tasks: [██████████░░░░░░░░░░] 12/25 (48%)             │
│  P0:    [████████████████████] 8/8   (100%)            │
│  P1:    [██████░░░░░░░░░░░░░░] 4/12  (33%)             │
│  P2:    [░░░░░░░░░░░░░░░░░░░░] 0/5   (0%)              │
├─────────────────────────────────────────────────────────┤
│  Current: Implementing quickbooks_list_invoices tool   │
│  Last Commit: feat: add quickbooks_get_customer tool   │
└─────────────────────────────────────────────────────────┘
```

---

## Troubleshooting

### Loop Stuck on Same Task

1. Check `progress.txt` for blocker notes
2. Manually edit `@fix_plan.md` to clarify task
3. Add context to `PROMPT.md`
4. Run `ralph --verbose` to see Claude's reasoning

### API Rate Limiting

```bash
# Reduce call rate
ralph --calls 30 --timeout 120
```

### Circuit Breaker Triggered

Claude made no progress for 5+ iterations:

```bash
# Check what's blocking
cat progress.txt | tail -50

# Manual intervention
code @fix_plan.md
# Simplify or skip the blocking task

# Resume
ralph --monitor
```

### Memory Issues

If context gets too large:

```bash
# Reset iteration state (keeps code)
rm progress.txt
ralph --monitor
```

---

## Best Practices

### 1. Write Specific PRDs

**Bad:**
```
- [ ] Add user management tools
```

**Good:**
```
- [ ] Implement quickbooks_get_customer tool (GET /v3/company/{id}/customer/{customerId})
- [ ] Implement quickbooks_list_customers tool with pagination (GET /v3/company/{id}/query)
- [ ] Implement quickbooks_create_customer tool (POST /v3/company/{id}/customer)
```

### 2. Include API Examples

```markdown
**API Response Example:**
```json
{
  "Customer": {
    "Id": "1",
    "DisplayName": "Acme Corp",
    "PrimaryEmailAddr": {"Address": "contact@acme.com"}
  }
}
```

### 3. Define Success Criteria

```markdown
**Acceptance Criteria:**
- Returns customer object with all fields
- Handles 404 for invalid IDs
- Works with read-only mode
```

---

## Example: Building a Workforce MCP Server

```bash
# 1. Reference the Tanda PRD as a complete example
cat docs/ralph/examples/TANDA_MCP_PRD.md

# 2. Copy and customize PRD for your API
cp docs/ralph/PRD_TEMPLATE.md bamboohr-mcp-prd.md
vim bamboohr-mcp-prd.md  # Fill in BambooHR-specific details

# 3. Import to Ralph
ralph-import bamboohr-mcp-prd.md bamboohr-mcp-server --template mcp

# 4. Run autonomous build
cd bamboohr-mcp-server
ralph --monitor --timeout 120

# 5. Watch the magic happen
# ... 30-50 iterations later ...

# 6. Deploy
railway up
```

**Typical Timeline:**
- Infrastructure: 10-15 iterations
- Tools (20 tools): 20-30 iterations
- Testing & Polish: 10-15 iterations
- **Total: 40-60 iterations (~1-2 hours)**

---

## Resources

- **Ralph Repository:** https://github.com/frankbria/ralph-claude-code
- **MCP Specification:** https://spec.modelcontextprotocol.io
- **Tanda MCP Reference:** This repository (`Tanda-Workforce-MCP-Server`)

---

*This guide is part of the Ralph workflow integration for MCP server development.*
