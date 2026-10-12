---
design_read: "Reading this as an operator-facing status-and-control surface inside an existing developer tool, for a single technical operator, with a terse, quiet-utility direction that inherits the host's theme, on TUI and desktop."
omitted:
  elevation: "No custom surfaces. The host owns every panel, dialog, tab strip and footer line; the goal UI never draws its own background, border or shadow, so there is nothing to elevate."
  shapes: "No custom geometry beyond the status glyph and its text spacing. Radii, borders and dividers come from host chrome, so no radius scale is defined here."
  rounded: "No radius token exists: every corner belongs to host chrome (see shapes). Nothing in these surfaces sets a radius."
colors:
  status-active: "{host.accent.positive}"
  status-paused: "{host.text.muted}"
  status-blocked: "{host.accent.attention}"
  status-unknown: "{host.text.faint}"
  status-text: "{host.text.primary}"
  action-disabled: "{host.text.faint}"
typography:
  item: "{host.font.small}"
  panel-heading: "{host.font.heading-small}"
  panel-body: "{host.font.body}"
  mono-value: "{host.font.mono-small}"
spacing:
  item-gap: "{host.space.1}"
  panel-padding: "{host.space.3}"
  section-gap: "{host.space.2}"
components:
  status-item: { text: "{typography.item}", gap: "{spacing.item-gap}", color: "{colors.status-text}" }
  goal-dialog: { padding: "{spacing.panel-padding}", heading: "{typography.panel-heading}", body: "{typography.panel-body}" }
  goal-panel: { padding: "{spacing.panel-padding}", row-gap: "{spacing.section-gap}" }
  action: { text: "{typography.item}", disabled: "{colors.action-disabled}" }
---

# Goal status surfaces — design contract

This contract covers the goal status surfaces added by Scope F: the TUI footer item
and its centered dialog, and the desktop pinned side tab, timeline title-row icon and
goal panel. Host theme tokens are **referenced, not redefined**: every `{host.*}`
token above resolves to the running host's theme, and this file defines only the
semantic aliases and their intended roles. **The exact `{host.*}` paths are
provisional**: they are asserted against the host's theme surface (the TUI plugin
context's `theme`, the desktop SDK's theme access) at implementation time, and each
alias is remapped to the real host token then without changing the roles above.

## Overview

A developer tool's goal loop is invisible unless the operator goes looking. These
surfaces make the goal's state visible where the operator already looks — the
composer footer on the TUI, the session's side strip and timeline title on the
desktop — and let the operator act on it (`pause`, `resume`, `clear`) without
leaving the surface.

- **Audience:** one technical operator, mid-session, often while an agent is working.
- **Emotional response:** calm and precise. The surfaces are quiet utility, not an
  alert system: a blocked goal should read as *needs a decision*, never as an error.
- **Non-goals:** no dashboards, no history views, no metrics, nothing the agent can
  read or trigger. No second plugin, no second design language.

## Colors

Semantic roles only, all resolved from the host theme:

| Role | Token | Use |
|---|---|---|
| active | `{colors.status-active}` | the goal is working; a filled glyph |
| paused | `{colors.status-paused}` | operator-held; muted, never alarming |
| blocked | `{colors.status-blocked}` | the agent needs a decision; the strongest role, still not an error colour |
| unknown | `{colors.status-unknown}` | state unreadable; the surface hides rather than showing this |

Text always carries the state (`goal: blocked`); colour never does it alone. The
state-to-role mapping is normative in *Status semantics* below.

## Typography

Inherit the host: one line at `{typography.item}` for the status item, the host's
small heading for a dialog/panel heading, the body size for panel content, and
monospace for anything copied verbatim (paths, ids, reasons from the record). Never
introduce a font, weight or size the host does not already have. Numbers are shown as
plain integers with their unit (`3 turns`, `12.4k tokens`), never abbreviated past
recognition.

## Layout

- **TUI item:** on the prompt footer status line, after the working-directory item,
  separated by `{spacing.item-gap}`; a single line, one glyph plus a short label.
- **TUI dialog:** centered (`centered: true`), the host's dialog size, one field per
  row with a bold label and plain value; actions on their own row at the end.
- **Desktop tab:** pinned, first in the session's side strip; the label is the glyph
  plus the word `Goal` only when the strip is wide enough, otherwise the glyph.
- **Desktop title row:** a small glyph plus the state word, placed with the other
  title-row affordances; it opens the same panel as the tab.
- **Desktop panel:** host padding; rows in the order Objective, Status, Counters,
  Decision needed, Review trail, Actions; long values wrap rather than truncate, and
  the panel is the place the full reason is always readable.
- **Truncation policy:** host chrome clamps one-line notices; the item therefore
  carries only `goal: <state>` and the surface that clamps is never the only place a
  reason appears. The panel and the dialog show reasons in full.

## Elevation & Depth

Omitted — see front matter: no custom surfaces exist to elevate.

## Shapes

Omitted — see front matter: host chrome supplies radii, borders and dividers.

## Components

