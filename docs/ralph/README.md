# Ralph Workflow Integration for MCP Servers

This directory contains templates and guides for building MCP servers autonomously using the [Ralph Claude Code](https://github.com/frankbria/ralph-claude-code) method.

## What is Ralph?

Ralph is a bash loop that pipes PRD → Claude Code → iterates until all tasks complete. Memory persists via git commits, `@fix_plan.md`, and `progress.txt`.

## Quick Start

```bash
# 1. Install Ralph CLI
git clone https://github.com/frankbria/ralph-claude-code.git
cd ralph-claude-code && ./install.sh

# 2. Create PRD from template
cp docs/ralph/PRD_TEMPLATE.md my-service-mcp-prd.md

# 3. Import and run
ralph-import my-service-mcp-prd.md my-service-mcp-server
cd my-service-mcp-server
ralph --monitor
```

## Contents

| File | Description |
|------|-------------|
| [PRD_TEMPLATE.md](./PRD_TEMPLATE.md) | MCP server PRD template optimized for Ralph |
| [PROMPT_TEMPLATE.md](./PROMPT_TEMPLATE.md) | Claude Code instructions template |
| [WORKFLOW_GUIDE.md](./WORKFLOW_GUIDE.md) | Complete guide to using Ralph for MCP development |
| [examples/TANDA_MCP_PRD.md](./examples/TANDA_MCP_PRD.md) | Complete example PRD for Tanda Workforce MCP server (this repo) |

## Typical Build Stats

| Metric | Value |
|--------|-------|
| Infrastructure Setup | 10-15 iterations |
| Per Tool Implementation | 1-2 iterations |
| Testing & Polish | 10-15 iterations |
| Total (20 tools) | 35-55 iterations |
| Time | 1-2 hours |

## Key Commands

```bash
ralph --monitor       # Autonomous loop with dashboard
ralph --timeout 60    # 60-minute execution window
ralph --calls 100     # Rate limit (calls/hour)
ralph --verbose       # Detailed output
```

## Pattern Reference

This workflow follows patterns established in the Tanda-Workforce-MCP-Server:
- 38 workforce management tools
- OAuth2 with automatic token refresh
- Zod environment validation
- Winston structured logging
- Express with security middleware

---

*Part of the Tanda-Workforce-MCP-Server documentation*
