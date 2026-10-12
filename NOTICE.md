# opencode-verified-goal — OpenCode plugin notice

Session-scoped goals for OpenCode: `/goal <objective>` keeps a session working
until an independent reviewer accepts closure, or the operator stops it.
Specification and decisions: `C:\Users\innad\.agents\spec-records\I23-opencode-goal-continuation\T1-opencode-goal-continuation\`.

## What it registers

- Tools: `set_goal`, `get_goal`, `update_goal`.
- Command: `/goal <objective>` | `/goal pause` | `/goal resume` | `/goal clear` | `/goal list`.
- Hooks: one `context` part (the fenced goal snapshot plus the objective fence) and one `compaction` hook.

## What it writes

- Goal records, the live-goal pointer, the id sequence, the reviewer reference and
  the transition mutex rows, per session, through `ctx.storage`
  (`plugin:<plugin-id>:goal:<sessionID>:…`) in `opencode.db`.
- A local review journal, one JSON line per review, at
  `%TEMP%\opencode-verified-goal\reviews\<sessionID>.jsonl`; files older than 14 days are
  pruned when the plugin starts. It records the transition, profile, verdict,
  reason, `unmet`, the reviewer's answer, the reviewer session and model, payload
  bytes, whether the reviewer was reused, and the duration. No prompts, no file
  contents beyond what the review saw.
- Sessions: it creates one reviewer session per goal (`goal-verifier …`) and
  removes it when the goal is cleared, completed, superseded, or the owning
  session is deleted.

## Reviewer isolation

The reviewer runs on the generated lane `subagent_goal-verifier`, whose first
permission is `*:*/deny` with no allows: it has no shell, no edits, no file
reads, no subagents and no tools beyond its own context. The plugin never calls
`ctx.permission.rules`. Its model is pinned by the lane; the plugin refuses the
console `opencode` provider and accepts only `opencode-go` (standing pin
`opencode-go/grok-4.7#xhigh`) plus `commandcode` as a temporary testing provider
while the opencode-go window is exhausted — a warning is logged whenever the pin
is not the standing one.

## Removing it

Delete the `opencode-verified-goal` entry from `plugin[]` (and its `plugin_origins` record)
in `C:\Users\innad\.config\opencode\opencode.json` and restart the server. Goal
records remain in `opencode.db` under the plugin's key prefix until swept; the
journal directory can be deleted any time.
