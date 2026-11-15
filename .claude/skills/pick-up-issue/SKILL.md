---
name: pick-up-issue
description: The software-factory workflow for this repo. Use when asked to "pick up an issue" (or several, e.g. "pick up all the bugs"): fix it on a branch, take it through the PR pipeline into staging, live-test staging, then promote to production.
---

# Pick up an issue

The workflow Hakeem wants every time he says "pick up an issue". One issue = one
branch = one PR. Production only ever receives what passed on staging.

## 0. Choose and check the issue

- Backlog issues carry the `workforce-mcp` label and a priority (`P0` first, then
  `P1`, `P2`, `P3`). The ground rules and definition of done are in the tracking
  issue #47: read them before starting.
- Do not start an issue labelled `needs-decision` until the decision is recorded
  in the issue (ask Hakeem), unless the issue states a default that can ship.
- `config` issues (Railway variables, Tanda tokens, Tanda settings) need a person:
  say exactly what to change and where, and stop.
- When picking up several, do them one at a time in priority order.

## 1. Fix

- Branch from the latest `origin/staging`: `wfm/<issue-number>-<short-slug>`.
- Make the smallest change that meets the issue's acceptance criteria. Follow
  `CODING_STANDARDS.md` (read-only towards Tanda, privacy filters, `args.ts`
  parsers, fail soft with `warnings[]`).
- Add tests in `tests/` for the change and its failure path. Update README /
  docs when users or deployers would notice.
- Run all of these and fix anything red before pushing:
  `npm run lint && npx tsc --noEmit && npm test -- --ci && npm run build`

## 2. PR through the factory

- Open a **ready (non-draft)** PR into `staging`, authored as `hakeemrabiuDFW`.
  Write the body with the `pr` skill from Matt Pocock's "Skills For Real Engineers"
  plugin (`.github/pull_request_template.md` has the same headings):
  - `## Summary`: `Closes #N`, then the smallest visual that shows the change
    (a diff-sketch, call tree, file tree or Mermaid diagram), with brief prose.
  - `## Evidence`: **Before** / **After**, e.g. the failing and passing test or the
    tool output before and after.
  - `## Merge Danger`: `**Door:**` one-way or two-way, and `**Blast Radius:**`.
  The gate rejects a body missing any of these headings.
- `pr-pipeline` runs checks plus the Standards and Spec Claude reviewers;
  `pr-gate` labels `risk:*`, posts the reviews and decides.
- Fix every blocking finding and every failed check, then push again. Reply to
  non-blocking findings (fix, or one line on why not).
- `risk:low` PRs are merged by the gate. `risk:medium`/`risk:high` PRs get
  `ready-for-human`. When the only remaining reason is the risk scope (checks
  green, no blocking findings, template complete), squash-merge it into
  `staging`: Hakeem approved this workflow. Anything else stays for him.

## 3. Live-test staging

- Merging to `staging` runs `.github/workflows/deploy.yml`, which builds the
  `:staging` image and, when the `RAILWAY_TOKEN` repo secret is set, deploys the
  `tanda-mcp-stage` Railway service. Without that secret it only pushes the image:
  then redeploy `tanda-mcp-stage` (project `jubilant-blessing`) with the Railway
  connector, which pulls the new `:staging` image.
- Confirm `https://tanda-mcp-stage-production.up.railway.app/health` shows the
  merged commit as `revision` before testing.
- Smoke test every tool against staging:
  `MCP_URL=https://tanda-mcp-stage-production.up.railway.app/mcp MCP_TOKEN=<staging MCP_SHARED_SECRET> npm run smoke`
  Read the secret from the staging service's variables with the Railway
  connector. Never print it, log it, or commit it.
- Also run the issue's own acceptance check against staging, and record both
  results (no PII, shapes and counts only) as a comment on the issue.
- If staging fails: fix forward with a new PR (back to step 1) or revert the
  merge. Never promote a failing staging.

## 4. Promote to production

- Batch: once every issue picked up in this round passes on staging, open one
  PR from `staging` into `main` listing the issues, with the same template.
- After it merges, `deploy.yml` builds `:production` and deploys it when
  `RAILWAY_TOKEN` is set; otherwise redeploy the production service (named
  `tanda-mcp-v4-staging` in Railway, despite the name) with the connector. Confirm
  `https://tanda-workforce-mcp-server-production-53ab.up.railway.app/health`
  reports the commit, then smoke test production (the Workforce MCP connector
  points at production).
- Close each issue with a comment linking the staging and production evidence.
  (`Closes #N` only auto-closes when a PR merges into `main`.)
- Close an issue only when the problem the user sees is gone in production, not when
  the code change merges. A workaround (failing soft, a warning, a clearer error) is
  not a fix: if production still shows the symptom (for example a `missing scope`
  warning), leave the issue open and link the issue that fixes the cause.

## Stop and ask Hakeem when

- a reviewer's blocking finding can't be fixed within the issue's scope,
- staging or production fails and the cause isn't in the change,
- the change needs a new Tanda scope, a write path to Tanda, or a Railway
  variable,
- anything would touch production outside step 4.
