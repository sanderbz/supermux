# Fase A6 — Polish & hardening (the last fase before the default flip)

**Worktree** `/opt/projects/supermux-a6` · **branch** `feat/a6-polish`, off `origin/main` (`a7cc52c` = #74).
**A1–A5 and B0/B1/B2/B4 are merged. B3 is NOT** — `feat/b3-pickers` points at `a7cc52c` itself
(0 of 51 boxes ticked). Nothing in A6 may assume a shared `<EntityPicker>`, palette navigation
verbs, the shortcut cheatsheet or transcript deep-links.

**Master plan** `docs/superpowers/plans/2026-08-13-claude-chat-renderer.md` — the A6 row (§7),
Track A risks (§8), motion ownership (Global Constraints + §11.11), the staleness guard (§2.1),
the delivery watchdog (§4.4), toggle mechanics (§6.2). It lives on the unmerged branch
`docs/grok-ui-plan`:
`git show origin/docs/grok-ui-plan:docs/superpowers/plans/2026-08-13-claude-chat-renderer.md`.

**Predecessor ledgers** `2026-08-14-fase-a2-chat-dataplane.md`, `…-a3-chat-surface.md`,
`…-a4-interactivity.md`, `2026-08-16-fase-a5-toggle-overview.md`, `…-b1-shell.md`,
`…-b2-roster.md`, `…-b4-fabric.md`, plus `docs/superpowers/plans/b4-security-checklist.md`.

> One sentence of scope: **A6 makes the thing that already works *hold up*** — it pays the
> accumulated deviation debt, gives the chat socket the honesty it is missing (the server already
> computes staleness and the client throws it away), finishes the motion and accessibility passes,
> and then **proves the whole program on video**: every scenario the Grok reference corpus
> demonstrates, re-enacted with *real* Claude sessions on desktop and phone, in both themes, as
> screenshots **and** Playwright-recorded video, judged side by side against the reference frames
> until a jury passes it — after which the owner gets a ten-minute guided real-device checklist
> and tries it with his own hands.

**A7 is deliberately NOT in this plan.** The default flip is a separate small PR that begins only
after the owner has personally used this build on his own devices. A6 ends with an **A7-readiness
checklist**, never with a flip.

---

## 0. Ground truth

> **`git fetch` before you audit anything.** The main checkout `/opt/projects/supermux` was at
> `c854937` (two merges behind) when this plan was written; every reference below is against
> `origin/main` = `a7cc52c`, read out of the worktree `/opt/projects/supermux-b3` which sits on
> that exact commit. Other agents build here on rotating branches — **never commit, branch or
> stash in the main checkout** (memory *concurrent-agents-in-repo*).

### 0.1 The accumulated polish debt

The audit read all eight ledgers and checked each claim against the code. **Read this first,
because the ledgers are not uniformly trustworthy:** only A5, B1, B2 and B4 carry real
*execution* ledgers. **A2, A3 and A4 have none** — their "explicitly deferred" sections are
*authoring-time* intentions and nobody recorded what actually shipped. One ticked box is
provably false (#4 below). So T0.3's triage is a re-verification, not a transcription.

| # | item | where recorded | class | proposed |
|---|---|---|---|---|
| 1 | **Subagent turns are invisible in chat, and `fetch-full` would 404 for them.** `find_full_entry` scans only the parent transcript (`server/src/sessions/chat/ws.rs:364-379`); subagent entries live in `<conv>/subagents/agent-<id>.jsonl`. The 404 is avoided only by never asking: `wire-entries.ts:453` skips `agent_id != null` and `:353` drops subagent turns. During a 5-way Task fan-out chat shows a spinner and `· N subagents` and nothing else, while the terminal shows the work | never written down in any plan | user-visible | **A7-blocker** |
| 2 | **Truncated entries are unrecoverable inside chat.** `AUTOFETCH_WINDOW=12`, `AUTOFETCH_CONCURRENCY=2` (`chat-socket.ts:117-118`); a failed fetch is never retried by design (`:161-164`); anything older than the newest 12 keeps its clip forever. The only affordance is a non-interactive `title` tooltip that says *"open the Terminal view for the full text"* (`transcript-item.tsx:286-291`) | A2 plan `:268`, `:761`; no ledger | user-visible | **A7-blocker** |
| 3 | Hook-token delegate endpoint — `/api/agents/delegate` is on the bearer router (`agents/mod.rs:23`); an agent holds only `SUPERMUX_HOOK_TOKEN`, so agent-initiated hand-off needs an admin-equivalent credential | `b4-security-checklist.md:73-82` (recorded, with the follow-up shape written out) | infra/security | later (own gate) |
| 4 | **`model` in new-session does not exist** — `b2-roster.md:481-484` ticks it, `new-session-sheet.tsx` has `desc`, `tags`, mark reroll and initial prompt and **zero** occurrences of `model` | ledger says done; code says no | user-visible + ledger integrity | **A6** |
| 5 | `overview-mobile-parity` largely closed by B2; **`ios-pwa-chrome` still 1-of-2 red**, and the host constraint remains (single-process chromium ⇒ one browser context per spec file; whole-suite runs are meaningless) | `b1-shell.md:467-470`, `:625-641` | infra (rig) | A6 (rig), later (the spec) |
| 6 | **`playwright.mobile.config.ts` cannot launch.** Playwright 1.60.0 requires **webkit 2287**; this box has **webkit-2215** only. Every plan that says "mobile shot via `playwright.mobile.config.ts`" describes a run that cannot have happened as written | `b2-roster.md:168`, `b3-pickers.md:152` | infra + invalidated evidence | **A6, first** |
| 7 | **Chat faces ≠ roster identity.** `pinFor`/`pin` is threaded through the whole renderer but supplied only by the dev benches; `chat-panel.tsx` never imports `usePin`. B2 landed the columns (`0027_session_mark_pin.sql`), so this is unblocked and simply unwired — two identities for one session across the two surfaces A7 makes co-equal | `a3-chat-surface.md:156` (`TODO §10`) | user-visible | **A7-blocker** |
| 8 | Attention card is still pane-scoped (`TODO §11.4`); B1 shipped `<ShellOverlay variant="frame"\|"pane">` and explicitly did not convert it | `a4-interactivity.md:465`, `b1-shell.md:395-400` | user-visible polish | A6 if cheap, else B5 |
| 9 | Changes rail — deferred three times (A4→A5→B1); B1 shipped the `pane` variant with **no consumers** | `a4:871`, `a5:843`, `b1:729` | feature gap | later |
| 10 | Context %/cost in the chat header — server has it (`chat/statusline.rs:443-476`), client has no consumer | `a4:886`, `b2:733-735` | user-visible | later (gated on #20) |
| 11 | Plan-dialog `Esc` still `actOn:false` — the deferred live capture never landed | `a4:748-773` | honest degradation | polish |
| 12 | Queued-prompt pill + cancel (P9) never built; queueing survives only as a receipt sentence; `pending.ts:312` still carries an unresolved `A2-SEAM` | `a4:653-660` | feature gap | polish |
| 13 | Bash "always allow" `actOn:false` — a **closed decision** with a 2.1.233-verified rationale. Do not re-open | `a4:750-760` | — | wontfix |
| 14 | `KEY_ALLOWLIST` never widened to `0-9`; documented workarounds exist | `a4:50-52`, `:883` | infra | later |
| 15 | The `T` renderer hotkey is desktop-only — `routes/focus/mobile.tsx` has no keydown capture | A5 deviation table `:120` | user-visible (HW keyboard on phone) | later |
| 16 | Quick-peek has no chat lens | A5 `:114`, `:846` | polish | later (B5) |
| 17 | **The default flip itself (A7)** — `chatRenderer` ships default-OFF | `a5:850` | — | **A7** |
| 18 | chat for codex/kimi/remote/team — excluded by the Global Constraints guard | `a5:853` | feature | later |
| 19 | Roster context % — needs a `statuslines` field on the sessions delta | `b2:101,338,719,733` | infra→feature | later |
| 20 | **The dark `statusline` delta key** — broadcast since A2 (`statusline.rs:593`), no TS type, no consumer. Cheap: typing + consuming it unlocks #10 and #19 | `b2:111`, `:752-753` | infra | A6 if cheap, else later |
| 21 | No typed Rust struct for the sessions delta — thirteen hand-built `json!` sites | `b2:749-751` | infra | later |
| 22 | Cross-device seen-cursors (`PATCH /sessions/{name}/seen`) — unread is `localStorage` only | `a5:848`, `b2:405-411` | user-visible | later (B5) |
| 23 | Tailers never warm for unattached sessions — a recorded architectural decision | `b2:754-756` | — | wontfix (re-decide only on evidence) |
| 24 | `MemberStatusDot` never merged into the mark vocabulary | `b2:371`, `:742-743` | polish | later (B5) |
| 25 | Board API not deprecated (page gone, server + iCal + hook routes live) | `b2:744-745` | infra | later |
| 26 | **`BUDGET_APP_JS` ratcheted to 210 KB, not the promised 200.** Current build **205.46 KB — ~4.5 KB of headroom** for B3 + B5 + A7 combined; `BUDGET_ENTRY_JS` 144.73/160 | `size-budget.mjs:29-46`; the obligation was `b2:50` | infra | **A6 must not consume it blindly** |
| 27 | **`bun run lint` is red on main** — six pre-existing `react-hooks/set-state-in-effect` errors (`last-send-recall.tsx` ×2, `where-picker.tsx`, `updates-panel.tsx`, `file-list.tsx`, `attention-card.tsx`). Standing convention since B1: *zero NEW errors*, not green | `b1:170-173`, `b3:178-180`, `b4:41-45` | infra | A6 (fix the one in `attention-card.tsx` it touches) |
| 28 | z-ladder never renumbered — named tokens over existing literals, ~50 call sites | `b1:31`, `:729` | infra | later |
| 29 | 24 files still use Tailwind `backdrop-blur-*` outside `.glass` — B1's one-blur invariant is enforced only in `globals.css` + a runtime ancestor-walk on the focus route | `b1:264-268` | infra / mobile-perf | later, but **T9.1 tests the hazard** |
| 30 | **B1's T10.4 dogfood was never done** — "this box's supermux instance on 8824 hosts the session doing the work" | `b1:666-670` | verification debt | **A6 closes it (T10)** |
| 31 | B1's unshipped §11 items: scroll-edge mask fades (§11.8), facepile morph (§11.9), presence layer (§11.10), side-pane consumers | `b1:727-733` | polish | later |
| 32 | `tests/e2e/status-dot-pulse.spec.ts` orphaned — no config's `testDir` covers it | `b2:747-748` | infra | A6 (adopt or delete, and say which) |
| 33 | `RosterRow` → `SessionIdentityRow` rename declined; alias documented. Do not re-raise | `b2:746` | — | wontfix |
| 34 | B4's `harness` SSE frame is on the **global** channel — `sessions:[…]` is a client-side filtering hint, not an authorization boundary. Any authenticated listener learns a delegation happened and between which slugs; no prompt body leaks. Accepted for that fase | `b4-security-checklist.md:41-51` | security, accepted | later |
| 35 | B4 out-of-scope: board-issue chips (**now unblocked** — B2 shipped the destination), host/PR/**subagent** chips (same root as #1), NL schedule parsing | `b4:696-700` | feature | later, except the board-issue chip (cheap) |
| 36 | **All of B3 is open.** Two defects inside it are pullable-forward without the fase: `mobile-bottom-panel.tsx:472-478` has `role="listbox"` with **no `role="option"` on the pills** (a real a11y bug), and `⌘1..9` is registered **twice with two different slot maps** (`use-keyboard-capture.ts:78-82` and `overview.tsx:489-512`) | `b3:107`, `:46` | a11y + UX | **A6 pulls both forward** |

**A6's shortlist**, if nothing else lands: **#1, #2, #7** (A7-blockers), **#4, #6, #27, #30, #32, #36**
(cheap, and each currently invalidates something a reviewer would otherwise believe).

### 0.2 The reference material — and the scenario list

**The corpus is real, large, and living in `/tmp`.** It is a session scratchpad, not a repo path:

```
/tmp/claude-1000/-opt-projects-supermux/0ce1fa02-9bc2-41c3-b2c6-7b2814d510c0/scratchpad/
```

- **`grok/` — 191 PNGs, 116 MB.** The load-bearing set is **`anim-hero-00.png … anim-hero-33.png`**
  (34 frames, 1952×1322, ~1.3 s apart): one complete task lifecycle in the live x.ai/bot replica.
  Also `anim-stage0..3-*` / `clean-stage0..3-*` (four feature scenarios), `mob-00..14`
  (390×844 @3×, iOS UA), `dark-hero-00..05`, `bot-scr00..10`, `crop-*`, `og.png`.
- **`grok/bot-css.txt`** (344 KB) + **`grok/grokbot-rules.css`** (193 extracted rules) +
  **`bot-styles.json`** (906 elements, 467 custom properties) + **`bot-dom.html`** —
  and, one level up, **`anim-rules.txt`** (the 118 transition/animation rules) and
  **`app-rules.txt`** (197 app-component rules).
- **The three reports the master plan cites by name** are inline files under generic names, because
  the harness blocked the subagents from writing named reports:
  `report-grok-ui` → `wfresult-4-a6e9bb9f28089b7ea.md` (37 KB) ·
  `report-grok-integration` → `deep-2.md` (50 KB) · `report-grok-mgmt` → `deep-3.md` (57 KB).
- **`taste/`** — the existing side-by-side comparison rig (`grok-roster-2x.png`,
  `grok-marks-4x.png` vs `ours-*`, blind-swap composites) with `taste-review.md` (10 numbered
  defects) and `taste-verify.md` (15-point retest). **This is the prior art for T11's jury; reuse
  its rubric shape rather than inventing one.**
- **`direction/`** (29 MB) — `direction.md` "Paper & Candy" + GPT-Image-2 boards;
  **`R1-hero-dark.png` is called out as "THE reference image for the product"**.
- **`hero-mockup/`** — the approved boards `/dev/chat-ui` is held against.
- **Re-runnable capture scripts survive** at `/home/supermux/pwlibs/driver/` (`groktime.mjs`,
  `grokmobile.mjs`, …) if a frame ever needs re-capturing.

**There is no usable Grok video.** `grok/hero.mp4` is a 5 KB HTML decoy; the real 106 s trailer was
never downloadable (media.x.ai is Cloudflare-blocked) and is, per the report, a lifestyle brand
film with no usable UI anyway. **The timed 34-frame `anim-hero` strip is the motion reference** —
which is why T11 judges our video as extracted frame strips, not as a vibe.

**Extracted motion numbers** live in `wfresult-4…md` §7 and `deep-2.md` §2.1. The two curves that
do 90% of the work: `cubic-bezier(.2,.9,.3,1.15)` (15 % overshoot, *arrivals*) and
`cubic-bezier(.22,1,.36,1)` (expo-out, *settling*). Entry-enter `.28s` (`[data-fresh]` `.42s`,
`translateY(8px) scale(.97)`); pending row `.28s`, its label `.35s` on a softer curve (arrives
*later*); typing dots `1.3s` with **static base opacities `.25/.45/.7`, not delays**; roster row
`.45s` `translateX(-10px)` (horizontal — a different axis from the transcript's vertical pops);
receipt ✓ `.28s` `scale(.4)→1`; working spinner `2.4s linear` (deliberately not 1 s); badge morph
`.26s`; same-cell crossfade `.26s`; hover `.12s`; avatar-row pill morph `.4s` on **padding**;
screen handover in `.52s` / out `.3s`; popovers 150/100; mascot recolour `fill .6s` (the slowest
transition in the product); offscreen `animation-play-state: paused !important`; **eight separate
colocated `prefers-reduced-motion` blocks**, and the typing dots keep `.25/.45/.7` so the row still
reads as a still. These are the numbers T6 and T11's jury check against.

**What Grok does NOT ship** (so the showcase must not claim to re-enact it): no collapsible
thinking trace, no file tree, no diff viewer, no terminal pane, no token/cost meter, no plan/todo
widget, no model picker, no attachment picker/preview, no recording UI behind the mic, no
settings-screen transition, no `view-transition-name`, no sort/filter/tags. The master plan already
marks P6/P8/P11 and thinking-disclosure as **"own design, no Grok reference."**

#### The scenario register (derived from the corpus)

**Group A — Grok-demonstrated, judged against the reference frames.**

| id | scenario | Grok reference | supermux equivalent | judged on |
|---|---|---|---|---|
| S1 | **Full task lifecycle** — prompt → thinking → work → receipts → done | `anim-hero-00..33` (the whole strip) | send → P12 working row → P8 receipts → prose → done | continuity + timing |
| S2 | Pending/thinking row + typing dots | `anim-hero-00` | `.sm-dots` working row, label arriving later | timing |
| S3 | Tool receipts list ("their entire tool-call UI") | `anim-hero-08` | P8 receipt group, receipts-first ordering | layout + legibility |
| S4 | Status badge morphs in place (`Working → Action needed → Done`) | `anim-hero-02`, `-08` | status/mode chip in the fixed header slot, `.sm-swap` | timing (zero layout shift) |
| S5 | Choice options widget (full-width rows, free text, gated Confirm) | §6 primitive 9 | P5 permission / plan-approval card, digit **and** tap | layout + keyboard |
| S6 | Cross-agent block "Messages from ●X and ●Y" + coloured mentions | `anim-hero-12` | B4 arrival divider + sender-pigmented mention chips | continuity |
| S7 | System pill line with a clickable entity chip | `anim-hero-18`, `-24` | B4 system lines + chip navigation | legibility |
| S8 | Routine created from the conversation | `anim-hero-24` | B4 `/supermux-schedule` → `Created schedule ⏱ …` | continuity |
| S9 | Work card with badge + live preview + action pills | `anim-stage0-*` | Attention card + `capture_ansi` mini-view | layout |
| S10 | Overlay opens over the shell, rail still visible under a scrim | `anim-hero-03`, deep-2 §2.3 | `<ShellOverlay variant="frame">` (full-screen terminal / Attention peek) | timing (in 520 / out 300) |
| S11 | Identity recolour — one property write, six surfaces | deep-2 §2.2 | `--sm-session-tint/-accent/-ink/-coat`, header crossfade in the fixed slot | continuity (no remount) |
| S12 | Roster/sidebar craft — 53 px rows, live tail preview, unread dot, pinned tiles, collapse-to-rail, mask fades | §2.1, `crop-roster.png`, `taste/grok-roster-2x.png` | B2 roster + focus strip | layout + legibility |
| S13 | Avatar-row relay morph "●●● Asking Research…" | `clean-stage3-*` | facepile morph + B4 in-flight handoff pill | timing |
| S14 | Composer with `@` mention popover and `/` reference | §9 | A4 composer `@`/`/` popovers | keyboard |
| S15 | Approval vocabulary (Allow once / Deny / Always allow) as a **card in the transcript, never a modal** | §10 (docs) | P5 card + mode chip | layout |
| S16 | Mobile — floating glass trio (back chevron · title pill · toggle), transcript clipping behind the pill | `mobel-mobilephonescreen`, `mob-00`, `mob-03` | mobile focus surface | layout |
| S17 | Dark theme | `dark-hero-00..05` | both themes, every scenario | legibility |
| S18 | Teach/watch overlay with a presence banner | `anim-stage1-*` | — **no equivalent; excluded, and `VERDICT.md` says so** | — |
| S19 | Emoji reaction chips | `anim-hero-24` | — **no equivalent; excluded** | — |

**Group B — supermux divergence, judged against our own direction boards
(`direction/R1-hero-dark.png`, `hero-mockup/*`) and against the *terminal*, not against Grok.**

| id | scenario | judged on |
|---|---|---|
| S20 | **Chat ↔ Terminal toggle** — the thing Grok has no analogue for; instant, lossless, both directions | continuity (zero state loss, zero layout shift) |
| S21 | Thinking-content disclosure (P7 collapse) | legibility |
| S22 | **Provisional tail → confirmed supersede** (P13) — the A1 quality checkpoint: "doesn't visibly glitch" | timing |
| S23 | Toggle-thrash under an output firehose | continuity |
| S24 | **Practical keyboard-driven use**, end to end, zero mouse events | keyboard |
| S25 | **Reconnect / return-from-background honesty** — the thing T2 builds | continuity |
| S26 | Delegation, human path (`@session` from the composer) | continuity |
| S27 | Changes rail / context % — **currently absent (§0.1 #9, #10); captured as a named gap, not faked** | — |

### 0.3 The chat-WS surface today

The socket is `web/src/components/chat/chat-socket.ts` (a framework-free class);
`web/src/components/chat/use-chat-ws.ts` is the React skin. **Note it is not under `hooks/`.**

**What is already good** — do not rebuild it:
- Backoff is complete and tested: `BASE_BACKOFF_MS = 300`, ×2, `MAX_BACKOFF_MS = 30_000`,
  **±20 % jitter**, `MAX_ATTEMPTS = 8` → `offline` (`chat-socket.ts:99-110`, `:305-322`).
  The counter resets on `seed_done`, deliberately **not** on `auth_ok`, with the reason written at
  `:256-268`. Terminal close codes `4404`/`1008`/`4001` stop the loop; `1013` retries.
- Re-seed semantics are sound: a reconnect is a **fresh full seed** by construction
  (`chat-socket.ts:19-23`, `:229` clears `seeded` + `highWater`), entries stay on screen but live
  frames are inert until the new `seed_done`. **Dedupe is arithmetic on `seq`**, never uuid or
  text (`ws.rs:34-35`, `wire.ts:270-272`); a detected hole is `Forward::Resync`, healed with a
  fresh seed, never skipped. Back-pagination has its own REST cursor (`<conv_id>:<byte offset>`,
  409 across conversations).
- 19 client unit tests (`tests/unit/chat-socket.test.ts`) and 10 server tests
  (`server/tests/chat_ws.rs`), including a firehose-consecutiveness test and
  `staleness_state_is_sent_on_seed_done_and_on_every_transition`.

**What is missing — and one of them is worse than "missing":**

1. **The server already computes staleness and the client throws it away.**
   `server/src/sessions/chat/tailer.rs:158-163` defines `TailState::{Live, Reconnecting{reason},
   NoHooks, Stopped}`, with the contract spelled out at `:153-155`: *"`Reconnecting` is
   deliberately not an error: the transcript we already showed stays on screen, but the client
   must not present it as a complete, current conversation."* `ChatSocket` maps it
   (`:379-389`), `useChatWs` exposes it (`:49`) — and **`tail.state` is read by nothing**
   (`chat-panel.tsx:438-439` reads only `isError`/`isLoading`). `use-chat-ws.ts:119-120`
   collapses five states into two booleans, so `reconnecting` and `no_hooks` render
   **identically to `live`**. The honesty mechanism is built and unplugged.
2. **No client-side staleness ceiling** — no timestamp is tracked anywhere in the socket layer
   (`lastFrameAt`/`ageMs`/`MAX_AGE` → zero matches). The only ceiling in the system is
   `NO_HOOKS_AFTER_MS = 60_000` (`tailer.rs:80-83`), which is about hook *installation*.
3. **No `visibilitychange` redial for chat.** Every other live surface has one —
   `use-live-term.ts:2262` (+`pageshow`+`online`), `use-sse.ts:332`, `use-peek-lens.ts:217`,
   `use-peek-prewarm.ts:77`. `chat-socket.ts` has none. A phone backgrounded past the 8-attempt
   ceiling lands in `offline` **permanently** until the panel unmounts, and
   `use-chat-ws.ts:95-103` only disposes when the last subscriber leaves — so a
   backgrounded-but-mounted panel never redials. **This is the single highest-value fix in A6.**
4. **The composer is not gated on socket state.** `sendGate` (`use-composer.ts:245-272`) gates on
   the peek lens and the dialog card only; `ChatComposer` receives no connection prop. Sends go
   over an independent REST path (`POST /send`) so they may genuinely succeed while the WS is
   down — defensible, but nothing tells the user which is true.
5. **The delivery watchdog manufactures false negatives when the socket is down.**
   `WATCHDOG_MS = 5_000` (`pending.ts:337`), latched so it cannot un-escalate
   (`use-pending-sends.ts:222`) — and it measures *echo arrival in the transcript*, which arrives
   over the very socket that is dead. The server receipt (`session.last_send_text`, riding SSE)
   is the existing mitigation; it is not wired into the escalation decision.
6. `ChatSocket` **does not register with `stores/connection-store.ts`**, so the app-wide
   `<ReconnectBanner>` (`layout.tsx:321`) and `<ConnectionOverlay>` (`App.tsx:282`) are blind to a
   dead chat socket.
7. **No e2e covers the chat socket's reconnect.** `ws-reconnect-restores-stream.spec.ts` covers
   the *terminal* WS only.

### 0.4 Motion: `springs.ts` vs reality

`web/src/lib/springs.ts` (89 lines, 72 importers) is the declared source of truth, and the claim
at `:58-61` is **false for three of seven tweens**.

- **Dead**: `tweens.popoverOut` (100 ms, `springs.ts:85`) has **no consumer** — and yet
  `BRAND.md:393` cites the `popoverIn` 150 / `popoverOut` 100 pair as the worked example of the
  exits-faster rule. The brand document currently documents a value nothing applies.
- **Imported but never read as values**: `tweens.containerIndicate` (350), `gapReveal` (120),
  `reflow` (100) — their durations are hand-copied into Tailwind literals
  (`group-grid.tsx:1376` `duration-[350ms]`, `:2360`, `:2367`).
- **Duplicate**: `springs.statusMorph` (500/32) is numerically identical to `springs.snappy`.
- **Near-dead**: `tileHover` (1 site), `settle` (1), `statusMorph` (2), `snippetSlide` (3),
  `toggleSnap` (4).
- **Off-token motion**: `mobile-compose-sheet.tsx:547` uses `ease:'linear'` as a raw string;
  `key-bar.tsx:506,564` inline transition objects; per-file magic constants `SWAP_S = 0.26`
  (`composer.tsx:52`, `header-pill.tsx`, `live-layer.tsx`), `ECHO_SWAP_S` (`conversation.tsx:685`),
  a bare `0.16` at `conversation.tsx:649`. **128 Tailwind `transition-*` classes across ~55 files**
  sit entirely outside the bank, with arbitrary durations (`duration-[120ms]` ×7 in the chat UI
  primitives, `duration-[400ms]` in `facepile.tsx:104`, `duration-[220ms]` in `ui/composer.tsx:82`).
  Credit where due: **`transition-all` has zero occurrences** — that rule genuinely holds.
- **Reduced motion is partial, and there is no blanket reset.** Five CSS blocks in `globals.css`
  (`:496`, `:528`, `:676`, `:765`, `:833`) plus a documented exemption for the status spinner.
  There is **no** `* { animation:none; transition:none }` under reduce, so the ~128 Tailwind
  transitions and every `animate-spin`/`animate-pulse` (30+ sites) run unconditionally.
  `useReducedMotion()` appears in ~60 components but `MotionConfig reducedMotion="user"` is set
  only in `routes/settings.tsx:834` — **not at the app root**.
  Concrete unbranched bugs in chat: **`working-row.tsx:73`** (`transition={springs.cardExpand}`
  with no reduce branch, in a file that already reads `useReducedMotion()` at `:57`),
  `ui/roster-row.tsx:160`, `ui/facepile.tsx:104`, `ui/composer.tsx:82`, `ui/system-line.tsx:78,147`,
  `ui/receipt-group.tsx:139`, `ui/captured-frame-card.tsx:121`, `ui/choice-card.tsx:145`.
  Elsewhere: `empty-state.tsx:44`, `team-card.tsx:215,237`, `stopped-session.tsx:294,321,406`,
  `claude-tools-sheet.tsx` (11 sites), and `springs.buttonPress` on `whileTap` at 63 sites
  (arguably fine — a tap scale is not vestibular — but it is not a *documented* decision).

### 0.5 Accessibility

**Tooling: none.** No `eslint-plugin-jsx-a11y`, no `@axe-core/*`, no `axe-playwright`;
`grep -rn "axe"` over the repo returns zero. `eslint.config.js` has no a11y config.

**What is already right** (do not regress it): the composer is a correctly-wired combobox
(`composer.tsx:210-215` + `entity-picker.tsx:194-207`); the composer refusal banner is a live
region (`:379`); the Attention overlay is a real `role="dialog"` with focus-in, focus-restore and
Tab cycling (`attention-card.tsx:185,405,407,428-434`); backlog and pending band are live regions
(`conversation.tsx:565,743`); the renderer switch is a proper `tablist`
(`renderer-switch.tsx:120,158-164`); chat icons are all `aria-hidden`; chat icon-buttons are
labelled; the roster grid has a drag live region (`group-grid.tsx:890-893`); the focus strip
collapsible is textbook (`focus-strip-section.tsx:91,106-108`); the command palette is Radix
`Dialog` with an sr-only title.

**The gap list** (each with a file:line, all confirmed at `a7cc52c`):

| id | gap |
|---|---|
| G1 | **No `aria-live`/`role` on the streaming region.** `live-layer.tsx` has **zero** `aria-*`/`role` — `:204-205` is a plain `<div data-testid="chat-live-layer">`; `conversation.tsx:429-436`'s track is a bare div; `chat-surface.tsx:211`'s scroller is a bare div. **A screen-reader user is never told an assistant message arrived, is streaming, or finished.** The headline gap |
| G2 | Working row has no `role`, no `aria-live`, no `aria-busy` (`chat/working-row.tsx`, `chat/ui/working-row.tsx`); `"Thinking…"` is plain text in an unannounced region |
| G3 | Bubbles have no semantics or author attribution — `ui/bubble.tsx:48,91` is `<div data-variant="assistant\|user">`; AT reads an undifferentiated wall |
| G4 | Choice cards: `role="group"` with **no accessible name** (`ui/choice-card.tsx:91`); selection is `data-selected` + colour only — **no `aria-pressed`/`aria-checked`/`aria-current`**, so the keyboard cursor is invisible to AT; `option.hint` is `title=` only; disabled buttons leave the tab order so the "why it's inert" reason is unreachable; the card is never focused when it appears |
| G5 | `CardCode` is `<pre tabIndex={0}>` with no `role`/`aria-label` (`choice-card.tsx:180-183`) — a tab stop that announces as nothing |
| G6 | `aria-expanded` without `aria-controls` on `ui/receipt-group.tsx:231` and `attention-card.tsx:120` |
| G7 | Entity/mention chips are not keyboard-operable — `transcript-item.tsx` dispatches `openSession` from click handlers; its only `aria-*` are two decorative `aria-hidden` |
| G8 | **No focus management after send.** `use-composer.ts` has no `.focus()` in its submit path; on a button-click send the Send button swaps out via `AnimatePresence` (`composer.tsx:221-241`) and **focus drops to `<body>`** |
| G9 | The chat surface has no landmarks and no heading — `chat-surface.tsx:186-224` is divs all the way down; `header-pill.tsx:174` is a `<header>` with no `aria-label` and no heading inside |
| G10 | **No skip links anywhere in the app** (`grep -rn "Skip to"` → zero) — every route makes a keyboard user traverse ~10 nav items |
| G11 | Broken heading structure on the roster: `<h1>Overview</h1>` at `overview.tsx:610`, group titles jump to `<h2>` at `:816`, and the sticky header duplicates "Overview" as a plain span at `:602` (two competing titles); `group-grid.tsx:1362`'s `<section>` has no `aria-labelledby` |
| G12 | **The roster is not a list and is not arrow-navigable.** `grep 'role="list"'` over `web/src` → **zero hits app-wide**. Tiles are `div role="button" tabIndex={0}` (`tile.tsx:758-762`), each a separate tab stop — 40+ stops before content, no roving tabindex. Note `chat/ui/roster-row.tsx:140-152` **is** a real `<button>` with `aria-label`, `aria-current` and an `onKeyDown` prop — the primitive is ready and no caller supplies arrow handling |
| G13 | `role="img"` status dot on an empty span (`chat-surface.tsx:158-161`) duplicated by `header-pill.tsx:241`'s `StatusDot` — double-announce or no-announce depending on composition |
| G14 | The overview "add group" inline editor has no focus restore on cancel (`overview.tsx:917-959`) |

Plus §0.1 #36's `role="listbox"` with no `role="option"` (`mobile-bottom-panel.tsx:472-478`).

### 0.6 The capture rig

| config | shape | A6 uses it for |
|---|---|---|
| `web/playwright.config.ts` | smoke; **no global `webServer`** — each spec boots its own real backend via `tests/e2e/smoke/harness.ts`; single-process flags gated on `SUPERMUX_E2E_NO_SANDBOX` (`:35-46`) | T3's reconnect proofs, T11's real-session showcase |
| `web/playwright.mobile.config.ts` | hermetic; `vite preview` :4317, all traffic route-mocked, `devices['iPhone 14 Pro Max']` + **webkit**, `serviceWorkers:'block'` | T9's mobile pass — **after T0.4 fixes webkit** |
| `web/playwright.screens.config.ts` | screenshot capture; real harness; chromium launch args hardcoded (`:19-28`) | T11's desktop captures |

`harness.ts` is the load-bearing file: `binaryPath()` `:44-56` (prefers **release**, falls back to
debug — A6 must ensure the debug binary is the one found); `spawnBackend()` `:109-129` — the env
contract `SUPERMUX_DATA_DIR` (mkdtemp) + `SUPERMUX_BIND=127.0.0.1:<port>` +
`SUPERMUX_AUTH_TOKEN` + `RUST_LOG`; `startBackend()` `:161-220` boots the binary, polls
`/api/health`, then spawns `bunx vite … --host 127.0.0.1` with
`SUPERMUX_E2E_BACKEND=<backendUrl>`; `injectGlobals()` `:228-235` sets
`window._SUPERMUX_AUTH_TOKEN`; **`killBackend()` / `restartBackend()`** (same port, same data dir)
— exactly the primitive T3 needs; `touchDragY()` `:310-381` is cross-engine synthetic touch
(Blink `new Touch` vs WebKit `document.createTouch`).

**There are no VR baselines in-tree.** `toMatchSnapshot`/`toHaveScreenshot` → zero results
repo-wide. VR is out-of-tree manual pre/post: shots into `~/b1-vr/<label>/`, compared with a
perceptual differ. The working rig scripts live in this session's scratchpad
(`vr.mjs` — real binary + seeded sessions + route × theme × viewport matrix; `shot.mjs` — pure
offline against a running Vite; `imgdiff.py` — PIL differ, `SAME <0.5 %` / `MINOR <3 %` / `DIFF`;
`perfile.sh`; `run-e2e-server.sh`). **`web/perf/baselines/` is bundle size, not visual.**

**`recordVideo` precedent already exists in-repo**: `/opt/projects/supermux/showcase/record.ts:170`
(a 9-beat marketing recording, its own package with its own `playwright ^1.60.0`).
Note `record.ts:374` — **Chromium's recordVideo size is fixed at context creation.**

**Browser reality.** Installed: `chromium-1223` ✓, `chromium_headless_shell-1223` ✓,
`ffmpeg-1011` ✓, `firefox-1538`, **`webkit-2215`**. Playwright 1.60.0 requires **webkit 2287**.
⇒ `playwright.mobile.config.ts` **cannot launch today**. Fix: `bunx playwright install webkit`.
No system `ffmpeg`, no `gifski` — video is Playwright's bundled ffmpeg producing `.webm`; any
mp4/gif conversion must invoke `~/.cache/ms-playwright/ffmpeg-1011/…` explicitly.

Chromium on this box needs (verified: 9 `not found` libs without it, 0 with it):

```bash
export LD_LIBRARY_PATH=/home/supermux/.local/chromelibs/extract/usr/lib/x86_64-linux-gnu:/home/supermux/.local/chromelibs/extract/lib/x86_64-linux-gnu
export SUPERMUX_E2E_NO_SANDBOX=1
```
plus `args: ['--no-sandbox','--no-zygote','--disable-gpu']` and **`deviceScaleFactor: 1`
(mandatory)**. Theme is a `.dark`/`.light` class on `<html>` — force it in an init script.

**Hard rig rules, learned the expensive way:**
- **Never `waitUntil:'networkidle'`** against a real backend — SSE + WS never idle. Use
  `domcontentloaded` + a ~900 ms settle.
- **One browser context per spec file** — `--single-process` chromium dies on a second context.
  Whole-suite runs are therefore meaningless; measure per file.
- Byte comparison is useless (live timestamps) — always the perceptual differ.

**`/dev/*` routes are `import.meta.env.DEV`-gated** (`App.tsx:24-74`, `:154-250`), so they exist
only under `vite`, never in the embedded bundle. Two are already URL-driven for rigs:
`/dev/chat-live` (`?mock&state=<idle|working|provisional|permission|delegation|…>&surface=phone&theme=&bare=1`)
and `/dev/shell` (`?theme=&overlay=1&variant=frame|pane&keyboard=1` — **`keyboard=1` shims
`visualViewport`**, which is T9.1's existing hook).

### 0.7 The dogfood instance — and the trap in this shell

The live instance on **:8824 hosts this very chat and is never restarted unasked**
(memory *never-restart-this-instance-unasked*; `~/.supermux/config.toml` → `bind = 127.0.0.1:8824`,
systemd `supermux.service`). There is **no port flag and no clap** — configuration is env +
`<data_dir>/config.toml`, resolved in `server/src/config.rs:189-271`.

**The trap:** this shell already inherits `SUPERMUX_DATA_DIR`, **`TMUX_TMPDIR`**, `SUPERMUX_SESSION`,
`SUPERMUX_URL` and `SUPERMUX_HOOK_TOKEN` pointing at the live instance. `TMUX_TMPDIR` is only
defaulted to `<data_dir>/tmux` when *unset* (`main.rs:56`) — here it is set, so a naive launch
attaches the second instance to the **live tmux server**. The launcher must override it explicitly:

```bash
unset CLAUDE_CODE_CHILD_SESSION CLAUDE_CODE_SESSION_ID CLAUDE_CODE_MESSAGING_SOCKET \
      CLAUDE_PID CLAUDE_CODE_ENTRYPOINT CLAUDE_CODE_EXECPATH CLAUDE_EFFORT \
      SUPERMUX_SESSION SUPERMUX_URL SUPERMUX_HOOK_TOKEN
export SUPERMUX_DATA_DIR=/home/supermux/.supermux-a6
export TMUX_TMPDIR=/home/supermux/.supermux-a6/tmux     # CRITICAL — else it joins :8824's tmux
export SUPERMUX_BIND=127.0.0.1:8829
export SUPERMUX_AUTH_TOKEN=a6-dogfood-token             # else read <data_dir>/auth_token
export RUST_LOG=warn
exec /opt/projects/supermux-a6/server/target/debug/supermux-server
```

The fresh data dir has no `config.toml`, so `bind` comes purely from `SUPERMUX_BIND`; nothing reads
or writes the live dir. Auth self-provisions to `<data_dir>/auth_token` at 0600 if the env var is
omitted (`config.rs:281-309`). Serve the UI via **Vite pointed at it** —
`web/vite.config.ts:165-178` proxies `/api` + `/ws` **only when `SUPERMUX_E2E_BACKEND` is set**:

```bash
cd /opt/projects/supermux-a6/web
SUPERMUX_E2E_BACKEND=http://127.0.0.1:8829 bunx vite --port 5210 --strictPort --host 127.0.0.1
```

(5202 and 5313 are already squatted by other worktrees; pick a free port.) This is also the **only**
way to reach the `/dev/*` benches. Then `addInitScript` the token before first navigation.

### 0.8 Real sessions vs the PII rule

The owner requires the showcase to use **real** sessions — a mock cannot prove fluidity. The repo
requires captures to be PII-free (memory *readme-screenshots-must-use-mock*: four of the owner's own
screenshots leaked client names in 2026-06). **These reconcile rather than trade off:** :8829 is a
*fresh, empty* data dir whose sessions A6 creates with neutral names (`a6-web`, `a6-api`,
`a6-docs`, `a6-review`) in scratch worktrees, driven by a real `claude` on harmless prompts. Every
frame is therefore both real and clean. **Nothing from :8824 is ever captured.** Artefacts live in
`~/a6-showcase/`, outside the repo, and are linked from the PR — never committed (they are large
binaries, and they are for the owner's judgment, not for the README).

---

## 1. Deliverables

1. **A clean debt ledger** — every open deviation from §0.1 either closed or re-filed against a
   named fase with a one-line reason. Zero unclassified TODOs in the chat/roster surfaces.
2. **A chat socket that behaves on a real phone** — the server's `TailState` finally consumed, a
   staleness ceiling, a `visibilitychange` redial, a composer that says which of its two planes is
   alive — each proved by a test that kills a real backend.
3. **A motion system with one owner** — dead tokens gone, ad-hoc durations retired, every
   decorative animation legible as a still under `prefers-reduced-motion`, offscreen loops paused.
4. **An accessible chat surface** — G1–G14 closed or explicitly carried, with an axe pass wired
   into Playwright so it cannot silently regress.
5. **The showcase** — `~/a6-showcase/` with `SCENARIOS.md`, the full capture matrix, the reference
   frame beside every capture, `VERDICT.md`, and a single index page the owner opens.
6. **`docs/REAL_DEVICE_CHECKLIST.md`** — a ten-minute, tool-free, riskiest-first owner checklist for
   what this VPS structurally cannot test.
7. **The A7-readiness checklist** in the PR body — every line either ✅ with evidence or ❌ blocking.
8. **`BRAND.md` §6f** — the motion, reduced-motion and accessibility contract, so the next surface
   cannot drift.

---

## 2. Tasks

### T0 — Base, the corpus rescue, and the triage gate

- [x] **T0.1** `git fetch`; `git worktree add /opt/projects/supermux-a6 -b feat/a6-polish origin/main`;
      `bun install` in `web/`; `cargo build` (debug) in `server/`. Never commit in the main checkout.
- [x] **T0.2** **Rescue the reference corpus out of `/tmp` — do this before anything else.**
      The entire Grok corpus (§0.2) lives in a session scratchpad under `/tmp/claude-1000/…`, which
      is not durable. Copy `grok/` (191 PNGs), `anim-rules.txt`, `app-rules.txt`, `taste/`,
      `direction/`, `hero-mockup/`, and the three reports (`wfresult-4-a6e9bb9f28089b7ea.md`,
      `deep-2.md`, `deep-3.md`) to `~/a6-showcase/reference/`, then verify the copy by count and by
      `file` type (remember `grok/hero.mp4` is a 5 KB HTML decoy — do not carry it as a video).
      **If the corpus is already gone, stop and tell the owner** — the scripts at
      `/home/supermux/pwlibs/driver/` can re-capture, but that is a decision, not a silent fallback.
- [x] **T0.3** **The triage gate.** Turn §0.1's 36 rows into a decision table, committed as the
      first commit: each row gets exactly one of `A6` / `A7-blocker` / `B5` / `wontfix` plus a
      one-line reason, re-verified against the code (the ledgers are not uniformly trustworthy —
      #4 is a ticked box that did not ship). `A7-blocker` items must close in this fase or the
      fase does not end. Record the closed-vs-deferred counts; they go in the PR body.
- [x] **T0.4** *(EXECUTED — outcome differs from the plan's expectation; full record in
      `a6-triage.md`. webkit **2287 installs** and its 268-package system-dependency closure was
      resolved without sudo, but it **still cannot launch**: headless WPE aborts on EGL display
      creation on this GPU-less box, and the Xvfb fallback needs `xkbcomp` at a root-owned path.
      Mobile evidence here is chromium-with-an-iPhone-descriptor at DPR 1 — emulation. The
      WebKit-specific half moves to the real-device checklist.)* **Fix the webkit mismatch before any mobile claim** (§0.1 #6): `bunx playwright
      install webkit` (needs 2287; 2215 is installed), then prove `playwright.mobile.config.ts`
      actually launches by running its existing `action-panels.spec.ts`. Record the result. **A
      mobile screenshot taken with a mismatched or absent engine is not evidence**, and three prior
      plans' mobile verification claims are currently unreproducible.
- [x] **T0.5** Record the baseline numbers a regression will be measured against:
      `bun run build:perf` (entry 144.73/160, app 205.46/210, CSS/30 — **~4.5 KB of headroom
      total**), `bun run test:unit` count, `cargo test` count, and the six pre-existing lint errors
      by file (the standing bar is **zero NEW**, not green).

**Verify**: worktree builds; `~/a6-showcase/reference/` exists with the expected file counts;
the triage table is committed; the mobile config launches.

---

### T1 — The regression net, before anything moves

- [x] **T1.1** Baseline VR sweep, **both themes, DPR 1**, via the §0.6 rig: `/dev/chat-ui`,
      `/dev/chat-live` at every `state=`, `/dev/focus`, `/dev/focus-mobile`, `/dev/roster`,
      `/dev/tiles`, `/dev/shell` (incl. `overlay=1`, `variant=frame|pane`, `keyboard=1`),
      `/dev/marks`, `/?mock` at every density tier, plus the mobile pass now that T0.4 unblocked it.
      Store as `~/a6-vr/before/`. Every later diff is annotated against it with `imgdiff.py`; an
      unannotated diff is a bug.
- [x] **T1.2** Assert the escape hatch: the terminal path's smoke specs pass **unedited**, and
      `/dev/renderer-thrash` round-trips. A6 may not make the terminal fallback worse — it is the
      thing A7 falls back to.
- [x] **T1.3** Adopt or delete the orphaned `tests/e2e/status-dot-pulse.spec.ts` (§0.1 #32) and say
      which in the commit message. B2 was asked to decide and did neither.

**Verify**: the before-set exists as a manifest (paths + hashes, not the PNGs); all suites green on
an untouched tree; per-file e2e runs only (§0.6).

---

### T2 — Chat-WS honesty: consume `TailState`, add the ceiling, add the redial

The master plan's A6 row asks for two things. The audit found a third that is worse: the honesty
mechanism is **built server-side and unplugged client-side**. Fix that first — it is nearly free.

- [x] **T2.1** **Plug in `TailState`.** `tail.state` is currently read by nothing
      (`chat-panel.tsx:438-439`), and `use-chat-ws.ts:119-120` collapses five states into two
      booleans. Render `reconnecting` and `no_hooks` as *visibly not-current*: the transcript stays
      on screen (the server's contract at `tailer.rs:153-155` is explicit about this) under chrome
      that says so. **This is the single cheapest honesty win in the fase** — the data is already
      on the wire and already tested (`chat_ws.rs:470`).
- [x] **T2.2** **The staleness ceiling.** Track the age of the last authoritative signal in the
      socket layer (today: zero timestamps tracked). Past the documented window while the session is
      supposed to be live → the same `reconnecting` presentation as T2.1, and the composer routed
      through the delivery watchdog. The number is exported and unit-tested **with A0's measured
      latencies as fixtures** (hooks ≪1 s, text-only transcript p50 31.4 s / max 32.8 s) — a ceiling
      that trips during a normal long prose turn is a worse bug than no ceiling.
- [x] **T2.3** **The `visibilitychange` redial** — the highest-value fix in A6. Follow the
      established in-repo pattern (`use-live-term.ts:2209-2264`: `visibilitychange` + `pageshow` +
      `online`), with a debounce so a fast alt-tab does not thrash, and reset the attempt counter on
      a foreground redial so a phone that slept past the 8-attempt ceiling is not stuck in `offline`
      forever (`use-chat-ws.ts:95-103` never disposes a mounted-but-backgrounded panel).
- [x] **T2.4** **Register with `connection-store.ts`** so the app-wide `<ReconnectBanner>` /
      `<ConnectionOverlay>` stop being blind to a dead chat socket — or write down why the chat
      socket deliberately stays out of the global banner. Either is fine; silence is not.
- [x] **T2.5** **Stop the watchdog manufacturing false "undelivered".** It measures echo arrival
      over the very socket that is down (`pending.ts:337`, latched at `use-pending-sends.ts:222`).
      Feed the SSE-borne server receipt (`session.last_send_text`) into the escalation decision, or
      suppress escalation while the socket is known-dead and say so in the UI. A false undelivered
      teaches the user the honesty mechanism lies — the exact opposite of its purpose.
- [x] **T2.6** **One vocabulary**: `live` / `reconnecting` / `stale` / `offline`, identical in the
      code, in `brand/copy.ts` and in `BRAND.md`. No surface invents a fifth word.
- [x] **T2.7** Do **not** touch what works: the backoff arithmetic (`chat-socket.ts:99-110`), the
      auth-grace reset rationale (`:256-268`), the terminal close-code set, the full re-seed model
      or the `seq`-arithmetic dedupe. They are correct and tested; A6 adds around them.

**Verify**: unit tests for the ceiling arithmetic (with A0 latencies) and the redial debounce; the
long-quiet-turn case must **not** trip; the vocabulary appears in `BRAND.md`; no magic numbers at
call sites.

---

### T3 — Reconnect correctness against a real backend

There is no e2e for the chat socket's reconnect today — only for the terminal WS.

- [ ] **T3.1** New spec using `harness.ts`'s `killBackend()`/`restartBackend()`: with a live chat
      attached, kill mid-turn, restart on the same port and data dir. Assert (a) the surface entered
      `reconnecting` **visibly** within the ceiling, (b) it returned to `live`, (c) the transcript
      has no duplicate and no missing entry, (d) the composer's state was honest throughout.
- [ ] **T3.2** **The background/foreground case — the real one.** Drive `visibilitychange`
      (hidden → past the ceiling → visible) while the backend keeps producing entries. Assert the
      redial fires, the gap is filled by the fresh seed, and the follow-bottom pin survives (no
      jump to top, no silent loss).
- [ ] **T3.3** The flaky-network case: `context.setOffline(true/false)` around a turn; same four
      properties as T3.1. This is what a commuter actually hits.
- [ ] **T3.4** The **stale-pointer** case (master plan §2.1): force the conversation pointer to
      resolve stale and assert the Attention card raises rather than an empty-but-composable chat.
- [ ] **T3.5** **Toggle-thrash under a reconnect** — run A5's harness while the socket is
      re-dialling. Assert no byte gap/overlap in the terminal buffer, no resize storm, chat scroll
      stable. The program's two hardest mechanisms have never been exercised against each other.
- [ ] **T3.6** Assert **content, not timing**, wherever possible (B4's T11 lesson), and keep one
      browser context per spec file (§0.6).

**Verify**: all five specs pass against a real **debug** binary — check `binaryPath()` does not pick
up a stale release binary from the main checkout.

---

### T4 — Debt paydown A: the three A7-blockers

- [x] **T4.1** **Subagent turns (§0.1 #1).** Decide once, and make the decision total: either the
      chat surface gains a voice for subagent turns (tailer already has the scope; the 404 is in
      `find_full_entry`'s single-transcript assumption at `ws.rs:364-379`), **or** the surface states
      plainly that N subagents are working and the terminal has the detail — with `fetch-full`
      structurally unable to be offered for them. What must not survive is today's state: a spinner,
      a count, and silence during a five-way fan-out. Whichever branch, a test pins it and
      `BRAND.md:294`'s `subagent | ❌ no surface yet` row is updated.
- [x] **T4.2** **Truncated entries (§0.1 #2).** A clipped message must read as *deliberately
      condensed with a way to see the rest* — not as a broken message whose only escape is
      "go use the terminal" in a `title` tooltip (`transcript-item.tsx:286-291`). Ship an explicit
      affordance with a loading state and a failure state that keeps the condensed text, and make
      the never-retry rule (`chat-socket.ts:161-164`) a *user-triggerable* retry rather than a dead
      end. The 12-entry auto-fetch window stays as the automatic policy.
- [x] **T4.3** **Chat faces = roster identity (§0.1 #7).** Wire `usePin` (`hooks/use-roster-marks.ts`)
      into `chat-panel.tsx` so the renderer's `pinFor`/`pin` seam — today supplied only by the dev
      benches — is fed by the real `mark_pin` column B2 landed (`0027`). Two identities for one
      session is exactly the seam a user notices the day chat becomes the default. Delete the
      `TODO §10` at `a3-chat-surface.md:156`'s call sites when it is real.
- [ ] **T4.4** Sweep for the *class*: every chat affordance that fetches, can 404, or sits behind a
      cap gets either a test of its failure path or a removal. The A0 lesson (`b8daf73`) is that a
      silent dead signal survives for weeks.

**Verify**: each item has a unit or smoke test; no chat affordance can 404 into an unhandled state;
`~/a6-vr` diff annotated.

---

### T5 — Debt paydown B: the cheap corrections

- [x] **T5.1** *(EXECUTED — see commit `6c5d507`. The ledger correction landed; the field itself
      was REFUSED because the create API does not accept a model, and shipping a control that goes
      nowhere is the same class of dishonesty as the ticked box that started this.)* **The `model` field in new-session (§0.1 #4)** — add it to `new-session-sheet.tsx`
      alongside `desc`/`tags`/reroll/initial-prompt, reusing the existing `ModelPicker`
      (`settings.tsx:108`). And **correct the B2 ledger's ticked box** in the same commit: a plan
      that lies about what shipped is worse than a missing field.
- [x] **T5.2** **The B3 defects worth pulling forward (§0.1 #36)** — `role="option"` on
      `mobile-bottom-panel.tsx:472-478`'s pills (a genuine a11y bug inside an existing
      `role="listbox"`), and the **duplicate `⌘1..9` registration** with two different slot maps
      (`use-keyboard-capture.ts:78-82` vs `overview.tsx:489-512`). Both are small, both are real
      user-facing ambiguity, neither needs B3.
- [x] **T5.3** *(DECIDED: does not fit, with the measured reason. The headroom is **0.21 KB**, not
      the ~4.5 KB the plan assumed — main app JS measured 209.79/210.00 KB on `origin/main`. A TS
      type plus a consumer does not fit in 0.21 KB, and B3 and B5 still have to land. Re-filed to
      `later` in `a6-triage.md`.)* **The dark `statusline` delta key (§0.1 #20)** — give it a TS type and one consumer,
      *if* it fits the ~4.5 KB budget. It is the unblocker for #10 and #19 and B2 named it as "the
      precedent to avoid". If it does not fit, write that down with the measured cost.
- [x] **T5.4** Fix the one pre-existing lint error in a file A6 touches
      (`chat/attention-card.tsx`, §0.1 #27) and leave the other five, so the "zero NEW" bar
      improves by one rather than being restated.
- [x] **T5.5** Every other `A6`-triaged item from T0.3 gets its own checkbox and verification line
      appended here at execution time. Everything triaged `B5`/`later`/`wontfix` is written into the
      PR body **and** into the relevant plan's out-of-scope section, so the next executor inherits a
      ledger rather than an archaeology problem.

**Verify**: `cargo check` + `cargo test` (debug) + `bun run lint` (zero new) + `bun run test:unit`
green; `bun run build:perf` still inside 210 KB with the headroom reported.

---

### T6 — The motion pass, with the reduced-motion sweep in the same task

Motion is the half of "fluid" a screenshot cannot show, and it is what T11's jury judges frame by
frame against §0.2's extracted numbers.

- [x] **T6.1** **Make the source-of-truth claim true.** `springs.ts:58-61` claims ownership it does
      not have. Delete `tweens.popoverOut` (dead) or give it its call site; make
      `containerIndicate`/`gapReveal`/`reflow` actually read as values instead of being hand-copied
      into Tailwind literals (`group-grid.tsx:1376`, `:2360`, `:2367`); resolve
      `statusMorph` ≡ `snappy` (alias or delete); adopt or drop the near-dead tokens.
- [x] **T6.2** **Retire ad-hoc motion in the three surfaces** (chat, roster, shell): the raw
      `ease:'linear'` at `mobile-compose-sheet.tsx:547`, the inline objects at `key-bar.tsx:506,564`,
      the per-file constants (`SWAP_S`, `ECHO_SWAP_S`, `FADE_S`, the bare `0.16` at
      `conversation.tsx:649`), and the arbitrary Tailwind durations in the chat UI primitives
      (`duration-[120ms]` ×7, `[400ms]`, `[220ms]`). Each becomes a token or the token set gains the
      one genuinely-missing curve with a note saying why. Keep the `transition-all`-is-zero rule.
- [x] **T6.3** **The three-speed rule holds and is enforced by a test.** `.12s` hover/press on
      *both* `background-color` and `color`; `.26s` in-place morph; `.28/.42s` `data-fresh`-gated
      arrival; `.45s` roster-row *horizontal* arrival; `.4s` facepile morph on **padding**; `.6s`
      identity recolour; and **exits always faster than entries** (overlay 520/300, popover 150/100).
      Enforce with a source-scan spec in the idiom of B1's `tour-anchors.test.ts`, so the rule cannot
      rot the way `springs.ts`'s ownership claim did.
- [x] **T6.4** **Never animate a backlog** (§5.1.3): seed entries mount `animation:none`; only
      post-`seed_done` entries pop; one container mount-fade. Assert it — it is the most visible
      "cheap" tell and it regresses whenever the seed path is touched, which T2 touches.
- [x] **T6.5** **Complete `prefers-reduced-motion` coverage.** Fix the concrete unbranched bugs
      first (`working-row.tsx:73` — a file that already reads `useReducedMotion()` at `:57` —
      then `ui/roster-row.tsx:160`, `ui/facepile.tsx:104`, `ui/composer.tsx:82`,
      `ui/system-line.tsx:78,147`, `ui/receipt-group.tsx:139`, `ui/captured-frame-card.tsx:121`,
      `ui/choice-card.tsx:145`). Then decide the systemic question **explicitly**: either add
      `<MotionConfig reducedMotion="user">` at the app root (it exists only in
      `settings.tsx:834` today) and/or a scoped CSS reset for the ~128 Tailwind transitions and the
      30+ `animate-spin`/`animate-pulse` sites — or document why per-component opt-in is the
      chosen model. Functional spinners stay animated (existing convention, already documented for
      `sm-status-spin`). Grok ships **eight** colocated reduce blocks and keeps the typing dots'
      `.25/.45/.7` base opacities so the row still reads as a still — match that standard.
- [x] **T6.6** **Offscreen surfaces pause** (`animation-play-state: paused`, Grok's
      `[data-demo-offscreen]` idiom). At roster scale the overview must not run forty loops behind a
      scrolled-out fold. Assert loop count and unregistration at scale, as B2's T2 did for marks.
- [x] **T6.7** `BRAND.md` gains **§6f — motion, reduced motion and the accessibility contract**:
      the token table, the exits-faster rule, the reduce doctrine, T7/T8's a11y rules and T2.6's
      connection vocabulary. One page for the next surface to read.
      **The a11y half was a literal PLACEHOLDER until fix/perf-a11y-net** — T6.7 and T8.2 both
      claimed to have filled §6f and neither had. It is now written from what ships: the
      one-state-one-voice ownership table, the G1–G14 resolutions, the Escape/trap collision
      matrix, and a *Carried, by name* list for the roving tabindex, focus-after-send, colour
      contrast and T8.5.

**Verify**: the source-scan spec is green; a reviewed still exists per animated surface under
`reducedMotion:'reduce'` in both themes; the VR diff vs T1 is annotated line by line.

---

### T7 — Accessibility, part 1: semantics, announcements, labels

- [x] **T7.1** **G1 — the streaming region announces.** `live-layer.tsx` has zero `aria-*`/`role`
      today. Give the transcript the correct role and a politeness that announces *arrivals* without
      re-reading the backlog on every flush. **The hard case is P13**: working row → provisional
      tail → the confirmed entry that supersedes it must produce **one** coherent announcement, not
      three. Assert by **announcement count over a scripted turn**, so a naive "just add aria-live"
      fix is caught.
- [x] **T7.2** **G2/G3** — the working row gets `aria-busy` and a live status; bubbles get author
      attribution so AT does not read an undifferentiated wall (`ui/bubble.tsx:48,91`).
- [x] **T7.3** **G4/G5 — choice cards.** Name the `role="group"` (`choice-card.tsx:91`); expose
      selection with a real ARIA state instead of `data-selected` + colour; move `option.hint` out
      of `title=`; make the "why this is inert" reason reachable even though disabled buttons leave
      the tab order; focus the card when it appears. Give `CardCode` (`<pre tabIndex={0}>`,
      `:180-183`) a role and a name, or take it out of the tab order.
- [x] **T7.4** **G6/G13** — `aria-controls` alongside every `aria-expanded`
      (`ui/receipt-group.tsx:231`, `attention-card.tsx:120`); resolve the duplicate status
      announcement between `chat-surface.tsx:158-161` and `header-pill.tsx:241`.
- [x] **T7.5** **G9/G11 — structure.** Landmarks and one heading for the chat surface; fix the
      roster's two competing "Overview" titles (`overview.tsx:602` vs `:610`) and give
      `group-grid.tsx:1362`'s `<section>` an `aria-labelledby`.
- [x] **T7.6** **G10 — a skip link.** Zero exist app-wide; every route makes a keyboard user
      traverse ~10 nav items. `layout.tsx` already has `<nav aria-label="Primary">` ×2 and a
      `<main>` at `:325` — this is a small, high-value addition.
- [x] **T7.7** **Tooling, so it cannot regress**: add an axe scan to the existing Playwright setup
      over `/dev/chat-ui`, `/dev/chat-live`, `/dev/focus`, `/dev/roster`, `/?mock` and the mobile
      focus, both themes, failing on new violations. If any existing violation must be carried,
      enumerate it by name. **Watch the bundle** — axe is a devDependency and must not reach the
      hero path (§0.1 #26: 4.5 KB of headroom).
      **TICKED AHEAD OF THE WORK; LANDED LATE (fix/perf-a11y-net).** At A6's merge there was no
      `@axe-core/*` dependency, no such spec, and `eslint.config.js` cited a verification file
      (`tests/unit/a11y-tooling.test.ts`) that did not exist either. Both now exist:
      `tests/e2e/smoke/a11y-axe.spec.ts` scans the six named surfaces in both themes against an
      ENUMERATED rule-level baseline (a fixed rule must be removed from it in the same commit that
      fixes it), and `tests/unit/a11y-tooling.test.ts` asserts the tooling is installed, actually
      extended, and never reaches `src/` or a built chunk. The carried entries are
      `color-contrast` (all surfaces, both themes — the light-theme token gap and the ink-3 ladder)
      and `nested-interactive` on `/dev/focus`.

**Verify**: axe green or an explicitly enumerated baseline; T7.1's announcement-count assertion in
the spec; no VR diff beyond annotated intent.

---

### T8 — Accessibility, part 2: keyboard and focus

- [x] **T8.1** **G8 — focus after send.** `use-composer.ts` has no `.focus()` in its submit path;
      on a button-click send the Send button swaps out via `AnimatePresence`
      (`composer.tsx:221-241`) and focus lands on `<body>`. `focusComposer()` already exists
      (`composer-draft.ts:78-80`) and is called from exactly two places — wire it into the normal
      path. Same for: after a choice card is answered, and after a sheet/overlay dismisses (focus
      returns to the opener — the Attention card already does this correctly; copy it).
- [x] **T8.2** **Traps where traps belong.** `ShellOverlay` and `ResponsiveSheet` trap focus and
      close on `Esc` — and `Esc` in the composer keeps its existing meaning (interrupt). Write the
      collision matrix down; this is the class of bug A5's T7 hit with the `T` hotkey, and §0.1 #36
      records a live duplicate-registration defect of exactly this shape.
- [x] **T8.3** **G7/G12 — everything interactive is reachable.** Entity/mention chips become real
      links or buttons (`transcript-item.tsx` dispatches from click handlers today). The roster gets
      list semantics (`role="list"` has **zero hits app-wide**) and a roving tabindex so a
      40-session roster is not 40 tab stops — note `chat/ui/roster-row.tsx:140-152` is already a real
      button with `aria-label`, `aria-current` and an `onKeyDown` prop that no caller supplies.
- [x] **T8.4** **`:focus-visible` is visible on glass** — check `--ring` against every substrate the
      shell paints, in both themes. A ring that vanishes on the tinted column is the same bug as no
      ring.
- [ ] **T8.5** **The keyboard-only walkthrough spec**: from a cold load — reach the chat, type and
      send, answer a choice card, toggle to terminal and back, open and close the session sheet —
      with zero mouse events. This spec is also the showcase's "practical keyboard-driven use"
      evidence (S24), so write it to be *recordable*.
      **UNCHECKED (fix/perf-a11y-net). It was never written** — 40 specs, none of them it — and
      that is not a bookkeeping slip: it is the spec that would have caught the composer-focus
      blocker (typing in the chat composer after a Chat↔Terminal toggle drops focus to `<body>`
      and leaks keystrokes into the live pty). Writing it before that fix lands would only add a
      red spec to `main`, so it is carried BY NAME here and blocked on that fix, rather than left
      claimed.

**Verify**: the walkthrough passes; the collision matrix is in `BRAND.md` §6f; axe's keyboard rules
green; T1's VR diff annotated.

---

### T9 — Mobile reality, as far as this box can go

Everything true-hardware goes to T12's checklist. Everything simulable is proved here, so the
owner's real-device pass finds only genuine hardware quirks.

- [ ] **T9.1** **Soft-keyboard simulation.** `/dev/shell?keyboard=1` already shims `visualViewport`
      — extend that idiom to the mobile focus surface and drive a full sequence (open, close, resize
      for the autocomplete/emoji bar). Assert: the composer stays above the keyboard; follow-bottom
      survives; the header pill does not detach; safe-area padding still **grows** the header box
      (the `globals.css:203-221` contract — a fixed 44 px clips under the Dynamic Island); and
      **nothing `position:fixed` is captured by an ancestor `backdrop-filter`** — §0.1 #29 records
      24 files still using `backdrop-blur-*` outside `.glass`, and this is exactly the hazard §11.1
      of the master plan warns about.
- [ ] **T9.2** **IME composition.** Simulate `compositionstart`/`update`/`end` in the composer.
      Assert Enter during composition does **not** submit, the draft is not duplicated (the historic
      Android IME duplication class), and auto-grow settles after commit.
- [ ] **T9.3** **PWA standalone shape** — capture in standalone display mode with simulated notch
      and home-indicator insets; assert no control sits under either and the dock keeps every
      non-terminal action (§5.2). Note `ios-pwa-chrome` is 1-of-2 red today (§0.1 #5) — fix or
      re-file with the reason.
- [ ] **T9.4** **Touch physics, as far as they simulate.** Use `harness.ts`'s `touchDragY()`
      (`:310-381`, already cross-engine). Assert: momentum handoff at the top does not fight backlog
      pagination; no accidental text selection while dragging; and the rig memory's touch-safety
      assertion — after tapping a chip, `document.activeElement` must **not** be
      `textarea.xterm-helper-textarea`, or the keyboard pops.
- [ ] **T9.5** Both orientations and the **375 px** small-phone width, not only the 430 px iPhone 14
      Pro Max the mobile config defaults to.

**Verify**: the mobile suite green on the webkit installed by T0.4; every assertion has a named
spec; every state lands in the VR diff set.

---

### T10 — The side-by-side dogfood instance on :8829

This also closes §0.1 #30 — B1's dogfood task that was honestly marked NOT DONE because :8824 hosts
the session doing the work.

- [ ] **T10.1** Bring up the debug binary on **:8829** with the §0.7 launcher **including the
      `TMUX_TMPDIR` override and the `unset` block** — without them the second instance joins the
      live tmux server. Serve the UI via Vite with `SUPERMUX_E2E_BACKEND` (the only way to reach the
      `/dev/*` benches). Put the exact commands in the PR body so the owner can paste them once.
- [ ] **T10.2** Create the four neutral sessions (`a6-web`, `a6-api`, `a6-docs`, `a6-review`) in
      scratch worktrees with harmless standing instructions (§0.8).
- [ ] **T10.3** **Dogfood it as a human for a working session** — not a script. Use :8829 as the
      actual interface long enough to hit what tests do not: a slow turn, a permission dialog at an
      awkward moment, a phone in a pocket coming back to foreground (T2.3's whole reason). Every
      friction goes into the ledger; anything A7-blocking is fixed **before** T11 captures anything.
- [ ] **T10.4** Teardown is part of this task: instance stopped, `~/.supermux-a6` removed, no
      schedules left armed, scratch worktrees deleted. **Verified, not assumed.**

**Verify**: `:8824` uptime unbroken across the whole fase — check it, do not assume; the friction
list exists and every entry is triaged.

---

### T11 — THE SHOWCASE (the owner's acceptance gate)

> The owner's directive as the acceptance condition: **after everything is built, all Grok-promo
> scenarios are re-enacted with real sessions on desktop and mobile, as screenshots and videos, and
> judged "at least as good and as fluid" against the reference captures — including practical
> keyboard-driven use.** He tries it only after that proof exists.

- [ ] **T11.1 — The scenario register.** Write `~/a6-showcase/SCENARIOS.md` from §0.2's table: per
      scenario, the reference frame(s) it is judged against, the supermux equivalent, the exact
      script (what is typed, what is tapped, expected end state) and **the named quality** the jury
      judges (timing / layout / legibility / continuity / keyboard). A scenario without a named
      quality cannot be judged. Carry the exclusions honestly: S18 and S19 have no equivalent, and
      §0.2's "what Grok does not ship" list means the showcase **cannot** claim to re-enact a
      thinking-collapse, a diff view, a terminal or a cost meter — those are Group B, judged against
      our own boards.
- [ ] **T11.2 — The capture rig.** One script per platform on `harness.ts` against :8829, with
      `recordVideo: { dir, size }` on the **context** (`showcase/record.ts:170` is the in-repo
      precedent; note `:374` — Chromium's video size is fixed at context creation). Desktop:
      chromium with the §0.6 launch recipe, **DPR 1**. Phone: webkit `iPhone 14 Pro Max` plus a
      375 px pass. Theme forced via the `<html>` class in an init script, both values. Never
      `networkidle`; `domcontentloaded` + ~900 ms settle. One context per spec file.
- [ ] **T11.3 — The matrix, with a stated reduction rule** (or it is unexecutable):
      **screenshots = every scenario × {desktop, phone} × {light, dark}**;
      **video = the motion-bearing scenarios only** (S1, S2, S4, S5, S10, S11, S13, S16, S20, S22,
      S23, S24, S25, S26) **× {desktop, phone} × dark**, plus light-theme video for the three
      scenarios where theme changes the motion read. File names are deterministic:
      `<id>__<platform>__<theme>.{png,webm}`.
- [ ] **T11.4 — Practical keyboard-driven use is a scenario, not a footnote (S24).** Composer typing
      at human cadence — `type()` with a delay, never `fill()`, so the video shows auto-grow and the
      send affordance changing state; soft-keyboard behaviour via T9.1's `visualViewport`
      simulation; touch scroll/fling via `touchDragY()`; choice-card answering by **digit and by
      tap**; toggle-thrash under an output firehose; a `@session` delegation end to end; and T8.5's
      keyboard-only walkthrough recorded as its own clip.
- [ ] **T11.5 — The visual jury.** Reuse the rubric shape that already exists in
      `reference/taste/taste-review.md` + `taste-verify.md` (10 numbered defects → 15-point PASS
      retest) rather than inventing one. Each reviewer agent receives, per scenario: the reference
      frame(s), our capture, the scenario's named quality, and §0.2's extracted animation numbers.
      Verdict: **PASS / PASS-WITH-NOTES / FAIL**, each with a concrete actionable reason. Subagents
      `Read` PNGs directly; **video is judged as an extracted frame strip at the scripted beats**
      (the Grok reference itself is a 34-frame strip at ~1.3 s — compare like with like).
      **Verdicts are written to disk before any fix**, so the loop has a record.
- [ ] **T11.6 — The loop.** For every FAIL and every actionable note: fix → re-capture that cell →
      re-judge. Repeat until zero FAILs and every PASS-WITH-NOTES is fixed or accepted in writing.
      **The loop is the deliverable, not a single pass** — a first-round all-PASS is evidence the
      jury was too easy and must be re-run against a harder rubric before it is believed. A jury
      note that asks for a *new feature* is re-filed, not built (§5).
- [ ] **T11.7 — `VERDICT.md`.** One row per scenario × platform × theme: final verdict, loop
      iterations, residual notes. Plus an honest section — **what the captures cannot prove**
      (everything in T12, plus S27's named gaps: no changes rail, no context %) — stated plainly
      rather than implied away.
- [ ] **T11.8 — The hand-off artefact.** One page the owner opens: every video/screenshot pair beside
      its reference frame with its verdict, so his review is one click, not a directory listing.

**Verify**: every matrix cell exists as a file; `VERDICT.md` has no FAIL rows; each accepted
PASS-WITH-NOTES has a written reason; artefacts are outside the repo and linked, never committed.

---

### T12 — The guided real-device checklist (a first-class owner deliverable)

- [ ] **T12.1** Write `docs/REAL_DEVICE_CHECKLIST.md`. Rules: **finishable in ten minutes**; every
      step is "do X → expect Y → ✅/❌ (+ photo or screen recording if ❌)"; ordered **riskiest
      first** (if step 1 fails, stop and report); **no devtools, no cable, no build**.
- [ ] **T12.2** Cover what simulation cannot: **install to Home Screen and launch standalone**
      (chrome, splash, status-bar colour, safe areas); **the real soft keyboard** (opens on composer
      tap, transcript not occluded, autocorrect/emoji-bar resize, dictation); **real IME** on Android
      if available; **touch physics** (fling momentum, rubber-band at the top of a paginated backlog,
      no accidental selection, no double-tap zoom); **backgrounding for real** (leave for five
      minutes, return — does it reconnect and fill the gap? this is T2.3's entire reason and the one
      thing a VPS cannot fake); **rotation**; **a real permission dialog answered from the phone**;
      **a delegation from the phone**; and **the terminal fallback still working on the device**.
- [ ] **T12.3** Each step names the mechanism it tests and **what to do if it fails** — the
      kill-switch string, the fallback, or "report and stop" — so a failure at 22:00 does not become
      a blocked evening.
- [ ] **T12.4** A "what we already proved" preamble linking T11's verdict, so he knows the checklist
      is the residue, not the whole test.

**Verify**: someone who has never seen the codebase can execute it end to end; every step has an
expected result; committed in the PR.

---

### T13 — A7-readiness checklist, PR, teardown

- [ ] **T13.1** Assemble the **A7-readiness checklist** in the PR body — each line ✅ with evidence
      or ❌ blocking:
      T0.3's triage table has no open `A7-blocker` (§0.1 #1, #2, #7 closed) ·
      T3's five reconnect specs green · the motion source-scan green and the reduced-motion sweep
      reviewed · axe green or an enumerated baseline · T9's mobile suite green on a **matching**
      webkit · T11's `VERDICT.md` has zero FAIL rows · the terminal fallback path byte-identical with
      its CI kept · the kill-switch documented with the exact string a user types
      (`localStorage['supermux:chat-renderer']`) · `build:perf` inside 210 KB with the remaining
      headroom stated (B3 and B5 still have to fit) · `:8824` untouched all fase ·
      and the one line no agent can tick: **the owner has run
      `docs/REAL_DEVICE_CHECKLIST.md` on his own devices and reported the results.**
- [ ] **T13.2** State plainly that **A7 is a separate PR** and that A6 changes no default — and
      prove it: grep the diff for a default change and show there is none.
- [ ] **T13.3** Full gate: `bun run lint` (zero **new** — five pre-existing remain, one fixed),
      `bun run test:unit`, `bun run build:perf` (delta vs T0.5), `cargo check`, `cargo test` (debug),
      `cargo clippy`, and the relevant specs from all three Playwright configs, **per file**.
      Never a release build.
- [ ] **T13.4** T10.4's teardown executed and verified; `:8824` uptime confirmed.
- [ ] **T13.5** Open the PR from the worktree and **hand off**. Never auto-merge, never deploy, never
      restart `:8824` (memories *user-reviews-all-merges*, *never-restart-this-instance-unasked*).

**Verify**: the checklist is complete and honest — an ❌ line stays ❌ rather than being quietly
re-worded.

---

## 3. Constraints, restated as checkable rules

1. **A6 changes no defaults.** T13.2 proves it with a grep.
2. **The terminal fallback may not get worse** — its specs run unedited, the toggle round-trips, the
   kill-switch string is documented.
3. **Never restart :8824.** All dogfood and capture happens on :8829 with its own data dir **and its
   own `TMUX_TMPDIR`** (§0.7), torn down at the end.
4. **No release builds.** `harness.ts:44-56` prefers a release binary — make sure the debug one is
   what it finds, or point it explicitly.
5. **Real sessions, neutral names, artefacts outside the repo** (§0.8). Nothing from :8824 is ever
   captured.
6. **DPR 1, forced theme class, fixed viewport, never `networkidle`, one context per spec file** —
   or the comparison is noise and the run is a lie.
7. **No `server/migrations/*` edits** (memory *sqlx-migrations-are-checksummed*).
8. **`components/chat/**` uses relative imports only** — `bun test` resolves the root tsconfig with
   no `paths`.
9. **Eligibility keeps its two owners** (`chat/flag.ts::chatEligible`, `chat/ws.rs::chat_eligible`).
   The staleness states layer on top; A6 adds no third gate.
10. **B3 has not happened.** No dependency on a shared `<EntityPicker>`, palette navigation, the
    cheatsheet or deep-links. A scenario that needs one is captured against today's surface and the
    gap is named in `VERDICT.md`.
11. **Bundle headroom is ~4.5 KB** for A6 + B3 + B5 + A7 combined. Every task reports its delta;
    axe and all capture tooling stay out of the shipped bundle.
    **CORRECTED (fix/perf-a11y-net): that number was never true after B2 merged.** `a6-triage.md`
    measured 0.21 KB at A6's start, and the ceiling has been ratcheted to `ceil(measured)` at every
    fase since — 210 → 211 (B3) → 212 (A6) → 216 (B5) — which reproduced a ~0 KB gate at each new
    number rather than fixing it. Five B3 deliverables were dropped for "size" against a gate with
    twenty-one bytes free. `size-budget.mjs` now applies its OWN documented policy (measured + 2%),
    so the awareness ceiling is a band rather than a tripwire; the hard gate that actually guards
    the hero path is `BUDGET_ENTRY_JS`, and it is at 94%.
12. **Lint bar is zero NEW errors** (five pre-existing remain after T5.4), not green.
13. **Every new surface keeps its `data-vr` hook** (`ARCHITECTURE.md:160`).
14. **Never end on a promise** (memory *workflows-over-named-agents*): a task is done when its
    artefact is on disk and has been read back.

---

## 4. Risks

| risk | mitigation |
|---|---|
| **The reference corpus evaporates.** The entire 116 MB Grok corpus lives in `/tmp/claude-1000/…0ce1fa02…/scratchpad/` — a session scratchpad, not durable storage. Losing it makes T11 unjudgeable | **T0.2 is the first substantive task**: copy everything to `~/a6-showcase/reference/` and verify by count and `file` type before any other work. The re-capture scripts at `/home/supermux/pwlibs/driver/` are the fallback, and using them is an owner decision, not a silent substitution |
| **The showcase becomes a rubber stamp** — a friendly jury passes everything and the owner finds the flaws | the rubric is fixed **per scenario** before capture (named quality); the reference frame sits beside every capture so "at least as good" is a comparison; verdicts are written before fixes; T11.6 states outright that a first-round all-PASS is suspicious; the existing `taste-review.md` rubric (10 defects → 15-point retest) is the proven shape |
| **Video proves nothing** — captured on an idle box, judged as a vibe | motion is judged as an **extracted frame strip at scripted beats**, exactly like the Grok reference (34 frames at ~1.3 s); typing is `type()` with a human delay, never `fill()`; the thrash and firehose scenarios are captured deliberately under load |
| **The staleness ceiling false-positives** on a normal 31 s prose turn | the ceiling keys on the *authoritative signal set* A0 measured (hooks ≪1 s; text-only transcript p50 31.4 s / max 32.8 s), not on transcript entries alone; those latencies are the unit-test fixtures; T3 includes a long quiet turn that must **not** trip it |
| **The visibility redial thrashes** on fast alt-tab or a notification pull-down | debounce + the existing bounded backoff; T3.2 drives repeated rapid flips and asserts a bounded dial count; the pattern is copied from `use-live-term.ts:2209-2264`, which has survived in production |
| **Plugging in `TailState` makes chat look broken** — `no_hooks`/`reconnecting` may be commoner than anyone realises, and the honest state may fire constantly | T10.3's human dogfood is the measurement: run with the state visible for a working session before deciding its presentation weight. If it fires constantly that is a *finding about the data plane*, not a reason to hide it |
| **A11y work breaks the visual design** — focus rings on glass, live regions forcing reflow | T8.4 checks the ring against every substrate in both themes; T7.1 asserts by announcement **count** so a naive `aria-live` that re-reads the backlog is caught; every a11y change re-runs T1's VR set |
| **The motion consolidation is one giant regressive diff** | sequenced after T1's baseline; each sub-task its own commit with its own `imgdiff.py` verdict; the source-scan test locks the rule rather than trusting the sweep — which is precisely how `springs.ts`'s ownership claim rotted in the first place |
| **The bundle budget blows** — 4.5 KB of headroom for A6 + B3 + B5 + A7 | every task reports its delta; a11y attributes and `aria-*` strings are measured, not assumed free; axe is dev-only; T5.3 is explicitly conditional on fitting |
| **The real-device checklist is written and never run** — A7 stalls forever | ten minutes, riskiest-first, no tools; T13.1 makes it the single un-tickable line, so its absence is visible rather than silent |
| **:8829 leaks into :8824** — shared tmux server, inherited hook token, an accidental restart | the §0.7 launcher's `unset` block and `TMUX_TMPDIR` override are written out verbatim; T10.4's teardown is verified; T13.4 confirms :8824's uptime |
| **Debt triage becomes a dumping ground** — everything re-filed to B5 and A6 ships hollow | T0.3 forces one of four labels with a reason; `A7-blocker` items must close; closed-vs-deferred counts go in the PR body |
| **Scope creep — A6 becomes A3 again** | A6 fixes recorded deviations and hardens; it adds **no new primitive**. A jury note asking for a feature is re-filed, and `VERDICT.md` says so |
| **The mobile evidence is retroactively invalid** — three prior plans claim mobile verification that could not have run on webkit 2215 | T0.4 fixes it before any mobile assertion and records the result; until then a mobile screenshot counts as no evidence |

---

## 5. Explicitly out of scope (and where it goes)

- **A7 — the default flip**, its release and its kill-switch announcement → the separate small PR,
  after the owner's hands-on.
- **B3** (picker/palette consolidation, cheatsheet, transcript deep-links, the shortcut dispatcher,
  FTS5 transcript index) → its own plan, unexecuted. A6 pulls forward only the two defects in §0.1
  #36.
- **B5** (duplicate/delete-honesty/undo, per-session notifications, modal + empty-state
  consolidation, cross-device seen-cursors, quick-peek → `ResponsiveSheet`,
  `MemberStatusDot` merge) → B5.
- **The changes rail and header context %/cost** (§0.1 #9, #10, #19) — captured in the showcase as
  **named gaps** (S27), not faked and not built.
- **The typed Rust sessions-delta struct** (§0.1 #21), the **z-ladder renumber** (#28), the **24
  stray `backdrop-blur-*` call sites** (#29) — infra refactors too wide for a hardening fase; #29's
  *hazard* is tested by T9.1 even though the refactor is deferred.
- **Board API deprecation** (#25) and the **hook-token delegate endpoint** (#3) — each needs its own
  owner gate, as `b4-security-checklist.md` records.
- **Track A's provider guard stays**: codex/kimi/remote/team are not made chat-eligible.
- **Token-level streaming** and any change to transcript flush behaviour — A0 settled this; A6
  polishes the workarounds, it does not relitigate them.
- **Any new chat primitive.** The vocabulary is closed at A4's set + B4's system lines.
- **Real-hardware iOS/Android verification** — structurally impossible here; that is exactly what
  T12's checklist delegates to the owner, deliberately and in writing.
