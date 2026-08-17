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
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { gzipSync } from 'node:zlib'

const KB = 1024
const DIST = join(import.meta.dirname, '..', 'dist', 'assets')

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
const BUDGET_APP_JS = 230 * KB
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

if (failed) {
  console.error('\n✗ Performance budget exceeded — failing build.\n')
  process.exit(1)
}
console.log('\n✓ All performance budgets met.\n')
