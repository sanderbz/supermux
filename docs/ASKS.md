# Asks — the "an agent is waiting on you" API

An **ask** is anything an agent is blocked on a human for: a Claude Code
permission dialog, an `AskUserQuestion`, an MCP server's form, a board card's
`needs-input`, or a needs-you notification. supermux stores every ask in
SQLite with a stable id and a lifecycle, publishes every change over SSE, and
lets an API client **answer** it — permission prompts and multi-select
questions included — without pressing a single key in the terminal.

It is the data plane for any inbox you want to build on top of supermux: a
phone app, a voice assistant, a script that approves `npm test` and pages you
for everything else.

- [Kinds and lifecycle](#kinds-and-lifecycle)
- [REST API](#rest-api)
- [SSE and resuming without gaps](#sse-and-resuming-without-gaps)
- [How answering works](#how-answering-works)
- [Configuration](#configuration)
- [Security](#security)
- [Limits](#limits)
- [Evidence: how Claude Code behaves](#evidence-how-claude-code-behaves)
- [Upgrading](#upgrading)

---

## Kinds and lifecycle

| `kind` | Raised by | Answered with |
|---|---|---|
| `permission` | Claude Code's `PermissionRequest` hook — a tool dialog | `allow` / `deny` (+ "always allow" updates) |
| `question` | an `AskUserQuestion` call (its PreToolUse + PermissionRequest) | labels per question, multi-select included, or free text |
| `elicitation` | an MCP server's form (`Elicitation` hook) | `accept` + form values / `decline` / `cancel` (opt-in, see [config](#configuration)) |
| `needs_input` | a board card's needs-input (`supermux-task needs-input …`) | a text reply, typed into the session |
| `waiting` | a needs-you `Notification` (`idle_prompt`, `agent_needs_input`, `permission_prompt` without a dialog ask) | a text reply, typed into the session |

States:

```
open ──► answered    answered through this API (resolution.by = "api")
     ├─► dismissed   dismissed through this API, nothing sent to the agent
     └─► resolved    went away some other way (resolution.by says how)
```

`resolution.by` on a `resolved` ask:

| `by` | `outcome` | Meaning |
|---|---|---|
| `terminal` | `tool_ran` / `tool_failed` | answered outside this API — at the keyboard, or by another client pressing keys — and the tool call finished |
| `terminal` | `accept` / `decline` / `cancel` | the MCP form was answered at the keyboard |
| `hook` | `cancelled` | Claude Code withdrew the request (the human pressed Esc / "No", the turn was interrupted) |
| `agent` | `turn_ended` / `working` / `issue_done` | the agent moved on |
| `session` | `new_prompt` / `session_started` / `session_ended` | the human prompted the agent again, or the Claude process started/ended |
| `board` | `reply` | a needs-input answered through `POST /api/board/{id}/reply` |

One dialog is one ask: Claude re-firing the same dialog, the question's
PreToolUse and PermissionRequest, and the decision hook reconnecting after a
supermux restart all land on the same row (matched by a hash of the tool call,
never by content).

## REST API

All routes take the owner bearer (`Authorization: Bearer <token>`) and answer
with the usual envelope `{ok, data}` / `{ok: false, error}`. They are
owner/admin only: a company-scoped member gets the uniform 404.

### `GET /api/asks`

| Query | Default | |
|---|---|---|
| `state` | `open` (`all` when `since` is given) | `open` / `answered` / `dismissed` / `resolved` / `all` |
| `session` | — | one session's asks |
| `kind` | — | one kind |
| `since` | — | only asks **changed** after this rev, oldest change first |
| `limit` | 200 (max 1000) | |

```json
{ "ok": true, "data": { "rev": 42, "more": false, "asks": [ <ask>, … ] } }
```

`rev` is the cursor to resume from (see [SSE](#sse-and-resuming-without-gaps));
`more: true` means the page was full — ask again with `since=<rev>`.

An ask:

```json
{
  "id": "ask_4f0c…",
  "session": "api-worker",
  "kind": "permission",
  "state": "open",
  "answerable": true,
  "detail": { "tool": "Bash", "summary": "⚡ Run the migration", "kind": "bash", "mode": "default", "suggestions": 2 },
  "created_ms": 1792088916741,
  "updated_ms": 1792088916790,
  "rev": 2,
  "input": {
    "tool_input": { "command": "bin/migrate --apply", "description": "Run the migration" },
    "permission_suggestions": [ { "type": "addRules", … }, { "type": "setMode", … } ]
  }
}
```

- `answerable` — can an answer be delivered **right now**? For
  permission/question/elicitation: a decision hook is connected and waiting.
  For needs_input/waiting: the ask is open.
- `detail` — persisted, display-grade, per kind:
  - `permission`: `{tool, summary, kind, mode, suggestions, agent_type?}` — the
    same secret-conscious summary the session card shows, never the raw command.
  - `question`: `{questions: [{question, header?, multi_select, options: [{label, description?}]}]}` — every question of the call.
  - `elicitation`: `{server, message, fields: [{name, title, kind, required, options?, …}], id?}`.
  - `needs_input`: `{issue_id, question}` (plus top-level `issue_id`).
  - `waiting`: `{notification_type, message}`.
- `input` — **live only**, on `GET` responses while a decision hook waits: the
  real tool input (so a human approving `Bash` reads the command that will run)
  and Claude's offered permission updates. Held in memory by the waiting hook;
  never written to disk, never sent over SSE. String values are capped at 4000
  characters.
- `resolution` — once closed: `{by, outcome, actor?, client?, answer?}`.
  `answer` records choices (the decision, the chosen labels, the form's field
  names) but never free text: a deny message, a free-text answer, a form value
  or a reply is recorded only as present.

### `GET /api/asks/{id}`

One ask, with live `input` when available. 404 for an unknown id.

### `POST /api/asks/{id}/answer`

The body depends on the kind. `client` (optional, ≤ 60 chars) labels the
answering client on the resolution (`"phone"`, `"voice"`…).

**permission**

```json
{ "decision": "allow" }
{ "decision": "allow", "permissions": [0] }
{ "decision": "deny", "message": "Not on prod — use the staging db.", "interrupt": false }
```

`permissions` picks entries of the live `input.permission_suggestions` by index
— Claude's own "Yes, and always allow …" updates — to apply with the allow.
`message` is what the agent reads instead of the tool result; `interrupt: true`
also stops its turn.

**question** (`AskUserQuestion`)

```json
{ "answers": {
    "Which fruits do you like?": ["Apple", "Cherry"],
    "1": "Green"
} }
```

One entry per question, keyed by the question text or its 0-based index.
A value is a label, a list of labels (multi-select), or
`{"selected": ["Banana"], "other": "and figs"}` for the dialog's
"Type something" row. Labels are matched exactly (then case-insensitively); an
unknown label is a 400, never a silent free-text answer. Every question must be
answered; a single-select question takes exactly one answer. To decline the
question instead: `{"decision": "deny", "message": "…"}`.

**elicitation**

```json
{ "action": "accept", "content": { "approver": "ops", "env": "staging" } }
{ "action": "decline" }
```

`content` is validated against the form (required fields, enum values, number
ranges, string lengths and formats) with the same rules the form card uses.

**needs_input / waiting**

```json
{ "text": "eu" }
```

Typed into the session followed by Enter (a stopped session is woken first).
For `needs_input` this is exactly `POST /api/board/{id}/reply`: it also clears
the card's "needs your input" state.

Responses: `200` with the closed ask; `400` for an answer that does not fit the
ask; `404` unknown id; `409 ask_not_open` when it already closed (someone else
answered, or the agent moved on); `409 ask_not_answerable` when no decision hook
is waiting (see [Limits](#limits)) — answer it in the terminal.

### `POST /api/asks/{id}/dismiss`

Close an open ask without answering. A waiting decision hook is released with
no decision, so the dialog simply stays in the terminal. Body optional:
`{"client": "…"}`.

## SSE and resuming without gaps

Every change is a named `asks` event on `GET /api/events`:

```
event: asks
data: {"op":"opened","rev":17,"ask":{…}}
```

`op` is `opened`, `updated` (detail changed, a hook attached/detached) or
`closed`. `rev` is a single counter across all asks: every insert or update
takes the next value, and a value is never handed out twice (not even after a
row is pruned).

To never miss an ask, across your own restarts and supermux's:

1. Subscribe to `/api/events`.
2. `GET /api/asks?since=<last rev you applied>` (or `state=open` on a cold
   start) and apply the rows in order.
3. Apply SSE frames as they come; skip any frame whose `rev` is not newer than
   the row you hold (an ask is a snapshot keyed by `id`).
4. After a disconnect, go back to step 2 with your last rev.

## How answering works

supermux already installs Claude Code hooks (see `server/src/claude_config.rs`).
For `PermissionRequest` — and for `Elicitation` — the hook is now a **decision
hook**: it streams Claude's payload to `POST /api/_internal/ask`
(per-session hook-token auth) and waits on that long-poll. When a client
answers, the server answers the long-poll with Claude Code's documented
decision-control JSON, which the hook prints:

```json
{"hookSpecificOutput":{"hookEventName":"PermissionRequest","decision":{"behavior":"allow"}}}
```

For an `AskUserQuestion` the decision is an `allow` whose `updatedInput` is the
call's own input plus `answers` (`{"<question>": "Apple, Cherry"}`) — Claude
Code's own way of answering a question from a hook, multi-select included.

This path does not depend on how a given Claude Code version draws its dialogs,
so it needs no per-version keystroke maps. The terminal stays in charge:

- Claude Code runs PermissionRequest hooks **alongside** the dialog. The dialog
  renders and stays usable while the hook waits; whichever answers first wins.
- When the terminal answers first, the tool's `PostToolUse` (correlated by
  `tool_use_id`) closes the ask and supermux releases the hook with no decision.
- When the terminal says "No" (or Esc / an interrupt), Claude Code kills the
  hook. The hook closes its connection, and the ask closes as
  `hook`/`cancelled` after a short grace.
- When supermux restarts, the hook reconnects (every 2 s, for ~90 s) and the
  ask becomes answerable again — same id, same row.
- An empty answer — no decision, an HTTP error, a server that predates this
  endpoint, a pane outside supermux — prints nothing, which Claude Code treats
  as "the hook has no opinion".

## Configuration

`~/.supermux/config.toml`, all optional:

```toml
[asks]
hold_secs = 86400            # how long a permission/question hook waits for an API answer (0–86400; 0 = API answering off)
elicitation_hold_secs = 0    # the same for MCP forms — OFF by default, see Limits
retention_days = 30          # closed asks older than this are pruned (daily)
hook_grace_ms = 5000         # how long a vanished hook may take to reconnect before its ask closes as cancelled
```

After `hold_secs` the hook stops waiting: the ask stays `open` with
`answerable: false`, and the dialog is the terminal's alone.

## Security

- **Nothing decides on its own.** A decision hook prints a decision only when a
  bearer-authenticated client answered that ask through
  `POST /api/asks/{id}/answer`. There is no auto-approve path in supermux.
- The decision endpoint uses the per-session hook token, exactly like
  `/api/_internal/hook`: session A's token cannot open or wait on asks of
  session B, and the dashboard bearer is not a hook token.
- Raw hook payloads are never persisted. The row holds the display-grade detail;
  the full tool input lives in the waiting hook's memory and is served only on
  authenticated `GET`s (`input`), capped.
- The asks API is owner/admin only.

## Limits

- **Claude Code only.** Codex and shell sessions have no hooks, so they raise no
  permission/question/elicitation asks (board `needs_input` still works).
- **A session uses the hooks Claude Code loaded.** `install_hooks` runs on
  every session start. A session whose hooks predate the upgrade still records
  its asks, but they are `answerable: false` until Claude Code picks up the new
  hook entries — a session restart always does (a hook change in a
  `--settings` file was not picked up mid-session in testing; whether a change
  to `~/.claude/settings.json` is, was not verified).
- **MCP forms are opt-in.** Claude Code runs `Elicitation` hooks *before* it
  draws the form, so while the hook waits the form is not shown in the
  terminal. With `elicitation_hold_secs = 0` (the default) the hook returns at
  once and the form appears as before; the ask is recorded and its answer
  arrives as `terminal`/`accept`. Set it to answer forms remotely; after it
  lapses the form appears in the terminal.
- **Questions are answered through `PermissionRequest`, never `PreToolUse`.**
  A waiting PreToolUse hook would hide the question dialog from the terminal.
- **Background agents.** A request from a subagent that cannot show a dialog
  waits for an API answer (up to `hold_secs`) instead of being denied at once.
- **Remote hosts** need `sh`, `curl` and `mktemp` on the remote, as the existing
  hooks already do.

## Evidence: how Claude Code behaves

Verified in scratch sessions on **Claude Code 2.1.293 and 2.1.300**, macOS,
2026-10-15:

| Behaviour | Result |
|---|---|
| PermissionRequest hook still running → is the dialog drawn? | Yes — fully drawn and usable (2.1.293, 2.1.300) |
| Hook prints `decision.behavior = "allow"` while the dialog is up | Dialog closes, tool runs, transcript: "Allowed by PermissionRequest hook" |
| Hook prints `deny` + `message` | "Denied by PermissionRequest hook"; the agent reads the message and carries on |
| AskUserQuestion (2 questions, one multi-select) answered by a PermissionRequest hook with `updatedInput.answers` | "User answered Claude's questions: · Which fruits do you like? → Apple, Cherry · Which color? → Green" |
| Human picks "Yes" in the terminal while the hook waits | Tool runs; Claude does **not** kill the hook (supermux releases it on PostToolUse) |
| Human picks "No" / Esc | Turn interrupted; Claude **kills** the hook; no other hook fires |
| PreToolUse hook still running → question dialog drawn? | No — status line shows "running PreToolUse hooks…" until it returns |
| Elicitation hook still running → form drawn? | No — "running Elicitation hooks…"; a hook `accept` answers the form |
| Hook `timeout: 86400` | Honoured: still waiting after 14 min (default would be 600 s); a decision then still lands |
| AskUserQuestion in `bypassPermissions` mode | PermissionRequest still fires for it |

How 2.1.300 draws the dialogs (for clients that still read the screen): the
Bash permission dialog has four rows — `1. Yes`, `2. Yes, and always allow
access to <dir> from this project`, `3. Yes, and switch to auto mode`, `4. No` —
with `Esc to cancel · Tab to amend`; a multi-question AskUserQuestion draws a tab
bar (`☐ Fruits  ☐ Color  ✔ Submit`), checkbox rows for multi-select, a
`Type something` row, `Next`, and a separate `Chat about this` row. The folder
trust gate now defaults the caret to `No, exit`. Row positions moved between
versions; the hook path above does not depend on any of them.

## Upgrading

1. Deploy the new binary as usual. Migration `0046_asks.sql` creates the
   `asks` table; nothing else changes in the schema.
2. The new hook commands are written to `~/.claude/settings.json` (and each
   remote host's) on the next session start, replacing supermux's own marked
   entries in place. Restart running sessions to be sure they load the
   decision hook (until then their asks are recorded, not answerable).
3. Nothing to configure; `[asks]` is optional.

Rolling back: like any migration, `0046` makes the database newer than the old
binary — sqlx refuses to start a binary that does not know an applied
migration (`VersionMissing(46)`). Before starting the old binary, drop it:

```sql
DROP TABLE asks; DROP TABLE ask_rev; DELETE FROM _sqlx_migrations WHERE version = 46;
```

The decision hook itself degrades to a silent no-op against a server without
`/api/_internal/ask` (the dialog simply stays in the terminal); start any
session on the old binary to rewrite the hook entries back.
