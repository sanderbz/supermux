# amux v2 → v3 — Complete Feature Extract

**Purpose**: canonical functional spec for the v3 rebuild (Rust + SvelteKit + Capacitor). Future v3 subagents implement against this — anything missing here is a bug in v3.

**Scope kept**: Sessions, Board (Kanban), Files, Scheduler, Agent commands.
**Scope dropped**: Notes, Calendar (FullCalendar), CRM/People, Map, Habits, Torrents, Metrics, Mail/Gmail/Journal, Channels (agent-to-agent chat), Browser automation.

All file/line citations are absolute paths in `/Users/sandervm/amux-redesign/` (the v2 source tree).

---

## Subsystem 1: Sessions

The crown jewel of amux. A "session" = a named tmux session running a Claude Code (or Codex) agent CLI, persisted to disk as `~/.amux/sessions/<name>.env` + `<name>.meta.json`. Live state flows over WebSocket; metadata + status flows over SSE.

### 1.1 Endpoints (REST + SSE + WS)

All session HTTP routes are gated by `_check_auth` (Bearer token or `?_token=` query). The WS endpoint accepts the same. CORS allows `localhost / 127.0.0.1 / 0.0.0.0 / LAN-IP / *.ts.net` origins.

| Method | Path | Purpose | Request | Response |
|---|---|---|---|---|
| GET  | `/api/sessions` | List all sessions (cached, stale-while-revalidate, TTL 2s) | — | `[Session]` (see data model) |
| POST | `/api/sessions` | Create a new session | `{name, dir?, desc?, creator?, worktree?:bool, provider?:'claude'\|'codex', mcp?:'chrome'}` | `{ok,message,worktree?,branch?}`. Conflict 409 if name exists |
| POST | `/api/sessions/connect` | Adopt an existing tmux session as an amux session | `{tmux_name, name?}` | `{ok,name,message}` |
| GET  | `/api/sessions-git` | Bulk git info for all sessions (avoids N+1) | — | `{session_name: {branch, repo, ...}}` |
| GET  | `/api/sessions/self?session=<name>` | Convenience self-lookup (uses query OR `X-Amux-Session` header) | — | `Session` row |
| GET  | `/api/sessions/{name}/info` | Single-session detail | — | `{name, dir, desc, pinned, tags, flags, provider, running, raw}` |
| GET  | `/api/sessions/{name}/meta` | Session metadata file + env mtime + memory size | — | `{...meta, name, dir, flags, desc, tags, env_updated, mem_size, mem_path}` |
| GET  | `/api/sessions/{name}/peek?lines=N` | Tmux scrollback snapshot (fallback to saved log if not running) | `lines` default 80 | `{name, output, saved?}` |
| GET  | `/api/sessions/{name}/ws-stats` | WebSocket streamer statistics | — | `{session, connected_subs, buffered_bytes, total_bytes_seen, uptime_seconds, fifo_path, active}` |
| GET  | `/api/sessions/{name}/log` | Download full saved terminal log | — | text/plain |
| GET  | `/api/sessions/{name}/log/info` | Lightweight log metadata | — | `{exists, size, mtime, path}` |
| GET  | `/api/sessions/{name}/transcripts` | List per-session JSONL backups | — | `{transcripts: [{filename, size, mtime}]}` |
| POST | `/api/sessions/{name}/transcripts` | Trigger manual JSONL backup | — | `{ok, path?}` |
| GET  | `/api/sessions/{name}/transcripts/{file}` | Download a specific backup file | — | application/x-ndjson |
| GET  | `/api/sessions/{name}/tracked-files` | Get per-session tracked-files list | — | `{files:[…]}` |
| POST | `/api/sessions/{name}/tracked-files` | Add files to tracked list | `{files:[…]}` | `{ok, files}` |
| DELETE | `/api/sessions/{name}/tracked-files` | Remove files | `{files:[…]}` | `{ok, files}` |
| GET  | `/api/sessions/{name}/stats` | Claude usage stats (tokens, cost) | — | `{tokens, ...}` |
| GET  | `/api/sessions/{name}/git[?detail=1]` | Git branch + (optional) status info | — | `{branch, repo, ahead?, status_lines?, remote_url?, session_branch?}` |
| GET  | `/api/sessions/{name}/git/commits?count=N` | Commit log (hash, author, date, subject, body) | — | `{commits:[…]}` |
| GET  | `/api/sessions/{name}/git/commit-detail?sha=…` | Commit metadata + stat + diff | — | `{hash, author, date, subject, body, stat, diff}` |
| GET  | `/api/sessions/{name}/git/diff?file=…&staged=0\|1&base=…` | Diff for a file (or full repo) | — | `{diff, file}` |
| POST | `/api/sessions/{name}/git` | Checkout/create branch in session work dir | `{branch, create?, worktree?}` | `{ok, branch}` |
| POST | `/api/sessions/{name}/git-push` | Send deploy-instructions text to the session (Claude does the actual `git push`) | — | `{ok, message}` |
| GET  | `/api/sessions/{name}/memory[?pull=1]` | Read per-session MEMORY.md (composed = global + session) | — | `{content, path}` |
| POST | `/api/sessions/{name}/memory` | Write session memory; re-composes Claude MEMORY.md symlink | `{content}` | `{ok}` |
| GET  | `/api/sessions/{name}/steer` | List queued "steering" messages (next-turn-boundary delivery) | — | `[{id,text,queued_at}]` |
| POST | `/api/sessions/{name}/steer` | Queue a steering message | `{text}` | `{ok,id,message}` |
| DELETE | `/api/sessions/{name}/steer` | Clear queue (or one by id) | `{id?}` | `{ok, cleared}` |
| POST | `/api/sessions/{name}/start` | Start (or restart) the session | `{prompt?}` | `{ok, message, resumed}`. Optional prompt is sent once Claude UI is ready |
| POST | `/api/sessions/{name}/stop` | Stop (graceful /exit → hard kill). 202 = "stopping" returned immediately; runs in background pool | — | `{ok, message}` |
| POST | `/api/sessions/{name}/send` | Send text + Enter to Claude (auto-wakes if not running) | `{text}` | `{ok, message}`. 409 if not-running, 500 on other err |
| POST | `/api/sessions/{name}/paste` | Paste literal text without auto-Enter | `{text, submit?:bool}` | `{ok, pasted}` |
| POST | `/api/sessions/{name}/keys` | Send a named tmux key (restricted allowlist) | `{keys}` | `{ok, message}` |
| POST | `/api/sessions/{name}/clear` | `tmux clear-history` | — | `{ok}` |
| POST | `/api/sessions/{name}/duplicate` | Copy .env (config only) under new name | `{new_name}` | `{ok, message}` |
| POST | `/api/sessions/{name}/clone` | Copy .env AND start with `--resume <uuid> --fork-session` (or scrollback paste fallback) | `{new_name}` | `{ok, message, started, method}` |
| POST | `/api/sessions/{name}/archive` | Stop + save full scrollback (50k lines) + set `CC_ARCHIVED=1` | — | `{ok, message}` |
| POST | `/api/sessions/{name}/wake` | Remove `CC_ARCHIVED=1` and start (resumes conversation) | — | `{ok, message}` |
| POST | `/api/sessions/{name}/apply-template` | Copy template files (CLAUDE.md, dir layout) to work_dir | `{template_id, dir}` | `{ok}` |
| POST | `/api/sessions/{name}/delete` | Stop, remove .env/.meta.json/.md/.log, remove git worktree if present | — | `{ok, message}` |
| PATCH | `/api/sessions/{name}/config` | Update session: `rename`, `model`, `toggle_yolo`, `toggle_auto_continue`, `dir`, `desc`, `toggle_pin`, `branch`, `tags`, `mcp`, `new_conversation` | one of above keys | `{ok, message}` |
| POST | `/api/sessions/{name}/share` | Create share token (perms `output`, `output+files`, `output+files+notes`; optional `expires_hours`, `label`) | `{perms, expires_hours?, label?}` | `{token, url, expires_at}` |
| GET  | `/api/sessions/{name}/share` | List share tokens | — | `[{token, perms, created_at, expires_at, label}]` |
| DELETE | `/api/sessions/{name}/share` | Delete one token or all for session | `{token?}` | `{ok}` |
| GET  | `/api/events` | **SSE stream** (sessions, board, logs, alerts, invalidate, ping) | — | `event-stream` |
| GET  | `/ws/sessions/{name}` | **WebSocket pty stream** (raw tmux bytes; bidirectional) | WS Upgrade | binary frames + JSON control |
| GET  | `/api/git-branches?dir=…` | List git branches in a dir | — | `{branches:[…]}` |
| GET  | `/api/git-check?dir=…` | Is dir a git repo? | — | `{is_git: bool}` |
| POST | `/api/suggest-branch` | LLM-suggest 4 git branch names for a new session | `{name,dir?,prompt?}` | `{suggestions:[…]}` |

Sub-route routing pattern (line ~45101 in `amux-server.py`):
```
m = re.match(r"^/api/sessions/([^/]+)(/([^/]+)(/([^/]+))?)?$", path)
```
i.e. `/api/sessions/<name>[/<action>[/<sub-id>]]`.

### 1.2 Data model

#### Session listing record (`list_sessions()`)

```jsonc
{
  "name":         "string",       // unique, slug: [a-zA-Z0-9_.-]+
  "dir":          "absolute-path",// CC_DIR (work dir)
  "desc":         "string",       // CC_DESC, human note
  "pinned":       false,          // CC_PINNED=1
  "archived":     false,          // CC_ARCHIVED=1
  "auto_continue":false,          // CC_AUTO_CONTINUE in (1,true,yes)
  "steering":     [],             // steering-queue entries
  "rate_limited_until": 0,        // unix ts (rate-limit reset_at) or 0
  "tags":         ["str", "..."], // CC_TAGS, comma-separated
  "flags":        "string",       // CC_FLAGS as raw string (shlex-tokenisable)
  "creator":      "string",       // CC_CREATOR (UI label, e.g. user email)
  "provider":     "claude|codex", // CC_PROVIDER, default claude
  "running":      true,           // tmux session alive AND not at shell prompt AND child proc exists
  "status":       "active|waiting|idle|''",  // see state machine
  "preview":      "string",       // last single intelligible line
  "preview_lines":["last 12 lines"], // for card mini-terminal
  "last_activity":1700000000,     // meta.last_send || meta.last_started
  "active_model": "string",       // detected from JSONL (claude) or CC_FLAGS (codex)
  "session_created": 1700000000,  // tmux session_created
  "task_time":    "1m 23s",       // parsed from spinner
  "task_name":    "string",       // active board "doing" title || meta.task_summary || CC_DESC
  "tokens":       12345,          // current conv token count from JSONL cache
  "branch":       "string",       // CC_BRANCH (empty if "none")
  "mcp":          "chrome|''",    // CC_MCP — currently only 'chrome'
  "worktree":     false,          // CC_WORKTREE=1
  "worktree_repo":"abs-path"      // CC_WORKTREE_REPO (parent repo dir)
}
```

