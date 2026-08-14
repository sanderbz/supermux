# supermux architecture map — for planning a second, non-terminal renderer for Claude Code sessions

> Note: the harness blocked writing the report file (`/tmp/.../scratchpad/report-supermux-arch.md`); the complete report follows inline.

Repo: `/opt/projects/supermux` (branch `main`, HEAD `a7a2b9b`). Rust backend in `server/`, React 19 + Vite PWA in `web/`. In-tree reference docs: `/opt/projects/supermux/ARCHITECTURE.md`, `/opt/projects/supermux/SCROLLBACK_SPEC.md`, `/opt/projects/supermux/web/PERF.md`.

---

## 0. Executive summary for the renderer project

- Everything the UI shows today about a session is **either** (a) raw pty bytes over one WebSocket, **or** (b) a small structured `SessionView` JSON row pushed over SSE. There is currently **no** structured message/turn stream on the wire.
- The richest structured data that already exists server-side and is *not yet* surfaced as a stream: Claude Code hook payloads (10 event types, incl. `tool_name`/`tool_input`, `session_id`), and the on-disk JSONL transcript (`~/.claude/projects/<enc-cwd>/<uuid>.jsonl`) which the **recall** feature already parses and classifies into typed turns (`Kind::Prompt | Command | Teammate | Notification | System | Tool | Image`).
- The single biggest architectural gift: `sessions::recall` already knows which JSONL file is the *live* conversation (kept fresh by the hook-driven `track_cc_conversation_id`, commit `c31518e`). A chat renderer can be built as "recall, but full-fidelity, incremental, and live".
- The single biggest constraint: **the pty geometry is global per session** — any attached client's `resize` wins last-write, so two views of the same session at different widths fight. A non-terminal renderer must therefore **not send `resize`** (it has no grid).
- There is already a per-session-independent input path (`POST /api/sessions/{name}/send`, `/keys`, `/paste` → `lifecycle::send_text`), so a chat composer does not need the terminal WS at all.

---

## 1. Frontend shell, routing, overview, focus panel

### 1.1 App shell & routes

`web/src/App.tsx:53-155` — `BrowserRouter` (basename = `import.meta.env.BASE_URL`), one `QueryClient` (staleTime 30s, `refetchOnWindowFocus`), providers: `ThemeProvider` → `QueryClientProvider` → `TooltipProvider` → `ToastProvider`, plus `<A2HSInstructionsSheet>`, `<OnboardingHost>`, `<ConnectionOverlay>` (mounted outside the providers).

Routes (`App.tsx:73-143`), all nested under `<Layout>` (`web/src/components/layout.tsx`, 278 lines — desktop SideNav / mobile BottomNav + `<Outlet/>`):

| path | element | file |
|---|---|---|
| `/` | `Overview` | `web/src/routes/overview.tsx:107` |
| `/focus` | `FocusEntry` (redirect to last-active) | `web/src/routes/focus.tsx:38` |
| `/focus/:name` | `Focus` (viewport fork) | `web/src/routes/focus.tsx:16` |
| `/board` | `Board` | `web/src/routes/board.tsx` |
| `/files/:name?` | `Files` | `web/src/routes/files.tsx` |
| `/scheduler`, `/settings` | … | `web/src/routes/*` |
| `/hosts` | `<Navigate to="/settings#hosts">` | `App.tsx:87-90` |

**DEV-only routes** (lazy, `import.meta.env.DEV` gated so they never ship): `/dev/tiles` (`routes/dev-tiles.tsx`), `/dev/term/:name` (`routes/dev-term.tsx`), `/dev/focus/:name?` (`routes/dev-focus.tsx`), `/dev/focus-mobile/:name?` (`routes/dev-focus-mobile.tsx`), `/dev/teams` (`routes/dev-teams.tsx`). See `App.tsx:19-40, 93-142`.

**`/?mock` demo data**: `web/src/routes/overview.tsx:842-855` (`useDevMockSeed`) — DEV-only; when `?mock` is present it lazy-imports `@/components/session-tile/mock` and `qc.setQueryData(SESSIONS_KEY, MOCK_TILES)`. `web/src/components/session-tile/mock.ts` contains plain + ANSI-coloured tail fixtures covering every status. Per project memory, **public screenshots must come from `/?mock` or `/dev/*`** — real sessions leak PII.

### 1.2 Overview (session grid / cards)

`web/src/routes/overview.tsx` (953 lines).

- Data: `useSessions()` (`web/src/hooks/use-sessions.ts`) → TanStack Query key `SESSIONS_KEY = ['sessions']` against `GET /api/sessions`, **merged key-by-key** by SSE `sessions` deltas (`use-sessions.ts:49-60` `mergeRow`). No polling.
- Team leads are split out of the grid and rendered by `<TeamCard>` (`overview.tsx:114-118`, `web/src/components/team/team-card.tsx`).
- View mode `tile | list` from `useUI` (`web/src/stores/ui-store.ts:23`); rows render `<SessionRow>` (`components/session-tile/session-row.tsx`), tiles render `<SessionTile>` (`components/session-tile/tile.tsx`).
- Grid classes are density-tier derived: `overview.tsx:70-88` `gridClassFor(tier)`, tiers from `web/src/lib/overview-size.ts`. Density is stored **separately for mobile and desktop** (`ui-store.ts:59,65`), stepped with `[` / `]` (`overview.tsx:164-193`).
- Layout/grouping/sorting: `web/src/lib/overview-layout.ts` + `web/src/hooks/use-overview-layout.ts` (persisted server-side under pref key `overview_layout`, see §7.3).
- Mobile display controls collapse into `<OverviewDisplayMenu>` (`components/session-tile/overview-display-menu.tsx`), a Vaul bottom sheet.

**How a tile renders a live preview** — this is the exact seam a second renderer plugs into:

`web/src/components/session-tile/tile.tsx`
- `:213` `hoverPreview = useUI(s => s.hoverPreview)` (`'live' | 'expanded'`)
- `:220-221` `overviewPreview = useUI(s => s.overviewPreview)`; `liveModeEnabled = overviewPreview === 'live'` — the **master switch already in place** for "live xterm peek" vs "static text tail only".
- `:246-265` `usePeekPrewarm(session.name, cardRef, {enabled: liveModeEnabled && fine && hoverPreview==='live' && liveCapable})` — a viewport-gated headless WS pre-warm (cap 12) in `web/src/hooks/peek-prewarm-store.ts` + `web/src/hooks/use-peek-prewarm.ts`.
- At rest the tile shows `<TailPreview>` (`components/session-tile/tail-preview.tsx`, 109 lines) which renders `preview_ansi` / `preview_lines` through the tiny SGR parser in `web/src/lib/ansi.ts` (183 lines, SGR-only, xterm 16/256/truecolour).
- On hover (fine pointer, live mode) it mounts `<TileLiveTerminal>` (`components/session-tile/tile-live-terminal.tsx`) = `<LiveTerminal readOnly allowProgrammaticInput fontSize={12} prewarmSeed suppressCachedTail>`; crossfade is gated on `onSettled` (replay settled), not first byte.
- Long-press / coarse pointer opens `<QuickPeekModal>` (`components/session-tile/quick-peek-modal.tsx`).
- `usePeekType` (`web/src/hooks/use-peek-type.ts`) installs a document-level keydown listener so you can *type into a hovered tile* through the read-only embed's imperative `send`/`sendKey`.

