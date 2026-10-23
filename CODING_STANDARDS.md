# Coding standards

Judgement calls for reviewers, human or Claude. Anything a tool can check
(typecheck, tests, build) runs in `.github/workflows/checks.yml`, not here.
`docs/SECURITY.md` is the security model these rules protect.

## Blocking

- **Secrets stay out of the repo and the logs.** No tokens, keys or client
  secrets in code, docs, tests or log lines. Config comes from environment
  variables (`src/config/environment.ts`); `.env.example` gets placeholders only.
- **Every MCP route stays authenticated.** New routes or JSON-RPC methods go
  behind the same auth middleware; nothing widens unauthenticated access
  without a matching change to `docs/SECURITY.md`.
- **The server stays read-only towards Tanda.** No tool or client path sends a
  write verb to the Tanda API.
- **Personal data stays filtered.** Payloads go through the privacy filters in
  `src/mcp/privacy.ts`; new sensitive fields are added to them, not exposed by
  default.
- **Tool input is validated.** New or changed tool arguments go through the
  shared parsers in `src/mcp/args.ts` (which throw `ArgError`) before use.
- **Behaviour changes come with tests** in `tests/`, and with README or docs
  updates when users or deployers would notice.

## Non-blocking

- **Simple beats clever.** The smallest change that solves the problem; no
  speculative options or abstractions for one caller.
- **Match the surrounding code.** Naming, comment density and idiom follow the
  file being edited.
- **Types say what they mean.** Avoid `any` and non-null assertions where a
  real type or a check would do.
- **Errors carry context.** Errors returned to MCP clients are clear and do not
  leak internals (stack traces, upstream response bodies).
- **Comments explain why**, not what.
