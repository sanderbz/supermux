#!/usr/bin/env node
/**
 * Performance budget gate.
 *
 * Runs after `vite build`. Measures gzipped sizes of the production bundle and
 * fails (exit 1) if any budget is exceeded. No new runtime deps — uses the
 * Node built-in `zlib`.
 *
 * Budgets:
 *   - main app JS  ≤ 200 KB gzipped  (the entry chunk + non-vendor app code;
 *                                     vendor chunks are cached independently)
 *   - CSS          ≤  30 KB gzipped
 *
 * Usage:  bun run perf:size   (or  node scripts/size-budget.mjs)
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { brotliCompressSync, constants, gzipSync } from 'node:zlib'

const KB = 1024
const DIST_ROOT = join(import.meta.dirname, '..', 'dist')
const DIST = join(DIST_ROOT, 'assets')

// Budgets in bytes (gzipped).
// HERO-PATH gate (new, strict): the ENTRY chunk is what every cold load pays
// before anything renders — hold it tight (~6% headroom over today's 151 KB).
const BUDGET_ENTRY_JS = 160 * KB
// TOTAL app JS (entry + lazy app chunks; vendor cached separately).
//
// RATCHETED 232 → 210 by fase B2, the PR that deletes the Board page. #70 set
// the 232 ceiling as explicitly TEMPORARY and required B2 to ratchet it back in
// the same PR as the removal. It did not come back to 200, and the audit trail
// for that is here rather than in a commit message:
//
//   with the Board page, all of B2 landed   entry 156.13 KB · app JS 216.88 KB
//   without it (this build)                 entry 144.73 KB · app JS 205.46 KB
//                                           ────────────────────────────────
//   the removal itself                      −11.40 KB entry · −11.42 KB total
//
// The removal is worth 11.4 KB gz on the HERO path — and it is what keeps the
// entry gate green: with the page still in, the entry chunk sat at 98% of its
// 160 KB budget. The 200 KB target in the plan predated #71 (the fabric spine)
// and #72 (fase A5) landing under this branch, plus B2's own roster, attention,
// issue and display surfaces. 205.46 KB is the honest floor today, so the
// ceiling is that plus ~2% headroom. Raising a ceiling silently is still not
// allowed; lowering it with the measurement attached is the point.
// 211 as of B3 (#75): measured 210.23 + margin. Policy (orchestrator,
// 2026-08-17): the ENTRY gate above is the designed hard limit protecting the
// hero path; this total is a floating awareness ceiling at measured+2%, and
// every PR that moves it must justify its bytes in the PR body. B3's +0.44 KB
// is §14 capability (EntityPicker/palette); its consolidation itself measured
// byte-neutral.
// 212 as of A6 (#TBD): measured 211.95 on the merge of `feat/a6-polish` with
// B3, against 210.23 for `origin/main` alone — a +1.72 KB fase, justified
// per-stream because A6 is three independent passes and an aggregate would
// hide which one to argue with:
//   +0.82 KB  T2, the chat data plane's honesty layer. The server has computed
//             staleness since A2 (`tailer.rs::TailState`) and the client threw
//             it away — `reconnecting` and `no_hooks` rendered pixel-identically
//             to `live`. This buys the vocabulary, the 90 s staleness ceiling,
//             the foreground redial, and the fix that stops the delivery
//             watchdog manufacturing false "undelivered" out of a silence the
//             dead socket caused itself.
//   +0.49 KB  T7/T8, accessibility. `live-layer.tsx` had ZERO aria/role, so a
//             screen-reader user was never told a message arrived. Most of this
//             is attributes and labels; `eslint-plugin-jsx-a11y` is a
//             devDependency and ships nothing.
//   +0.45 KB  T6 motion + T4 the A7-blockers, net of the deletions the motion
//             pass paid with (25 inline reduce literals collapsed into one
//             shared branch; `tweens.popoverOut` retired).
// The ENTRY gate is the one that guards the hero path and it MOVED DOWN
// relative to its budget: 146.72 / 160 KB (92%), because the new code lands in
// the lazy `chat-panel` chunk and `A0_LATENCIES` tree-shakes out entirely.
// Ceiling set to ceil(measured), which is the same rule B3 used (210.23 → 211).
// 216 as of B5 (#TBD): measured 215.91 against 211.95 for A6 — a +3.96 KB fase.
// The ENTRY gate, the one that actually guards the hero path, MOVED DOWN
// relative to its budget: 150.40 / 160 KB (94%), and none of B5's weight lands
// on it. The `/dev/*` benches T13 adds are `import.meta.env.DEV`-gated and
// tree-shake out entirely — verified absent from `dist/`, so they cost nothing
// here. Apportioned per stream (by module contribution, not by isolated
// builds), because an aggregate would hide which one to argue with:
//   ~1.5 KB  T3, the notification client. `push-bridge` + its mount point +
//            the per-bot policy control. This is the half of §15.4 that had NO
//            client at all: the service worker had been posting payloads into
//            a void since the PUSH milestone because nothing was listening, and
//            the home-screen badge did not exist (`setAppBadge` had zero
//            occurrences in `web/`). The SW itself is a public asset and is not
//            in this bundle.
//   ~1.3 KB  T8, the recovery ladder. `use-recovery` + the inline/canonical
//            renderings. Buys the first manual recovery a user has ever had —
//            and the first UI for `recovery.auto_heal`, a real pref that was
//            reachable only by hand-crafting a `PUT /api/prefs`.
//   ~1.0 KB  T9, the confirm idiom. This one is a NET ADD that pays for a
//            larger deletion later: it replaces three inline mechanisms across
//            six sites plus four `window.confirm` calls, and the six sites'
//            hand-rolled timers came out. It reads as growth now because the
//            shared machine and the dialog are new files while the deletions
//            are scattered lines.
//   ~0.2 KB  T4, the seen-cursor merge in `attention-tiers`/`use-attention`.
// Ceiling set to ceil(measured), the same rule B3 and A6 used.
// 217 as of the palette/pickers fix wave: measured 216.16 against 215.39 for
// B5 — a +0.77 KB wave, and it is the ceiling itself that made these bytes
// worth writing down. The verification pass found five palette/picker defects
// whose fixes are each 1–2 hundred bytes, and B3's ledger records that five of
// its deliverables were DROPPED rather than shipped because the gate had ~21
// bytes of headroom at the time. A gate that turns a 0.2 KB accessibility fix
// into a deferred task is measuring the wrong thing; the ENTRY gate is the one
// that guards the hero path, and it MOVED DOWN relative to its budget again:
// 150.59 / 160 KB (94%). Per stream, by module contribution:
//   ~0.25 KB  the "Go to" group — the app's four routes, the two Settings
//             anchors and the theme flip. The palette could reach NONE of the
//             app's destinations: `settings` returned zero rows.
//   ~0.20 KB  the phone surface — one shared ⌘K trigger (extracted from the
//             desktop dock, so the dock's copy came OUT), a bottom-nav search
//             cell, a focus-dock icon, and the coarse-pointer fork. ⌘K had no
//             visible trigger at all below 768px.
//   ~0.15 KB  the ranker's relevance floor + the `{label, extra}` rank shape,
//             and the toast that names the session a slash row writes into.
//             This one BUYS SAFETY: `dark` used to offer /supermux-schedule as
//             its only row, and Enter on it POSTed into a live agent.
//   ~0.10 KB  the combobox attributes (role/aria-controls/aria-expanded/
//             aria-activedescendant + two ids), which is what makes arrowing
//             through results audible at all.
//   ~0.07 KB  recall reachability + the Esc/✕ and group-heading polish.
// Ceiling set to ceil(measured), the same rule B3, A6 and B5 used.
// Raised again in the same wave by the roster-attention fixes: measured 216.74 against 215.39 for
// origin/main at efb911b — +1.35 KB, all of it on the entry chunk because the
// overview IS the entry chunk. The ENTRY gate, the one that guards the hero
// path, stays at 151.17 / 160 KB (94%) — unchanged in percentage from B5's
// 150.40. Apportioned per finding, because an aggregate would hide which one to
// argue with:
//   ~0.55 KB  the roving tabindex (`hooks/use-roving.tsx` + its three consumer
//             seams). A6 T8.3 was CHECKED and unshipped: the roster measured 38
//             tab stops with inert arrow keys. This is the whole of the composite
//             widget — one tab stop per list, arrows, Home/End, focus adoption.
//   ~0.45 KB  the per-session action menu rendered in the DEFAULT overview.
//             Almost all of this is the two extra mount points and the
//             `MoveTarget` projection: the menu itself MOVED out of
//             `group-grid.tsx` rather than being copied, so the ~4 KB of menu
//             body is not new. Pin / Rename / Info / Mark unread had zero entry
//             points in the shipping sort mode.
//   ~0.25 KB  the unread tier's affordance — the second dot kind, the count
//             badge, and the `unread` cursor sentinel. This is the tier the
//             whole T5 server change (entry_count / epoch / last_entry_ts) was
//             computed for and no pixel consumed.
//   ~0.10 KB  the roster/overview polish batch: the list preview's
//             `preview_lines` fallback, the `Row detail` density label, the
//             group-by disabled state and its reason line. Net of the copy
//             changes, which are byte-neutral.
// 219 at fix-wave-1 integration: the palette (+0.77 KB) and roster (+1.35 KB)
// streams above were measured independently against B5's 215.39; combined on
// one tree with the focus-toggle and chat-content fixes they measure 218.34.
// Same ceil(measured) rule; entry gate 152.30/160 (95%) remains the guard.
//
// 220 as of fix/perf-a11y-net: THE POLICY IN THIS FILE, APPLIED.
//
// The comment at the top of this block has said "measured + ~2% headroom" since
// B2. Every fase since has instead shipped `ceil(measured)` — 210 → 211 → 212 →
// 216 — which is not a budget, it is a tripwire that happens to be one byte
// above the floor. The consequences were real and are documented elsewhere in
// the repo: B3 recorded "0.01 KB headroom left — no additive task may run until
// T3/T4 delete" and dropped five deliverables for size, two of which are now
// open majors; A6's own ledger told B5 and A7 they had ~4.5 KB when the true
// figure was 0.21 KB; B5 then landed on 215.91 against a 216.00 ceiling — 92
// bytes. A gate nobody can pass without first raising it is not enforcing
// anything; it is just a step in everyone's PR.
//
// So the number is now what the stated policy produces, and both halves are
// written down so the next fase can argue with the arithmetic rather than
// rediscover it:
//
//   measured on this branch        215.61 KB     (B5's 215.91 + 0.22, see below)
//   measured at wave-1 integration 218.54 KB     (all seven fix streams on one tree)
//   documented policy              measured × 1.02
//   ceiling                        218.54 × 1.02 = 222.91 -> 223 KB
//
// THIS IS NOT SHELTER FOR THIS PR'S BYTES. fix/perf-a11y-net measures 215.61,
// i.e. it fits under the OLD 216 ceiling with room to spare; the ratchet is the
// fix for the "21 bytes of headroom" finding, not a lift for its own code. Its
// +0.22 KB over B5 is:
//   +0.15 KB  `lib/live-region-owner.ts` and its four call sites — the
//             ownership seam that stops a turn being announced three times and
//             "Reconnecting…" twice, and that lets the app-root outage curtain
//             stand down for the chat surface (the documented "what is on
//             screen stays" promise).
//   +0.07 KB  the `enabled` guard in `use-board.ts` and the comments around it,
//             which delete a guaranteed 404 per team card per page load.
//
// AND NOTE WHERE THE REAL GATE IS. `BUDGET_ENTRY_JS` above is the hard limit
// that protects the hero path — every cold load parses the entry chunk before
// first paint — and it is unchanged at 160 KB, currently 150.00 (94%). That one
// is a gate. This one is an awareness ceiling: every PR that moves it must still
// justify its bytes in the PR body, which is the rule that has actually been
// doing the work all along.
//
// 223 held at chore/remove-kimi: measured 219.26 against 219.49 for origin/main
// at 2809001 — the Kimi provider's removal returns 0.23 KB (the tools sheet's
// KIMI_ACTIONS + KimiToolsBody and nine now-unused lucide icons, the New Session
// third option, the provider branches in the two focus headers and the two
// external-editor gates, the dev mock tile; the new `lib/retired-providers`
// module and its note are ~0.15 KB of that back). The entry chunk moved down
// too: 153.11 / 160 (96%) from 153.39.
//
// The ceiling does NOT move. Applied literally, measured × 1.02 = 223.65 would
// RAISE it — a removal buying future headroom is the one thing this ledger has
// never been for, and the whole point of the fix-wave-1 ratchet was that a
// ceiling should track real cost rather than drift upward. So the rule for a
// subtractive PR is: the ceiling ratchets DOWN or stands still, never up. 223
// stands, and it is now 3.74 KB of genuine headroom instead of 3.51.
// 230 at states-wave integration (the ONE ratchet for #87+#89+#88, per the
// measured×1.02 policy above): the wire plane (+~3.9 KB: agent_error classifier,
// BlockedRow, system rows) and the pty lens (+~3.3 KB: notice/question families,
// usage gauge) measure 225.40 together; 225.40 × 1.02 = 229.9 -> 230. The login
// card (#88, ~+0.5 KB) is expected to land inside this same ceiling.
// Entry gate unchanged at 160 — still the guard.
// 232 at the hook-forms wave (mcp.elicitation_form + mcp.task_input_required +
// limit.grace_window): measured 231.75 against 229.05 for origin/main at
// 7690249 — a +2.70 KB fase, and the same ceil(measured) rule every fase since
// B3 has used (measured × 1.02 = 236.28 would be the policy's ceiling; the
// ledger has always taken the tighter of the two). 0.25 KB of headroom is
// thin on purpose: the next thing through here should measure first.
//
// Where the bytes went, because this ledger is a justification and not a
// tally: ~2.1 KB is `ui/form-card.tsx` — a JSON Schema rendered as real typed
// controls (string/number/integer/boolean/enum/date), per-field validation
// messages, required enforcement and the third-party attribution chrome. The
// rest is `chat/elicitation.ts` (the pure validator + answer builder, shared
// with the server through a parity corpus) and three system rows in
// `wire-entries.ts`. Nothing was added to the roster or the shell.
//
// The card is what an MCP-using session gets INSTEAD of hanging silently
// forever with a green dot, so the bytes buy a state the app previously could
// not represent at all. The entry chunk moved 154.76 → 157.09 / 160 (98%): the
// live layer is on the hero path and imports the card statically. That is 2.91
// KB of headroom left on the gate, and the next thing to touch this file
// should either code-split the card or spend elsewhere.
//
// 232 at the PTY-07 dialog families (`feat/states-dialog-families`): measured
// 231.15 against 229.06 for origin/main at dc64cf6, so +2.09 KB, effectively all
// of it in `chat-panel` (38.28 -> 40.37; the entry chunk moved 154.77 -> 154.84).
// What it bought, and why each part is bytes rather than nothing:
//   +~0.8 KB  the two `Session paused` registry entries and the card copy for
//             them. Most of it is the DISABLED-REASON prose — the sentence that
//             says a row would spend usage credits on the reader's account and
//             that chat has never seen this dialog on a live screen. That
//             sentence IS the feature: without it the card is a greyed-out
//             control with no explanation, which is the state the audit found.
//   +~0.6 KB  `registry/armed.ts` + the lens' armed reader, which is what stops
//             the composer's Stop from sending an Escape the screen has armed
//             (catalog `generic.armed_keys` — it clears the user's terminal
//             draft, or exits Claude Code outright).
//   +~0.4 KB  the retraction fold and its tombstone row: marking withdrawn
//             replies instead of drawing them as live, without deleting
//             anything from the append-only ring.
//   +~0.3 KB  the refusal class and the stalled row — two states that used to
//             render as an ordinary retryable API error, or as nothing at all.
// The ×1.02 policy above would allow 236 (231.15 × 1.02 = 235.77). It is NOT
// taken: this is one PR of a wave, and if every PR in a wave applies the 2 %
// to its own measurement the ceiling drifts up by compounding. 232 is the
// measured cost rounded up, which is what the ledger is for; the wave's own
// integration commit is where a single ×1.02 belongs, if it needs one at all.
// 239 at wave-3b integration (#93 + #94 on one tree): the two streams above
// were measured against different parents; together they measure 233.91.
// measured×1.02 policy: 233.91 × 1.02 = 238.59 -> 239. Entry gate unchanged.
//
// 239 HELD at fix/w4-infra-a11y: measured 237.10 on this branch rebased onto
// `main` at 084b522 (the chat-theme lane), against 236.5x for that parent
// alone — this lane's own cost is +0.51 KB and it fits inside the standing
// ceiling, so the ceiling does not move. (The rule this ledger has followed
// since the fix-wave-1 ratchet: a ceiling tracks real cost, and a PR that fits
// under the current one does not get to raise it "while it is here".) The
// ENTRY gate is the one worth watching — 159.06 / 160 KB, 99%, i.e. 0.94 KB of
// headroom left across ALL lanes. The next additive change to the hero path
// should code-split rather than spend. This lane's share of it:
//   ~0.35 KB  `components/a11y/turn-announcer.tsx` + its mount in the focus
//             route + the third claim in `live-region-owner.ts`. This is the
//             turn announcement for the DEFAULT (terminal) renderer, which had
//             none: instrumented over a real 75 s turn, the announcement
//             timeline was empty. It sits on the hero path because the focus
//             route is where a turn happens, and the chat chunk is lazy.
//   ~0.16 KB  `teammate-chip.tsx`'s stretched activation button (the fix for a
//             serious `nested-interactive`) and one `data-testid`.
// The turn announcer is on the hero path because the focus route is where a
// turn happens and the chat chunk is lazy; the chip fix is unavoidable markup.
// 242 at the mobile-polish batch: the attention-rollup picker sheet, the
// composer's folded actions sheet + real dictation wiring, and the calmer
// header measure 241.65 total. The ENTRY (hero-path) chunk actually DROPPED to
// 147.13 / 160 (92%) because the picker sheet is now lazy — the growth is all
// in on-demand chunks, which is exactly where new surface belongs. ceil(measured).
// 243 as of WS4 (grok-mode identity marks): measured 242.06 against 241.65, a
// +0.41 KB wave, all of it `lib/grok-agent-hue.ts` — the per-agent hue write WS1
// SHIPPED AS A STUB and its own comment deferred to WS4 ("that runtime write is
// WS4/WS5"). It is the one variable write that re-skins the ~6 non-semantic Grok
// surfaces on a session switch (side-pane wash, mention chips, composer ring,
// thinking coat), and it MUST live on the shell root in layout.tsx — the entry
// chunk — because that is the element that owns `data-grok` and knows the focused
// slug; it cannot be lazy without lazy-loading the shell. The whole of the wave
// is the derivation (bodyColor/accentInk over the immutable slug) + the empty-on-
// unfocused guard that keeps the identity/status firewall honest. The mark
// EXPRESSION half (needs-you halo, working-only breathe, idle dim) is pure CSS,
// so it lands in the CSS budget (23.35/30, 78%), not here. The ENTRY (hero-path)
// gate is UNMOVED at 147.34 / 160 (92%): none of this touches the hero path — the
// hue write is inert until a focus route mounts under grok. ceil(measured).
// 247 as of WS5+WS6 (grok-mode overview / roster — the radical inbox): measured
// 246.18 against 243 for WS4 — a +3.53 KB wave, ALL of it the new
// `grok-roster-*.js` chunk (3.95 KB gz: `GrokRoster` + its Row A/B/C anatomy,
// the four hairline sections, the facepile team row, and the cost/context detail
// pane). It is a LAZY chunk fetched only when the default-OFF `grok-mode` flag is
// on — `routes/overview.tsx` picks it with `React.lazy`, precisely so this whole
// surface stays OFF the cold hero path. The proof is the ENTRY gate, the one that
// actually guards first paint: it moved only +0.16 KB (147.34 → 147.50 / 160,
// still 92%) — that sliver is the flag read + the lazy-import wiring in the
// overview module itself (which IS the entry chunk); the roster's body is not on
// it. This is exactly where new surface belongs (the same argument the mobile-
// polish batch and B5's `/dev` benches made): weight on an on-demand chunk, the
// hero path untouched. ceil(measured), the rule every fase since B3 has used; the
// grok-mode.css half of WS5+WS6 lands in the CSS budget (25.94/30, 86%), not here.
// 249 as of iOS bug #2 (the phone composer stops being a form control): measured
// 248.82 against 246.92 for the branch parent (150df7d, bug #1 + mobile bubbles)
// — a +1.90 KB fase. iOS Safari draws its prev/next/Done accessory bar above the
// keyboard for `<input>`/`<textarea>` and for nothing else, so the phone's
// message box becomes a `contenteditable` host (`plain-editable.tsx`) and the
// bar's only native dismiss — the Done button — comes back as a tap-the-
// transcript gesture (`use-tap-to-dismiss.ts`). Where the bytes went:
//   ~1.6 KB  `plain-editable.tsx` — NOT chrome: it is the DOM↔plain-text map
//            that lets the rest of the composer keep reading `value`,
//            `selectionStart/End` and `setSelectionRange` off the field exactly
//            as it read them off the textarea (the `@`/`/` picker, the insert
//            seam and auto-grow all depend on those four being exact), plus the
//            plain-text paste guard and the trailing-scaffolding reader that
//            keeps a contenteditable's bookkeeping `<br>`/`\n` out of the draft.
//   ~0.3 KB  `use-tap-to-dismiss.ts` — the coarse-pointer tap gate (one finger,
//            no drag, no selection, not on a control, something focused) and its
//            pointerdown/up plumbing on the scroll track.
// UNUSUALLY, ~1.44 KB of this lands on the ENTRY chunk (147.58 → 149.02 / 160,
// 93%), not on a lazy one — because `ui/composer.tsx`'s `Composer` is statically
// reachable from the entry chunk, so its mobile branch's import rides there too.
// It is NOT code-split: the composer field is the always-present core input, and
// hiding it behind `React.lazy`/Suspense to shave hero bytes would pop the field
// in a frame late on every mobile chat mount — the ledger's lazy examples are
// on-demand SHEETS and benches, never the field itself. The entry gate keeps
// 11 KB of headroom, so the spend is honest here rather than hidden. ceil(measured);
// the `.sm-plain-editable` CSS lands in the CSS budget (27.34/30, 91%), not here.
// 250 as of the feat/bot-concept merge (bot concept server+web landing on the same
// branch as iOS bug #2): measured 249.09 against the 249 iOS ceiling — a +0.07 KB
// sliver, all of it the ASK-1 roster create-verb (the "+ New bot" pill + palette
// action + botMode flag read) that folds onto the lazy grok-roster chunk plus a
// rounding crumb on entry (entry still 149.15/160, 93%). Both fases' weight is now
// remeasured together on one branch; ceil(measured) = 250. No new hero-path cost.
//
// 255 as of the feat/grok-mode BOT PANEL (ASK 3): the roster's detail pane stopped
// GLANCING and became a real per-bot settings page — a tabbed BotPanel (Overview ·
// Instructions · Tools · Activity) that reuses session-info-panel's section bodies
// (name/desc/tags/git/schedules/issues/notif) and adds the editable model picker,
// role presets, notes editor and a [...] actions menu. Measured 254.31; +5.22 KB
// over the 249.09 baseline, ALL of it on the lazy chunks — `bot-panel` is
// `React.lazy`, mounted only when a bot is selected (desktop pane) or the mobile
// focus title opens its sheet — so the ENTRY/hero path is untouched (149.48/160,
// 93%, a rounding crumb off the prior 149.15). A genuine additive feature, not a
// regression to trim: ceil(measured) = 255. The .gr-botpane CSS (~0.15 KB) lands
// in the CSS budget (27.76/30, 93%), not here.
// 257 as of the feat/grok-mode EXPRESSIVE FACES wave: the mark engine gained a
// Grok-skin blob silhouette (adapted blobatar recipe, `grok-blob.ts`), three new
// face states (thinking/streaming/connecting) + their eye geometries, the
// decoupled `attentionFor` layer and `markStateForSession` in `mark-status.ts`.
// Measured 255.28; +0.97 KB over the 254.31 bot-panel baseline, effectively ALL
// of it on the LAZY `marks` chunk (5.04 -> 5.12) and the roster/chat panels that
// read the new status mapping — the hero ENTRY path is untouched (149.68/160,
// 94%, a rounding crumb): the blob math is only reached through `geometry.ts` ->
// `session-mark.tsx` (the marks chunk), never through the entry-reachable
// `grok-agent-hue.ts`. A genuine additive feature (the faces now encode status
// pre-attentively like Grok Bot), not a regression to trim: ceil(measured) + a
// thin margin = 257. Every byte of expression/motion is CSS under `[data-grok]`
// (28.47/30 CSS, 95%) and byte-inert off the skin. The next thing through here
// should measure first — 1.7 KB of headroom is intentional.
// 258 as of the composer-attachments + selection-fix + shell-viewport merge batch:
// measured 257.13 against 257 — a +0.13 KB batch (attachment chips + paste/drag,
// the selection ticker-gate, the visualViewport keyboard-avoidance hardening + the
// overscroll scroll-chaining fix). All on lazy/chat chunks; entry hero path unmoved
// at 149.80/160. ceil(measured).
// 268 as of the feat/connectors-memory CONNECTOR STORE (the owner's flagship Bot-
// mode surface): the whole store landed — the `/store` catalog grid + card +
// detail + grant control (lazy `store-view` chunk, 4.69 KB), the per-bot Tools-tab
// `GrantedConnectors` list, the inline chat `connect-card` (secure paste / sign-in
// → straight to the vault, on the chat chunk), the Memory-tab learned-notes panel,
// and the `connectors.ts` foundation client + `connectors-store` query cache.
// Measured 267.77; +12.49 KB over the 255.28 faces baseline. Where the bytes went:
//   +4.69 KB  `store-view` — the flagship grid: header+search, Featured rail,
//             category chips, responsive card grid, the detail sheet + the connect
//             flow. A LAZY chunk (the `/store` route AND the bot-scoped sheet both
//             `React.lazy` it), so none of it is on the cold hero path.
//   +~3.5 KB  the always-reachable store atoms the bot-panel/chat pull statically:
//             `connector-card`, `connector-icon`, `grant-control`, `granted-
//             connectors` (the Tools-tab list), `learned-notes` + `memory.ts`.
//   +~2.0 KB  `chat/ui/connect-card.tsx` — the Grok moment, on the chat chunk: the
//             six-state secure connect card (proposed/oauth/key/saving/added/error)
//             that POSTs the credential to the vault and NEVER through the MCP
//             stream. Its dispatch branch in `live-layer` is a few bytes.
//   +~2.3 KB  `connectors.ts` (9-endpoint client) + `connectors-store` (the query
//             cache + optimistic grant/revoke verbs) + the settings/palette
//             doorways. The client rides the `@/lib/api` barrel, which is why the
//             ENTRY gate moved 149.68 -> 151.40 / 160 (95%) — the one hero-path
//             cost, still 8.6 KB inside the gate that actually guards first paint.
// A genuine additive feature — the owner's top-priority surface, not a regression
// to trim: ceil(measured) = 268. The `.cs-*` store skin (base + the scoped
// `[data-grok]` glass) lands in the CSS budget (29.47/30, 98%), not here.
// 271 as of the ROUND-1 JURY FIXES (connector store polish + connect wiring):
// measured 270.69; +2.92 KB over the 267.77 store baseline. The whole of it is the
// design-blocker close-out on the always-reachable store atoms (the store-view
// chunk is lazy; these atoms are pulled statically by the bot-panel/chat, which is
// why the weight lands here and not on a lazy chunk):
//   +~2.0 KB  `store/brand-marks.tsx` — REAL brand marks (GitHub/Notion/Slack/
//             Linear/Sentry/Playwright/iCloud canonical single-path SVGs + a
//             brand-hued Postgres/browser glyph) replacing the initials-on-
//             gradient monogram, which the jury called the single loudest
//             placeholder tell (B1). The catalog ships NO icon bytes, so without
//             this every card fell back to a monogram; the marks are bundled
//             (never hotlinked) and drawn on App-Store-style tiles.
//   +~0.9 KB  the connect/verb/featured polish across `connector-card`,
//             `connector-detail` (the OAuth "Sign in with {service}" lead, B4;
//             the unified Connect verb, B3; the neutral-disabled CTA, H2) and
//             `store-view` (Featured given an actionable brand-washed treatment
//             + de-duplicated from the grid, H1) + the inline connect-card's
//             derived OAuth lead. `chat/ui/connect-card` gained the has_oauth
//             derivation; its dispatch is unchanged.
// The ENTRY (hero-path) gate moved only 151.40 -> 151.45 / 160 (95%, a rounding
// crumb — the connectors client barrel already carried the store types): none of
// this is on the cold hero path. A design-quality close-out the owner required,
// not a regression to trim: ceil(measured) = 271. The store skin stays in the CSS
// budget (29.53/30, 98% — net FLAT: the orphaned `.cs-rail`/`.cs-featured-glow`
// rules were removed as the Featured rail became a grid), not here.
// 273 as of the feat/connectors-memory -> feat/grok-mode MERGE: measured 272.76 —
// the connector store (271 branch) now stacked on top of the composer-attachments +
// selection-fix + shell-viewport batch (258) on one branch. +1.76 over the 271
// connector ceiling = the two lines of divergence measured together for the first
// time; entry hero path unmoved at 151.61/160. ceil(measured).
// 277 as of the PER-MESSAGE ACTION BAR (Bot-mode Copy · Share · More on assistant
// messages): measured 276.93 against 272.76 for feat/grok-mode — a +4.17 KB fase,
// ALL of it on a new LAZY chunk. `ui/message-actions.tsx` is `React.lazy`'d by
// `transcript-item.tsx` (the same discipline `ChatMarkdown` uses), so the ENTRY
// (hero-path) gate — the one that actually guards first paint — MOVED DOWN to
// 151.07/160 (94%, from 151.61): the bar's weight, the dropdown-menu it reuses and
// the Vaul overflow sheet are all fetched only when an assistant bubble with
// actions first renders under Bot mode, never on cold load. Where the bytes went:
//   +~1.7 KB  `ui/message-actions.tsx` — the bar itself: the CSS-only hover-reveal
//             (no React state on the reveal path, so it never re-renders the
//             memoised prose subtree or fights text selection), the Copy→check
//             flash, the feature-detected Share, and the desktop dropdown / phone
//             sheet fork over the three exports.
//   +~1.5 KB  `chat/message-export.ts` — the pure export plane: copy/share/
//             download idioms + the standalone `.html` document wrapper. The
//             markdown→HTML render (`react-dom/server` + the markdown chunk) is
//             `await import()`ed on demand, so neither weighs here or anywhere
//             until "Export as HTML" is actually picked.
//   +~0.6 KB  `chat/message-actions-sheet.tsx` — the touch overflow on the shared
//             Vaul `MobileActionSheet` (already bundled), three 44pt export rows.
//   +~0.4 KB  the mount seam in `transcript-item.tsx` (the gated sibling column +
//             its lazy boundary) and the `showActions` thread through
//             `conversation.tsx`/`chat-panel.tsx`.
// A genuine additive feature, gated so the base app (Bot mode off) is byte-
// identical: ceil(measured) = 277, the rule every fase since B3 has used. The
// `[data-msg-actions]` grok skin (~0.1 KB) lands in the CSS budget (29.50/30,
// 98%), not here.
const BUDGET_APP_JS = 277 * KB
const BUDGET_CSS = 30 * KB

function gzipSize(path) {
  return gzipSync(readFileSync(path), { level: 9 }).length
}

function fmt(bytes) {
  return `${(bytes / KB).toFixed(2)} KB`
}

let files
try {
  files = readdirSync(DIST)
} catch {
  console.error(`✗ ${DIST} not found — run \`bun run build\` first.`)
  process.exit(1)
}

const js = []
const css = []
for (const name of files) {
  const path = join(DIST, name)
  if (!statSync(path).isFile()) continue
  if (name.endsWith('.js')) js.push({ name, gz: gzipSize(path) })
  else if (name.endsWith('.css')) css.push({ name, gz: gzipSize(path) })
}

js.sort((a, b) => b.gz - a.gz)
css.sort((a, b) => b.gz - a.gz)

// "main app JS" = all JS chunks that are NOT split-out vendor chunks.
// Vendor chunks are named `vendor-*` / `vendor` by vite.config.ts manualChunks.
const isVendor = (n) => /vendor/i.test(n)
const appJs = js.filter((c) => !isVendor(c.name))
const vendorJs = js.filter((c) => isVendor(c.name))

const appJsTotal = appJs.reduce((s, c) => s + c.gz, 0)
const vendorJsTotal = vendorJs.reduce((s, c) => s + c.gz, 0)
const cssTotal = css.reduce((s, c) => s + c.gz, 0)

console.log('\nPerformance budget report (gzipped)\n')

console.log('App JS chunks:')
for (const c of appJs) console.log(`  ${c.name.padEnd(36)} ${fmt(c.gz)}`)
console.log(`  ${'—'.repeat(36)} ${'—'.repeat(9)}`)
console.log(`  ${'app JS total'.padEnd(36)} ${fmt(appJsTotal)}\n`)

console.log('Vendor JS chunks (cached independently, not budget-gated):')
for (const c of vendorJs) console.log(`  ${c.name.padEnd(36)} ${fmt(c.gz)}`)
console.log(`  ${'—'.repeat(36)} ${'—'.repeat(9)}`)
console.log(`  ${'vendor JS total'.padEnd(36)} ${fmt(vendorJsTotal)}\n`)

console.log('CSS:')
for (const c of css) console.log(`  ${c.name.padEnd(36)} ${fmt(c.gz)}`)
console.log(`  ${'—'.repeat(36)} ${'—'.repeat(9)}`)
console.log(`  ${'CSS total'.padEnd(36)} ${fmt(cssTotal)}\n`)

// The ENTRY chunk is the hero path: every cold load parses it before first
// paint. Gate it separately and tighter than the total.
const entry = appJs.find((c) => /^index-/.test(c.name))
const entryGz = entry ? entry.gz : 0

const checks = [
  { label: 'entry JS (hero path)', actual: entryGz, budget: BUDGET_ENTRY_JS },
  { label: 'main app JS', actual: appJsTotal, budget: BUDGET_APP_JS },
  { label: 'CSS', actual: cssTotal, budget: BUDGET_CSS },
]

let failed = false
for (const { label, actual, budget } of checks) {
  const ok = actual <= budget
  const pct = ((actual / budget) * 100).toFixed(0)
  console.log(
    `${ok ? '✓' : '✗'} ${label.padEnd(14)} ${fmt(actual)} / ${fmt(budget)} budget (${pct}%)`,
  )
  if (!ok) failed = true
}

// ── COLD-LOAD HERO PATH (reported, NOT gated) ────────────────────────────────
//
// The gates above police the ENTRY CHUNK. That is the right thing to hold
// tight, but it is not what a first-time visitor pays. Before the browser can
// paint anything it also pulls index.html, every `modulepreload`ed vendor
// chunk, both stylesheets, and the two `-core` font faces — and "vendor chunks
// are cached independently" is true of the SECOND visit and false of the one
// that FCP measures.
//
// Measured on a CDP Fast-3G preset (1.6 Mbps, 562.5 ms RTT), cache cleared,
// DPR 1: FCP 3.82 s (unthrottled control 0.38 s), and the first tile carrying a
// real session name at 4.78 s. The number below is what that 3.8 s is made of.
// Brotli, because that is what the binary negotiates (`static_assets.rs`) —
// except woff2, which is a Brotli container already and ships as-is.
//
// Reported rather than gated, deliberately: a gate needs a defensible number
// and this one has never had an argued budget. Put it in the PR body, argue
// reductions against it. The obvious candidates are the vendor chunks that the
// OVERVIEW does not need — `vendor-framer` and most of `vendor-xterm` are
// terminal-route weight sitting on the roster's critical path.
function brSize(path) {
  return brotliCompressSync(readFileSync(path), {
    params: { [constants.BROTLI_PARAM_QUALITY]: 11 },
  }).length
}

const indexHtml = join(DIST_ROOT, 'index.html')
if (existsSync(indexHtml)) {
  const html = readFileSync(indexHtml, 'utf8')
  const hero = [{ what: 'index.html', bytes: brSize(indexHtml) }]

  // Everything index.html tells the browser to fetch before first paint:
  // the entry module, every modulepreload, and every stylesheet.
  const refs = new Set()
  for (const m of html.matchAll(/(?:href|src)="(\/assets\/[^"]+)"/g)) refs.add(m[1])
  for (const ref of [...refs].sort()) {
    const path = join(DIST_ROOT, ref.replace(/^\//, ''))
    if (existsSync(path)) hero.push({ what: ref.replace('/assets/', ''), bytes: brSize(path) })
  }

  // The two unrestricted `-core` faces. The full patched faces are
  // `unicode-range`-scoped to PUA glyphs and are NOT on this path (see
  // `tests/unit/first-load-weight.test.ts`), so they are correctly absent.
  const fontsDir = join(DIST_ROOT, 'fonts')
  if (existsSync(fontsDir)) {
    for (const name of readdirSync(fontsDir).sort()) {
      if (!name.endsWith('-core.woff2')) continue
      // woff2 IS a brotli container — the server never re-compresses it, so
      // neither does this.
      hero.push({ what: `fonts/${name}`, bytes: statSync(join(fontsDir, name)).size })
    }
  }

  const heroTotal = hero.reduce((s, h) => s + h.bytes, 0)
  console.log('\nCold-load hero path (brotli on the wire, first visit, empty cache):')
  for (const h of hero) console.log(`  ${h.what.padEnd(36)} ${fmt(h.bytes)}`)
  console.log(`  ${'—'.repeat(36)} ${'—'.repeat(9)}`)
  console.log(`  ${'cold-load total (not gated)'.padEnd(36)} ${fmt(heroTotal)}`)
  console.log(
    '  ↑ what a first-time phone visitor downloads before the first tile.\n' +
      '    Not a gate — a number to argue reductions against in the PR body.\n',
  )
}

if (failed) {
  console.error('\n✗ Performance budget exceeded — failing build.\n')
  process.exit(1)
}
console.log('\n✓ All performance budgets met.\n')
