# amux v3 — User Vision (canonical UX truth)

The user articulated the target experience. This document is authoritative — all v3 work checks against it.

## Overview screen (home)

**Layout**: dense tile grid. Tiles sit nearly edge-to-edge (small gap, ~4–8pt).

**Per tile**:
- **Title** at top = the Claude Code chat description (the agent's own auto-generated convo title, NOT the tmux session name). Falls back to session name if no title yet.
- **Bottom portion of the terminal**: a small live preview showing the last few lines of tmux pty output. Not the whole terminal — just the tail, so you can read what's happening at a glance. Probably 4–6 lines max in a small monospace font, clipped from the top with a subtle fade.
- **Status indicator**: subtle dot or border — running, waiting-for-input (pulse), error (calm orange), idle (dim).

**Interaction**:
- **Hover** (desktop) → tile scales up with natural spring-physics, the terminal-preview grows so you can read more. This is the "peek" — instant, no click, no commitment. Mouse leaves → snaps back.
- **Click** → enters real focus mode (see below).

**View toggle**: tiles is default. A switcher (top-right or ⌘V) flips to a list view (cmux pattern). Both views render the same data, just different layout.

## Focus mode — Desktop

When you click a tile:
- The focus view takes over the main area (split-pane on wide displays: tile-strip left + focus right; full takeover when narrow).
- **Real tmux feel**: keyboard is fully captured — every keystroke goes to the agent's pty via WebSocket. All special keys work: arrows, Ctrl-C, Ctrl-U, Tab, Shift+Tab (sent as BTab), function keys, Esc.
- **Detach affordance**: explicit button or `⌘D` (tmux convention) to return to overview without killing the session.
- **Fallback overlay panel**: when the user wants to send keys/commands without typing them (e.g., on touch, or for slash commands), an overlay with send-keys buttons. Like the current amux dock conceptually, but cleaner.

## Focus mode — Mobile (iOS)

Full-screen takeover. Native iOS app feel.

**Top of screen** (44pt + safe-area top):
- Back chevron (left edge — swipe-from-edge also works)
- Session title (the Claude chat description, truncating)
- `···` overflow menu (right) — settings, detach, kill, etc.

**Middle**: the terminal, full real estate.

**Bottom** (Termius-inspired narrow bar):
- **1 tap = switch session** (horizontal swipe between active sessions, or tap session-chip to pick from list)
- **Keyboard toggle** — show/hide soft keyboard with one tap
- **Specials button** — opens accessory groups (Esc / Tab / ⇧Tab / Ctrl-C / arrows / PageUp / PageDown / literals / custom)
- **Input field** (when keyboard is up) — type to send, with the slash-menu and accessory-row on top

**Gestures** (Termius-grade):
- Hold-anywhere-then-drag = arrow joystick with 3-speed gear
- Two-finger swipe down = PageUp (scroll back)
- Edge swipe right = back to overview
- Edge swipe left = next session

## Other surfaces (Scheduler, Board, Files)

All must feel **just as native** as the focus mode. Same Apple-grade finish, same spring physics, same materials, same typography. No "this view is secondary" lazy designs.

### Scheduler specifically
The user emphasized: "boot agents en agents een command/prompt/skill laten starten, of bestaande agents iets sturen hierin". Two job types:
- **Boot job**: start a new session with a specific working dir, prompt template, and optional skill (e.g., "spawn a `/cso` agent in /opt/projects/foo every Monday 9am")
- **Send job**: send a command/prompt/slash to an existing session (e.g., "send `/compact` to gel-astro every 6h", or "send 'run tests and report' to ipc-astro every CI commit")

Both must be schedulable via cron-style expressions + manual one-shot trigger. UI = list of jobs with last-run + next-run + status, edit inline.

### Board
Kanban with sessions as tasks. Columns: todo / doing / done (configurable). Each card = an issue, optionally bound to a session. Atomic claim (CAS) so two agents don't both pick the same task. Drag-reorder.

### Files
Per-session file browser. Open file → markdown editor (CodeMirror or similar) or read-only viewer for non-text. Breadcrumb nav. Mobile = drill-down navigation, desktop = sidebar + main pane.

## Cross-cutting principles

1. **Reliable status indicators** — multi-signal (PTY heartbeat + Claude Code hook events + prompt-pattern detection). If amux says "waiting", it's actually waiting. cmux issue #1027 is famous for getting this wrong.

2. **Programmable orchestration** — `amux wait <session> --state done --timeout 600` and similar primitives. Agents can spawn workers and block on completion, not poll.

3. **Native feel everywhere** — every animation uses spring physics from `window.AmuxSprings` equivalents, no `transition: all`, no ad-hoc colors, no UPPERCASE.

4. **Real keyboard capture in focus mode** — desktop user types and tmux receives keystroke-for-keystroke. Mobile uses native iOS keyboard with accessory bar.

5. **Single source of truth in UI**: the tile preview IS the terminal (sampled). Focus mode IS the terminal (live). No double rendering, no stale state. WebSocket-only — no 3s polling fallback.

## Anti-vision (explicitly NOT this)

- A web dashboard that "shows you info about" tmux sessions. We want the user to BE in tmux, via web.
- Toy mobile that shrinks the desktop. Mobile must be a first-class iOS app feel.
- Marketing claims of "control plane" without actual governance/RBAC/audit log.
- Calendar / Map / Habits / CRM / Notes / Channels — all dropped.

## Acceptance bar

If at any point during v3 development a feature feels like "almost as good as native", it's not done. Steve Jobs proud. Either fix or remove.