Sort order: `pinned-desc, running-desc, (active|waiting before idle), -last_activity`.

#### Persisted `.env` keys (per session, in `~/.amux/sessions/<name>.env`)

| Key | Type | Notes |
|---|---|---|
| `CC_DIR`            | abs path | required; the work dir for Claude |
| `CC_FLAGS`          | shlex str | full extra args to claude/codex (e.g. `--model X --dangerously-skip-permissions`) |
| `CC_DESC`           | str | short description |
| `CC_PINNED`         | "1"/"" | pin to top |
| `CC_ARCHIVED`       | "1"/"" | hide from overview, suppress auto-restart |
| `CC_AUTO_CONTINUE`  | "1"/"" | YOLO + auto-respond + auto-restart enabled |
| `CC_AUTO_CONTINUE_MSG` | str | text to send when auto-continuing (default "continue") |
| `CC_RATE_LIMIT_RESUME_TEXT` | str | text to steer on rate-limit reset (default "continue") |
| `CC_TAGS`           | csv | freeform tags |
| `CC_CREATOR`        | str | who created (audit) |
| `CC_PROVIDER`       | "claude"\|"codex" | which CLI to spawn |
| `CC_BRANCH`         | str | git branch (legacy; empty/"none" = main flow) |
| `CC_WORKTREE`       | "1"/"" | session uses a git worktree |
| `CC_WORKTREE_REPO`  | abs path | parent repo root for cleanup on delete |
| `CC_MCP`            | "chrome"/"" | inject `--mcp-config ~/.amux/mcp-chrome.json` |

#### Per-session `.meta.json` (in `~/.amux/sessions/<name>.meta.json`)

| Key | Notes |
|---|---|
| `created_at` | unix ts |
| `creator` | mirror of CC_CREATOR |
| `start_count` | int — incremented each successful start |
| `last_started` | unix ts of last start |
| `last_send` | unix ts of last send_text |
| `last_send_text` | first 200 chars of last sent text |
| `task_summary` | Haiku-generated 3-word task label (board issue auto-create) |
| `cc_session_name` | Claude Code session NAME (preferred resume key; new, since `claude --name` shipped) |
| `cc_conversation_id` | Claude UUID (legacy migration path) |
| `codex_session_id` | Codex session ID (captured ~8s after first start) |
| `tracked_files` | list of file paths the session is "tracking" |
| `start_error` | optional last-error message |
| `restarting` | transient flag (auto-restart in flight) |

#### Defaults file `~/.amux/defaults.env`

| Key | Notes |
|---|---|
| `CC_DEFAULT_FLAGS` | extra flags prepended to every session start. Holds the user-selected default model `--model X` plus any persistent options. Edited via `/api/settings/default-model`. |

### 1.3 State machine — status detection

Pure function over the last ~12 lines of cleaned (ANSI-stripped) tmux capture. See `_detect_claude_status` (line 5103).

Returns one of: `'active'`, `'waiting'`, `'idle'`, `''` (empty = not running / unknown).

**active** triggers (any of):
- "esc to interrupt" / "esc t…" in last 5 lines (spinner running with cancel hint).
- Spinner line: starts with a dingbat (U+2700..27BF) + ellipsis (U+2026). e.g. "✻ Beaming…".
- "Running…" or "Reading <N> file" lines.
- Codex bullet + "esc to interrupt" / "working" / "running".

**idle** triggers (any):
- Completed spinner: dingbat + " for " + duration with NO ellipsis. e.g. "✻ Brewed for 1m 8s".
- Status bar present (⏵⏵ or "bypass permissions" or "plan mode") without active/waiting markers.
- Bare `❯` at line end, or `$ ` shell prompt without leading `❯`.
- Codex `gpt-X · ~/path` model status line, or `›` prompt.

**waiting** triggers:
- "enter to select" anywhere.
- "do you want to proceed".
- Selector pattern: `.*❯\s*\d+\.` (i.e. `❯ 1. Yes`).
- "interrupted" + "what should claude do".
- Status bar contains `<N> bash|tool|read|edit|write|glob|grep|notebook` (only when bypass off), or "approve".

**Higher-level pseudo-statuses surfaced separately to the UI:**

| Signal | Source | Surfaced as |
|---|---|---|
| `rate_limited_until` > now | `_session_auto_actions[name].rate_limit_reset_at` | Card badge "rate-limited until HH:MM" |
| `restarting` | `_session_auto_actions[name].restarting` | Disable sends, show spinner |
| `hibernated` | `_session_auto_actions[name].hibernated` | "Sleeping — will wake on next send" |
| `not running` (process gone, tmux still alive) | `is_running()` returns False | "Stopped" badge |

**Status transitions trigger side effects (in `list_sessions()`):**

- `active|waiting → idle` (running): kick `_complete_session_board_issue` + `_pickup_next_board_task` in background.
- `idle → idle` (now not running): complete board issue.
- `active|waiting|idle → ''` (no longer running): complete board issue.

### 1.4 tmux integration

| Concept | Convention |
|---|---|
| tmux session name | `amux-<session_name>` (helper `tmux_name`, line 1190). Auto-migrates legacy `cmux-*` / `cc-*`. |
| target arg | same as name (`tmux_target`, line 1206). |
| capture pane | `tmux capture-pane -t <target> -p -S -<lines>` (line 1248). |
| live stream | `tmux pipe-pane -O -t <target> 'tee -a <log> > <fifo>'` — replaces existing pipe (line 39148-39158). Reader thread drains fifo with `select`. |
| key send (text) | `tmux send-keys -t <target> -l '<text>'` then `Enter` (separately). For >400 chars uses `load-buffer` + `paste-buffer -p` (no Enter interp) (line 6860-6873). |
| key send (special) | `tmux send-keys -t <target> <KeyName>` |
| WS paste | `load-buffer -b amux-paste -t <target> -` (stdin) + `paste-buffer -d -b amux-paste -t <target>` |
| pane resize | `tmux resize-window -t <target> -x <cols> -y <rows>` (cols 20-1000, rows 5-500) |
| new session | `tmux new-session -d -s <amux-name> -n <name> -c <work_dir> -e TMUX_SESSION_NAME=<n> -e AMUX_SESSION=<n> -e AMUX_URL=https://localhost:8822 [-e ANTHROPIC_API_KEY=…] <SHELL>`. Then `set-option remain-on-exit on`, `set-option allow-rename off`, `set-window-option automatic-rename off`, `rename-window <name>`. |
| stop graceful | send `/rename <name>` (if needed) → send `/exit` → wait 15s for shell prompt → hard-kill Claude pid if timeout |
| respawn pane | `tmux respawn-pane -k -t <target> <SHELL>` (used as fallback in `_hard_kill_claude` when Claude PID is missing) |
| list active | `tmux list-sessions -F '#{session_name}'` |
| pane info | `tmux list-panes -a -F '#{session_name}\t#{window_activity}\t#{session_created}\t#{pane_title}'` |
| pane pid | `tmux list-panes -t <target> -F '#{pane_pid}'` (shell pid; Claude is its child) |

**Allowed tmux key names (`send_keys` allowlist, line 7003):**

```
Enter, Escape, Tab, BTab, Space, BSpace,
Up, Down, Left, Right, Home, End,
PageUp, PageDown, IC, DC,
C-c, C-d, C-z, C-l, C-a, C-e, C-k, C-u, C-r, C-p, C-n, C-b, C-f, C-w,
M-b, M-f, M-d,
F1..F12,
y, n, q
```

The WS endpoint **does NOT enforce this allowlist** (it accepts any key name tmux accepts) — the WS is auth-gated and the user owns the session. The REST `keys` endpoint enforces it (line 7017).

### 1.5 Claude Code / Codex invocation

In `start_session()` (line 6159):

**Env cleanup before spawn:**
- Always unset `CLAUDECODE`, `CLAUDE_CODE_ENTRYPOINT` (so child Claude doesn't think it's nested).
- If `~/.claude.json` has `oauthAccount`, unset `ANTHROPIC_API_KEY` (else Claude auth conflicts).
- Source one of `~/.zprofile`, `~/.bash_profile`, `~/.profile` (whichever exists).
- `cd <work_dir>` explicitly.

**Resume strategy (Claude, in priority order):**
1. `meta.cc_session_name` valid + jsonl exists for it → `claude --resume <uuid-from-name-lookup>`.
2. `meta.cc_conversation_id` is UUID + jsonl exists → `claude --resume <uuid>` (migration).
3. Else → `claude --name <name>` (fresh).

**Resume strategy (Codex):**
- `meta.codex_session_id` set → `codex resume <id>`, else `codex`.
- Defaults applied if not in flags: `--model gpt-5.5`, `-a never` (or `--dangerously-bypass-approvals-and-sandbox` when YOLO).
- Auto-add `--add-dir <git_root>` and `--add-dir <git_root>/.git` if work_dir is inside a git repo.

**Flag composition order (Claude):**
```
claude [default_flags from defaults.env] [session_flags from .env] [session_flag (--resume/--name)] [extra_flags arg] [--mcp-config ~/.amux/mcp-chrome.json if CC_MCP=chrome]
```

**Root-running quirk:** v2.1.69+ Claude rejects `--dangerously-skip-permissions` when uid=0; flag is stripped automatically. To preserve YOLO behaviour, `_init_claude_config()` writes `~/.claude/settings.json` granting `permissions.allow: ["Bash(*)","Edit(*)","Write(*)","MultiEdit(*)","NotebookEdit(*)"]` and `skipDangerousModePermissionPrompt: true`.

**MCP integration:** only "chrome" is supported. When `CC_MCP=chrome`, `--mcp-config ~/.amux/mcp-chrome.json` is appended.

**Onboarding bypass:** `_init_claude_config()` ensures `hasCompletedOnboarding=true`, approves the API-key fingerprint, and pre-trusts `~`, `/app`. `_auto_trust_dir(work_dir)` trusts each session's work_dir before launch.

**Existing-tmux re-use:** if tmux session already exists, the code checks if pane is at a shell prompt, sends `C-c`+`C-u`, sets `HISTFILE=/dev/null`, cd's to work_dir, then sends the claude command. If not at prompt, sends `C-c`, waits 3s, and respawns the pane if still stuck.

