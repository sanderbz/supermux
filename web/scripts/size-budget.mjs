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
const BUDGET_APP_JS = 212 * KB
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
