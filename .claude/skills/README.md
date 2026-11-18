# Project skills

Skills every Claude session in this repo can use, including the factory agents.

## This repo's own

| Skill | Invoked by | Use |
| --- | --- | --- |
| `pick-up-issue` | the pickup Routine, or the user | Fix a backlog issue on a branch, take it through the PR pipeline into `staging`, live-test staging, then promote to production. |

This repo has no `ship` skill: `pick-up-issue` and the GitHub PR pipeline (`pr-pipeline.yml`, `pr-gate.yml`) cover that path here.

`pr` below is Matt's upstream version. It mentions `scripts/pr-visual.sh` and `scripts/pr-screenshot.sh`, which this repo doesn't have, so a diagram stays as `mermaid` in the PR body. The gate checks only the template's headings.

For MCP Apps here: this server's own code under `src/` is the source of truth; use `create-mcp-app` and `add-app-to-server` for the protocol and the screen's HTML and script.

## Shared with every factory repo

The same set lives in every factory repo (`Martinez-WhatsApp-Connector`, `martinez-ops-hub`, `route-bid-mcp`, `Tanda-Workforce-MCP-Server`), so any Claude session opened in one of them can call it, whether or not Matt's plugin is installed on that account.

From Matt Pocock's [skills](https://github.com/mattpocock/skills) repo, version 1.2.3, copied unchanged. The agent can call these itself:

| Skill | Use |
| --- | --- |
| `diagnosing-bugs` | A diagnosis loop for hard bugs and performance regressions. |
| `tdd` | Test-first: red, green, refactor. |
| `prototype` | A throwaway prototype to answer one design question. |
| `research` | Read primary sources and write the findings to a Markdown file. |
| `domain-modeling` | Sharpen the domain model, `CONTEXT.md` and ADRs. |
| `codebase-design` | Deep-module vocabulary for interfaces and seams. |
| `code-review` | Review changes since a point against the standards and the spec. |
| `resolving-merge-conflicts` | Work through an in-progress merge or rebase conflict. |
| `wizard` | A bash wizard for steps only a person can do. |
| `grilling` | Stress-test a plan with hard questions. |
| `writing-for-agents` | How to write skills, `AGENTS.md` and `CLAUDE.md`. |

Also from Matt's plugin, but only when the user types them (`disable-model-invocation`): `ask-matt`, `grill-me`, `grill-with-docs`, `handoff`, `implement`, `improve-codebase-architecture`, `setup-matt-pocock-skills`, `teach`, `to-questionnaire`, `to-spec`, `to-tickets`, `triage`, `wait-what`, `wayfinder`.

From Matt's `skills/in-progress/` folder (his beta bucket, which the plugin doesn't ship): `pr`, `retro` (**Hakeem only**: no workflow, Routine or other skill may call it), `implement-spec`, `claude-handoff` (local CLI only).

The official MCP Apps skills, copied unchanged from [modelcontextprotocol/ext-apps](https://github.com/modelcontextprotocol/ext-apps) (`plugins/mcp-apps/skills`, commit `ea3e9d0`; Apache-2.0 and MIT): `create-mcp-app` and `add-app-to-server`, for a screen that shows inside Claude. They describe an Express server; follow this repo's own server code where it differs.

Matt's `triage`, `to-tickets` and `setup-matt-pocock-skills` read issue-tracker settings that `setup-matt-pocock-skills` writes. Nobody has run it in this repo yet, so they fall back to asking.

To update one, copy its folder again from upstream and note the new version here, in every factory repo. Don't edit them in place: local changes are lost on the next copy. Keep their upstream formatting.

Licences: Matt's skills are MIT, Copyright (c) 2026 Matt Pocock; the full text is in the upstream repo's `LICENSE`.