Other tile parts: `status-dot.tsx`, `activity-status.tsx` (`ActivityLine`, `ErrorBadge`), `host-badge.tsx`, `tile-error.tsx`, `tile-skeleton.tsx`, `group-grid.tsx` / `group-header.tsx`, `types.ts` (`TileSession`).

### 1.3 Focus panel

`web/src/routes/focus.tsx:16-24` forks purely on `useMediaQuery('(min-width: 768px)')`:

**Desktop** — `web/src/routes/focus/desktop.tsx:58` `<DesktopFocus>` → `<DesktopSplit>` (`web/src/components/focus-mode/desktop-split.tsx`, 733 lines):
- left 320px strip: `<FocusStripSection>`, `<CompactTile>`, `<TeamStripGroup>`, `<FocusStripModeToggle>` (`:476`), grouped by `use-grouped-strip.ts` / `focus-strip-groups.ts`.
- right main pane: `<DesktopFocusHeader>` (`:556-583`, carries status/activity/subagents/error, `onRefresh` → `termRef.current?.resync()`), `<LastSendBar>`, then the terminal pane at `:606-636`:
  ```
  status === 'stopped' ? <StoppedSession name={name}/> : <LiveTerminal name={name} onReady={handleTermReady}/>
  ```
  wrapped in `<Dropzone>` (image drop) with `<TerminalCaptureIndicator>` overlay.
- below: attachment chips, `<DesktopDock>` (`components/focus-mode/dock.tsx`) whose every action goes through the ONE imperative terminal handle `termRef.current` (`sendKey`, `send`).
- `<SnippetPanel>`, `<MobileComposeSheet>` (used on desktop too for the `$EDITOR` bridge), `<SessionInfoPanel>`.

**Mobile** — `web/src/routes/focus/mobile.tsx` (682 lines): `<MobileSheet>` (full-screen, height driven by `useKeyboardViewport`) → `<FocusHeader minimal>` → `<LiveTerminal>` (`:503`) → floating `<KeyBar>` → `<MobileBottomPanel>` + `<MobileDock>`. Vaul sheets for: session picker, key-bar customize, snippets, compose, action sheet, last-send recall. Edge gestures via `use-edge-gestures.ts`.

Both branches obtain a single `UseLiveTermResult` handle via `<LiveTerminal onReady>` and drive every affordance from it — "single source of truth, no duplicate WS, no second xterm" (`focus/mobile.tsx:40-43`).

### 1.4 Where a per-session renderer toggle naturally lives

Three existing precedents, ascending scope:

1. **Global UI preference in Zustand+localStorage** — `web/src/stores/ui-store.ts:39-52,87-128` (`persist`, storage key `supermux-ui`). `overviewPreview: 'live' | 'text'` is *literally the same shape* as a `sessionRenderer: 'chat' | 'terminal'` default would be, and it is already surfaced in Settings and read in `tile.tsx:220`. Adding `defaultRenderer` here is a 5-line change.
2. **Per-session, client-side override** — no per-session client map exists; the natural add is a `Record<sessionName, 'chat'|'terminal'>` in the same `ui-store` (persisted), overlaid on the global default. `tile.tsx` and `desktop-split.tsx`/`focus/mobile.tsx` each already have a single branch point (`status==='stopped' ? … : <LiveTerminal/>`) that becomes a 3-way switch.
3. **Cross-device persistence** — `GET/PUT /api/prefs/{key}` (`server/src/prefs.rs:44-121`) with a **hard allowlist** at `server/src/prefs.rs:60-64` (`overview_layout` | `quick_keys`), 50 KB cap, and an SSE `prefs` broadcast so other tabs reconcile. Adding `session_renderer` to that allowlist gives account-wide, multi-device persistence with zero migration. Client mirror pattern: `web/src/hooks/use-overview-layout.ts`.

Note: `PATCH /api/sessions/{name}/config` (`server/src/sessions/mod.rs:760-778` `ConfigInput`) is the per-session server-side patch surface (display_name, desc, dir, branch, mcp, tags, toggle_pin, toggle_auto_continue). Adding a `renderer` column would mean migration `0025_*` — possible, but `/api/prefs` is cheaper and is the sanctioned path for pure-UI state.

UI placement precedents: overview → the display menu/chips (`overview-display-menu.tsx`, plus the desktop chips built in `overview.tsx`); focus → `<FocusStripModeToggle>` (`desktop-split.tsx:476`) and `<DesktopFocusHeader>` action row, or `<SessionInfoPanel>` for a per-session setting.

---

## 2. Terminal pipeline, end to end

```
child (claude/codex/kimi/shell)
  │ pty
  ├── TMUX PATH:  tmux pane → `pipe-pane` → FIFO in <data>/pty/<name>.fifo
  │                 → PtyStream reader → 512 KB replay ring + broadcast::Sender<Bytes>
  └── NATIVE PATH: supermux-holder (setsid, owns pty master)
                    → unix socket, length-prefixed frames
                    → NativeSession pump → alacritty_terminal Vt grid  (+ on-disk spool)
                    → same broadcast::Sender<Bytes> via NativePtyReader
                                     │
                         ws/mod.rs handle_socket  (per browser tab)
                                     │ binary frames = pty bytes, text frames = JSON control
                                     ▼
                         web/src/hooks/use-live-term.ts → xterm.js
```

### 2.1 The runtime seam (`SessionRuntime`)

`server/src/sessions/runtime.rs:83-209` defines the object-safe trait every call site talks to (`Arc<dyn SessionRuntime>`, resolved+cached by `AppState::runtime_for`, `server/src/state.rs`). 16 required methods + 5 provided:

- lifecycle: `spawn`, `alive`, `kill`
- input: `send_text`, `send_key`, `paste(text, bracketed)`, `resize(cols, rows)`
- capture: `capture_plain(lines)`, `capture_ansi(lines)`, `capture_screen_ansi()`, `capture_full()`, `seed()`, `history_window(end_offset, count) -> HistoryWindow`, `history_meta() -> (u32,u16)`
- introspection: `pane_pid()`, `dead()`
- provided: `target()`, `resolved_session_name()`, `submit_gap()`, `shell_is_foreground()`, `attach_generation()`

Two impls: `TmuxRuntime` (`runtime.rs:224-345`, pure delegation to `sessions::tmux::Tmux`) and `NativeRuntime` (`runtime.rs:379-479`, wrapping `native::NativeSession`). Which one a session gets = the `sessions.runtime` column (`'tmux' | 'native'`, migration `server/migrations/0024_session_runtime.sql`), constants at `runtime.rs:349-351`. Native is the current default per project memory ("tmux-less native is default; v0.5.0"). `SessionView.runtime` exposes it on the wire (`server/src/sessions/mod.rs:160-165`).

`HistoryWindow` (`runtime.rs:47-68`) is wire-serialized verbatim into the `history` WS frame; its JSON shape is pinned by a test (`runtime.rs:567-600`).

### 2.2 Native runtime (commit `a7a2b9b`)

`server/src/sessions/native/` — module map at `native/mod.rs:25-37`:

| file | role |
|---|---|
| `proto.rs` | holder⇄daemon frames: `kind u8 + len u32 BE + payload`, `MAX_FRAME` 1 MiB. Daemon→holder `INPUT 0x01`, `RESIZE 0x02`, `SIGNAL 0x03`, `QUERY 0x04`. Holder→daemon `HELLO 0x81` (JSON `Hello{session,pid,cols,rows,started_at,replay_bytes,spool_total}`), `OUTPUT 0x82`, `EXIT 0x83`, `INFO 0x84`. Attach handshake at `proto.rs:39-51` (one lock guards spool snapshot + queue install → no gaps, no duplicates). |
| `holder.rs` | the `pty-holder` subcommand: `setsid`-detached, owns pty master + child, one daemon connection at a time |
| `spool.rs` | `<data_dir>/native/<name>/{out.raw, out.raw.1, meta.json, exit, sock}`; `SPOOL_CAP` 64 MiB, `SPOOL_KEEP` 32 MiB, `REPLAY_TAIL` 8 MiB, modes 0700/0600 (`spool.rs:77-90`) |
| `vt.rs` | `alacritty_terminal::Term` + `Processor`. `HISTORY_LINES = 2000` (`vt.rs:41`), `HISTORY_WINDOW_MAX = 500` (`vt.rs:45`). Public surface: `advance`, `resize`, `alt_active`, `app_cursor`, `history_size`, `cursor`, **`take_damage() -> Damage`** (`vt.rs:265`), `capture_plain/ansi/screen_ansi/full`, `seed`, `history_window`, `dump` |
| `serialize.rs` | cell → plain/ANSI serializer (round-trip proven) |
| `keys.rs` | key name → pty bytes (mirrors tmux's `send-keys` table) |
| `runtime.rs` | `NativeSession` — connection pump, `subscribe() -> broadcast::Receiver<Bytes>`, `attach_generation()`, `SUBMIT_GAP = 50ms` (`native/runtime.rs:83`) |
| `reader.rs` | `NativePtyReader: PtyReader` feeding the shared `PtySink` |

Pump loop, `native/runtime.rs:9-16`: `connect → HELLO → fresh Vt at client geometry → replay frames (rebuild grid, NOT forwarded to WS) → READY + attach_gen bump → live frames (grid + broadcast) → disconnect → backoff`. Every completed attach bumps `attach_gen`, which the WS layer turns into a fresh authoritative re-seed (`ws/mod.rs:726`).

**Relevant to a structured renderer:** `Vt::take_damage()` already yields `Damage { rows: Vec<DamagedRow> }` — a per-row dirty set. Nothing consumes it for the wire today; it is the natural hook if you ever want a cell-diff protocol instead of raw bytes. But the VT holds only 2000 lines of history (vs tmux's 50000) — it is not a transcript store.

### 2.3 The WebSocket protocol

Server: `server/src/ws/mod.rs` (1759 lines). Routes at `ws/mod.rs:85-99`:
- `GET /ws/sessions/{name}` → `handle_ws` (`:100`) → `handle_socket` (`:359`) — read/write session terminal
- `GET /ws/teams/{team}/{member}[?pane_id=%id]` → `handle_team_ws` (`:124`) / `handle_team_socket` (`:142`) — read-only teammate pane

Not wrapped by the bearer middleware. Handshake (`ws/mod.rs:1-14`):
1. Origin allowlist (`origin_allowed` `:1374`) → bad → close **1008**
2. First text frame must be `{"type":"auth","token":"…"}` within `AUTH_TIMEOUT` 2s (`:48`) → else close **1008**
3. `{"type":"auth_ok"}` sent (`:376`); per-session subscriber cap (`config.ws.subscribers_per_session`, default **32**, `server/src/config.rs:92,99-101`) → 33rd closed **1013**
4. Optional pre-seed resize peek (`peek_initial_resize` `:811`, `PRESEED_RESIZE_PEEK = 150ms` `:57`) — the client batches `[auth, resize]` on open so the seed is captured at the right geometry
5. `send_seed_then_done` (`:937`): binary seed frame (from `rt.seed()`), then `{"type":"attach_meta","history_size":N,"cols":W}`, then `{"type":"replay_done"}`
6. Live fan-out from `broadcast::Receiver<Bytes>` as binary frames; `Lagged` → close **1013**
7. Server PING every 20s (`PING_EVERY` `:45`); no inbound for 30s (`PONG_DEADLINE` `:46`) → close

Close-code semantics (client mirror at `web/src/hooks/use-live-term.ts:238-244`): `1000` normal/unmount, `1008` auth/origin (permanent), `1011` server error (backoff then permanent), `1013` subscriber-too-slow/cap (silent reconnect on next `visibilitychange→visible`), `4001` token revoked (permanent), `4404` **`CLOSE_NOT_RUNNING`** (`ws/mod.rs:77`) — pty is gone, terminal state, do NOT retry.

**Client → server control frames** — `server/src/ws/protocol.rs:13-52` (`ClientMsg`, internally tagged, lowercase):

| frame | payload |
|---|---|
| `auth` | `{token}` |
| `input` | `{data}` — literal text injected at the pane |
| `key` | `{data}` — named key |
| `resize` | `{cols, rows}` |
| `ping` | — |
| `resync` | — re-push the attach seed (manual "refresh"; also auto-fired server-side after a resize, debounced `RESYNC_SETTLE = 300ms` `ws/mod.rs:70`) |
| `history` | `{req_id, end_offset, count, cols}` — windowed scrollback (copy-mode-over-web) |

**Server → client**: binary = raw pty bytes; text = `{"type":"auth_ok"}`, `{"type":"attach_meta", history_size, cols}`, `{"type":"replay_done"}`, `{"type":"history", req_id, history_size, start_offset, end_offset, hit_top, cols, at_limit, rows[]}` (or `{..., rows:[], error:true}`) — built at `ws/mod.rs:1006-1050`.

Input coalescing: `plan_applies` (`ws/mod.rs:1056`) folds a drained run of frames — contiguous `Input`s join into one `Text` apply; contiguous `Resize`es collapse to the last (a drag fires 10+/100ms and each used to fork a `tmux resize-window`, starving typed characters). `apply_one` (`:1286`) does the runtime call under the per-session lock.

Server-side prompt sniffing lives on this path too: `inspect_for_prompt` / `consume_last_prompt` / `sanitise_prompt` (`ws/mod.rs:1144-1284`) watch WS `input` frames terminated by Enter and write `last_send_text`/`last_send_at` on the session row — i.e. **typing in the terminal already produces a structured "user prompt" event**.

Seed/live overlap correctness: the WS subscribes *before* capturing the seed, so bytes produced during the capture would appear twice; `drain_queued_overlap` (`:921`) discards exactly what is queued at capture instant (`:947`). Tests at `ws/mod.rs:1573-1620`.

### 2.4 The pty fan-out / replay ring

`server/src/sessions/pty.rs`: one `PtyStream` per session (registry `server/src/ws/streamer.rs`, `PtyStreamer::for_session` `:48`, `for_pane` `:75`). `REPLAY_CAP = 512 KB` bounded ring (`pty.rs:68-75`), `READ_CHUNK = 8192` (`:78`), `broadcast_capacity` default 1024 (`config.rs:95-97`). `subscriber_count()` (`pty.rs:224`) enforces the 32-per-session cap. The FIFO lives in the persistent data dir, never `/tmp` (systemd `PrivateTmp`), see `streamer.rs:20-33`.

### 2.5 The xterm client

`web/src/hooks/use-live-term.ts` (2351 lines) — one file owning terminal + WS lifecycle in a single mount effect (`:654`).

- Public handle `UseLiveTermResult` (`:43-122`): `containerRef`, `state` (`connecting|live|reconnecting|offline|stopped`), `hasFirstFrame`, `ready`, `send`, `sendKey`, `resize`, `resync`, `copyAll`, `copySelection`, `retry`, `focus`, `blur`, `tryOpenLinkAt`, `scrolledUp`, `scrollToBottom`, `historyEnabled`, `cols`.
- Options (`:388-427`): `readOnly`, `fontSize`, `allowProgrammaticInput`, `prewarmSeed`, `onSettled`, `wsPath` (used for the teammate route — the entire WS machinery is reused, only the URL changes).
- xterm config `:849-889`: JetBrainsMono Nerd Font Mono, `fontSize` 13 default, `lineHeight 1.2`, theme read from CSS vars `--terminal-bg`/`--terminal-fg` (`themeFromCss` `:276`), hardcoded 16-colour `ANSI_PALETTE` (`:252-269`) byte-identical to `web/src/lib/ansi.ts`'s `ANSI_16`, `scrollback: 50000`, `cursorBlink:false`, `disableStdin: readOnly`.
- `disableXtermMouseTracking(term)` (`web/src/lib/disable-xterm-mouse.ts`) swallows DECSET ?1000/?1002/?1006 so touch-scroll and drag-select survive whatever Claude emits.
- Renderer strategy: WebGL first, DOM fallback; one-rAF fit→attach→refit to avoid a cols flash (`:1074-1135`).
- Custom touch-drag scrollback with momentum (`:912-995`) because xterm 6.0 has no built-in touch scroll.
- Frame dispatch (`:1736-1830`): binary → `term.write`; text → `JSON.parse` switch on `msg.type` for `auth_ok` / `replay_done` / `attach_meta` / `history`. **Unknown text types are ignored** — additive frames are safe.
- `markReady()` (`:1421`) pins to bottom then reveals (`ready`) and fires `onSettled`; `REPLAY_DONE_FALLBACK_MS = 400` covers old servers (`:208`).
- Reconnect: exponential backoff w/ decorrelated jitter (`backoffDelay` `:381`), `MAX_ATTEMPTS = 6`, `RESUME_STALE_MS = 15s` proactive reconnect on visible.
- tmux-authoritative scrollback is behind a localStorage flag (`web/src/lib/term-history-flag.ts`, `TERM_TMUX_HISTORY`), default OFF; when on, `history` frames + gap-fill prepend (`:664-844`).

Wrapper: `web/src/components/terminal/live-terminal.tsx` (411 lines) — props at `:30-101`, notably `previewAnsi`/`previewLines` (cached-tail crossfade; falls back to the shared `useSessions` cache by name), `suppressCachedTail`, `wsPath`, `onReady`, `onFirstFrame`, `onSettled`, `onStateChange`. Read-write terminals register with the global connection store (`web/src/hooks/use-connection-link.ts`) driving `<ReconnectBanner>`; read-only embeds do not.

Siblings: `components/terminal/stopped-session.tsx` (calm stopped surface + restart), `resume-picker.tsx`, `teammate-terminal.tsx`.

---

## 3. Structured (non-terminal-bytes) data that already flows

### 3.1 `SessionView` — the per-session JSON row

`server/src/sessions/mod.rs:142-217` (built by `view()` `:233`), TS mirror `web/src/lib/api/sessions.ts:71-172` (`ApiSession`).

Fields: `name` (immutable slug — routes/WS/tmux/hook key), `display_name`, `status`, `dir`, `provider`, `desc`, `pinned`, `archived`, `auto_continue`, `tags[]`, `flags`, `branch`, `mcp`, `worktree`, `creator`, **`runtime`** (`"tmux"|"native"`), `preview_lines[]` (last 6 lines, ANSI-stripped), `preview_ansi[]` (last 20 lines, SGR preserved), `activity` (e.g. `✎ tile.tsx`), `activity_kind` (`bash|edit|read|search|web|task|mcp|tool|failed`), `error {type,message}`, `subagents` (u32, omitted when 0), `mode` (`normal|accept_edits|plan|bypass`), `last_send_text` (≤200 chars), `last_send_at`, `created_at`, `updated_at`. Frontend-only extras on the TS type: `task_summary`, `tokens`, `running`, `missing`, `host_id`, `last_activity`.

Delivery: `GET /api/sessions` once, then SSE `sessions` deltas merged key-by-key.

### 3.2 SSE

`server/src/sse.rs` → `GET /api/events` (auth via `?_token=` because `EventSource` can't set headers). Client: `web/src/hooks/use-sse.ts` — **module-level singleton** EventSource fanned out to all subscribers, 300ms×2^n backoff capped 30s + jitter, 18s staleness watchdog, deterministic wake recovery on `visibilitychange`/`focus`/`online`.

Event types (`use-sse.ts:50-66`): `sessions`, `status`, `alerts`, `board`, `boards`, `schedules`, `teams`, `prefs`, `settings`, `external-edit`, `ping`.

`status` payload: `{name, status, version}`. `sessions` payload: `{delta: [{name, …partial ApiSession}]}` — the hook path broadcasts `{name, activity, activity_kind, error, subagents}` (`server/src/hooks.rs:294-310`).

### 3.3 Status detection

`server/src/sessions/status.rs` (1715 lines) + `server/src/sessions/auto_actions.rs` (the detector loop).

`Status` enum (`status.rs:158`): `Active | Waiting | Idle | Stopped | Starting | Unknown`. `Mode` (`:192`) parsed from the persistent status bar by `parse_mode` (`:238`).

Fusion order (`status.rs:20-35`):
1. **Hook turn state machine** — apex. `TurnState` (`:309`) holds the newest instant of each turn-relevant hook; `HookEvent` (`:255`). `Notification` newest → `Waiting`; `turn_start > turn_end` → `Active` (covers silent thinking); else `Idle`. Bounded by `TURN_SAFETY = 15min` (`:66`).
2. **Regex bank** over a `capture_plain(CAPTURE_LINES=30)`:
   - `ACTIVE_BANK` `status.rs:800-805`: `(?im)(esc to interrupt|esc t…|running\.\.\.|reading \d+ file|^\s*[✻✶✳✢✽✺❋⚹∗·*][^\n]*…)` — spinner glyph must be **line-leading** (the boot false-positive fix).
   - `WAITING_BANK` `:808-812`: `(?i)(enter to select|do you want to proceed|❯\s*\d+\.|interrupted.*what should claude|approve)`
   - `IDLE_BANK` `:873`: `(?im)(✻.* for \d|❯\s*$|\$ $|gpt-\S+ · ~)`
   - `CODEX_ACTIVE_BANK` `:818`, `CODEX_WAITING_BANK` `:825-828`
   - `KIMI_ACTIVE_BANK` `:843-844` (moon phases U+1F311..U+1F318, line-anchored), `KIMI_WAITING_BANK` `:851-854`
   - `INTERRUPT_MARKER` `:860`
3. **PTY heartbeat** — bytes within 1.5s → Active, *only* for sessions without live hooks (`PTY_ACTIVE_WINDOW` `:44`).
4. **Idle timeout** — silent ≥30s → Idle (downgrade only).

50ms flap debounce; on commit: DB write → `watch::Sender<(status, version)>` send-replace → SSE `status`. Adaptive cadence: hot-active 1s / active 2s / idle 4s / waiting 5s (`status.rs:103-125`). `MAX_PREVIEW_STALENESS = 4s` (`:83`).

Golden fixtures: `tests/fixtures/status/*.txt`. **Project-memory warning**: re-verify any "live-verified" TUI regex against real captures including resize repaints.

### 3.4 Claude Code hooks — the richest structured feed

Installed into the user's global `~/.claude/settings.json` by `server/src/claude_config.rs` (`install_hooks` `:92`, marker `supermux-hook` `:39`, atomic temp+rename, transport-aware for remote hosts).

10 events (`claude_config.rs:56-70`): `UserPromptSubmit`→`user_prompt`, `PreToolUse`→`pre_tool`, `PostToolUse`→`post_tool`, `Notification`→`notification`, `Stop`→`stop`, `SubagentStart`→`subagent_start`, `SubagentStop`→`subagent_stop`, `SessionStart`→`session_start`, `SessionEnd`→`session_end`, `StopFailure`→`stop_failure`.

The command (`claude_config.rs:387-402`):
```
: supermux-hook; D=$(head -c 16384); [ -z "$D" ] && D='{}';
curl -fsS --max-time 1 -X POST -H "Content-Type: application/json"
  -H "X-Supermux-Hook-Token: $SUPERMUX_HOOK_TOKEN"
  "$SUPERMUX_URL/api/_internal/hook"
  -d "{\"session\":\"$SUPERMUX_SESSION\",\"event\":\"<token>\",\"payload\":$D}" || true
```
→ **Claude's full hook STDIN JSON, capped at 16 KB, arrives at the server per event.**

Ingest: `server/src/hooks.rs:73-154`. Auth = per-session `hook_token` from `session_runtime` (constant-time compare), **not** the dashboard bearer. `apply_payload` (`:161-249`) derives activity/error/lifecycle; `HookPayload` (`server/src/sessions/activity.rs:33-58`) is a *lenient* parse with `session_id` (alias `sessionId`), `tool_name`, `tool_input {command, description, file_path, pattern, url}`, `message`, `error_type`, `error`. **Everything here is in-memory only and never persisted** (`activity.rs:15-17`) — a deliberate security posture a chat renderer must respect or explicitly revisit.

`activity_label` (`activity.rs:114-180`) maps tool → `(label, kind)`: `Bash`→`⚡ …`/`bash`, `Edit|Write|MultiEdit|NotebookEdit`→`✎ basename`/`edit`, `Read`→`📖 basename`/`read`, `Grep|Glob`→`🔍 pattern`/`search`, `WebFetch|WebSearch`→`🌐 fetching`/`web`, `Task|Agent`→`🤖 subagent`/`task`, `mcp__a__b`→`🔌 b`/`mcp`, else name/`tool`. Labels truncate at `MAX_LABEL = 40`.

### 3.5 Recall — the live conversation transcript reader

`server/src/sessions/recall.rs` (1439 lines) + `recall/codex.rs` (535) + `recall/kimi.rs` (783). Endpoint `GET /api/sessions/{name}/recall` (`sessions/mod.rs:83`, handler `recall.rs:165`).

Query (`recall.rs:57-74`): `scope` (`session|project`), `q` (substring search), `include_sidechains`, `include_system_events`, `before` (cursor), `limit` (default 20, max 100).

Response (`recall.rs:140-147`): `{entries[], hasMore, nextBefore}`. `RecallEntry` (`:79-98`): `{uuid, ts, sessionId, sessionTitle?, text, reply?, sidechain, kind, label?}`.

`Kind` (`recall.rs:104-124`): `prompt | command | teammate | notification | system | tool | image`. `is_user_initiated()` (`:129-133`) = prompt|command|teammate — the default filter.

File resolution:
- `resumable::project_dir_for(dir)` (`server/src/sessions/resumable.rs:94-102`) = `claude_config_dir()/projects/<encoded cwd>`, where `claude_config_dir()` is `$CLAUDE_CONFIG_DIR` else `~/.claude`, and the encoding replaces every `/` **and** every `.` with `-` after `canonicalize()`. Documented + verified at `resumable.rs:15-30`.
- `files_for_scope` (`recall.rs:350-378`): `Session` → exactly `<proj>/<cc_conversation_id>.jsonl`; `Project` → every `*.jsonl` newest-mtime-first.
- `read_user_turns` (`recall.rs:392+`): streams the JSONL forward with a **cheap substring gate before any JSON parse** (`"type":"user"` / `"type":"assistant"` / `"ai-title"`), pairs each user turn with the next assistant turn's first text block, tracks the latest `aiTitle`, then reverses to newest-first. All under `spawn_blocking`.
- Caps: `PROMPT_MAX_CHARS = 8000`, `REPLY_MAX_CHARS = 600` (`recall.rs:35-38`). Text runs through `crate::ws::sanitise_text`.

**How the live conversation is tracked (commit `c31518e`)** — the piece a chat renderer depends on:
- Claude rotates its transcript file on restart / `/clear` / compaction, forking a fresh `<session_id>.jsonl`. `cc_conversation_id` used to be written only on a resume-pick, so "this session" recall drifted days stale.
- Every Claude hook payload carries the live conversation UUID as `session_id`. `server/src/hooks.rs:138-147` captures it on **`SessionStart` and `UserPromptSubmit` only** (per-tool/subagent hooks are skipped — their subagent ids would thrash it) and calls `db::sessions::track_cc_conversation_id` (`server/src/db/sessions.rs:591-602`): a conditional `UPDATE sessions SET cc_conversation_id = ? WHERE name = ? AND cc_conversation_id <> ?` that leaves `cc_session_name` (the `--resume` handle) untouched.
- So: **`sessions.cc_conversation_id` is a live pointer to the current transcript file, self-healing on the next prompt.** Resolve path = `project_dir_for(session.dir).join(format!("{cc_conversation_id}.jsonl"))`.

Also on disk per resumable (`resumable.rs:31-41`): the filename UUID == `sessionId` inside the transcript == the `--resume` id; `{"type":"ai-title","aiTitle":"…"}` lines carry the chat title (last wins); mtime is the update time.

### 3.6 Board / teams / delegate / steering / agents

- **Board** (`server/src/board/`): issue tracker with a hook protocol at `/api/hook/board/*` (`X-Supermux-Hook-Token`, scoped to the session's currently-doing issue), claim flow, dispatch, iCal feed. Client: `web/src/routes/board.tsx` (1035 lines), `web/src/hooks/use-board.ts`, `web/src/lib/api/board.ts`/`boards.ts`. Skill `supermux-task` (`server/src/agents/supermux-task.md`) is how sessions report progress.
- **Teams** (`server/src/teams/`, `server/src/sessions/teams.rs`): detects Claude Agent Teams (teammates are tmux split panes inside the lead's window — a native session can never host a team, `runtime.rs:22-25`). `GET /api/teams`, SSE `teams`. Env gate `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1` injected only when the global `experimental.agent_teams` setting is on **and** provider is `claude` (`lifecycle.rs:152-158`). Client: `web/src/hooks/use-teams.ts`, `web/src/components/team/*`, teammate WS `/ws/teams/{team}/{member}`.
- **Delegate** (`server/src/agents/delegate.rs:35-70`): `POST /api/agents/delegate {from,to,prompt}` — delivers via `lifecycle::send_text` (auto-wakes a stopped target), records an edge for `GET /api/agents/delegations?session=X`, writes an audit row (`actor=agent:<from>`), prompt text deliberately **not** logged.
- **Agents wait** (`server/src/agents/wait.rs`): `GET /api/agents/{name}/wait?state=…` long-polls the per-session status watch channel.
- **Steering** (`server/src/sessions/steering/`): `GET/POST/DELETE /api/sessions/{name}/steer` queues messages delivered at the next turn boundary (status → waiting/idle), single-flight, exactly once.
- **External edit** (`server/src/external_edit.rs`): `$EDITOR`/`$VISUAL` point at `<data_dir>/bin/supermux-edit` (`lifecycle.rs:427-437`); Claude's Ctrl+G (`chat:externalEditor`, byte `\x07`, `use-live-term.ts:367-371`) opens the browser compose sheet via the `external-edit` SSE event.
- **Claude tools** (`server/src/claude_tools/`): MCP + skills registry surfaced in the command palette (`web/src/components/claude-tools/*`, `web/src/hooks/use-claude-tools.ts`).

### 3.7 REST input surface (independent of the terminal WS)

`server/src/sessions/mod.rs:60-119`. Relevant to a chat composer:
- `POST /api/sessions/{name}/send {text}` → `lifecycle::send_text` (`lifecycle.rs:1126-1163`): auto-wakes a stopped session, takes the per-session lock, `send_text` → **submit gap** → `send_key("Enter")`, then writes `last_send_text`/`last_send_at` and broadcasts. Submit gap: `rt.submit_gap()` (native = 50ms, tmux = 0 because its two forks give the gap for free — `runtime.rs:175-188`), overridden to 200ms for Kimi (timing-based paste detection).
- `POST /api/sessions/{name}/keys {keys|key}` — allowlisted (`KEY_ALLOWLIST` in lifecycle.rs)
- `POST /api/sessions/{name}/paste {text, submit}` — one bracketed paste, never N keystrokes
- `GET /api/sessions/{name}/peek?lines=N` — plain capture snapshot
- `POST /api/sessions/{name}/mode` — switch Claude permission mode
- `GET /api/sessions/{name}/resumable`, `POST /api/sessions/{name}/resume`
- `GET /api/sessions/{name}/git`, `/tracked-files`, `/steer`, `/external-edit/submit`, `/archive`, `/unarchive`, `/wake`, `/clone`, `/duplicate`, `/purge`, `PATCH /config`

All responses use the envelope `{ok:true,data}` / `{ok:false,error}` (`sessions/mod.rs:122-134`, `server/src/error.rs`).

---

## 4. Session providers & launch

`PROVIDERS = ["claude", "codex", "kimi", "shell"]` (`server/src/sessions/mod.rs:357`), validated at create (`:388`, default `"claude"` at `:559`). Session names are charset-restricted and may not start with `-` because the name flows into argv (`:357-388`).

**Provider-specific logic lives in exactly two functions** in `server/src/sessions/lifecycle.rs`:

### `build_env` (`lifecycle.rs:122-256`) — per-session pty env
Always: `SUPERMUX_SESSION`, `TMUX_SESSION_NAME`, `SUPERMUX_URL` (loopback for local, `remote_callback_url` for remote), `SUPERMUX_HOOK_TOKEN`, `TERM=xterm-256color`, `COLORTERM=truecolor`, `CLAUDE_CODE_FORCE_SYNC_OUTPUT=1` (forces DECSET 2026 synchronized output — Claude gates on a hardcoded TERM list that excludes `xterm-256color`; without this you get torn/duplicated frames), `CLAUDE_CODE_DISABLE_ALTERNATE_SCREEN=1` (renders inline on the primary buffer so scrollback exists at all). Conditional: `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1` when the setting is on and provider is `claude`.
Deliberately **not** set: `CLAUDE_CODE_DISABLE_MOUSE` — verified a no-op on 2.1.156; mouse tracking is neutralized client-side instead.

### `build_launch_command` (`lifecycle.rs:273-441`) — the shell line typed into the fresh pane
Returns `(command, resume_intended)`. Common prefix for every provider:
```
source ~/.zprofile 2>/dev/null; source ~/.bash_profile 2>/dev/null; source ~/.profile 2>/dev/null;
export EDITOR='<data_dir>/bin/supermux-edit' VISUAL='<same>'; {agent}
```

- **claude** (`:387-419`, also the fallback for unknown non-shell providers):
  `claude [config.provider_defaults.claude_flags] [session.flags]` then
  - if `cc_session_name` non-empty → `--resume '<cc_session_name>'`, `resume_intended = true`
  - else if `cc_conversation_id` non-empty → `--resume '<cc_conversation_id>'`, `resume_intended = true`
  - else → `--name <session.name>`, `resume_intended = false`
  Values are charset-validated at the HTTP boundary (`valid_cc_id`, `[A-Za-z0-9._-]{1,128}`) and single-quoted anyway.
- **codex** (`:275-330`): `codex --no-alt-screen [defaults] [flags]`, wrapped in a self-contained installer + `codex login status` / `codex login --device-auth` shell preamble. No supermux-driven resume.
- **kimi** (`:331-385`): `export PATH="$HOME/.kimi-code/bin:$PATH"; …; kimi login && kimi [defaults] [flags]`. Runs inline (no alt-screen flag needed). No supermux-driven resume.
- **shell**: never reaches this builder.

`start()` (`lifecycle.rs:687+`) spawns/re-attaches, installs the Claude hooks (skipped for codex/shell, `:784`), waits for the agent UI (`agent_ui_visible` `:441` = `❯` / `❱` / `? for shortcuts`), and handles the resume-picker escape (suppressed when `resume_intended`, `:496+`).

Other provider forks: recall dispatch (`recall.rs:180-215`), status regex banks (`status.rs`, `StatusDetector::for_provider`), Kimi's 200ms submit gap (`lifecycle.rs:1141-1156`), Ctrl+G edit affordance gating (`desktop-split.tsx:663-671`), team-conversion eligibility `provider === 'claude'` (`focus/desktop.tsx:146-147`).

**Hooks into Claude's session files**: only two places touch `~/.claude` — `server/src/claude_config.rs` (writes `settings.json` hooks) and `server/src/sessions/resumable.rs` + `recall.rs` (read `~/.claude/projects/<enc>/<uuid>.jsonl`). There is **no filesystem watcher** on the transcripts today; recall is pull-only, on demand, under `spawn_blocking`.

---

## 5. Design system

- **Tailwind v4, CSS-first.** `web/tailwind.config.ts` exists only to declare content globs; the real config is `@theme` inside `web/src/styles/globals.css` (485 lines), wired via `@tailwindcss/vite` (`web/vite.config.ts`).
- **Dark mode:** `@custom-variant dark (&:is(.dark *))` (`globals.css:18`); `.dark` is applied to `<html>` by `web/src/components/theme-provider.tsx` **before first paint**; localStorage key `supermux-theme`. Dark is the default.
- **Tokens** (`globals.css:47-135`): iOS HIG-grounded semantic palette (`--background`, `--card`, `--primary`, `--muted`, `--border`, `--destructive`, `--warning`, `--popover`, `--ring`, `--radius: 0.75rem`), plus terminal surface `--terminal-bg`/`--terminal-fg` (read at mount by `useLiveTerm`). Brand + status tokens are theme-independent **bare HSL triples** so callers can do `hsl(var(--x) / α)`: `--brand: 38 92% 58%`, `--status-active` (amber), `--status-waiting` (blue), `--status-ready` (green), `--status-error` (calm orange, never alarmist red), `--status-idle` (grey). Mirrored for TS at `web/src/brand/tokens.ts`; copy strings at `web/src/brand/copy.ts`; `web/src/brand/BRAND.md`.
- `@theme inline` (`globals.css:136-180`) maps vars into the Tailwind namespace (`bg-brand`, `bg-status-active`, `--radius-sm/md/lg/xl`).
- **Fonts:** self-hosted `JetBrainsMono Nerd Font Mono` woff2 (`@font-face` `globals.css:31-45`, files under `web/public/fonts/`, `NOTICE.md` for licensing) — required so Powerline/Nerd glyphs render in both xterm **and** the static `TailPreview`. UI font is SF Pro / system stack.
- **Component library:** local shadcn-style primitives in `web/src/components/ui/` — `button`, `badge`, `dialog`, `dropdown-menu`, `input`, `kbd`, `popover`, `responsive-sheet`, `scroll-area`, `sheet`, `tabs`, `toast`, `toggle`, `tooltip`. `components.json` present. Radix under the hood; `class-variance-authority` + `clsx` + `tailwind-merge` (`web/src/lib/utils.ts` `cn`).
- **Motion:** framer-motion 11; **all springs come from `web/src/lib/springs.ts`** (`springs`, `eases`) — the convention forbids ad-hoc cubic-beziers (`ARCHITECTURE.md:159`). View Transitions morph helper at `web/src/components/view-transitions/morph.tsx` (`useNavigateMorph`, `vtSessionName`).
- **Mobile:** Vaul 1.1 bottom sheets (`ui/sheet.tsx`, `ui/responsive-sheet.tsx`, `focus-mode/mobile-sheet.tsx`, `mobile-action-sheet.tsx`, `mobile-bottom-panel.tsx`, `mobile-compose-sheet.tsx`, `session-picker-sheet.tsx`, `archived/archived-sheet.tsx`, `session-tile/new-session-sheet.tsx`). Keyboard-aware viewport via `web/src/hooks/use-keyboard-viewport.ts`. Safe-area utilities (`pt-safe` etc.) in globals.css.
- **Markdown/code rendering already available**: `react-markdown` + `remark-gfm` + `rehype-highlight` + `rehype-slug` + `lowlight` (`web/src/components/files/markdown-viewer.tsx`), and CodeMirror 6 for the file editor (`components/files/code-editor.tsx`, lazy — its language packs are deliberately kept off the hero path). **A chat renderer can reuse `markdown-viewer.tsx` and the code paths for free.**
- **VR hooks:** `data-vr-*` attributes on components targeted by Playwright visual regression (`ARCHITECTURE.md:160`); configs `web/playwright.config.ts`, `playwright.mobile.config.ts`, `playwright.screens.config.ts`, tests under `web/tests/`.

---

## 6. Constraints, failure modes, performance

### 6.1 Two views of the same session at once

This already happens today (overview hover-peek + focus route + prewarm sockets), so the machinery exists — but with sharp edges:

1. **Subscriber cap 32 per session** (`server/src/config.rs:92,99-101`); the 33rd is closed **1013** and the client silently reconnects on next visibility. Prewarms count against it: `MAX_CONCURRENT_PREWARMS = 12` (`web/src/hooks/peek-prewarm-store.ts`).
2. **Geometry is global and last-write-wins.** Every attached client may send `resize`, and `apply_one` applies it to the one shared pty. Two viewers at different widths ping-pong the pane width; the client-side guard is `HISTORY_WIDTH_MISMATCH_MAX = 3` consecutive mismatches before it pauses history fetching (`web/src/hooks/use-live-term.ts:704-710`). **A non-terminal renderer must never send `resize`** — otherwise it will fight the real terminal view and reflow the agent's TUI. It also need not send `resync` (harmless but pointless).
3. **`resync` after resize is server-triggered and debounced** (`RESYNC_SETTLE = 300ms`, `ws/mod.rs:70`) — a width change from view A causes a full re-seed push on the attach path.
4. **Input ordering** is preserved per socket by `plan_applies`, and cross-socket by the per-session `state.lock_for(name)` mutex — but two views typing simultaneously interleave at the pty. A chat composer using `POST /send` and a terminal typing at the same time will interleave; `send_text` holds the lock for text+gap+Enter so at least a submit is atomic.
5. **`last_send_text` is written from both paths** (REST `send_text` at `lifecycle.rs:1160` and WS input sniffing at `ws/mod.rs:1144-1284`), so a chat composer's prompts appear in recall/the last-send bar automatically.
6. **Auth**: WS uses in-band first-frame auth from `window._SUPERMUX_AUTH_TOKEN` (`web/src/env.ts`), never a URL param. SSE uses `?_token=` because EventSource can't set headers.

### 6.2 Reconnect / state replay

- On every (re)connect the server pushes a full authoritative **seed** (`rt.seed()` = full scrollback + alt-screen-aware visible screen), then `attach_meta`, then `replay_done`. The client hides the viewport (`ready=false`) until `replay_done` (or a 400ms fallback), then pins to bottom and reveals — no visible replay scroll.
- Native runtime: every holder reconnect rebuilds the grid from the on-disk spool and bumps `attach_generation`; the WS layer subscribes to that watch and schedules a re-seed (`ws/mod.rs:726`), so a deploy (`KillMode=process`) is invisible to attached clients.
- `4404` means the pty is genuinely gone → client must stop retrying and show `<StoppedSession>`.
- Scrollback beyond the seed: tmux keeps `history-limit = 50000`; the native VT keeps only `HISTORY_LINES = 2000` in the grid, but the spool retains 32–64 MiB of raw bytes on disk. The `PtyStream` replay ring is 512 KB.

### 6.3 Performance

`web/PERF.md`, enforced by `web/scripts/size-budget.mjs` (run via `bun run build:perf`, exit 1 on overage):

| metric | budget |
|---|---|
| main app JS | ≤ 200 KB gzipped |
| CSS | ≤ 30 KB gzipped |
| Lighthouse perf | ≥ 85 |
| FCP | < 500 ms |
| TTI | < 1.5 s |
| Overview, 20 tiles @ 2s SSE | 60fps iPhone 14 / 30fps iPhone SE |
| Focus keystroke latency | < 50 ms LAN / < 100 ms Tailscale |

Vendor chunks are split via `manualChunks` in `web/vite.config.ts` (`vendor-react`, `vendor-xterm`, `vendor-framer`, `vendor-codemirror`) and excluded from the main-app-JS budget; `vendor-codemirror` only loads behind the lazy code-editor route. **A chat renderer that avoids new heavy deps on the hero path (or is lazy-loaded like the code editor) stays inside budget; `react-markdown`+`rehype-highlight`+`lowlight` are already dependencies but currently only reachable from the files route — verify they don't land in the main chunk once the overview imports them.**

Server-side: native captures are memory reads (~0.3 ms for a 200×50 viewport serialize) vs a `tmux` fork per capture on the tmux path (`native/mod.rs:12-16`). VT memory ~9.7 MiB/session at 200×50 with a saturated 2000-line history (`native/vt.rs:5-9`). Recall parsing is `spawn_blocking` with a substring gate before JSON parse — multi-MB transcripts are fine but it is O(file) per request, and Project scope reads *every* jsonl in the folder.

### 6.4 Other constraints (project conventions & memory)

- **Never `cargo build/test --release`** on this host (OOM). Use `cargo check` / debug builds. Debug `cargo check`/`test` work in-sandbox with `OPENSSL_NO_VENDOR=1 OPENSSL_LIB_DIR=/usr/lib/x86_64-linux-gnu`.
- **Never edit `server/migrations/*`** — sqlx checksums them; a `VersionMismatch` bricks deployed installs. New schema = new `00NN_*.sql` (next free: `0025`).
- **`main` is branch-protected** (code-owner review + green CI). Open a PR; never auto-merge. Other agents work in this repo on rotating branches — isolate via a worktree off `origin/main`; don't commit/branch/stash in the main checkout.
- **Never restart the running instance unasked** — supermux on :8824 hosts the user's chat. Test side-by-side on another port.
- One module = one router (`pub fn router_for(state) -> Router`, merged in `server/src/http.rs`). Envelopes on every response. Audit every mutation (`?`, not `let _ =`). Path-jail every filesystem entry point via `files::path_safe::resolve_safe`. No private/customer names in code.

---

## 7. Concrete seams for a second renderer (synthesis)

### 7.1 Where the render decision is made today (3 call sites)

| surface | file:line | current expression |
|---|---|---|
| overview tile (rest + hover) | `web/src/components/session-tile/tile.tsx:213-221`, plus the `<TailPreview>`/`<TileLiveTerminal>` branches below | `overviewPreview === 'live' ? live xterm peek : static tail` |
| desktop focus main pane | `web/src/components/focus-mode/desktop-split.tsx:619-629` | `status === 'stopped' ? <StoppedSession/> : <LiveTerminal onReady/>` |
| mobile focus | `web/src/routes/focus/mobile.tsx:~495-515` | same shape |

Each becomes a 3-way switch. The dock/keybar/joystick all drive `termRef.current` (a `UseLiveTermResult`); a chat renderer either (a) exposes a compatible subset of that handle, or (b) the parents gate those controls off when the chat renderer is active. Option (a) is cheaper: implement `send`, `sendKey`, `focus`, `blur`, `copyAll` against `POST /send` + `/keys`, and no-op `resize`/`resync`.

### 7.2 Where the data for a chat view would come from

Ranked by cost:
1. **Transcript-derived (recommended).** `sessions.cc_conversation_id` + `resumable::project_dir_for(dir)` → the live `<uuid>.jsonl`. `recall.rs` already has the streaming parser, the Kind classifier, sanitisation, cursor pagination, and per-provider dispatch (codex/kimi variants exist). A "full-fidelity" endpoint would extend, not replace, that module: emit assistant text blocks, tool_use/tool_result pairs, thinking blocks, and attachments rather than the 600-char `reply` preview. Liveness needs either polling on SSE `status`/`sessions` ticks, an fs watcher (none exists today — `server/src/scheduler/watch.rs` and `server/src/teams/watcher.rs` are the in-tree watcher precedents), or a tail-offset cursor.
2. **Hook-derived live overlay.** Already in-memory: current tool + kind + subagent count + error + turn state. Zero new plumbing — it's already on the `sessions` SSE delta. Ideal for the "working…" state between transcript flushes. Caveat: `hooks.rs`/`activity.rs` explicitly persist nothing; a renderer wanting a *history* of tool events must either widen that policy deliberately or read it back from the transcript.
3. **pty bytes.** Available but wrong shape for a chat UI (Ink TUI redraws, not messages).

### 7.3 Persistence options for the toggle
- localStorage only: `web/src/stores/ui-store.ts` (`persist`, key `supermux-ui`).
- Cross-device: add a key to `is_known_pref_key` (`server/src/prefs.rs:60-64`) → `GET/PUT /api/prefs/{key}` + SSE `prefs`; client mirror pattern in `web/src/hooks/use-overview-layout.ts`.
- Per-session server-side: `PATCH /api/sessions/{name}/config` (`ConfigInput`, `server/src/sessions/mod.rs:760-778`) + migration `0025`.

### 7.4 Additive-safety notes
- The WS client ignores unknown text frame types (`use-live-term.ts:1736-1830`), and `ClientMsg` has no `deny_unknown_fields` — an old server given a new frame just drops it. So a new structured stream can be added on the same socket without breaking any deployed client, *or* on its own route (`/ws/sessions/{name}/chat`) merged in `ws::router_for` (`ws/mod.rs:85`).
- Every new module follows: one `mod` in `server/src/lib.rs`, one `router_for(state)`, one `.merge(...)` in `http::protected_router` (`server/src/http.rs:145-165`).

---

## 8. File index (quick reference)

**Backend**
```
server/src/ws/mod.rs                    WS endpoint, handshake, seed, history, input coalescing (1759)
server/src/ws/protocol.rs               ClientMsg control frames (95)
server/src/ws/streamer.rs               per-session PtyStream registry (396)
server/src/sessions/runtime.rs          SessionRuntime trait + Tmux/Native impls (653)
server/src/sessions/native/*            tmux-less runtime: proto/holder/spool/vt/serialize/keys/runtime/reader
server/src/sessions/pty.rs              FIFO reader, 512KB replay ring, broadcast fan-out
server/src/sessions/tmux.rs             tmux shell-outs
server/src/sessions/lifecycle.rs        build_env(122) build_launch_command(273) start(687) send_text(1126)
server/src/sessions/status.rs           detector + regex banks (1715)
server/src/sessions/activity.rs         HookPayload(33) activity_label(114)
server/src/sessions/recall.rs (+codex,kimi)  JSONL transcript reader (1439/535/783)
server/src/sessions/resumable.rs        ~/.claude/projects path encoding (project_dir_for:94)
server/src/sessions/mod.rs              router(60) SessionView(142) view(233) ConfigInput(760)
server/src/hooks.rs                     /api/_internal/hook ingest, cc-id tracking (138-147)
server/src/claude_config.rs             ~/.claude/settings.json hook installer (EVENTS:56, hook_command:387)
server/src/prefs.rs                     /api/prefs/{key} allowlist (60)
server/src/sse.rs, state.rs, http.rs, error.rs, auth.rs
server/src/agents/delegate.rs, wait.rs; board/; teams/; scheduler/; files/; claude_tools/; updates/
server/migrations/0001..0024_*.sql      (next free: 0025)
```

**Frontend**
```
web/src/App.tsx                         routes (53-155)
web/src/components/layout.tsx           shell, SideNav/BottomNav
web/src/routes/overview.tsx             grid (107), useDevMockSeed (842)
web/src/routes/focus.tsx                viewport fork (16), FocusEntry (38)
web/src/routes/focus/desktop.tsx        (58) → components/focus-mode/desktop-split.tsx (733)
web/src/routes/focus/mobile.tsx         (682)
web/src/routes/dev-{tiles,term,focus,focus-mobile,teams}.tsx
web/src/hooks/use-live-term.ts          xterm + WS lifecycle (2351)
web/src/components/terminal/live-terminal.tsx  wrapper + cached-tail crossfade (411)
web/src/components/session-tile/{tile,tail-preview,tile-live-terminal,quick-peek-modal,mock}.tsx
web/src/hooks/{use-sessions,use-sse,use-peek-prewarm,use-peek-type,use-teams,use-board}.ts
web/src/hooks/peek-prewarm-store.ts
web/src/stores/ui-store.ts              persisted UI prefs (39-52, 87)
web/src/lib/ansi.ts                     SGR→segments for static previews (183)
web/src/lib/api/*.ts                    typed client (sessions.ts has ApiSession + RecallEntry)
web/src/styles/globals.css              Tailwind v4 @theme, tokens, fonts, dark mode (485)
web/src/brand/{tokens.ts,copy.ts,BRAND.md}
web/src/lib/springs.ts                  the only motion source
web/PERF.md, web/scripts/size-budget.mjs
```
