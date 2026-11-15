---
status: accepted
---

# Who a write to Tanda is made as

Every write tool runs as the identity of the MCP caller. There are two kinds: a person's own Tanda login (OAuth, through the Claude connector) or the server's shared identity (`MCP_SHARED_SECRET` + `TANDA_ACCESS_TOKEN`, used by scheduled tasks and scripts). Tanda's history records whichever identity made the call, so we decide per kind of write, once, here:

- **A write that is itself a judgment needs a personal identity.** Approving timesheets (`tanda_approve_timesheets`) is the approval, so Tanda must show the person who made it. The shared identity may preview, because a preview changes nothing and the staging release gate (#97) needs it. It gets no `confirm_token`, and applying is refused.
- **A write that carries out a decision made elsewhere may use the shared identity, but must name that decision.** Creating a hire after John approves it in Monday (`tanda_create_user`) and deactivating a user (`tanda_deactivate_user`) are such writes. Under the shared identity, `source_ref` (for example the Monday item id) is required, so the audit log links the change to the person who decided. A personal identity doesn't need it.

A new write tool must say which of the two it is. We rejected the alternatives: one shared service account for everything loses who approved what in Tanda, and personal logins for everything rules out scheduled automation such as the Monday onboarding flow (#84 acceptance 4).
