# Tanda Workforce MCP

An MCP server that lets Claude read, and in a few guarded cases change, Martinez Cleaning's workforce data in Tanda (Workforce.com).

## Language

**Personal identity**:
A person's own Tanda login, used when they call the MCP through the Claude connector (OAuth).
_Avoid_: user token, OAuth user

**Shared identity**:
The server's own Tanda login (`TANDA_ACCESS_TOKEN`), used by scheduled tasks and scripts that authenticate with the shared secret.
_Avoid_: service account, bot user, system token

**Write tool**:
A tool that changes Tanda data. It is off unless writes are enabled, and it always previews before a confirm.
_Avoid_: action tool, mutation

**Exception note**:
The `MCP-EXCEPTION` marker added to a shift that was approved despite a data-quality flag.
_Avoid_: flag comment, warning tag

**Deactivate**:
Mark a Tanda user inactive (Tanda's "delete"). It is reversible with rehire and removes the user from billed headcount.
_Avoid_: delete, remove, terminate
