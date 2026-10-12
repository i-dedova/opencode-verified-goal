# OpenCode Verified Goal

A goal loop for OpenCode whose transitions are gated by an **independent reviewer** — a
separate, deny-all subagent lane that must approve each move — instead of by the working
agent's own judgement.

- **Loop.** `/goal <objective>` starts a persistent objective that survives compaction,
  continues when the session idles, and is bounded by turn, token and elapsed-time budgets
  with no-progress pauses.
- **Gate.** Each gated transition goes to a second session running the reviewer lane, which
  is read-only (`*:*/deny`) and answers in a fixed verdict grammar. The working agent cannot
  approve itself.
- **Status.** The session title and status lines carry the goal state; `get_goal` reports it.

## Requirements

- OpenCode 2.x (measured against 2.0.27).
- A provider/model your OpenCode already has configured for the reviewer. The plugin carries
  **no provider policy** — any provider you have configured is eligible, and the reviewer
  falls back through the lane pin and then your parent session's own model.

## Install

1. Install the plugin — the host does it, and writes the global config entry itself:

   ```
   opencode plugin add @i-dedova/opencode-verified-goal
   ```

2. Install the reviewer lane — one file the host loads from its agents directory, which a
   plugin cannot inject:

   ```
   npx -y @i-dedova/opencode-verified-goal install-lane
   ```

   Manual equivalent: copy `agents/subagent_goal-verifier.md` from this package into
   `~/.config/opencode/agents/`. The command is idempotent: running it twice leaves exactly
   one lane, and it reports "already current" instead of rewriting.

3. Restart OpenCode — the config entry and the lane are read at start.

Lifecycle: `opencode plugin check`, `opencode plugin update`, `opencode plugin remove`.

## Configure the reviewer

Without configuration the reviewer runs on the lane's pinned model. To choose your own, give
the plugin entry options:

```json
"plugins": [
  {
    "package": "@i-dedova/opencode-verified-goal",
    "options": { "reviewer": { "model": "provider/model", "variant": "high" } }
  }
]
```

Resolution order, and what the operator sees at each step:

1. `options.reviewer`, when it resolves in your configured catalog;
2. otherwise the lane's own pin;
3. otherwise the **parent session's own model**, announced with one status line —
   `goal reviewer - <providerID>/<modelID> (parent session: no configured reviewer and no lane pin)`;
4. otherwise the review **fails closed** with `verifier-error` and the transition does not
   apply.

A configured value the catalog cannot resolve logs one warning naming it and falls through to
the next step; an omitted `variant` leaves the model's own default effort. The reviewer always
runs **through the lane**, because the lane's frontmatter is what gives it its deny-all
boundary — no model choice can substitute for that.

## Commands and tools

Operator: `/goal <objective>`, `/goal`, `/goal list`, `/goal pause`, `/goal resume`,
`/goal clear`. Agent: `get_goal`, `set_goal`, `update_goal`.

## State

Goals live in the host's plugin storage under the namespace
`plugin:<hex(i-dedova.verified-goal)>:` — the plugin never writes that prefix itself. Records
survive idle, supersede and clear; history is retained so a session can host several goals
over time.

## Status of the surfaces

The server plugin, its tools, the commands and the reviewer gate are in this release. The TUI
and desktop status surfaces described in `DESIGN.md` are **not in this release yet** — the
session title and the status lines are the current operator surface.

## Development

```
npm test                            # the plugin suite (109 tests)
npm run install-lane -- --dry-run   # see where the lane would go
```

Releases are tag-driven: bump `version`, tag `vX.Y.Z` matching it, and the workflow verifies
the suite and publishes with provenance.

## Licence and credits

MIT. The install-guide shape and the release automation follow the conventions of
[`prevalentWare/opencode-goal-plugin`](https://github.com/prevalentWare/opencode-goal-plugin)
(MIT); this implementation is independent of it.