**Wait-for-ready:** polls `tmux_capture` for up to 10s expecting `_claude_ui_visible(output)`. If stuck in the resume picker (`_at_resume_picker`), sends `Escape`+`C-c`, clears `cc_session_name` & `cc_conversation_id`, and retries with `--name`. If still not up after fallback, marks `meta.start_error` and returns failure.

**Post-start log streaming:** writes `=== Session started: <ts> ===` header, then `tmux pipe-pane -o "cat >> <log>"` for on-disk log capture (replaced later by TmuxStreamer's `tee` when a WS client connects).

### 1.6 Live updates

#### SSE: `GET /api/events`

- `Content-Type: text/event-stream`.
- Server max lifetime: 5 minutes per connection (caps thread accumulation). Client auto-reconnects via EventSource.
- Socket-level timeout: 10s.
- Tick interval: **2 seconds**.
- Cache `_SSE_CACHE_TTL = 2s` shared between SSE and `GET /api/sessions`. Single-writer lock prevents thundering herd.

**Event payload shapes (newline-delimited `data: <json>\n\n`):**

```json
{"type":"sessions","payload":[…list_sessions()…]}
{"type":"board","payload":[…_load_board()…]}
{"type":"logs","payload":[…ring-buffer entries…]}
{"type":"alerts","payload":[{type, session, message, ts}]}
{"type":"invalidate","keys":["notes"|"crm"|"journal"]}     // v3 will skip these
{"type":"ping","ts":1234567890}
```

- `ping` sent every 5 ticks (~10s) — drives client liveness via `onmessage`. Plain SSE comments would NOT trigger `onmessage` on iOS Safari, so a real data event is required.
- `sessions` and `board` are only sent when JSON changed since last send (delta).
- Logs ring buffer is 2000 events deep (in-memory `_event_log`).
- Alerts buffer is 50 deep (`_sse_alerts`).

#### Client-side reconnect / freshness (FRONTEND CONTRACT v3 must preserve)

- `_SSE_STALE_MS = 18000` — declare zombie if no data for 18s; force-reconnect.
- `_SSE_REFRESH_MS = 4000` — on `visibilitychange`/`pageshow`/`focus`/`online`, refetch sessions+board if last data > 4s ago.
- After 3 SSE errors, fall back to polling: `fetchSessions()` + `fetchBoard()` every 5 seconds.
- Polling fallback MUST hit both `/api/sessions` AND `/api/board` (rule from `.claude/rules/sse-realtime.md`).
- Periodic watchdog (5s) tears down stale SSE while page is visible.

#### WebSocket: `GET /ws/sessions/{name}`

**Handshake:** RFC 6455 with `Sec-WebSocket-Version: 13`. Origin allowlist enforced (same set as CORS). Auth via `?_token=` query OR `Authorization: Bearer` header.

**Per-session singleton `TmuxStreamer`** (line 39060):
- Replaces (idempotent) any existing `pipe-pane` with `tee -a <log> > <fifo>` so on-disk log AND fan-out coexist.
- Seeds replay buffer with `tmux capture-pane -p -e -J -t <target> -S -200` (with escape sequences `-e` so xterm renders the existing screen on subscribe).
- Reader thread `select()`s the fifo, appends to in-memory `replay` (capped at `_STREAMER_REPLAY_BYTES = 64 KB`), fans out to all subscribers.
- On EOF (writer closed), re-opens fifo to recover; only stops when explicitly told to.
- `_MAX_SUBS_PER_SESSION = 8` — additional subscribers get `CLOSE 1013` "too many subscribers".

**Wire protocol:**
- **server → client**: binary frames, raw tmux pty bytes with ANSI/SGR preserved.
- **client → server**: text frames containing one JSON object:
  - `{"type":"input","data":"<text>"}` — literal text (paste). Capped at 1 MB. Server uses `load-buffer` + `paste-buffer` (single subprocess pair).
  - `{"type":"key","data":"<tmux key name>"}` — `Enter`, `BSpace`, `C-c`, `Tab`, `Up`, `F5`, etc. (any tmux-accepted name).
  - `{"type":"resize","cols":N,"rows":N}` — `tmux resize-window`. Bounds 20≤cols≤1000, 5≤rows≤500.
  - `{"type":"ping"}` — optional liveness from client.

**Replay:** first message after handshake = current replay buffer (last ≤64 KB) so terminal shows context immediately.

**Keep-alive:**
- Server PING every 20s. If no PONG within 30s → close.
- Server reads PINGs from client and echoes PONG.

**Backpressure:**
- Per-subscriber bounded outbound queue (256 chunks max). On overflow, that subscriber is dropped (`alive.clear()`) — never blocks the streamer fan-out.

**Permanent-close codes** (client must NOT reconnect on these):
- `1011` — session not found / internal error.
- `1008` — auth/origin policy violation.
- `1013` — too many subscribers.
- `4001` — explicit server-initiated close.

**Other close codes**: client reconnects with exponential backoff (300ms → 2× up to ~30s, banner shows `connecting → reconnecting → offline` with "tap to retry").

**Reverse-proxy gotcha (v3 MUST handle):** WebSockets can't upgrade over HTTP/2. If page is loaded through Tailscale serve (h2 → :443), the WS URL must talk directly to the python listener port (`window._AMUX_SERVER_PORT`, injected by bootstrap). v3 backend should listen on a single port for both HTTPS and WS, or split similarly.

### 1.7 UI surfaces (what the user sees)

These are surfaces v3 must offer (functional, not visual — visual tokens come from `DESIGN_SPEC.md`).

**Overview**
- List/grid of session "cards": one per `.env` file.
- Each card shows: name, work dir, status dot (idle/active/waiting/error), preview (last ~12 lines for inline mini-term), task_name, active_model, tokens, branch, rate-limit/archived badges if relevant.
- Sort/filter by pinned, running, status, last_activity.
- Inline create + connect-to-existing-tmux flows.
- "+" floating action button → new session sheet.
- Search bar that filters by name/desc/tags.

**Focus mode** (when a session is selected)
- Live xterm.js terminal wired to `/ws/sessions/{name}`.
- Input dock: textarea + send button + accessory bar (`↑ ↓ Enter Esc Tab Ctrl-C Ctrl-U`).
- Plus-sheet ("+" button): attach file, paste from clipboard, message history, quick commands (`continue, /status, /model, /mcp, /clear, /compact`), interrupt (Ctrl+C).
- Slash-command autocomplete: typing "/" opens a list (from `/api/slash-commands`, which merges built-ins + `~/.claude/commands/*.md` skill files).
- Header chrome: session name, status dot, copy-all button, back button.
- Sub-panels (tabs/sheets, depending on viewport): tasks, memory (editor), git (commits + diff viewer), tracked-files.
- Mobile: drag-detent sheet (peek / half / full) over the overview.
- Desktop: split layout with sessions list on left (~220px), terminal on right.
- Cmd+K palette anywhere → fuzzy switch sessions.

**Peek terminal**
- Read-only snapshot via `/api/sessions/{name}/peek` (used for non-live previews / share view / fallback when WS unavailable).

**Dock + accessory bar**
- Always-visible bottom dock in focus mode: input + send + plus.
- Accessory bar appears on input focus.

**Settings**
- Default model picker (writes `~/.amux/defaults.env` via `/api/settings/default-model`).
- API key fields (Anthropic, OpenAI) via `/api/settings/env` — stored masked in UI, written to `~/.amux/server.env`.

### 1.8 Settings / config

**Global server config**: `~/.amux/server.env` (loaded at startup; OVERRIDES process env because user settings win over Docker-injected defaults).

Known env vars used:

| Var | Purpose |
|---|---|
| `AMUX_AUTH_TOKEN` | Force-set auth token. `"none"` disables auth entirely. |
| `AMUX_S3_BUCKET`, `AMUX_S3_KEY`, `AMUX_S3_REGION` | iCal public sync target (Board → S3). |
| `AMUX_GCAL_ID` | Google Calendar push sync target. |
| `AMUX_RATE_LIMIT_MODE` | `off` / `capped` (default) / `unlimited`. |
| `AMUX_RATE_LIMIT_BUDGET` | per-session auto-resume budget per UTC day (default 3). |
| `ANTHROPIC_API_KEY`, `OPENAI_API_KEY` | LLM creds (editable via `/api/settings/env`). |
| `POSTHOG_KEY`, `POSTHOG_HOST` | Server-side telemetry (no-op if unset). |
| `GOOGLE_API_KEY` | Frontend Maps/etc (passed via inline window var). |
| `SHELL` | Used to spawn tmux panes. |
| `AMUX_AUTO_UPDATE_REPO`, `AMUX_AUTO_UPDATE_BRANCH`, `AMUX_AUTO_UPDATE_INTERVAL` | Self-update from GitHub. |
| `AMUX_PORT` | Set in cloud Docker images; used as "is_cloud" detection. |

**Per-session env**: see §1.2 `.env` keys.

**MCP per-project config**: `~/.amux/mcp-chrome.json` (when `CC_MCP=chrome`). Repo also ships a `mcp.json` (centralized template).

**defaults.env**: `~/.amux/defaults.env` with `CC_DEFAULT_FLAGS`. Edited by `/api/settings/default-model`.

### 1.9 Edge cases / gotchas

These are battle-tested behaviours that v3 MUST replicate or explicitly drop:

- **Rate-limit watchdog** (`_rate_limit_loop` every 3s):
  - Detects `1. stop and wait for limit to reset` selector → presses `1` to park.
  - Parses reset time from 3 known formats + bare HH:MM fallback (filtering current-time-bar false positives by requiring ≥5min in future).
  - Stores `rate_limit_reset_at` per-session in `_session_auto_actions`.
  - At reset time: respects `_RATE_LIMIT_MODE`; in `capped`, enforces per-day budget; checks `_should_skip_rate_limit_resume(scrollback)` to avoid fighting a user who moved past the wait-state; sends `CC_RATE_LIMIT_RESUME_TEXT` (default "continue").
  - Fleet drift check: logs warning if reset times across sessions differ by >30s (means parser misread something).
- **YOLO auto-respond** (`_yolo_loop` every 3s, only sessions with `--dangerously-skip-permissions` / `--dangerously-bypass-approvals-and-sandbox` / `CC_AUTO_CONTINUE`):
  - Patterns (`_YOLO_PROMPTS`, line 1416): require "Esc to cancel" marker so model-level questions are never auto-answered. Match: command substitution prompt, generic "Do you want to proceed?", "don't ask again", codex "Allow X to <verb>".
  - Cooldown: 6s per session.
- **Auto-compact** (`_snapshot_loop` every 60s):
  - When Claude shows `context left until auto-compact: <N>%`, fires `/compact` if `pct < 50` and pref `auto_compact_enabled != "0"`.
  - Also triggers on `image exceeds the dimension limit` and `Could not process image` errors (one-shot per error).
  - JSONL backup taken before /compact (`pre_compact` reason).
  - Sets `post_compact_continue` so when session goes idle ~30s later, sends `CC_AUTO_CONTINUE_MSG`.
- **Thinking-block corruption** (`redacted_thinking` + `cannot be modified`): hard-kill Claude, restart, replay last meaningful user message (from JSONL tail).
- **Session-ID-in-use** (`Session ID … is already in use`): hard-kill + restart + replay last msg.
- **Auto-restart-on-shell-exit** (`CC_AUTO_CONTINUE=1`): if Claude exited to shell prompt (or process-level: pane has no child), `start_session` again. Rate-limited to once per 90s.
- **Stale-process reaper**: Claude processes lose API connection after ~2 days but stay alive. Restart any idle session whose Claude pid is >48h old.
- **Auto-hibernate**: stop Claude in sessions idle >30 min (frees ~400-750 MB each). Wakes on next `send_text`. Skipped during 10-min startup grace.
- **Auto-archive idle**: hourly job, archives sessions inactive >7 days (see `_auto_archive_idle`).
- **Enforce archived stopped**: 10-min job ensures archived sessions are not running.
- **Send into resume-picker is rejected** (would corrupt session selection): `send_text` checks `_at_resume_picker(output)` and returns `"session is in resume picker"`.
- **Send when not running auto-wakes**: `send_text` calls `start_session` once (with `_auto_waking` guard), waits for ready, sends.
- **Steering** (`_steering_queue`): queued sends delivered when session next reaches `waiting` or `idle` status. Single-flight per snapshot tick. Emits `steering_delivered` alert.
- **Board ↔ session coupling**:
  - Sending text to a session triggers Haiku-summarisation (3-word title) → auto-creates or updates a board issue (`owner_type=agent`, `status=doing`).
  - When session transitions to idle (after being active/waiting), the in-progress board issue is auto-moved to `done` (UNLESS tagged `gh:*` or status `review` — those are owned by GH hook).
  - After completing, `_pickup_next_board_task` finds the oldest `todo` for that session and sends `title + desc[:500]` as the next prompt.
  - Creating a board issue assigned to a session (`session` set, `owner_type=agent`, status `todo|backlog`) auto-notifies that session via a one-shot tmux message (`notified=1` flag enforces idempotency).
- **Auto-resume on startup** (`_auto_resume_sessions`): on fresh container start (tmux has no sessions, not an os.execv reload), restart every session whose meta `start_count > 0`.
- **Server self-reload** (`_watch_self`): server watches its own file mtime; on change does `os.execv` (tmux sessions survive because they're not children of the python process).
- **Log streaming re-attach** (`_attach_log_streaming`): on every server start, re-attaches `pipe-pane "cat >> log"` for surviving sessions, with a "=== Server restarted: <ts> ===" marker.
- **Memory composition** (`_compose_memory`): global memory (`~/.amux/memory/_global.md`) is concatenated above a marker `<!-- amux:session-memory -->` above per-session memory (`~/.amux/memory/<name>.md`). Composed file is written to `~/.claude/projects/<project>/memory/MEMORY.md` (Claude's source of truth). On next session start, if Claude wrote changes through the marker, the changes are captured back into per-session memory.
- **Renaming a session** (`PATCH /config {rename: …}`): renames tmux session, env file, meta file, log file, memory file; repairs Claude's symlink to memory; updates board issues' `session` column.
- **Changing model** (`PATCH /config {model: …}`): strips existing `--model X`, writes new flag, AUTO-RESTARTS the session (in-place /model send is unreliable). Captures `cc_conversation_id` before kill so resume on restart uses the live conv.
- **Changing dir** (`PATCH /config {dir: …}`): writes new CC_DIR, hard-kills Claude + restarts (because cwd is set at spawn).
- **Worktree delete**: when deleting a session with `CC_WORKTREE=1`, runs `git -C <CC_WORKTREE_REPO> worktree remove --force <CC_DIR>` (best-effort).
- **Branch is intentionally kept** on delete (user manages branches via git).
- **Send-after-ready** (`_send_after_ready`): waits up to 30s for `❯` or Claude UI, then sends. Used by `start {prompt}` and `clone`.
- **Cloud "hello-world" seed**: on first run when `AMUX_PORT` is set (i.e. cloud Docker), creates `hello-world` session in `/root/dev`.
- **Local "amux-helper" seed**: in a git checkout of amux itself, creates `amux-helper` session pointed at the repo.
- **Connect-tmux flow**: `POST /api/sessions/connect {tmux_name, name?}` adopts a pre-existing tmux session — reads `pane_current_path` for CC_DIR, renames tmux to `amux-<name>`, writes minimal .env.
- **Stop returns 202** (`{ok:true, message:"stopping"}`) — actual stop runs in `_stop_pool` (ThreadPoolExecutor max_workers=4). Calls `_complete_session_board_issue` on success.
- **Per-session send lock + per-session start/stop RLock** prevent races.

---

## Subsystem 2: Board (Kanban)

SQLite-backed Kanban board. Stable issue IDs with per-prefix counters. Atomic claim for multi-agent coordination. iCal feed (kept for v3) + Google Calendar push (kept).

### 2.1 Endpoints

| Method | Path | Purpose | Request | Response |
|---|---|---|---|---|
| GET | `/api/board?done_limit=N` | List non-deleted issues (default 100 done items capped; 0 = unlimited) | — | `[Issue]` |
| POST | `/api/board` | Create issue | `{title, session?, status?, due?, due_time?, creator?, desc?, tags?:[…], owner_type?:'human'\|'agent'}` | `Issue` (201) |
| POST | `/api/board/clear-done` | Soft-delete all `done` issues | — | `{ok, remaining}` |
| PATCH | `/api/board/{id}` | Update issue. Fields: title, desc, status, session, due, due_time, owner_type, pinned, pos, tags, creator. | — | updated `Issue` |
| DELETE | `/api/board/{id}` | Soft-delete (sets `deleted = ts`) | — | `{ok, deleted}` |
| POST | `/api/board/{id}/claim` | **Atomic CAS claim** for agent-owned items | `{session}` | `Issue` or 409 |
| GET | `/api/board/statuses` | List status columns (id, label, position) | — | `[{id, label}]` |
| POST | `/api/board/statuses` | Add custom column | `{label}` | `{id, label}` |
| DELETE | `/api/board/statuses/{id}` | Remove custom column; reassigns affected issues → `todo`. Built-ins not deletable. | — | `{ok}` |
| PATCH | `/api/board/statuses/{id}` | Rename label | `{label}` | `{ok}` |
| PUT | `/api/board/statuses/reorder` | Reorder columns | `{order:[ids…]}` | `{ok}` |
| GET | `/api/board/tag-completion?tag=X` | Aggregate done-status for a tag | — | `{tag, total, done, complete}` |
| GET | `/api/calendar.ics` | iCal feed of items with `due` (public path — no auth) | — | text/calendar |

### 2.2 Data model

#### `issues` table

```sql
CREATE TABLE issues (
    id          TEXT PRIMARY KEY,        -- e.g. "GA-7" (prefix from session name)
    title       TEXT NOT NULL,
    desc        TEXT NOT NULL DEFAULT '',
    status      TEXT NOT NULL DEFAULT 'todo',
    session     TEXT,                    -- assignee session (nullable)
    creator     TEXT NOT NULL DEFAULT '',
    due         TEXT,                    -- 'YYYY-MM-DD'
    due_time    TEXT,                    -- 'HH:MM' (optional)
    created     INTEGER NOT NULL,
    updated     INTEGER NOT NULL,
    deleted     INTEGER,                 -- nullable; soft-delete ts
    owner_type  TEXT NOT NULL DEFAULT 'human',  -- 'human' | 'agent'
    pinned      INTEGER NOT NULL DEFAULT 0,
    pos         REAL NOT NULL DEFAULT 0, -- fractional position for drag-reorder
    notified    INTEGER NOT NULL DEFAULT 0,
    gcal_event_id TEXT                   -- Google Calendar event id (sync)
);
```

#### `issue_tags` table

```sql
CREATE TABLE issue_tags (
    issue_id TEXT NOT NULL,
    tag      TEXT NOT NULL,
    PRIMARY KEY (issue_id, tag),
    FOREIGN KEY (issue_id) REFERENCES issues(id) ON DELETE CASCADE
);
```

Known tag conventions:
- `gh:<owner>/<repo>#<N>` — links to GitHub issue (board never moves these to done automatically; SessionEnd hook handles).
- `workspace:<name>` / `project:<name>` — UI grouping.

#### `issue_counters` table

```sql
CREATE TABLE issue_counters (prefix TEXT PRIMARY KEY, next_n INTEGER NOT NULL DEFAULT 1);
```

#### Statuses (built-in, seeded at init)

| id | label | position |
|---|---|---|
| `backlog` | Backlog | 0 |
| `todo` | To Do | 1 |
| `doing` | In Progress | 2 |
| `review` | In Review | 3 |
| `done` | Done | 4 |
| `discarded` | Discarded | 5 |

User-added statuses get `is_builtin=0`. Built-ins cannot be deleted (only renamed/reordered).

#### Issue response shape (`_load_board`, `_item_by_id`)

```jsonc
{
  "id": "MA-12",
  "title": "...",
  "desc": "...",
  "status": "doing",
  "session": "my-session" | null,
  "creator": "alice@example.com",
  "due": "2026-05-25" | null,
  "due_time": "14:30" | null,
  "created": 1700000000,
  "updated": 1700001000,
  "owner_type": "human" | "agent",
  "pinned": 0|1,
  "pos": 0.0,
  "tags": ["foo", "bar"]
}
```

Sort (in `_load_board`): `pinned-desc, (pos != 0 first then pos-asc, then -updated)`.

### 2.3 Issue ID generation

Prefix derived from session name (`_prefix_from_session`, line 4140):
- one word: first 5 uppercase alphanumeric chars (e.g. `my-cool-thing` → `MCT`).
- multi-word: first letter of each word, uppercased, capped at 5 (e.g. `gel-astro` → `GA`).
- no session: `AMUX`.

Counter is atomic per-prefix via `INSERT OR IGNORE … RETURNING`.

### 2.4 Drag-reorder (`pos` field)

- New cards: placed at top of column with `pos = (min existing pos in column) - 1024.0`.
- On reorder, client computes a new fractional `pos` between neighbours and PATCHes `{pos: <float>}`.
- Items with `pos = 0` (never reordered) sort by `updated` instead — keeps pre-existing data sensible.

### 2.5 Atomic claim (multi-agent coordination)

```
POST /api/board/{id}/claim {session}

UPDATE issues SET status='doing', session=?, updated=?
WHERE id=? AND status IN ('todo','backlog') AND owner_type='agent' AND deleted IS NULL
```

- The `owner_type='agent'` check in WHERE prevents TOCTOU races with concurrent PATCH that flips owner_type.
- `rowcount == 0` → 409 `"claim failed — taken by another session"`.
- `owner_type='human'` → 409 `"item is not an agent task"`.
- Anything other than `todo`/`backlog` → 409 with current status reported.

### 2.6 Session integration

- Creating an agent-owned task with `status` in `(todo, backlog)` and `creator != session` auto-notifies the assignee (`_notify_session_of_task`) via a one-shot tmux send (gated by `notified=1`).
- PATCHing `session` to a new value resets `notified=0` so the new assignee gets pinged.
- When a session goes idle, its active issues auto-move to `done` (skipping `gh:*` and `review`-status items) and `_pickup_next_board_task` claims the next `todo` for that session.

### 2.7 iCal / Google Calendar export

- `GET /api/calendar.ics` (PUBLIC — no auth) generates iCal text from issues with `due` set.
- Due dates without `due_time` → all-day events. With `due_time` → 1-hour events.
- Status mapping: `todo→NEEDS-ACTION`, `doing→IN-PROCESS`, `done→COMPLETED`.
- `_push_ical_bg()` triggers S3 upload if `AMUX_S3_BUCKET` set. Public URL: `https://{bucket}.s3.{region}.amazonaws.com/{key}`.
- `_gcal_sync_bg(item_id, …)` triggers per-item push to Google Calendar if `AMUX_GCAL_ID` set.

### 2.8 SSE / cache invalidation

- On any board write (POST/PATCH/DELETE/clear-done/status mutation/claim): `_sse_cache["board"]["time"] = 0`.
- SSE loop notices stale cache, refetches `_load_board()`, sends `{type:"board", payload:[…]}` on JSON diff.

### 2.9 Event log emission

Each board mutation emits a structured event (in `_classify_request`):
- create → `(board, created, "", "")`
- update → `(board, updated, id, "")`
- delete → `(board, deleted, id, "")`
- claim → `(board, claimed, id, "")`
- clear-done → `(board, cleared, done, "")`
- status added/removed/renamed → `(board, status-{added|removed|renamed}, sid, "")`

These appear in the SSE `logs` topic.

### 2.10 Auto-create-from-session-send

In `POST /api/sessions/{name}/send`, after a successful send, `_summarize_task_bg(session, text)` spawns a Haiku call to make a 3-word title; on success, `_auto_create_board_issue(session, title, prompt)`:
- If an active (non-done/discarded) issue for this session exists → update title and move to `doing`, append progress log line `New task: <prompt[:200]>`.
- Else → INSERT new with prefix from session name, `owner_type=agent`, `status=doing`, `creator=amux`.

---

## Subsystem 3: Files

A per-session and global file browser, markdown editor, file viewer (images/PDFs/video/audio/text), upload/delete, breadcrumb nav. Backed by direct filesystem access with strict allow-list.

### 3.1 Endpoints

| Method | Path | Purpose | Request/Query | Response |
|---|---|---|---|---|
| GET | `/api/ls?path=…&hidden=0\|1` | List directory entries | path required | `{path, parent, entries:[{name,type,size,modified}]}` |
| GET | `/api/file?path=…&cwd=…` | Read file with type-aware response | path required (abs or rel+cwd) | varies (see below) |
| PUT | `/api/file` | Write text file (whitelisted extensions only) | `{path, content}` | `{ok, path}` |
| GET | `/api/file/raw?path=…&cwd=…` | Binary stream with HTTP Range + ETag | same | streamed bytes |
| GET | `/api/file/transcode?path=…&cwd=…` | ffmpeg remux/transcode to MP4 (chunked) | video file | video/mp4 stream |
| GET | `/api/file/vtt?path=…` | Convert SRT to WebVTT (for `<track>`) | SRT path | text/vtt |
| POST | `/api/fs/upload` | Multipart upload to a dir (`dir` field + files) | multipart/form-data | `{saved:[{name,size}]}` |
| DELETE | `/api/fs/delete` | Delete file or dir (recursive) | `{path}` | `{ok, deleted}` |
| POST | `/api/fs/open` | Open dir in native OS file manager (Darwin/Linux/Windows) | `{path}` | `{ok, path}` |
| POST | `/api/upload` | Base64 single-file upload (image/etc) to `~/.amux/uploads/<uid>-<name>` | `{name, data}` | `{path, name, url}` |
| GET | `/api/uploads/{filename}` | Serve from `~/.amux/uploads/` (1h cache) | — | bytes |
| GET | `/api/autocomplete/dir?q=…` | Type-ahead for dir picker | query | `[paths…]` (caps 10) |

### 3.2 File response shape (`/api/file`)

Type-detected by extension:
- **Images** (.png/.jpg/.jpeg/.gif/.webp/.svg/.bmp/.ico): inline base64 `{path, is_image:true, data_url, mime}`. Max 5 MB.
- **PDFs** (.pdf): `{path, is_pdf:true, data_url}`. Max 10 MB.
- **Videos** (.mp4/.mov/.webm/.avi/.mkv/.m4v): `{path, is_video:true, mime, size, modified, srt?, profile?, task?}` (does NOT inline — UI uses `/api/file/raw`). Optional sidecar `<file>.json` is parsed for `profile`/`task` metadata.
- **Audio** (.mp3/.wav/.ogg/.m4a/.aac/.flac): `{path, is_audio:true, mime, size}`.
- **Binary** (null byte in first 8KB): `{path, is_binary:true, size, ext}`.
- **Text**: `{path, content, is_markdown, is_csv, is_html}`. Limit 200 KB (5 MB for CSV/TSV); truncated with marker.

### 3.3 Writable file extensions (`PUT /api/file`)

```
.md, .markdown, .mdx, .txt, .json, .yml, .yaml, .toml, .ini, .cfg,
.sh, .bash, .zsh, .py, .js, .ts, .jsx, .tsx, .mjs, .cjs,
.css, .scss, .less, .html, .htm, .xml, .svg, .csv, .sql, .graphql, .proto,
.go, .rs, .java, .rb, .php, .swift, .kt, .c, .cpp, .h, .cs, .r, .lua, .pl,
.env, .gitignore, .dockerignore, .tf, .hcl, .conf, .log, .makefile
```

Files with no extension are also writable (e.g. `Dockerfile`, `Makefile`). Parent dirs are auto-created.

### 3.4 Filesystem access control (`_is_path_allowed`)

Blocked **absolute paths**:
```
/etc/shadow, /etc/sudoers, /etc/master.passwd,
/private/etc/shadow, /private/etc/sudoers,
/var/db/sudo, /private/var/db/sudo
```

Blocked **prefixes**:
```
/etc/ssh/, /private/etc/ssh/, /var/run/secrets/, /run/secrets/
```

Blocked **home-relative dirs**:
```
.ssh, .gnupg, .aws, .kube, .netrc, .npmrc, .docker,
.config/gcloud, .config/gh
```

All paths are resolved via `Path.resolve()` first (defeats `..` traversal); then checked against the above sets.

### 3.5 Upload mechanics

- `POST /api/upload`: base64 single-file. 20 MB cap (`UPLOAD_MAX_BYTES`). Image magic-byte validation (rejects fake images). Stores to `~/.amux/uploads/<uid>-<safe_name>`. Auto-purges files >24h old.
- `POST /api/fs/upload`: multipart, 200 MB cap, writes into a user-chosen `dir`. Sanitises filenames (`[^\w.\- ]` → `_`), deduplicates with `_N` suffix.

### 3.6 UI surfaces

- Files view: breadcrumb nav, sort by name/size/modified, hidden-toggle.
- Markdown editor: PUT-back-to-disk; live preview.
- Image/PDF viewer inline (data URL).
- Video player using `/api/file/raw` with Range support (HTML5 `<video>`). Falls back to `/api/file/transcode` for non-H.264 codecs (ffmpeg remux to fragmented MP4).
- Audio player.
- Per-session file browser: rooted at `CC_DIR` of the current session.
- Pref persistence (`files_cwd`, `files_show_hidden`) via `/api/prefs`.

### 3.7 Range / ETag (`/api/file/raw`)

- `If-None-Match` → 304 when matching `"{mtime}-{size}"`.
- `Range: bytes=A-B` → 206 with `Content-Range`. Default 64 KB chunks.
- `Cache-Control: private, max-age=3600, immutable`.

### 3.8 Edge cases

- Per-session "tracked files" list (`meta.tracked_files`) is a freeform attachment list maintained via `POST/DELETE /api/sessions/{name}/tracked-files`. Used by `git-push` to scope `git add`.
- Files endpoints do NOT support write into blocked paths even with auth (defense in depth — auth token compromise shouldn't expose ~/.ssh).
- Subsystem is filesystem-direct (no sandbox / no virtual FS). v3 should preserve this — Claude sessions and the dashboard share state via plain files.

---

## Subsystem 4: Scheduler

Cron-style recurring jobs. Two flavours:
1. **tmux job**: send a text message to a (running) session at the scheduled time. The user calls this "send to existing session".
2. **shell job**: run a bash command. Used for OS-level tasks (rare).

Also supports "watch mode" for after-action verification.

Note: there's also an internal `_JOB_REGISTRY` (Python jobs registered via `schedule_job()`) that runs the same scheduler loop — that's housekeeping (email sync, snapshots, etc.) and is NOT user-exposed via the API.

### 4.1 Endpoints

| Method | Path | Purpose | Request | Response |
|---|---|---|---|---|
| GET | `/api/schedules` | List all schedules (non-deleted) | — | `[Schedule]` |
| POST | `/api/schedules` | Create | see body below | `Schedule` (201) |
| GET | `/api/schedules/runs` | Last 50 runs across all schedules | — | `[{id, schedule_id, ran_at, status, note, title}]` |
| GET | `/api/schedules/{id}` | Single schedule | — | `Schedule` |
| GET | `/api/schedules/{id}/runs` | Recent runs for one schedule (last 20) | — | `[Run]` |
| POST | `/api/schedules/{id}/run` | Manual trigger (run now) | — | `{ok, ran}` |
| PATCH | `/api/schedules/{id}` | Update; recomputes `next_run` | partial | `Schedule` |
| DELETE | `/api/schedules/{id}` | Soft-delete | — | `{deleted}` |

### 4.2 Data model

#### `schedules` table

```sql
CREATE TABLE schedules (
    id            TEXT PRIMARY KEY,         -- "SCHED-N"
    title         TEXT NOT NULL,
    session       TEXT NOT NULL,            -- target session (or "" for shell)
    command       TEXT NOT NULL,            -- text to send / shell command
    kind          TEXT NOT NULL DEFAULT 'tmux',   -- 'tmux' | 'shell'
    sched_type    TEXT NOT NULL DEFAULT 'once',   -- 'once' | 'recurring'
    recurrence    TEXT,                     -- 'hourly' | 'daily' | 'weekly' | 'monthly'
    run_at        TEXT,                     -- ISO 'YYYY-MM-DDTHH:MM' or 'HH:MM'-or-encoded form (see _next_run_dt)
    next_run      TEXT,                     -- computed next-fire ISO
    last_run      TEXT,
    enabled       INTEGER NOT NULL DEFAULT 1,
    run_count     INTEGER NOT NULL DEFAULT 0,
    schedule_expr TEXT,                     -- free-text alternative ("daily at 9pm", "every 5m", cron)
    watch         INTEGER NOT NULL DEFAULT 0,
    watch_timeout INTEGER NOT NULL DEFAULT 120,   -- seconds
    done_pattern  TEXT,                     -- regex to detect "task done" in output
    done_action   TEXT NOT NULL DEFAULT 'disable',  -- 'disable' | 'notify' | 'command:<text>'
    created       INTEGER NOT NULL,
    updated       INTEGER NOT NULL,
    deleted       INTEGER
);
```

#### `schedule_runs` table

```sql
CREATE TABLE schedule_runs (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    schedule_id TEXT NOT NULL,
    ran_at      INTEGER NOT NULL,
    status      TEXT NOT NULL DEFAULT 'ok',  -- 'ok' | 'error' | 'done'
    note        TEXT
);
```

### 4.3 Schedule expression parser (`_parse_next_run`, line 4355)

Free-text formats supported (case-insensitive):
- `in 30m`, `in 2h` — one-shot relative.
- `every 5m`, `every 2h`, `every 1d` — interval-from-now.
- `every morning` / `every evening` / `every night` — aliases for 9am / 18:00 / 18:00.
- `every weekday at HH:MM` — Mon-Fri (cron `M H * * 1-5`).
- `every <dayname> at HH:MM` — weekly shorthand (Monday..Sunday).
- `daily at HH:MM` (also `daily at 6pm`).
- `weekly on <day> at HH:MM`.
- `monthly on <N> at HH:MM` (1-28).
- 5-field cron `MIN HOUR DOM MON DOW` (DOW: 0=Sun, 6=Sat). Supports `*`, `*/N`, `A-B`, `A,B,C`.

If `schedule_expr` is set, it OVERRIDES `recurrence`/`run_at`. Otherwise `_next_run_dt` computes from `recurrence` + `run_at`:
- `hourly`: minute portion of run_at, next hour.
- `daily`: HH:MM, next day if past.
- `weekly`: `run_at` format `"<wd>:<HH>:<MM>"` (wd: 0=Mon..6=Sun).
- `monthly`: `run_at` format `"<DD>:<HH>:<MM>"`.

### 4.4 Run loop (`_scheduler_loop`, line 4656)

- Single thread, 1 second tick.
- Inner sub-tick every 10s: queries `SELECT * FROM schedules WHERE deleted IS NULL AND enabled=1 AND next_run <= ?` with ISO now string.
- For each due row:
  - `_run_schedule(sched)` (synchronous from this thread; spawns watcher in BG if `watch=1`).
  - If `sched_type == 'once'`: disable.
  - Else: recompute `next_run` from `schedule_expr` (preferred) or `_next_run_dt`.
- Also drives `_JOB_REGISTRY` (internal Python jobs) on the same tick — see §1.9 for the list.

### 4.5 `_run_schedule` semantics

- `kind='shell'`: `subprocess.run(["/bin/bash","-c",command], timeout=600)`. Status `error` if non-zero exit. Note (first 500 chars) = stderr/stdout.
- `kind='tmux'` (default):
  - Pre-capture output (`tmux_capture(session, 200)`) if `watch=1` — used for delta detection.
  - `send_text(session, command)` (auto-wakes if session not running).
  - Status `error` if send fails.
- Insert into `schedule_runs`, bump `run_count`.
- Push alert: `_push_alert("scheduler", session, f"Ran schedule: {title}")`.
- If `watch=1` and `kind=tmux` and status `ok`: spawn `_watch_schedule_response` background thread.

### 4.6 Watch mode (`_watch_schedule_response`)

- Polls `tmux_capture(session, 200)` every 5s for up to `watch_timeout` seconds (default 120).
- Extracts "new output" by finding the pre-output's tail anchor (last 100 chars of last 200 chars of pre_output) in current output.
- Matches `done_pattern` as regex (case-insensitive); falls back to substring on invalid regex.
- On match:
  - `done_action == 'disable'`: set `enabled=0`, push alert, log run as `done`.
  - `done_action == 'notify'`: push alert only, log run as `done`.
  - `done_action.startswith('command:')`: send `done_action[8:]` to the session, disable, log `done` with the follow-up text.

### 4.7 Manual trigger

`POST /api/schedules/{id}/run` runs `_run_schedule(sched)` immediately, updates `last_run`/`updated` but does NOT advance `next_run` (the scheduler loop will).

### 4.8 Edge cases

- Schedules continue to fire even when the target session is stopped (because `send_text` auto-wakes).
- `_check_rate_limit_drift` is itself a registered job — runs every 3s (via `_rate_limit_loop`).
- The "kind=shell" branch is a power-user feature; v3 may de-prioritize but the field exists.
- `run_at` for ad-hoc "in 30m" expressions stores the absolute computed time, not the original expression.

---

## Subsystem 5: Agent commands (boot + send)

This is the user-facing API for "boot an agent with a prompt and/or skill" and "send a slash-command to an existing agent". It uses pre-existing endpoints — there's no dedicated `/api/agents` route — but the workflows are first-class.

### 5.1 Boot a new agent with a prompt

```http
POST /api/sessions
{ "name": "my-task", "dir": "/abs/path", "desc": "Build a thing",
  "provider": "claude", "worktree": true }
```

If `worktree=true` and `dir` is a git repo, a worktree is created at `<repo_root>/.worktrees/<name>` on a new branch `session/<name>`. Falls back to checkout-of-existing-branch if branch already exists.

Then start it with an initial prompt:

```http
POST /api/sessions/my-task/start
{ "prompt": "Implement the foo widget per FOO.md" }
```

The `prompt` is delivered AFTER Claude UI appears (`_send_after_ready`, line 6609): polls tmux every 1s for up to 30s waiting for `❯` (U+276F) or `❱` (U+2771), then sleeps 500ms (readline settle), then `send_text`. Timeout still sends best-effort.

### 5.2 Boot a new agent with a skill

Skills are markdown files persisted in SQLite (`skills` table) and ALSO synced to `~/.claude/commands/<name>.md` so Claude sees them as native `/<name>` slash commands. So "boot with skill X" = boot with a prompt of `/X` (optionally with arguments).

Workflow:
1. `GET /api/skills` → list. Each row: `{name, description, hint}` (description + argument-hint pulled from YAML frontmatter).
2. Pick one.
3. `POST /api/sessions/{name}/start {prompt: "/skillname any-arguments"}`.

The `apply-template` action (`POST /api/sessions/{name}/apply-template {template_id, dir}`) is a *different* concept — it copies bootstrap files (CLAUDE.md, default dirs) from `templates/<id>/` into the work_dir BEFORE start. It does not send a prompt.

### 5.3 Send a slash command to an existing agent

```http
POST /api/sessions/{name}/send
{ "text": "/compact" }
```

Special handling in the handler (line 45349):
- If `text.strip().startswith("/compact")` → backup JSONL transcript first (`pre_compact` reason) so revert is possible.

All slash commands go through `send_text` — they're just sent as text. The set is:
1. **Built-in claude/codex slash commands** (hardcoded list `_BUILTIN_SLASH_COMMANDS`, line 3347): `/add-dir, /agents, /batch, /clear, /color, /compact, /config, /context, /copy, /cost, /debug, /diff, /doctor, /effort, /export, /extra-usage, /fast, /feedback, /focus, /help, /hooks, /ide, /init, /login, /logout, /loop, /mcp, /memory, /model, /permissions, /plan, /plugin, /recap, /release-notes, /remote-control, /rename, /resume, /review, /rewind, /sandbox, /schedule, /security-review, /simplify, /skills, /stats, /status, /statusline, /tasks, /terminal-setup, /theme, /ultraplan, /ultrareview, /usage, /vim, /voice`.
2. **User skills** from `~/.claude/commands/*.md` and `<cwd>/.claude/commands/*.md` (line 3406). Description parsed from YAML frontmatter.

`GET /api/slash-commands` returns the merged list `[{cmd, desc}]`. Frontend uses this for the "/" autocomplete menu.

### 5.4 Skills API

| Method | Path | Purpose | Request | Response |
|---|---|---|---|---|
| GET | `/api/skills` | List skills with description + argument-hint | — | `[{name, description, hint}]` |
| GET | `/api/skills/{name}` | Full markdown content | — | `{name, content}` |
| POST | `/api/skills/{name}` | Create or update; also writes to `~/.amux/skills/<name>.md` AND syncs to `~/.claude/commands/<name>.md` | `{content}` | `{ok, name}` |
| DELETE | `/api/skills/{name}` | Delete from DB + `~/.amux/skills/<name>.md` | — | `{ok}` |

Skills are stored in the `skills` table `(name TEXT PRIMARY KEY, content TEXT, updated INTEGER)`. YAML frontmatter convention:

```
---
description: One-line summary
argument-hint: <usage hint>
---
<markdown body>
```

### 5.5 Sending Ctrl+C or special keys

```http
POST /api/sessions/{name}/keys
{ "keys": "C-c" }
```

Allowlist enforced (see §1.4). For arbitrary text *paste* without Enter, use `POST /api/sessions/{name}/paste {text, submit?:false}`.

### 5.6 Steering — "queue this message for the next turn boundary"

```http
POST /api/sessions/{name}/steer
{ "text": "Please use the new API too" }
```

The message is queued in memory (`_steering_queue`). The snapshot loop (`_snapshot_all_sessions`, runs every 60s) delivers ONE queued message per session when status becomes `waiting` or `idle`. Emits `steering_delivered` alert via SSE.

This is the "I want to interrupt the agent mid-task with context but not actually preempt it" use case. Different from `send` (which always sends now).

### 5.7 Cross-session orchestration ("agent calls another agent")

Sessions get `AMUX_SESSION=<name>` and `AMUX_URL=https://localhost:8822` env vars. Combined with the auth_token file at `~/.amux/auth_token` (mode 0o600), agents can call back into the API. The default global memory (`GLOBAL_MEMORY_DEFAULT`, line 5516) ships with curl snippets teaching agents how to:
- List sessions (`GET /api/sessions`).
- Peek another session (`GET /api/sessions/OTHER/peek`).
- Send to another session (`POST /api/sessions/OTHER/send`).
- Create board tasks for themselves (`amux board add` CLI stub or `POST /api/board`).
- Claim agent-owned tasks (`POST /api/board/<id>/claim {session}`).

This is the documented orchestration pattern; v3 should keep these semantics intact (especially the env-var injection and the auth-token-file convention).

### 5.8 amux CLI stub (auto-installed for session use)

`_auto_trust_dir` (line 3142) writes `/usr/local/bin/amux` as a sh stub that:
- Reads `AMUX_TOKEN` from env or `~/.amux/auth_token`.
- Injects `Authorization: Bearer $AMUX_TOKEN` on every curl call.
- Proxies subcommands: `amux board <sub>`, etc.

So `amux board add "title"` inside a session JustWorks™.

---

## Shared infrastructure

### Auth model

- Token file: `~/.amux/auth_token` (mode 0o600). Auto-generated `secrets.token_urlsafe(32)` if missing. Overridable via `AMUX_AUTH_TOKEN` env var (`"none"` disables auth entirely).
- Token presented as `Authorization: Bearer <token>` header OR `?_token=<token>` query parameter.
- Public paths (no auth, hardcoded): `/`, `/manifest.json`, `/sw.js`, `/icon.svg`, `/icon.png`, `/icon-192.png`, `/icon-512.png`, `/ca`, `/release-notes`, `/api/release-notes`, `/api/calendar.ics`.
- Public prefixes: `/s/`, `/api/share/`, `/invite/`, `/proxy/`, `/api/branding/`.
- **Localhost bypass**: GET requests from `127.0.0.1`/`::1` to NON-`/api/*` AND NON-`/ws/*` paths bypass auth. The `/api/*` + `/ws/*` exclusion is critical: Tailscale serve proxies tailnet traffic through localhost, so a blanket bypass would let any tailnet user hit privileged endpoints.
- Static asset GETs (anything non-/api, non-/proxy, non-/ws) for non-localhost still bypass — they're static.
- Response on auth failure: 401 `{"error":"unauthorized"}`.

### CORS

Origin allowlist (Origin header):
- `localhost`, `127.0.0.1`, `0.0.0.0`.
- LAN IP (`get_lan_ip()`).
- Any `*.ts.net` (Tailscale MagicDNS).

Methods: `GET, POST, PATCH, PUT, DELETE, OPTIONS`. Headers: `Content-Type, Authorization`. `Access-Control-Allow-Private-Network: true`.

Security headers always set: `X-Content-Type-Options: nosniff`, `X-Frame-Options: SAMEORIGIN`.

### AUTH_TOKEN distribution

Injected into the dashboard HTML via inline script:
```js
window._AMUX_AUTH_TOKEN = "<token>";
window._AMUX_HOME = "<home>";
window._AMUX_USER_EMAIL = "<gateway-injected, e.g. X-Amux-User-Email>";
window._AMUX_USER_ID = "<gateway-injected>";
window._AMUX_DEFAULT_MODEL = "<from defaults.env>";
window._AMUX_SERVER_PORT = "<python listener port — 8822 by default>";
window._AMUX_S3_ICAL_URL = "<bucket URL or '' >";
window._GOOGLE_API_KEY = "<for maps/etc>";
window._AMUX_POSTHOG_KEY, _AMUX_POSTHOG_HOST = "<telemetry>";
```

Frontend builds auth-aware URLs via `_authUrl(API + path)` (appends `?_token=`).

### Tailscale serve integration

- `_get_tailscale_hostname()` shells out to `tailscale status --self --json` and parses `Self.DNSName`.
- If found, `_ensure_tls` fetches a real Let's Encrypt cert via `tailscale cert` for that hostname.
- Also generates a self-signed fallback cert covering Tailscale IPs (for raw-IP connections).
- TLS resolution order: (1) Tailscale cert → (2) mkcert root CA → (3) openssl self-signed.

### Cloud / OSS unified codebase

`CLAUDE.md` rule (line 24): `amux-server.py` is identical for cloud and local. No `if IS_CLOUD` branches. Differences driven by:
- Env vars injected by gateway (e.g. `X-Amux-User-Email` header).
- Presence/absence of optional env vars (e.g. `AMUX_S3_BUCKET`, `AMUX_PORT`).

`AMUX_PORT` set ⇒ Docker container ⇒ `_init_default_sessions` creates `hello-world` in `/root/dev`.

### iOS app + web compatibility constraints

- Single file `amux-server.py` (Python stdlib HTTP server, no Flask/FastAPI). v3 will replace this with Rust but must preserve URL surfaces.
- Service Worker (`/sw.js`) for offline asset caching.
- PWA manifest (`/manifest.json`) with theme color, custom branding overrides.
- Apple-specific meta in inline HTML: `apple-mobile-web-app-capable`, `viewport-fit=cover`, `env(safe-area-inset-*)` (rule from `.claude/rules/css-mobile.md`).
- Touch targets ≥44×44 on mobile.
- HTTPS required (PWA, BFCache, WebSocket-from-secure-origin).
- xterm.js renders via canvas/WebGL — DOM-level `Selection.toString()` returns nothing. Mobile must surface a "copy all" button explicitly (selection by drag does not work).
- iOS Safari pauses EventSource in background → server pings every 10s as real data events (not SSE comments) so client `onmessage` fires; client watchdog detects 18s silence as zombie.

### Server lifecycle / runtime

- Listens on `:8822` by default (`--bind 0.0.0.0` default; restrictable). `--no-tls` for HTTP.
- Threading: `ResilientHTTPSServer(ThreadingHTTPServer)`.
- Self-restart: `_watch_self` watches `__file__` mtime and `os.execv`s on change. Tmux sessions survive (they're not children of python).
- Graceful signal handling (`_install_signal_handlers`).
- Auto-startup tasks (in order, line 46593+): `_yolo_loop` (3s), `_rate_limit_loop` (3s), `_snapshot_loop` (60s), browser/ray reapers, token-cache refresh (120s), email sync (15m default), `_evict_stale_caches` (5m), tmp cleanup (30m), `_auto_archive_idle` (1h), `_enforce_archived_stopped` (10m), transcript cleanup (24h), log rotation (24h), DB maintenance (24h), API-key validation (5m).
- Resource snapshots logged every 5 min.
- DB: SQLite WAL mode, per-thread connections (`get_db()`).

---

## What the v3 backend MUST guarantee

### Real-time invariants

1. **WS character-by-character streaming**: every byte tmux writes to a session pane reaches every subscribed WS client within ~50ms. xterm.js gets raw bytes with ANSI/SGR preserved.
2. **SSE within 2 seconds**: any session state change visible in `/api/sessions` payload within 2s on the SSE stream.
3. **Ping every 10s**: SSE emits a real `{"type":"ping"}` data event every 10s to keep iOS Safari EventSource alive.
4. **WS replay buffer ≥ 64 KB**: first message after WS connect is the replay buffer so terminals never render blank.
5. **Reconnect resilience**: WS clients reconnect with exponential backoff. Server distinguishes permanent close codes (1011, 1008, 1013, 4001) — clients MUST NOT retry on those.
6. **No double events**: SSE de-dupes by JSON equality before emit. v3 should match.

### Lifecycle invariants

7. **Session resume is idempotent**: starting an already-running session returns `(True, "already running")`; never starts a second tmux session for the same amux name.
8. **Stop is always graceful first, hard-kill fallback**: 15s grace, then `pkill -9` Claude PID. Tmux session stays alive.
9. **Auto-restart preserves conversation**: model changes capture `cc_conversation_id` from the LIVE process (not stale meta) before kill, so `--resume <id>` works after restart.
10. **Worktree cleanup on delete**: deleting a session with `CC_WORKTREE=1` runs `git worktree remove --force`.
11. **No message loss**: `send_text` is per-session locked. Large payloads (>400 chars) use `tmux load-buffer` (single atomic insert), not chunked send-keys.
12. **Steering delivered exactly once**: at the next `waiting`/`idle` boundary, one queued message is sent and removed from the queue.

### Multi-agent invariants

13. **Atomic claim**: `POST /api/board/{id}/claim` uses a single UPDATE with full WHERE predicate so two sessions racing for the same task get exactly one winner.
14. **Notify-once**: assigning an agent task to a session pings once (gated by `notified=1`); re-PATCHes don't re-ping. Reassigning resets the flag.
15. **Per-prefix monotonic IDs**: `INSERT OR IGNORE … UPDATE … RETURNING` guarantees no two issues get the same `<prefix>-N`.

### Auth invariants

16. **Token leak ≠ filesystem ownage**: `_is_path_allowed` blocks ~/.ssh, ~/.aws, /etc/shadow, etc., even with valid auth.
17. **Localhost-bypass excludes /api and /ws**: tailnet traffic via Tailscale serve must still present a valid token.

### Data invariants

18. **DB schema migrations are idempotent**: `_init_db` runs `ALTER TABLE ADD COLUMN` migrations wrapped in try/except (already-exists is benign). v3 should keep this pattern.
19. **Soft-delete**: board issues use `deleted = ts` (no row removal). Lets the audit trail and gcal sync work correctly.
20. **JSONL backup before destructive ops**: `/compact` and corruption-recovery always backup JSONL first (`backup_session_jsonl(name, reason)`).

### UX invariants

21. **First card paint ≤ 100ms**: `/api/sessions` cache serves stale data instantly; one background thread refreshes (no thundering herd).
22. **Cmd+K palette open ≤ 100ms**: must work on iOS Safari, not just desktop.
23. **Files API supports HTTP Range**: required for `<video>` scrubbing on iOS.

---

## What v2 got wrong (lessons for v3)

1. **The single-file religion is a productivity tax for v3**: `amux-server.py` is 46 863 lines of Python + inline HTML + inline CSS + inline JS. Editing is slow, tooling is broken, AI agents have to re-read mega-chunks. v3 is Rust + SvelteKit — embrace the split. The "single deploy artifact" property can be preserved with `include_str!`/embedded assets without paying the per-edit cost.
2. **3-second polling was the original status fetch — kill it everywhere**: v2 retrofitted WebSockets (`TmuxStreamer`) but still has fallback polling. v3 should make WS the only path for live terminal data; fall back to SSE for everything else. No more `setInterval(fetchPeek, 3000)`.
3. **Hardcoded model defaults are fragile**: v2 has multiple "patched: skip hardcoded --model" comments where the default was repeatedly wrong. v3 should have ONE model resolution path: per-session CC_FLAGS → defaults.env CC_DEFAULT_FLAGS → Claude account default. No hardcoded "sonnet" anywhere.
4. **The `_session_auto_actions` global dict is a mutable pile**: states like `rate_limit_reset_at`, `last_compact`, `restarting`, `hibernated`, `last_claude_alive`, `last_auto_continue`, `last_stale_check`, `last_backup`, `img_dim_compacted`, `img_corrupt_compacted`, etc. all live in one untyped dict per session. v3 must give this a typed struct (Rust enum/struct) — losing a flag = losing recovery behaviour.
5. **The status detector is fragile string-matching**: `_detect_claude_status` matches "esc to interrupt", dingbat ranges, "stop and wait for limit to reset", etc. Every Claude UI revision risks breaking it. v3 should ideally hook Claude Code's IPC (if/when available) rather than parsing scrollback — but until then, the detector belongs in a well-tested module with golden-file test fixtures.
6. **Rate-limit parser had to grow a "bare HH:MM with ≥5min-future filter" fallback** (line 1610) because Claude's UI wraps the reset time onto a separate line from the "resets" label. Defensive parsing — v3 must include the same fallback logic. Keep the golden fixtures.
7. **Snapshot loop does too much**: `_snapshot_all_sessions` runs every 60s and inside its inner per-session loop handles auto-compact, thinking-block recovery, session-ID-conflict recovery, auto-continue, auto-restart-on-exit, OOM-detect, stale-process reap, hibernate, post-compact-continue, steering delivery. Each got bolted on. v3 should split these into dedicated, individually-testable watchers (e.g. one async task per concern).
8. **Steering queue and slash-command autocomplete are in-memory only**: a server restart drops queued steers. v3 should persist these to the DB (cheap, prevents lost-input bug after a deploy).
9. **`is_running()` is expensive**: every call shells out 3 times (`tmux list-sessions`, `tmux capture-pane`, `tmux list-panes`, `pgrep`). v3 should keep a hot in-memory map driven by the streamer + a single periodic sync. v2 already partly does this via `_tmux_info_map` but mixes the two.
10. **Localhost bypass is a CVE waiting to happen**: the carve-out for /api and /ws is correct but easy to forget in a new endpoint. v3 should make auth required-by-default in the router layer, with an explicit `#[public]` marker for the few public paths.
11. **Send to a stopped session auto-wakes silently** (`send_text` calls `start_session` if not running). Convenient but surprising — v3 should still do it, but emit an event so the UI shows "starting…" feedback.
12. **The CLI (`amux` bash script) duplicates start/stop logic instead of calling the server**: v2 has both `start_session(name)` in Python AND `cmd_start` in bash that re-implements tmux launch. v3 should make the CLI a thin client over the API; one source of truth for spawn semantics.
13. **Memory composition silently overwrites Claude's edits**: `_capture_claude_memory_changes` looks for content after the marker to preserve, but if Claude edited content ABOVE the marker (the global memory), those edits are lost on next compose. v3 should either lock global memory or surface conflicts.
14. **Per-session env file format is hand-parsed**: `parse_env_file` rolls its own quote-aware parser. Easy to break. v3 should use a structured format (JSON or TOML) for the per-session config — `.env` was a convenience for the bash CLI; in v3 (no bash) we don't need it.
15. **`_session_auto_actions` is purged on os.execv**: server self-reload loses rate-limit reset times, hibernation flags, etc. v3 should persist this to SQLite (the only state that genuinely matters across restarts: `rate_limit_reset_at`).
16. **Board ↔ session coupling is implicit**: `_summarize_task_bg` decides to create or update a board issue from a successful send. The Haiku call is silent — no feedback to the user, no way to opt out, no way to retry. v3 should make this explicit (e.g. a UI toggle "auto-create board issue from prompt").
17. **Filesystem allowlist is hand-curated**: works for known dangerous paths, but a new file type (e.g. `.kube/config`) could slip through. v3 should consider a positive allowlist (only home dir + explicitly-shared dirs) by default, with opt-out.
18. **Mobile peek-detent terminal renders blank**: see `research/amux-state-notes.md` — when the focus sheet is at the peek (30vh) detent, the terminal area is empty because xterm.js hasn't been attached yet at that height. v3 must attach xterm regardless of sheet detent so users see content immediately.
19. **No way to select a range and copy from terminal on mobile**: xterm canvas renderer; `Selection.toString()` is always empty. Only "copy all" works. v3 should add a long-press range-select gesture mapped to xterm's mouse handler.
20. **Schedule run history lives forever**: `schedule_runs` has no rotation. v3 should either cap (e.g. last 100 per schedule) or auto-purge old rows in the DB maintenance job.

---

## Appendix A — Filesystem layout (everything in `~/.amux/`)

```
~/.amux/
├── auth_token              # mode 0o600
├── server.env              # persistent server config (loaded at startup)
├── defaults.env            # CC_DEFAULT_FLAGS
├── data.db                 # SQLite (issues, statuses, schedules, prefs, …)
├── mcp-chrome.json         # MCP config injected when CC_MCP=chrome
├── sessions/
│   ├── <name>.env          # per-session config
│   └── <name>.meta.json    # per-session metadata
├── memory/
│   ├── _global.md          # shared context for all sessions
│   └── <name>.md           # per-session memory (Claude sees composed)
├── logs/
│   ├── <name>.log          # rolling pane log (10 MB cap)
│   └── server.log
├── transcripts/<name>/     # JSONL backups (pre-compact etc)
├── uploads/                # /api/upload destination (24h TTL)
├── board/                  # legacy flat items.json (migration source)
├── notifications.json      # legacy (v3 drops)
├── habits.json             # v3 drops
├── map.json                # v3 drops
├── notes/                  # v3 drops
├── crm/                    # v3 drops (in DB)
├── journal-media/          # v3 drops
├── channels/               # v3 drops
├── gmail-tokens/           # v3 drops
└── branding/               # white-label assets (icon, logo)
```

Plus, Claude's own files:
```
~/.claude/
├── .claude.json            # onboarding/trust state (server writes)
├── settings.json           # YOLO/permissions (server writes)
├── projects/<encoded-dir>/
│   ├── memory/MEMORY.md    # composed-memory target (symlink or copy)
│   └── <conv-uuid>.jsonl   # conversation history
└── commands/<name>.md      # synced from skills table
```

## Appendix B — Endpoints kept in v3 (canonical list)

```
GET    /                          (dashboard HTML)
GET    /manifest.json
GET    /sw.js
GET    /icon.{svg,png,192,512}
GET    /ca                        (mkcert root CA download)
GET    /api/cert                  (TLS cert for manual mobile trust)

# Auth
GET    /api/identity
GET    /api/settings/env          (returns masked)
PATCH  /api/settings/env          (ANTHROPIC_API_KEY, OPENAI_API_KEY)
GET    /api/settings/default-model
PATCH  /api/settings/default-model

# Sessions (see §1.1 — exhaustive)
GET    /api/events                (SSE)
GET    /api/sessions
POST   /api/sessions
POST   /api/sessions/connect
GET    /api/sessions-git
GET    /api/sessions/self
GET    /api/sessions/{name}/(info|meta|peek|log|log/info|transcripts|transcripts/{f}|stats|git|git/commits|git/commit-detail|git/diff|memory|steer|ws-stats|tracked-files)
POST   /api/sessions/{name}/(start|stop|send|paste|keys|clear|duplicate|clone|archive|wake|apply-template|delete|memory|steer|git|git-push|transcripts|tracked-files|share)
DELETE /api/sessions/{name}/(steer|tracked-files|share)
PATCH  /api/sessions/{name}/config
GET    /api/sessions/{name}/share
GET    /ws/sessions/{name}        (WebSocket)

# Board (see §2.1)
GET    /api/board
POST   /api/board
PATCH  /api/board/{id}
DELETE /api/board/{id}
POST   /api/board/{id}/claim
POST   /api/board/clear-done
GET    /api/board/statuses
POST   /api/board/statuses
PATCH  /api/board/statuses/{id}
DELETE /api/board/statuses/{id}
PUT    /api/board/statuses/reorder
GET    /api/board/tag-completion
GET    /api/calendar.ics          (PUBLIC — no auth)

# Files (see §3.1)
GET    /api/ls
GET    /api/file
PUT    /api/file
GET    /api/file/raw
GET    /api/file/transcode
GET    /api/file/vtt
POST   /api/fs/upload
DELETE /api/fs/delete
POST   /api/fs/open
POST   /api/upload
GET    /api/uploads/{filename}
GET    /api/autocomplete/dir

# Scheduler (see §4.1)
GET    /api/schedules
POST   /api/schedules
GET    /api/schedules/runs
GET    /api/schedules/{id}
PATCH  /api/schedules/{id}
DELETE /api/schedules/{id}
GET    /api/schedules/{id}/runs
POST   /api/schedules/{id}/run

# Skills / slash commands
GET    /api/skills
GET    /api/skills/{name}
POST   /api/skills/{name}
DELETE /api/skills/{name}
GET    /api/slash-commands

# Prefs / lookup / git helpers
GET    /api/prefs (key=...)
POST   /api/prefs
GET    /api/git-branches
GET    /api/git-check
POST   /api/suggest-branch
POST   /api/lookup                (Haiku-backed term explainer)
GET    /api/history               (cmd history; useful, low cost)
POST   /api/history
POST   /api/history/import
DELETE /api/history

# Memory
GET    /api/memory/global
POST   /api/memory/global

# Share / templates
GET    /s/{token}                 (PUBLIC viewer page)
GET    /api/share/{token}/{action}  (PUBLIC, scoped by token perms)
GET    /api/templates

# Layout presets (UI niceness)
GET    /api/layout-presets
POST   /api/layout-presets
DELETE /api/layout-presets/{name}
```

Everything not in this list is **explicitly dropped in v3** (notes/calendar/CRM/map/habits/torrents/metrics/mail/journal/channels/browser/org/invites/graph/reports/terminal/gmail/proxy/branding-write/etc).