- **StatusItem** — glyph and state word. Focusable, activates on click or the host's
  activate key. Renders nothing when there is no live goal.
- **GoalDialog (TUI)** — centered; the GoalPanel rows plus actions; `Esc` closes and
  returns focus to the item; no state change on open or close.
- **GoalPanel (desktop)** — the same rows in a side panel; stays mounted while the
  session is routed, updates reactively.
- **ActionRow** — one action per legal operation for the current state. An illegal
  action is disabled with a short reason naming the state that refuses it (`pause`
  is disabled when the goal is already paused or blocked; `resume` is available
  whenever the record is `paused`, `blocked`, or a stopped `active`). An action the
  latest known state already refuses is never offered; an activation the server
  still refuses - the state moved on, a foreign owner, a held mutex, a failed write -
  shows that reason and refreshes the surface, so the guarantee is "nothing is
  offered that the known state refuses", never "no activation can fail".
- **Status glyph set** — active (working): filled dot; active (stopped) and paused:
  ring; blocked: attention dot; no live goal: nothing (surface hidden). Glyphs are
  always accompanied by their word except in the pinned tab label where space forces
  the glyph alone (the label still names the state). No glyph exists for a completed
  goal, because a completed record has no live surface.

## Do's and Don'ts

- **Do** keep every status to one line; the detail belongs to the dialog/panel.
- **Do** resolve all colour, type and spacing from the host theme.
- **Do** disable-with-reason instead of offering an action the known state refuses,
  and show the server's reason when an activation is refused anyway.
- **Do** render nothing when there is no goal, and nothing at all if the plugin's
  state cannot be read.
- **Don't** encode state in colour alone, or in a glyph alone, without a label.
- **Don't** add chrome the host does not have (custom borders, shadows, badges).
- **Don't** let the surfaces write goal state the `/goal` command would refuse; the
  UI is a second face of the same operations, never a second authority.
- **Don't** create a second plugin, package or design language for UI concerns.

## Status semantics

Normative mapping; every surface derives from this table.

| State | Word | Glyph | Role | Actions offered |
|---|---|---|---|---|
| active (working, `continuing: true`) | `working` | filled dot | `{colors.status-active}` | pause, clear |
| active (stopped: `continuing: false`, e.g. max_turns / verifier-refused) | `stopped: <stop_reason>` | ring | `{colors.status-paused}` | resume, pause, clear |
| paused | `paused` | ring | `{colors.status-paused}` | resume, clear |
| blocked | `blocked` | attention dot | `{colors.status-blocked}` | resume (operator authority, unreviewed), clear |
| no live goal (including a completed goal, whose record is retained but its slot cleared) | — | — | — | nothing rendered |

Words are display vocabulary for the record's `status`/`stop_reason`; the record
vocabulary is unchanged (`active`, `paused`, `blocked`, `complete`). `working`,
`stopped`, `resume`, `pause`, `clear` and `Goal` are display terms only.

## Interaction and accessibility

- Every action has a keyboard path: the TUI item is focusable with the host's
  focus-next binding and activates with the host's activate key; the dialog's actions
  are reachable with the host's arrow/enter bindings; on the desktop the tab, the
  title-row icon and the panel actions are ordinary host controls.
- Mouse: the TUI item activates on click (the same path as the working-directory
  item); the desktop uses normal click/focus.
- After a dialog or panel action the state updates in place; after closing a dialog
  focus returns to the invoking item.
- Every status and every action carries an accessible label naming the goal and the
  state (`goal blocked: waiting for an operator decision`), so screen readers do not
  depend on the glyph or the colour.
- High Contrast and text-scaling behaviour is inherited from the host; this contract
  adds no fixed pixel sizes.

## State coverage

| Condition | Surface behaviour |
|---|---|
| no goal | nothing rendered; no placeholder |
| goal active (working or stopped) / paused / blocked | the mapped glyph + word |
| projection missing, or recording a foreign owner or an unreadable record | nothing rendered; actions never offered against a foreign record |
| plugin not loaded, so no projection exists | nothing rendered; the host's plugin-error surface is the only indicator |
| state changes while a dialog is open | the dialog re-derives from the newest projection: a state-change emission updates it, an ending emission hides it (`complete` by its status, a removal by `removed: true`), and a reporting emission (`/goal list`, a refusal) leaves it exactly as it was - stale fields are never shown as current, and a report never hides a live goal |

The surfaces read projections, so a record that changes health *after* a valid emission is
outside their guarantee (R-054); the live-state authority remains the server plugin and
`/goal`.

## Evidence

Desktop captures are `confirmed-visual`; TUI captures taken from the installed build
are `confirmed-deployed`; per-monitor DPI, screen-reader behaviour and High Contrast
states remain `unverified` until exercised live and are listed as an open gate on
the ticket.

## Agent prompt guide

When changing anything under `plugins/opencode-verified-goal`, read this file first. Keep UI
changes inside the existing surfaces; a new surface or a new status must be added to
the tables above in the same change, or it does not exist. Status text comes from
`metadata.goal`; never parse the human-readable description, and never invent a state
the record cannot hold.
