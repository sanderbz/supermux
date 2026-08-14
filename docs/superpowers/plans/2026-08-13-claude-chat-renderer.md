# supermux × Grok-class UI — Master Plan (v3)

> **For agentic workers:** This is the master plan (design + architecture + phasing) for two tracks: **Track A** — the native Claude chat renderer (Part I), and **Track B** — app-wide Grok-class integration (Part II). Each phase gets its own detailed TDD implementation plan (superpowers:writing-plans) at execution time, executed via superpowers:subagent-driven-development. Do not implement from this document alone.
>
> v2 integrated a three-lens adversarial review verified against the deployed Claude Code (2.1.227) and a live 3397-line transcript corpus. v3 adds Part II from a second research wave: Grok Bot's agent-management paradigms (14 docs pages, DOM/CSS forensics of app v0.18.0), its cross-surface integration mechanics (118 extracted animation/transition rules), and a full inventory of supermux's non-focus surfaces.

**Goal:** Make supermux feel like one natively-integrated, Grok-class product: a custom chat-native UI as the *default* interface for Claude Code sessions (instant lossless toggle to the raw terminal), an overview that reads as a roster of visually-identified agent teammates, and fluent, choreographed integration across every page.

**Architecture (Track A):** One live interactive Claude Code session in the pty, exactly as today — the chat UI is a **second renderer** over that same session, never headless/SDK. Inflow: live JSONL transcript tail + hooks + statusline tap. Outflow: the terminal-independent REST input path. The TUI stays authoritative; honesty is mechanized (delivery watchdog).

**Architecture (Track B):** No new pages. A session **identity system** (deterministic mark + accent), a single **shell language** (one glass substrate, shared chrome tokens, shell-scoped overlays), a **motion system** (three speeds, exits faster, one slow identity transition), and consolidation of the app's duplicated primitives (pickers, modals, headers, empty states) into one vocabulary.

**Tech Stack:** Rust (axum, notify watcher, extended recall parser) · React 19 + Tailwind v4 + framer-motion (existing stack) · reuse `react-markdown`/`rehype-highlight` (lazy) · no new heavy deps on the hero path.

## Global Constraints

