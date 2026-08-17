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
const BUDGET_APP_JS = 217 * KB
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