- **THE GROK-STYLED INTERFACE IS THE PRIMARY INTERFACE** (owner decision 2026-08-14). It is not an overlay, not a second renderer that loads later, not an alternative view: it is interface #1, the thing supermux *is*. The terminal remains available as a **fallback** — reachable instantly (auto-surfaced by the Attention mechanism, or user-set as preference in Settings) — but it is the secondary path and no design decision may treat the chat surface as the optional one. ("Overlay-first" in §1/§4 describes the *data* layering — live hook signals before transcript confirmation — never the product hierarchy.)
- **Latency findings never block the direction.** Where Claude Code's transcript is too slow (long prose: ~31s), we ship pragmatic workarounds (pty-derived provisional text, receipts-first, elapsed indicators) and improve them later — quality gates steer the *how*, never the *whether*.
- **Visual quality is judged by taste against the Grok pixels, side by side — not by metrics alone.** Accessibility numbers (ΔE, contrast, IoU) are constraints a design must pass, never the thing a design is optimized toward. Every visual deliverable gets an aesthetic review against the reference captures before it reaches the owner; GPT Image 2 is in the loop for direction and polish comparisons.
- **Never headless.** The interactive `claude` in the pty is the only session. (Memory: `custom-ui-wraps-live-pty`.)
- **Instant switch to the terminal fallback, both directions, zero state loss** — specced (§6.2), incl. toggle-thrash test.
- **The chat client never sends `resize`.** Pty geometry is a server-side policy (§2.6): explicit at create + chat attach, persisted, ≥40 cols.
- **Track A v1 scope: local Claude Code sessions only.** Guard (client and server): `provider === 'claude' && host_id == null && !team`. Codex/kimi (transcript parsers exist; status overlay is the gap), remote hosts, teams → Later.
- **Ship behind flags with hidden kill-switches; flip defaults in separate commits** (the PR #27 pattern). Track B visual changes ride the same discipline where risky (identity system, shell substrate).
- **Nothing silently invisible** (Track A): every interactive Claude state is *chat-rendered* or *Attention card* (§2.7); unknown-unknowns are caught by the delivery watchdog.
- **Accent ≠ status** (§5.1.2): the 8-hue identity wheel is disjoint from the 4 status hues (≥30°, unit-tested); accent and tone never tint the same surface.
- Repo rules: no release builds; no editing `server/migrations/*`; PRs only from a worktree off `origin/main` (user reviews all merges); never restart :8824 unasked (dogfood side-by-side on another port).
- Perf reality (measured): app JS **154.3/200 KB gz (77%)**; `vendor-markdown` 92.8 KB gz lazy. Chat renderer + markdown ship lazy; fase A3 adds a hero-path vendor gate to `size-budget.mjs` and refreshes the stale baseline.
- **Motion ownership**: framer springs for layout/gesture/shared-element; CSS keyframes for ambient loops + list-entry pops. New curves exported from `springs.ts` in array + CSS-string form. Functional spinners stay animated under `prefers-reduced-motion` (existing convention); decorative animation gets colocated `animation:none` twins whose static state still reads (Grok keeps the typing dots' .25/.45/.7 stagger). Offscreen surfaces get `animation-play-state: paused`.
- Public screenshots only from `/?mock` or `/dev/*` (PII rule).

---

# PART I — Native Claude Chat Renderer (Track A)

## 1. Why (evidence)

~334 commits of this repo's history are terminal-rendering pain. Git archaeology (`report-render-pain`): of 11 recurring failure classes, **8 die entirely** when Claude sessions render as DOM — alt-screen seed framing, resize garble, partial-frame echo races, WebGL atlas ghosting, mouse-reporting vs touch-scroll, touch text-selection, IME duplication, keyboard-cycle duplication, and the scrollback-ownership war. What survives (status detection, TUI-modal input fidelity, reconnect correctness, mobile viewport chrome) is first-class below.

Design target validated by Grok Bot (xAI, 2026-08-11/12): chat-first agent UI, all activity as typed transcript primitives, reviewer-praised polish (full extracted design system: `report-grok-ui`). We adopt its **discipline** and deliberately diverge where supermux is a *coding* tool (§5.6) — Grok's top criticisms (cost blindness, sameness) are our openings.

Latency ground truth (A0-measured — **the gate FAILED; the pre-agreed fail branch is ACTIVE**): the transcript's *shape* is one block per line, but its *timing* is not — **nothing is written during generation; the flush unit is a completed assistant message / tool phase.** Measured: text-only turns first-visible at p50 **31.4s** (gate: 2s); tool-heavy p50 **4.4s**; the same turn's first text appears on the **pty at 3.24s** — the transcript adds +27.6s. What *is* fast: status flip idle→active **206ms p50**, own `user` echo **187ms**, queue receipt **158ms**. Therefore the chat renderer is **overlay-first by design**: hook/status signals carry the live layer (P12 working row, hook-driven receipts, P13 provisional pty-derived tail), and the transcript is the *confirming* layer that supersedes provisional content when the batch lands (discard-and-replace, never merge). "Chat shows what the agent says *as it says it*" is off the table for CC 2.1.2xx. Raw evidence: `a0-findings.md` §1.

## 2. Data plane (inflow)

### 2.1 Transcript tail

- Source: `~/.claude/projects/<enc-cwd>/<cc_conversation_id>.jsonl` (pointer maintained by hooks on `SessionStart`/`UserPromptSubmit`, `server/src/hooks.rs:138-147`). Resolution via `resumable::project_dir_for`.
- **Corpus facts the parser is built on (A0-verified; re-verify per CC version — note: the CLI auto-updates under us, 2.1.227→2.1.231 happened mid-probe; running sessions keep their boot binary, so version keys are per-entry `version` fields and per-session boot banners, never `claude --version`):**
  - Assistant entries: one content block per line is the *typical* case (1 multi-block `[thinking,text]` in 21,431 measured lines) → parser treats `content` as a list of N blocks. **Timing caveat (A0-measured): lines are batch-flushed per completed message/tool phase, not as generated** — entries earlier in a batch land up to 27s after their own `timestamp`. The tailer must treat entry `timestamp` (CC's clock) and arrival time (flush) as different facts; live-ness comes from the overlay, never the tail.
  - **Compaction does not rotate the file**: `type:"system", subtype:"compact_boundary"` sits inline (with `logicalParentUuid`); `sessionId` unchanged. Byte cursor survives compaction; the stale comment at `hooks.rs:133-134` gets corrected. Never depend on `compactMetadata` internals — its shape drifts across versions (70 KB arrays on 2.1.170 vs 1.5 KB on 2.1.211).
  - **Subagents are separate files**, not sidechains: `<proj>/<conv-id>/subagents/agent-<id>.jsonl` (`isSidechain:true`, `agentId`, `promptId`) + `agent-<id>.meta.json` (`agentType`, `description`, `toolUseId`, `spawnDepth`; `model` **optional** — absent on 2.1.231). Main file: zero `isSidechain:true`; recall's `include_sidechains` is dead for this version.
  - Top-level types present: `assistant, user, system, attachment, last-prompt, custom-title, mode, permission-mode, pr-link, queue-operation, file-history-snapshot, file-history-delta` **plus `agent-name`, `agent-setting`, `bridge-session`, `ai-title`** (all corpus-counted). `queue-operation` → primitive P9. Unknown types → tolerated `unknown` variant, rendered neutral, never a crash — **exercised by real corpus today** (13 more attachment subtypes located but unfixtured), not insurance.
  - **Key-casing hazards**: `session_id` and `sessionId` co-occur on one entry; `toolUseID` (capital ID) appears inside hook attachments — the parser tolerates both casings.
  - Single lines up to **950 KB** exist (482 KB image, 104 KB tool_result fixtured) → hard per-entry wire cap.
- New module `server/src/sessions/chat/`:
  - `tailer.rs` — per-session notify watcher (precedents: `scheduler/watch.rs`, `teams/watcher.rs`) + byte-offset cursor; second watch scope on `subagents/`; re-resolves the pointer on `SessionStart` hook and watcher miss. Keeps the **last N parsed entries per session in memory** (feeds tiles, §2.5).
  - `parser.rs` — extends `recall.rs`'s streaming parser to full-fidelity typed entries. Fixture-tested against the anonymized live corpus (the `reverify-subagent-live-claims` rule: no shape ships without a live capture proving it).
  - `ws.rs` — the chat socket, **registered inside `ws::router_for`** (NOT `protected_router` — its bearer middleware can't be satisfied by a browser WS; that's why the terminal WS lives outside it, `server/src/http.rs:46`): same `origin_allowed` + first-frame auth + 2s timeout. Frames: `seed` (cursor-paginated) → `seed_done` boundary → live `entry`/`overlay`. Firehose mid-stream attach test: strictly consecutive, no gap/overlap. Client ignores unknown frame types.
  - REST in `protected_router`: `GET /api/sessions/{name}/chat/entry/{uuid}` — fetch-full for wire-truncated entries.
- **Wire caps:** per-entry byte cap (~16 KB) + `truncated: true` + fetch-full endpoint; seed byte budget. Security posture stated: transcript content now streams to the authenticated dashboard — same trust level as the terminal bytes it replaces. Hook payloads stay in-memory-only (`activity.rs:15-17`).
- **Staleness guard:** `cc_conversation_id` self-heals only on the *next* SessionStart/UserPromptSubmit. The tailer compares the resolved file's `sessionId` + mtime against process start / last hook time; stale pointer (server restart, terminal-side `--resume` pick, hook install failure) → "reconnecting to this conversation" state, composer routed through the delivery watchdog — never a plausible-looking stale transcript.
- **Subagent detail** is lazy: the P4 card joins `SubagentStart/Stop` hook counts with `meta.json.toolUseId` → parent `Task` tool_use; agent file fetched on card expand.

### 2.2 Hooks — the live overlay

Already flowing (10 events): turn state (hook state machine apex in `status.rs`), current tool label+kind, subagent count, errors — over existing SSE.

**Changes to `claude_config.rs`:**
1. **`-o /dev/null` on the hook curl** — the `{"ok":true}` response body reaches Claude's context: **832 of 3397 corpus lines (~25%) are `hook_success` attachment noise**. ✅ Shipped: **PR #55** (`fix/hook-stdout-noise`, awaiting owner review).
2. Add `PostToolUseFailure` to EVENTS — **A0-confirmed live** (payload adds `tool_use_id`, `error` string, `is_interrupt`, `duration_ms`; server handling exists at `hooks.rs:173-176`; the "no such event" comment there is wrong).
3. Add `PermissionRequest` as **trigger-only** — **A0-confirmed live**: fires when the dialog displays, before any decision, carrying `tool_name`, `tool_input`, `permission_mode`, `permission_suggestions`, `prompt_id`; an exit-0/no-stdout entry verifiably does NOT auto-decide (inert in the global settings file, as designed). Card *content* still comes from the transcript `tool_use` entry (hook pipe is 16 KB-truncated, `ToolInput` drops Edit/Write content). **Every hook stdin carries `permission_mode` — hooks are the mode source** (the statusline does not carry it, §2.3).
4. **`Notification` has no typed subtype** (free text; also fires as a ~60s idle nag) → contributes ambient Waiting only, never a specific card.

### 2.3 Statusline tap — context & cost (A0-verified shapes)

The statusLine script receives JSON with (verified on 2.1.227 + 2.1.231): `context_window.used_percentage` (int, + full token breakdown), `cost.total_cost_usd`, `model` (**an object** `{id, display_name}`, not a string), plus useful extras: `version` (the capture pin), `rate_limits.{five_hour,seven_day}.{used_percentage,resets_at}`, `session_name`, `exceeds_200k_tokens`. **`permission_mode` is absent** — mode comes from hook payloads + `SessionView.mode`. `git.branch` unverified in a repo (probe ran outside one). **Cadence: event-driven, per-turn granularity** (startup / submit / API boundaries / tool events / mode toggle; one mid-turn fire in a 35s streaming turn; zero while idle) — fine for context%/cost pills, **never a liveness signal**. Chaining: `statusLine` is a single global object slot `{"type":"command","command":…,"padding":…}` — no array. Wrap-don't-clobber contract: recognize only `type=="command"` (else refuse); mutate only `command`; preserve `padding`/unknown keys verbatim; the wrapper tees stdin to the supermux tap, pipes the same stdin to the original, passes original stdout through unchanged; marker + embedded original ⇒ idempotent install, exact uninstall. Surfaces: context% + cost + model in the session header pill; context% on roster rows at high density — the per-agent cost surface Grok visibly lacks.

### 2.4 Status fusion

Unchanged (hooks apex, regex banks safety net, byte heartbeat last resort). Chat surfaces Waiting only from hook-anchored signals; idle-across-resize tests carry over.

### 2.5 Overview tail — zero new requests

The tailer holds the last N parsed entries in memory → publish a compact `chat_tail` (last user one-liner + last assistant/receipt line + ts) on the **existing `sessions` SSE delta** (the `preview_lines` pattern). No REST-per-tile, no per-tile WS (a full-file recall scan per tile would kill the `spawn_blocking` pool — the live corpus is 8.9 MB). This `chat_tail` is also Part II's roster preview line (§12.2).

### 2.6 Pty geometry policy (server-side)

`rt.resize` is only ever called from the terminal WS today; native ptys boot at 80×24 — a chat-only session would run Claude at 80 cols forever, then reflow catastrophically on first terminal toggle. Policy: explicit geometry at session create and on first chat attach (default **120×40**, configurable), persisted on the session row, restored on holder respawn; terminal clients keep last-write-wins; the chat client never sends resize. A0 hardened the rationale: at 52 cols, dialog option lines **wrap** (live-captured) — narrow geometry is a *fingerprint* hazard for the modal registry, not just cosmetic.

### 2.7 State table (complete, three-column)

Rule: every row is **chat** (native) or **attention** (Attention card → terminal). Nothing silently invisible.

| State | Source | Rendering |
|---|---|---|
| User prompt (chat/terminal/delegate/steer) | transcript `user` + optimistic echo (P10) | chat |
| Queued prompts (CC queue + steering) | `queue-operation` entries + steering API | chat (P9) |
| Assistant text / markdown | transcript `text` blocks | chat |
| Thinking (ambient) | hook turn-state | chat (P7) |
| Thinking (content) | transcript `thinking` blocks | chat (collapsed disclosure) |
| Tool call running | `PreToolUse` hook | chat (running receipt line) |
| Tool success + output | transcript `tool_use`+`tool_result` | chat (receipt + P6) |
| Tool failure | `PostToolUseFailure` hook + transcript | chat (danger receipt + stderr) |
| Hook-blocked tool | transcript feedback entry | chat (receipt, `blocked` tone) |
| Subagents | hooks (live) + `subagents/*.jsonl` (detail) | chat (P4 group w/ facepile, lazy expand) |
| Todos | `TodoWrite` tool_use | chat (P11) |
| Edits/diffs | `Edit`/`Write`/`MultiEdit` tool_use | chat (P8); Bash-mediated edits → changes rail (§5.6) |
| Plan approval (ExitPlanMode) | transcript tool_use + Waiting | chat (P5 — all 3 real options) |
| Permission prompt | `PermissionRequest` (trigger) + transcript (content) | chat (P5 via modal registry) |
| Mode changes (incl. terminal Shift+Tab) | `mode`/`permission-mode` entries + `SessionView.mode` | chat (system line + header chip reconciles) |
| Compaction / `/clear` | `compact_boundary` / `SessionStart(clear)` | chat (system line) |
| Context% / cost / model | statusline tap | chat (header pill) |
| Errors / rate limits / usage-limit screens | `stop_failure` hook; else watchdog | chat (danger card) / attention |
| Images in transcript | `image` blocks | chat (inline thumb, tap to view) |
| Delegations / cross-session messages | delegate API + transcript | chat (system line + arrival divider, §13) |
| `/login`, trust dialog, resume picker, `/rewind`, `/bashes` + Ctrl+B, MCP elicitation, model/config pickers, unknown modals | watchdog + Waiting heuristics | **attention** |

## 3. Input plane (outflow)

- **`SessionInput` interface** — the renderer-agnostic handle both views implement: `submit(text)`, `insert(text)`, `sendKey(name)`, `focus()`, `blur()`. The three parent surfaces switch to it (`UseLiveTermResult` is *not* shimmed — its `send(cmd + '\r')` call sites would double-submit through REST `send_text`, which appends Enter itself; `tryOpenLinkAt` is terminal-only). Mapping: `insert` → `POST /paste {submit:false}`; `submit` → `POST /send`; `sendKey` → `POST /keys`.
- **Chat composer is client-side state.** Attachments, snippets, slash chips insert into the React textarea — never into the TUI composer (four existing paths put invisible text there: attachment path-injection, dock slash segments, snippet insert, a human typing in the terminal view). Before `submit`, the server asserts the TUI composer line is empty (peek-verify); non-empty → "the terminal has an unsent draft" banner + Open terminal.
- **Mid-turn sends — DECIDED (A0, live-measured): `/send`.** CC records a `queue-operation` enqueue at *submit* (+158ms) with dequeue/remove events (P9 gets its receipt and its cancel path); `/steer` writes nothing to the transcript until boundary delivery (measured 23s of silence — exactly the §8 "send vanishes" risk) and stays server-side only (board dispatch, agent→agent, scheduler; never in the composer — two competing queues behind one text box). The P10 delivery watchdog stays mandatory: enqueue proves acceptance, not execution, and dialog-open sends were not A0-tested.
- **Interrupt** → `keys Escape` (Stop replaces send while Active). **Mode chip** → `POST /mode`, **gated on no-dialog-visible** (A0: mode convergence presses BTab, and BTab inside a permission dialog *accepts* it). **Images** → existing Dropzone → paste path.
- **Composer power features (v1, coding-native):** `@` opens the entity picker (§14) scoped to files (`GET /api/sessions/{name}/tracked-files`) **and sessions** (delegate, §13); `/` opens the command popover — pass-through allowlist (`/compact`, `/clear`, plain-text-safe verbatim; picker-opening commands — `/model`, `/resume`, `/rewind`, `/config` — get an inline hint + Open-terminal affordance). Ctrl+G external-edit bridge stays.
- Concurrent terminal+chat typing interleaves at the pty as two terminal tabs do today; `send_text` holds the session lock for text+gap+Enter — a submit is atomic.

## 4. Renderer, state model & honesty

### 4.1 Two renderers, one session

Three call sites become a 3-way switch: `tile.tsx:213-221`, `desktop-split.tsx:619-629`, `focus/mobile.tsx:~495-515`. Terminal WS machinery untouched; chat WS is a separate cheap subscription. Toggle mechanics §6.2.

### 4.2 Primitive vocabulary (11 + system line)

Grok-validated: P1-P5, P7 (reference pixels + extracted CSS). **Own design, no Grok reference**: P6, P8, P11, thinking-content disclosure — full numeric specs in the fase-A3 design addendum before code.

- **P1 User bubble** — right-aligned, solid emphasis fill, r16, padding 10/12, max-width ~72%.
- **P2 Assistant bubble** — left, low-alpha fill on the chat substrate, r16, 10/12; **no per-bubble avatar** (identity lives in the header pill, roster and thinking row — Grok's captures show none); consecutive bubbles stack at 12px. Markdown via a `variant="chat"` component map (compact headings, tight lists, inline code as 4%-fill 0.92em mono chip) — not the document-tuned `markdown-viewer.tsx` styles; VR test: bubble with h2 + list + fenced code.
- **P3 Receipt list** — tool calls as checklist lines: check slot + tool name (600) + `→ outcome · counts`. Built for Claude's volume (30–100 calls/turn): one bubble per contiguous run; repeats coalesce (`Read ×12`); cap + "show all N"; virtualize >200. Running line: spinner in the check slot, label live from `PreToolUse`, morphs to ✓ with the scale-.4 pop. **No emoji** — 12px monochrome icons at `currentColor` (the `activity_label` emoji taxonomy stays terminal/tile-only). File-touching lines deep-link into the file viewer.
- **P4 Card** — stateful containers: subagent group, long-running Bash, errors. Title 14/600 + `data-tone` badge (existing `bg-status-*/15` + full-strength-text convention), badge morphs in place via the **same-cell crossfade** (§11.6). Card-title accent underline (1.5px, offset 3) on **hover only**. Subagent group header uses the **facepile morph** (§11.9): member marks overlapped, the active one expanding into a labelled pill (`●●● explore: searching…`).
- **P5 Choice card** — anything the TUI shows as a numbered list (permission, plan approval): full-width option rows (r10), `[data-selected]` = accent border 55% + accent fill 8%, digits 1..N as kbd hints bound 1:1 to the modal-registry mapping (server-side digit keys land in A4; until then the registry drives `Down×n`+`Enter`), Confirm pill at opacity .4 while nothing selected. **Free-text is not an in-dialog row on 2.1.2xx**: for permission it maps to Esc-then-composer; for plan approval to option 3 → composer — the card's free-text affordance drives those sequences. **ExitPlanMode renders the three real options** (auto mode / manually approve edits / tell Claude what to change) and reads the full plan markdown from the footer-exposed `~/.claude/plans/plan-<slug>.md`.
- **P6 Tool-output block** — JetBrainsMono 12.5/18, `--terminal-fg` on `--terminal-bg`, ANSI via `lib/ansi.ts`, max-height 220px + bottom fade + expand, copy affordance. Default expanded for Bash test/build output; collapsed for Read/Grep bulk.
- **P7 Thinking row** — 28px **session mark** (§10) with `data-state="thinking"` + 3-dot opacity wave (1.3s, staggered base opacities .25/.45/.7) + 13px tertiary label; row springs in 0.28s, label follows on its own softer curve (0.35s `cubic-bezier(.2,.8,.3,1)`). Label = current tool or "Thinking…".
- **P8 Diff block** — unified; no line numbers v1; hunk header 12px tertiary; full-strength `#9ece6a`/`#f7768e` foregrounds over 6–8% washes; intra-line word-diff on; wrap mobile / h-scroll desktop; max-height 320px + fade; a `Write` of a new file → collapsed file card (`+ 214 lines`); `MultiEdit` = stacked hunks, one header.
- **P9 Queued pill** — user text in a muted outline bubble + "queued" micro-badge (CC queue + steering unified); promotes to P1 via crossfade on transcript confirmation.
- **P10 Pending echo** — optimistic local echo: `sending → sent-unconfirmed → undelivered(retry)`; reconciles against the matching transcript `user` entry (normalized text + ts window + TTL) as a **no-op crossfade, never a second entry-pop**.
- **P11 Todo card** — receipt-style rows h32, circle→check glyph, done rows strike + tertiary, in-progress row carries the working badge; rewrites animate via framer `layout`.
- **P12 Working row (REQUIRED — fail-branch primitive)** — the live turn indicator, driven by the status flip (206ms p50), never the transcript: mark + elapsed timer + current hook label; numeric spec + VR states at 0s/5s/30s/>120s in the A3 addendum; collapses post-hoc into "worked for Ns" when the batch lands.
- **P13 Provisional tail (REQUIRED — fail-branch primitive)** — a visually distinct, explicitly-unconfirmed text block rendered from the pty capture (`?ansi=1` channel, pulled forward to A1/A2) during long prose generation (pty shows text at ~3.2s vs transcript ~31s). Reconciliation rule: **discarded and replaced** by the first confirmed entry (supersede gap up to ~28s), crossfade, no scroll jump, never merged. VR/perf gates cover the swap (no duplicate text, no reflow jump).
- **Receipts-first ordering rule**: when a flush batch lands, tool receipts render before the closing prose — the closing text is never the first thing to appear.
- **System line** — centred 13/500 tertiary one-liner with **clickable entity chips** (§13): `Renamed to ●deploy-fix`, `Context compacted`, `Mode → accept edits`, `Delegated from ●research`, `Created schedule ⏱ nightly-audit`, `PR opened #47`.

Scrollback: DOM scroll, native selection/copy. Cursor-paginated backlog on scroll-top with scrollTop restoration via scrollHeight delta; follow-bottom pin (48px threshold); re-anchor while a bubble grows; scroll-to-bottom pill at 44pt.

### 4.3 Modal registry (act-on set — A0 fingerprints captured & key-verified)

v1 acts on two TUI dialog families: **permission** and **plan approval**. Trust dialog and resume picker are detection-only → Attention card (A0: trust dialog not live-triggerable on this host — `hasTrustDialogAccepted` auto-written; flagged `needs-live-recapture`; resume picker rows are conversations with no stable mapping).

- **Registry entry contract**: live-capture fingerprint (whitespace-normalized token anchors — options wrap at 52 cols, never full-line equality; `❯` alone is never a fingerprint — live-confirmed collisions) + option→key mapping + **verify-caret-before-send** (re-peek between every navigation key — concurrent-client races observed live) + post-send dismissal check.
- **Key mechanics (A0-verified)**: digits are **not sendable today** (`KEY_ALLOWLIST` has no 0-9 → A4 adds them; until then `Down×(n−1)` + `Enter`); `Esc` cancels to `⎿ Interrupted…` + composer; **BTab inside a permission dialog *accepts* it** → `POST /mode` and the mode chip are gated on no-dialog-visible; an unexpected `accept_edits` flip is a possibly-swallowed BTab.
- **Verified act-on set v1**: permission options 1/3/Esc everywhere + option 2 on Edit/Write (BTab-verified); **Bash option 2 deferred** (persistence not found in any settings file — inconclusive, needs a clean re-run). Plan approval (real 2.1.231 labels): `1. Yes, and use auto mode` → `⏵⏵ auto mode on`, no further permission dialogs; `2. Yes, manually approve edits` → `⏸ manual mode`, Edit dialogs follow; `3. Tell Claude what to change` → dismissed, still plan mode, feedback via composer; Esc unverified (A4 self-test captures it first). The dialog footer exposes `~/.claude/plans/plan-<slug>.md` — P5 reads the full plan markdown from disk.
- **Dialog outcomes write nothing to the JSONL** (and a BTab-induced mode flip writes no `permission-mode` entry, while `POST /mode` does) — chat infers accept (tool_result appears) vs deny/esc (`Interrupted…` shape) and reconciles the mode chip from `SessionView.mode`. Mandatory, not belt-and-braces.
- **Version-pinned per session**: fingerprints record the **session's boot banner version** (`╭─── Claude Code vX.Y.Z ───╮` via peek) — the CLI auto-updates on disk while running sessions keep their boot binary, so `claude --version` is the wrong pin. On mismatch, registry *actions* hard-disable (degrade to Attention + Open terminal) until re-captured. Startup self-test asserts fingerprints against a fresh capture.

### 4.4 Delivery watchdog + Attention card (the honesty mechanism)

Inverted detection — everything must confirm, or escalate:

1. **Every chat send is watched**: no matching transcript `user` entry AND no Active transition within 5s → the P10 echo flips to `undelivered` and the Attention card raises, regardless of status. Catches `/login`, pickers, usage-limit screens, unknown-unknowns (the b8daf73 lesson: the authoritative signal can silently die for weeks).
2. **Transcript unresolvable/stale while running** (first start before any entry, trust dialog, staleness guard) → Attention card, not an empty-but-composable chat.
3. **Waiting without a chat-modeled cause** → Attention card.

The Attention card: "Claude is showing a dialog in the terminal" + a read-only **xterm** mini-view fed by `capture_ansi` (new `?ansi=1` on `peek` — A0-confirmed absent today: `/peek` is plain-text (`lifecycle.rs:1213`) and `lib/ansi.ts` is SGR-only; `rt.capture_ansi` exists server-side, so this is a small A2/A4 addition; interim colour channel until then: the sessions-list `preview_ansi`, 20 ANSI lines per detector tick) + one-tap **Open terminal**. If the mini-view can't render faithfully, message only. Presented in the **shell-scoped overlay** (§11.4) when expanded.

## 5. Design language (chat surface)

Foundation: supermux's HIG tokens + brand (amber `--brand`, calm status hues, dark default) infused with Grok's discipline. Identity system in §10 (Part II) — the chat surface consumes it.

### 5.1 Principles
1. **Quiet chrome, loud content** — hairlines, low-alpha fills, elevation via blur+hairline. **Dark-theme correction**: chat substrate is `--card` (#1c1c1e), not `--background` (#0a0a0a); dark fills 8–12%; `hairline` utility renders 0.5px only ≥2dppx, 1px below; VR asserts bubble-vs-substrate contrast in both themes.
2. **Accent ≠ status.** Per-session accent from the identity system (§10): 8-hue wheel disjoint from the 4 status hues (≥30°, unit-tested). Accent surfaces: mark / mention chips / card-title hover underline / roster identity / side-pane wash 6% / composer focus ring. Tone surfaces: badges, card edges. Never the same surface.
3. **Arrivals spring, changes morph** — `eases.arrive = cubic-bezier(.2,.9,.3,1.15)` 0.28s; `eases.settle = cubic-bezier(.22,1,.36,1)`; hovers 0.12s (background-color *and* color); in-place morphs 0.26s. **`data-fresh`-gated**: seed entries mount `animation:none`; only post-`seed_done` entries pop (0.42s); one 1s container mount-fade on attach. Never animate a backlog.
4. **Tiny, tight type** — body 14/20 −0.15px, secondary 13/18, badges 12, system lines 13/500, code 12.5/18 JetBrainsMono.
5. **Interaction states are part of the spec**: fase-A3 addendum includes a per-primitive hover/press/focus table (message hover → copy + timestamp; receipt hover → deep-link; `:focus-visible` via `--ring`; 44pt touch states). Keyboard-first: digits drive P5, Esc interrupts.

### 5.2 Layout
- **Focus (desktop):** existing shell + left strip. Transcript (padding 8/20/48, gap 12, max-width ~52rem centered) under a floating glass header pill in a **fixed 44px slot with an absolutely-positioned crossfading inner** (§11.7) — mark + name + status badge + mode chip + context% + cost; transcript scrolls under it. Composer pill (h46, radius-full, hairline, raised glass `blur(20px) saturate(160%)`) with the 48px 4-stop gradient fade mask above (anchored `bottom-full` to the composer); auto-growing `<textarea>` (max-h 120px, native IME), placeholder `Message <session>`, Enter submits / Shift+Enter newline, Stop replaces send while Active.
- **Focus (mobile):** transcript in the existing `MobileSheet` (keyboard-aware viewport, safe-areas, dual-signal detector reused). Floating glass chrome: back chevron · header pill · toggle (the Grok mobile trio — same three affordances as desktop, repacked). **Dock keeps all non-terminal actions** (snippets, attach, dictation, Ctrl+G, mode); only the raw-key joystick/keybar hides.
- **Toggle placement:** focus header segmented control `[Chat | Terminal]` with same-cell crossfade; overview display menu (global default) + per-tile context action (override). Hotkey `T` only when no input focused.

### 5.3 State visuals
Existing tone convention: `hue @ ~14% fill + full-strength text` (working amber + 2.4s slow spinner · waiting blue + 5px dot · done green · failed calm-orange, never alarmist red). Timestamps: centred divider at session-block starts; relative times tick (recomputed on an interval — the roster does this too, §12). Seed hidden until `seed_done`, pinned-bottom reveal. Stopped: existing calm surface, chat-styled.

### 5.6 Coding-native surfaces (anti-lookalike divergence)
1. **Changes rail** — working-tree strip (existing `GET /git` + `tracked-files`): changed files with +/− counts, tap → file viewer; catches Bash-mediated edits P8 never sees. Desktop: the side pane (§11.3, accent-tinted 6%); mobile: sheet from the header.
2. **Context/cost in the header + roster** — the number a power user checks before `/compact`; Grok's most-criticized blind spot.
3. **`@`-files and `/`-commands in the composer** — chat mode must not be less capable than the terminal at the app's actual job.

## 6. Toggle & persistence

### 6.1 Persistence
`ui-store.ts`: `defaultRenderer` (global) + `rendererOverrides: Record<name,…>`, persisted. Cross-device: `session_renderer` added to the prefs allowlist (`prefs.rs:60-64`) + SSE `prefs` reconcile — no migration. Applicability guard client and server (chat WS 404s for non-eligible sessions).

### 6.2 Toggle mechanics
- **Terminal stays mounted-but-hidden after first use** (geometry frozen — a zero-size fit reflows, d2c333c), so toggling back skips the auth→resize→seed handshake (failure classes B/K live there). First-ever open does the handshake behind the crossfade. +1 against the 32-subscriber cap, acceptable.
- **Visual:** ≤180ms same-cell crossfade, zero layout shift; header pill persists via its fixed slot (§11.7 — more robust than view transitions; Grok ships none); terminal theme shares `--terminal-bg/fg`; diff palette aligned.
- **Carry-over:** chat keeps scroll + composer draft (client state); terminal keeps buffer; unread clears on either view. Toggling while a registry keypress awaits dismissal: the check completes; outcome lands on return.
- **Test:** toggle-thrash — 100 switches under an output firehose; assert no byte gap/overlap, no resize storm, chat scroll stable.

## 7. Track A phasing

**Fase A0 — Ground truth + quick wins. ✅ DONE (2026-08-13).** Corpus, dialog registry fixtures, hook/statusline verification, PR #55 (merged: a86f04d). **Gate verdict: FAIL** — text-only p50 31.4s / max 32.8s (gate 2/6s), tool-heavy p50 4.4s; root cause: transcript batch-flushes per completed message, never during generation. **Fail branch ACTIVATED** (pre-agreed): P12 working row + P13 provisional tail promoted to required primitives; hook overlay load-bearing; receipts-first ordering; `?ansi=1` capture channel pulled forward. Not in scope: token streaming, new write surfaces. Full verdict + evidence: `a0-findings.md`.

**Fase A1 — Walking skeleton (dogfood).** Read-only chat tail from the *existing* `/recall` (minimally extended) + SSE status driving **P12** + hook-driven receipt overlay (hook EVENTS additions pulled forward from A2) + a first `?ansi=1`-based **P13** behind the flag, in the **real** focus panel with the terminal as fallback switch. Also measures the one A0 unknown: hook→UI latency (expected ≪1s). **Quality checkpoints after the dogfood week** (steer the *how*, never the *whether* — owner decision 2026-08-14): (a) something session-specific changes within 1s of send; (b) mid-turn the user can tell *what* the agent is doing without the terminal; (c) provisional→confirmed supersede doesn't visibly glitch. Anything failing → iterate with whatever pragmatic mechanism works (more aggressive pty-derived text, different presentation) until it holds; the direction never reverts.

**Fase A2 — Chat data plane.** `sessions/chat/` module: tailer (+ subagents scope, staleness guard, in-memory tail), parser + fixtures, chat WS (seed/entry/overlay, caps, firehose test), `chat_tail` on the sessions SSE delta, statusline tap (owner consent required — it writes the live `~/.claude/settings.json`), `?ansi=1` on peek (hardened from the A1 interim), geometry policy.

**Fase A3 — Full renderer, read-only.** Design addendum first (P6/P8/P11 numeric specs, hover/press/focus table, mock fixtures covering all primitives + tones + themes) → `/dev/chat` + `?mock` → primitives + motion + markdown chat-variant + VR (offline mobile rig) + perf gates.

**Fase A4 — Interactivity.** `SessionInput` swap; composer (send/insert/paste/attach/@//); P10 echo + delivery watchdog; P5 choice cards via the version-pinned registry; Attention card with `capture_ansi` mini-view; queued pills; mode chip; changes rail (side pane).

**Fase A5 — Toggle everywhere + overview.** 3-way switch at the three call sites, mounted-but-hidden retention, crossfades, persistence, chat-tail tiles, `T` hotkey, toggle-thrash test.

**Fase A6 — Polish & hardening.** Motion pass; real-device pass (iOS PWA + Android IME); a11y; chat-WS reconnect audit (staleness ceiling + visibility redial); dogfood side-by-side on another port.

**Fase A7 — Default flip.** Separate small PR; release via in-app updater; kill-switch documented.

## 8. Track A risks

| risk | mitigation |
|---|---|
| Block-level flush feels dead vs token streaming | A0 numeric gate + pre-agreed fail branch; hook overlay is the ≤1s live layer |
| Transcript format churn across CC releases | `unknown` variant; fixtures re-captured per CC bump; parser never panics; registry actions version-locked |
| Wrong-dismissal on dialog drift | version pin + hard-disable on mismatch + startup self-test |
| Send vanishes into a modal/queue | delivery watchdog — undelivered is a first-class visible state |
| TUI composer has invisible draft | client-side composer; peek-verify before submit; draft banner |
| Stale conversation pointer | staleness guard + "reconnecting" state, composer gated |
| Two views fight over the pty | chat never resizes; geometry policy; submit atomic under session lock |
| Waiting false positives | hook-anchored signals only; `Notification` demoted to ambient |
| Perf regression | lazy chat chunk; hero-path vendor gate; `chat_tail` rides existing SSE |
| Huge entries flood the wire | per-entry cap + `truncated` + fetch-full; seed byte budget |
| iOS-only bugs invisible in CI | plain DOM (no GPU-ish surfaces); real-device pass A6 |
| Terminal escape hatch rots | path byte-identical, CI kept, mounted-but-hidden = exercised on every toggle |

---

# PART II — App-wide Grok-class integration (Track B)

Grounded in three findings: (1) Grok's management IA is deliberately thin — a flat pinned/unpinned list, one search box, one `+`, a dot, hide/duplicate/delete — and **supermux's grouping/sorting already exceeds it**; the borrow is *row craft, identity system and event vocabulary, not information architecture*. (2) Grok's "one app" feel comes from ~16 concrete, extractable mechanics (`report-grok-integration`), not from taste. (3) supermux's own inventory (`report-supermux-pages`) lists 10 roughnesses that would make a Grok-class focus panel feel like a foreign object — sessions have no visual identity, `pinned/tags/desc` are wired end-to-end but unreachable, route changes are hard cuts, six routes speak six header languages, four modal shells coexist, and ⌘K can't navigate.

## 10. Session identity system (the foundation — feeds both tracks)

**The mark.** Every session gets a persistent identity mark: **shape × hue × detail** (Grok's token is shape × colour × eye-style *precisely because* colour alone fails at 18px and for colour-blind users). supermux version:
- 4 silhouettes × 8 hues × 3 monochrome-safe detail variants (pupil/notch geometry) = **96 tokens** — enough that duplicates are rare at this user's real session counts (20+ concurrent).
- **Persisted**, not derived: `mark_shape`/`mark_hue`/`mark_detail` columns (migration `0025`). Default assigned at create = slug hash, **deduped once against the live roster, then frozen** — a pure live hash would reshuffle marks whenever the roster changes, and the reroll affordance (§12.6) and duplicate-session ("copy carries the avatar", §15.1) need persistence anyway. Editable by user and agent (`PATCH /config`).
- SVG mark set in `web/src/brand/marks/` with sub-parts (`__head`, `__eye`) recolored via `--fg`, `transition: fill .6s` (the one deliberately slow transition — identity changes are felt, not snapped).
- **`data-state` on the mark is the *ambient* activity indicator** (`idle | thinking | working | waiting | stopped | failed` pose/eye variants) — but pose is the weakest channel, so the mark does **not** replace the status channel at small sizes: a status ring/dot on the mark survives 18px. The exact status × tier × mark-state × tone **mapping table ships in B0** (one vocabulary; `error` and `starting` explicitly mapped; `MemberStatusDot`'s parallel set merges in) and lands in `BRAND.md` in the same PR — not four fases later.
- The 8 hues are **disjoint from the 4 status hues** (≥30°, unit-tested on the wheel table).
- Surfaces (rollout order): focus header pill → chat P7 thinking row → roster rows/tiles → session chips (pickers, palette rows) → mention chips → team facepiles (exact Grok geometry: three 18px member marks, 1-over-2 cluster, 2px page-coloured ring, z 1/2/3). Human identity stays initials (the footer `AS` pattern — "you are the one human here").
- **Per-session accent as root custom properties**: entering a session writes `--sm-session-tint/-accent/-ink/-coat` once on the shell element; consumers (side-pane 6% wash, mention chips 14%, choice-selected 8%/55%, card-title hover underline, thinking mark coat, composer focus ring) read the variables. One variable write, five surfaces recolour in lockstep. Never on status badges, never a full re-theme.

**Identity fields (the Grok triple, adapted).**
- `display_name` = the name (mutable; slug stays the load-bearing identity for routes/hooks/scripts — Grok's no-slug model is its structural weakness, we deliberately keep ours but stop *showing* it: display name everywhere, slug on hover/detail + copy affordance).
- `desc` **promoted to "standing instructions"** (Grok's description doctrine: durable rules live on the agent, tasks live in the message). Surfaced in the session header detail + new-session sheet; groundwork for later injection into the session's context.
- `task_summary` stays the live auto-title (Grok's job-title field has no proven display surface — we skip it; task_summary already fills that slot, live).
- **Self-naming**: the agent proposes a `display_name` after the first prompt (migration 0019 split slug from label precisely so renames are safe); applied via `PATCH /config`, logged as a transcript system line `Renamed to ●deploy-fix`. **Guard rails (B0 decision, resolves the task_summary conflict):** self-naming fires only while `display_name` still equals the slug (a user-set name is never overwritten), and identity renders two-line wherever the preview slot isn't already live — `display_name` 14/20 + `task_summary` secondary — so the live auto-title isn't shadowed (`sessionTitle()` returns `display_name` whenever it differs from the slug). User rename becomes reachable everywhere the name shows (today it's buried in the info panel).
- **Phantom features get UI**: pin (tile/row context + palette + roster ordering — `smartSort` already sorts by it), tags (chips on tiles at low density + filter in the display menu — search already matches them), desc (header detail + new-session sheet). These are wired end-to-end server-side today with zero controls — half-built in a way that looks like a bug.

## 11. The shell — one glass language

The single most important structural fact from the Grok forensics: **the whole window is one glass substrate; columns are translucent tints on it. One blur, three alphas** — that's why regions read as one app. Mechanics to adopt (ranked; all values extracted from shipping CSS):

1. **Substrate + tinted columns — paint, not blur.** The Grok replica blurs its shell because a wallpaper sits behind it; supermux's shell root is the outermost element — there is nothing behind it to blur, and a non-`none` `backdrop-filter` makes the element a **containing block for every `fixed` descendant**, which would silently break the mobile focus sheet's `visualViewport` keyboard math (`mobile-sheet.tsx:53-70`), the KeyBar, the joystick, and the tour overlay — plus the repo already documents iOS WebKit dead-taps under backdrop-filter ancestors (`a2hs-sheet.tsx:95-98`). So: substrate = **opaque paint** (`--card`-mix tint layers per column); `backdrop-filter` stays exclusively on *floating chrome* (the existing `.glass` pattern: header pill 28px/165%, composer + popovers 20px/160%). Separators are 0.5px absolute `::after` strips, never `border`. B1 adds a mobile-keyboard + keybar regression test.
2. **Shared chrome tokens**: `--sm-toolbar-min-h` as a **floor with additive `pt-safe`** — never a fixed height (the repo's documented safe-area contract, `globals.css:203-221`: "the inset has to GROW the header box"; a fixed 44px clips under the Dynamic Island). Crossfading inners live in `inset-0` absolute children of min-height boxes. Per-column floor (44 vs 56) decided explicitly in B1. One z-ladder documented (content 1 → panes/headers 3-5 → overlay 20 → popovers 30 → presence 50).
3. **Side pane** (changes rail, session info, issue detail): 3-column grid `minmax(0,auto) minmax(0,1fr) minmax(0,auto)`; the pane column animates width 0→N while its child is `position:absolute; inset:0 0 0 auto` — content keeps natural width, never re-typesets. Pane background: `color-mix(var(--sm-session-tint) 6%, transparent)`.
4. **Shell-scoped overlay — desktop (`≥md`) only** (full-screen terminal, Attention peek, diff/file viewer, issue detail): `position:absolute; inset:0` inside the shell — nav rail and header stay visible, dimmed under a `#00000061` scrim (`cursor:default`, click-to-dismiss); frame sized by container queries (`aspect-ratio` + `min(100cqh−72px, 62.5cqw−45px, 512px)`); 26px glass close button. Enter 520ms `settle`, exit 300ms — exits always faster than entries (popovers: 150/100). **`ResponsiveSheet` is the mobile form of the same state** (on mobile the focus route strips the navs and lives in a body-level fixed sheet — a shell-absolute overlay would be occluded); quick-peek keeps its Vaul drag idiom and migrates via §16.1 in B5, not B1. Rule stated explicitly (Grok device 16): **three fidelities, one component** — inline card / side pane / overlay-or-sheet are the *same* component with a `variant` prop that changes only chrome.
5. **Route transitions**: `morph.tsx` promoted from 3 call sites to the standard — nav links use `<MorphLink>` (zero consumers today), the duplicate reduced-motion-ignoring copy in `session-row.tsx:19-34` is deleted, every route gets enter choreography on the three-speed system. Tile→focus keeps the shared-element session morph (`vtSessionName`). **Collision resolved in B1**: the nav-active pill currently animates via framer `layoutId` (`layout.tsx:114-118,187-191`) — `startViewTransition` snapshotting mid-spring double-animates it; either the pill becomes a VT-named element or the nav is excluded from the transition.
6. **Same-cell crossfade** for every in-place state change: `.sm-swap { display:grid } .sm-swap > * { grid-area:1/1; transition:opacity .26s }` + `[data-hidden]` — badges, mode chips, `Chat|Terminal` labels, context%/cost, "You're in control"↔"Working". Zero layout shift.
7. **Fixed-height chrome slots**: headers are `relative` boxes at `--sm-toolbar-h` with absolutely-positioned crossfading inners — session switches and renderer toggles swap header content with guaranteed zero layout shift.
8. **Scroll-edge mask fades**: `--fade: 36px`, `[data-fade-top]/[data-fade-bottom]` mask-gradients on any scroller + the 48px composer fade — scroll affordance without shadows, correct on glass.
9. **The facepile morph** (`avatar-row`): overlapping marks (−24% margin) where the active one expands into a labelled pill by animating **padding** (0.4s ease) — used for the subagent group card (P4), team rows, and the overview header's "N active" cluster (the one that just changed state morphs open with its name for a few seconds).
10. **Presence layer** (z50, above even overlays): labelled cursors ("You" vs the agent's mark-coloured ghost) whenever a shared/watched surface exists (teammate view, future). "Who is driving" must never be occluded.
11. **Motion system consolidation**: three speeds — `.12s` hover/press (background *and* color), `.26s` in-place morph, `.28/.42s` `data-fresh`-gated arrival — plus `.45s` roster-row arrival (**horizontal** `translateX(-10px)`, a different axis than the transcript's vertical pops: different surface, different signature), `.4s` facepile morph, `.6s` identity recolour. Exits faster than entries everywhere.

## 12. Overview → roster (keep our IA, adopt their craft)

**Deliberately NOT adopted**: Grok's flat list, its lack of sort controls/folders/tags/filters, its countless unread dot, its collapsed-mode unread hiding (a bug — attention state must survive collapse), its 50-item cap. supermux's grouping (drag groups, named dividers), three sort modes, and density tiers stay — they exceed Grok.

**Adopted:**
1. **Row craft**: the roster row — 53px: 32px mark · name 14/20 · relative time 12/16 (ticking) · **live preview line 12/16 in the same slot as status** (idle → `chat_tail` text verbatim; active → the live activity label; the preview *is* the status line). `container-type: inline-size`; `@container (max-width:160px)` drops the timestamp first. Component shape (avoids the god-component trap): one presentational **`<SessionIdentityRow>`** (mark + title + meta/preview slots + `density`) consumed by thin interaction wrappers (overview list, focus strip, palette); the form-control `SessionPicker` is explicitly *excluded* (it's a value picker, not a roster row). **Palette/picker rows are static** — no ticking timestamps or mutating status under the keyboard cursor (Grok's picker rows are static too). The tile/row split ends via a **fact-ladder table** (B2 deliverable): tile tiers 1–4 · list row · strip · picker — which facts (tokens/branch, error badge, host badge, jump chip, context%, preview lines, archive affordance) appear at which density, so switching view mode changes *density*, never *which facts exist*.
2. **Three-tier attention model** — **provider-neutral by construction**: **needs attention** (permission / plan approval / question / inbound delegation — hook/transcript anchors where available, `waiting` status otherwise) > **unread activity** (Claude sessions: new entries since last view via `entry_count`/`last_entry_ts` added to the `chat_tail` SSE delta; non-eligible sessions — codex/kimi/remote/team: `last_activity`/preview-change fallback, so every row has the tier) > **working** (← `active`). `error` is promoted alongside needs-attention (it already has three affordances today; it doesn't vanish). Seen-cursors: **localStorage v1**; cross-device later via a per-row `PATCH /api/sessions/{name}/seen` — *not* the prefs blob (single 50 KB value, whole-value PUT, last-write-wins across devices would clobber read state). Opening a session marks read; manual mark-unread in the context menu.
3. **Roster-level attention rollup** — the thing Grok lacks: a compact "needs you: N" facepile cluster in the overview header (morphing open per §11.9). Tap target: **the session's chat scrolled to the pending P5 choice card** — the common case — falling back to the Attention card for watchdog states (the two are different things: P5 = modeled approvals in chat; Attention card = escalation for what chat can't model).
4. **Pinned-first hairline** (no "Pinned" text header) in list/strip/pickers; pin control finally surfaced (§10). The focus strip additionally adopts the **collapse-to-rail** `[data-collapsed]` pattern (avatar-only 18px marks) — keeping the unread dot visible in collapsed mode (Grok hides it there; that's a bug, not a paradigm).
5. **Tile evolution**: mark + status ring replaces the bare status dot; chat-mode tiles show the conversation tail instead of raw ANSI; context% at high density; team tiles get the composite facepile mark.
6. **New-session flow**: keep our functional fields (dir/provider/host/worktree — load-bearing; Grok's form-free create doesn't fit), add: mark preview with reroll (persists to the mark columns), `desc` ("standing instructions"), tags, **model**, and an **initial prompt** (replaces the board's "Add & start"). Provider picker gets marks instead of text-only labels.
6b. **Sort/grouping debt paid, not laundered** (deep-1 roughness #4 — the current IA is a complexity-to-value inversion, not a strength): per-group sort modes move from localStorage to the server pref (they currently don't follow you across devices, contradicting §13.4); **group-by presets** (dir/provider/host/status) join manual drag groups; one canonical prefs surface (the display menu) with Settings→Appearance and the palette as thin mirrors, cross-referenced.
7. **Header unification**: the remaining routes (overview/files/settings) adopt one header grammar (the `--sm-toolbar-h` glass bar: title 17/600 + context controls + search where applicable), replacing today's six divergent header languages. Settings' large-title scroll behavior stays as the one sanctioned variant (it's good).

### 12.8 Navigation slimming (owner decision, 2026-08-13)

Nav shrinks to **Overview · Focus (desktop) · Files · Settings** — the chat-first paradigm makes two pages redundant:

- **Board: removed — but a read surface ships before the page dies.** The board's Doing-card loop (agent question → inline reply → status) *is* the chat renderer's core loop, done better (P5 cards, delivery watchdog, attention tiers). But the board has live **writers** that keep running (`board/dispatch.rs` steering-injection, `board/claim.rs`, `scheduler/hook.rs`, and `teams/board_sync.rs` — the mirror of `~/.claude/tasks/{team}/NN.json` that backs the team `X/Y tasks` rollup, which transcript lines can never replace since teams are outside Track A's guard). "API stays, UI goes" is not neutral while four server components write into an invisible store. So B2 ships, *in the same PR as the removal*: an **issue list + detail in the session detail sheet / side pane** (per-session and per-team; acceptance items, PR/commit links, due, `team:`-assignee, and the durable-comment fallback for replying to a *dead* session — which chat structurally can't hold), reusing the existing `BoardDetailPane` machinery in the §11.4 overlay/sheet form. That surface is also the navigation target for `board issue` entity chips (§13.1) and picker results (§14). Removed: the page, nav item, palette board verbs, board switcher. API deprecation is a separate later decision once transcript-based reporting has replaced the `supermux-task` skill in practice.
- **Scheduler: folds into Settings + per-session — as a redesign, not a "move".** Grok's IA (routines live on the agent; no global routines page): primary surface = **session detail → Schedules** sheet (list, Test-run, run history with failures, enable/pause) + **conversational creation** (§13.3). Settings gains a **Schedules section** as the global admin view — respeced to Settings' grammar (settings-width list rows + `ResponsiveSheet` detail hosting the existing `ScheduleForm`/`FireLog`); the current 5-column `max-w-5xl` table cannot move "wholesale" into a 42rem column. `/scheduler` redirects to `/settings#schedules` (the `/hosts` pattern). **Onboarding is part of this PR**: tour step 3 anchors on the Scheduler nav item (`data-tour="scheduler"`, `layout.tsx:56`) — it gets retargeted/rewritten (and step 4's create-flow anchor re-verified against §12.6's new sheet) so the tour never points at a page that no longer exists.

## 13. The transcript as management log + cross-session fabric

1. **System lines with clickable entity chips** (mechanic: inline-flex pill, `margin:-1px -5px -1px -3px; padding:1px 5px 1px 3px` — negative margins cancel padding so the chip costs zero layout; hover fill + colour transition .12s; inline mark at `height:1lh`). Entities: session, board issue, schedule, host, PR, subagent. Every cross-session event becomes a navigation affordance. Sources: rename, schedule created, board issue linked/done, delegation, worktree created, mode change, compaction — surfacing the audit trail supermux already writes (`0007_audit.sql`) as living transcript content.
2. **Delegation UX — the biggest under-exploited supermux asset**: `POST /api/agents/delegate` exists but is a curl incantation today. In chat: `@<session>` in the composer → delegate (picker shows marks + live status); the sending transcript gets an **in-flight handoff pill** (`[sender mark] ●●● Sending to ●deploy-fix… [recipient mark]`); the receiving transcript gets the **arrival divider + sender-coloured mention chips** — cross-agent provenance at the point of arrival, in the sender's colour. **Mechanism (the current pipeline can't render this):** delegate delivers via `lifecycle::send_text`, so the receiver's JSONL gets a plain `user` entry indistinguishable from a human prompt, and recall's `Kind::Teammate` is Claude's fleet envelope, not supermux delegation. B4 extends the delegate API with an explicit `actor` (a composer-initiated delegate is the *human*, not `agent:<from>` as the audit row currently records) and emits a first-class **`delegation` event** (id, from, to, ts) on SSE/chat-WS that the renderer joins to the transcript entry for the divider; if a transcript wrapper tag is used instead, `recall.rs` gets a `Kind::Delegation` variant in the same PR (else delegated prompts vanish from the default recall view). Delegations also feed the roster needs-attention tier ("inbound handoff").
3. **Conversational automation — with a named mechanism** (today agents can only report schedule *completion*; create/list are bearer-only, and nothing parses natural language): B4 ships (a) a managed **`/supermux-schedule` command + hook-token-scoped create endpoint** mirroring the board hook pattern — the agent parses "run this every weekday at 8" itself and POSTs a concrete cron spec; the server validates and logs `Created schedule ⏱ <name>` as a system line with a chip — and (b) the trivial human path: a composer affordance opening `ScheduleForm` prefilled. Per-session placement is primary (session header → Schedules sheet); global admin in Settings (§12.8). Adopt **run-history retention** (keep last 20 run records) and surface Test-run + failure history in the detail sheet (plumbing exists, `0020`).
4. **Cross-device continuity**: same thread on phone and desktop is already true; make it *felt* — seen-cursors and renderer prefs sync via `/api/prefs` + SSE.

## 14. One picker, one palette (discovery spine)

One `<EntityPicker>` component (rows `padding:7px 8px; gap:10; radius:8`; `[data-highlighted]` set identically by keyboard and pointer; container `max-height:min(280px,46vh)`, `overscroll-behavior:contain`, raised glass, shadow `0 1px 2px #0000000f, 0 14px 36px -10px #00000047`; **nested radii step down, never match**), two anchors (down from a search field; up from an `@`/`/` composer token with tighter 4px/6px rows). Typed result union: session · file · board issue · schedule · snippet/skill · host · action.

Consumers (consolidating today's separate implementations): ⌘K palette, overview search, composer `@`/`/` popovers, palette session rows. (The form-control `SessionPicker` stays a value picker per §12.1.) The palette finally gets: navigation (**Files/Settings** — the four-item nav per §12.8), new session, new group, theme toggle, sort/density/view (as mirrors of the canonical display-menu surface, §12.6b), "open file", "new schedule" — and, once the chat renderer exists, **transcript deep-links** (recall search exists server-side). `board issue` stays in the typed union — its navigation target is the §12.8 issue detail surface, not a removed page. Shortcuts get advertised: `⌘K` hint in the shell, shortcut cheatsheet in the palette (today `[`/`]`, `g n`, `⌘1..9`, type-on-hover are all invisible).

## 15. Lifecycle & notifications

1. **Duplicate session** (Grok's "a bot is its own template"): clone `desc`, `tags`, `provider`, `flags`, `mcp`, `auto_continue`, schedules into a fresh slug + new worktree — **not** transcript/history. Named `<name> copy`. (`/clone` and `/duplicate` endpoints exist — unify + surface.)
2. **Archive language aligned to "hide"**: archived sessions keep running schedules unless explicitly stopped — state this contract in the UI either way (Grok leaves it implicit; we say it).
3. **Delete honesty**: the confirm dialog enumerates what is and isn't removed (worktree? branch? board issues? schedules? delegation history?) — and keeps an undo window (Grok's no-undo is a liability, not a paradigm). Kills the four raw `window.confirm()`s (incl. "kill session") as part of §16.
4. **Notifications**: per-session opt-in toggle (web-push exists), suppressed while the app is focused, PWA badge still updates; wired to the three attention tiers (default: needs-attention only). The idle-away guard ("keep schedules running?") becomes an opt-in cost-control prompt for `auto_continue` + schedules.
5. **Graded, consequence-labelled recovery** — inline *and* canonical: the error state offers the least-destructive action in place ("Reconnect holder — keeps scrollback"), Settings lists the full ladder (Restart → Recover holder → Reset) each labelled by what it preserves; blocked things state *why* with the same sentence everywhere.

## 16. Consistency cleanup (the unglamorous phase that makes it feel native)

1. **One modal system**: `ResponsiveSheet` becomes the only sheet (10 raw Vaul call sites migrate in); shadcn `Dialog` only for small focused confirms; **zero** native `window.confirm()`. One inline-confirm idiom (the 4s-armed pattern) replaces the current three.
2. **One empty/loading/error language**: `EmptyStatePlaceholder` + `brand/copy.ts` everywhere (board lanes, files, scheduler currently hand-roll four variants); one skeleton idiom.
3. **Teams integration**: desktop gets a team-creation path (currently mobile-only long-press); `MemberStatusDot`'s parallel vocabulary merges into the mark `data-state` system; teammate rows become the standard roster row; team boards keep read-through semantics but standard card chrome.
4. **Toast/entity-chip/status vocabularies documented in `BRAND.md`** so future surfaces can't drift.

## 17. Track B phasing (interleaved with Track A)

Track B is sequenced so Track A always lands on ready foundations; each fase = one PR.

**Fase B0 — Identity + motion foundations** *(before A3)*: mark SVG set + migration `0025` (mark columns, hash-default + dedupe-once + frozen) + wheel disjointness test; **the vocabulary mapping table** (status × attention tier × mark `data-state` × tone, incl. `error`/`starting`/`failed`, merging `MemberStatusDot`) into `BRAND.md`; self-naming guard rails decision (§10); root accent variables; `springs.ts` curve additions; `hairline` + `.sm-swap` + min-height chrome-slot utilities. Ships flag-free (additive); marks appear first on the focus header + pickers.
**Fase B1 — Shell + route morphs + scheduler fold** *(parallel to A3/A4)*: painted substrate + tinted columns + z-ladder (no root backdrop-filter; mobile-keyboard + keybar regression test); nav `<MorphLink>` + delete the session-row duplicate + resolve the `layoutId`-vs-view-transition nav-pill collision; shell-scoped overlay component (desktop) + `ResponsiveSheet` as its mobile form — first consumer is the Attention card (quick-peek migrates in B5); header grammar (`--sm-toolbar-min-h` floors, per-column decision) on the remaining routes; **scheduler → Settings section (respeced to Settings grammar) + `/scheduler` redirect + onboarding-tour retarget** (§12.8).
**Fase B2 — Roster evolution + board removal** *(with A5, shares the `chat_tail` delta; removal gated on the attention rollup + chat reply loop + issue read surface all being live)*: `<SessionIdentityRow>` + fact-ladder table, mark-on-tile, three-tier attention model (provider-neutral fallbacks, `entry_count` on the delta, localStorage seen-cursors) + header rollup, pinned hairline + pin/tags/desc UI, new-session identity fields (mark reroll, desc, tags, model, initial prompt), sort/grouping debt (§12.6b: per-group sort → server pref, group-by presets, one canonical prefs surface); **issue list/detail surface in session detail (per-session + per-team) in the same PR as removing the Board page/nav/palette verbs** (server API + writers stay, §12.8).
**Fase B3 — Picker/palette consolidation** *(after A4's composer popovers prove the component)*: `<EntityPicker>` everywhere applicable, palette navigation + actions + shortcut cheatsheet, transcript deep-link search.
**Fase B4 — Transcript-as-log + delegation + conversational schedules** *(needs A2 data plane)*: system-line entity chips; delegate API `actor` + first-class `delegation` event + `@session` composer flow + handoff pill + arrival divider (+ `Kind::Delegation` if a wrapper is used); `/supermux-schedule` command + hook-token-scoped create endpoint + composer affordance + per-session schedule detail; audit surfacing.
**Fase B5 — Lifecycle + notifications + cleanup**: duplicate/delete-honesty/undo, per-session notifications + badge, modal/empty-state/teams consolidation (quick-peek → `ResponsiveSheet` here), recovery ladder, cross-device seen-cursors via `PATCH /sessions/{name}/seen` if wanted.

## 18. Track B risks

| risk | mitigation |
|---|---|
| Identity marks read as toys / clash with the pro tone | geometric silhouettes + monochrome detail variants v1 (expressive eyes are a flagged enhancement); B0 mockup review with the owner; kill-switch to status dots |
| Mark duplicates at real session counts | 96-token space + create-time dedupe + persisted columns + reroll |
| Accent-follows-session re-theming disorients | scoped to the six named surfaces; never badges; 0.6s transition makes switches legible |
| Substrate/glass breaks fixed-position mobile chrome | substrate is painted, never a root backdrop-filter (containing-block hazard); blur only on floating `.glass` chrome; B1 keyboard/keybar regression test |
| Route morphs regress focus key handling / double-animate the nav pill | per-link adoption, route-by-route tests; `layoutId` collision resolved in B1; reduced-motion → plain navigate |
| Roster attention tiers false-positive (the #41/#43 class again) | needs-attention is hook/transcript-anchored; unread is seen-cursor arithmetic on provider-neutral signals, no byte heuristics |
| Vocabulary drift (6 statuses × 3 tiers × mark states × tones) | one B0 mapping table in BRAND.md, shipped with the first mark, not after |
| Consolidation churn breaks muscle memory | per-surface PRs; the user reviews each; no removals without the replacement in the same PR |
| Scope creep (Track B eats Track A) | B0/B1 small and additive; B2+ gated on the Track A fase that proves the shared piece |
| Board removal orphans live writers / team task drill-down | issue read surface (session detail + per-team) ships in the removal PR; server API + `supermux-task` + `board_sync` stay; deprecation separate and later |
| Scheduler fold breaks onboarding/muscle memory | tour retargeted in the same PR; `/scheduler` redirect; Settings section respeced, not squeezed |

## 19. Open questions

1. ~~Mid-turn `/send` vs `/steer`~~ — **decided in A0: `/send`** (§3).
2. Mark expressiveness — **decided in B0 round 2: Option B (eye-states) cut to backlog**; v1 is geometric shape × hue × detail.
3. `chat_tail` payload shape (lines per density tier) — decide with the B2 fact-ladder measurements.
4. Board API end-state (deprecate vs keep as the issue store behind the session-detail surface) — decide after transcript-based task reporting has run in practice.
5. Owner sign-offs pending (from A0 §8): statusline installer touching the live `~/.claude/settings.json` (A2); `KEY_ALLOWLIST` widening to `0-9` (A4) vs staying with `Down×n`+Enter; clean-host capture slot for the three deferred dialog captures (Bash always-allow persistence, plan-Esc, trust dialog) vs shipping registry v1 without those act-ons; CC version-churn re-verification ownership/cadence.

## 20. Sources

- `report-grok-ui` — Grok Bot design system (tokens, keyframes, 34 timed captures) — scratchpad + `…/scratchpad/grok/`
- `report-grok-mgmt` (deep-3) — agent management paradigms, 14 docs pages, 40-row adopt/adapt/skip mapping
- `report-grok-integration` (deep-2) — shell/transition forensics, 118 animation rules, 16 ranked integration devices
- `report-supermux-pages` (deep-1) — full non-focus inventory, 10 roughnesses
- `report-supermux-arch` — architecture map with file:line seams
- `report-render-pain` — 11 failure classes, dies/survives, 22 locked lessons
- `report-claude-wrapping` — hooks/transcript/statusline surfaces + TUI-only gaps
- `review-1/2/3.md` — three-lens adversarial review of v1 (integrated in v2)
