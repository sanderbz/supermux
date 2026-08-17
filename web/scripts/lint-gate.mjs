#!/usr/bin/env node
/**
 * ESLint, as a gate that can pass today.
 *
 * `bun run lint` currently reports 6 errors on a clean checkout — all of them
 * `react-hooks/set-state-in-effect` in code that predates the rule. Wiring the
 * raw command into CI would make every PR red on day one, which is exactly how
 * `bun run test:e2e:smoke` stopped being read (CONTRIBUTING.md points
 * contributors at a suite that was 19-red before they touched anything).
 *
 * So this gates on the COUNT: a PR may not add an error, and every error it
 * removes ratchets the baseline down. Warnings are printed and not gated —
 * there are ~61 and they are advisory by design.
 *
 * Lower BASELINE_ERRORS when you fix one. Raising it needs a reason in the PR
 * body, and "the rule is annoying" is not one.
 */
import { spawnSync } from 'node:child_process'

const BASELINE_ERRORS = 6

const run = spawnSync('bun', ['x', 'eslint', '.', '-f', 'json'], {
  cwd: new URL('..', import.meta.url).pathname,
  encoding: 'utf8',
  maxBuffer: 64 * 1024 * 1024,
})

// eslint exits 1 when there are errors — that is expected here, we read the
// report. A missing/!JSON stdout is a real failure.
let report
try {
  report = JSON.parse(run.stdout)
} catch {
  console.error('✗ could not parse eslint JSON output')
  console.error(run.stdout?.slice(0, 2000))
  console.error(run.stderr?.slice(0, 2000))
  process.exit(1)
}

let errors = 0
let warnings = 0
const offenders = []
for (const file of report) {
  errors += file.errorCount
  warnings += file.warningCount
  for (const m of file.messages) {
    if (m.severity === 2) {
      offenders.push(`${file.filePath}:${m.line}:${m.column}  ${m.ruleId ?? 'parse'}`)
    }
  }
}

console.log(`\neslint: ${errors} error(s), ${warnings} warning(s)\n`)
for (const o of offenders) console.log(`  ${o}`)

if (errors > BASELINE_ERRORS) {
  console.error(
    `\n✗ ${errors} eslint errors, baseline is ${BASELINE_ERRORS}. ` +
      `This PR adds ${errors - BASELINE_ERRORS}.\n`,
  )
  process.exit(1)
}
if (errors < BASELINE_ERRORS) {
  console.log(
    `\n✓ ${errors} errors — below the ${BASELINE_ERRORS} baseline. ` +
      `Ratchet BASELINE_ERRORS in scripts/lint-gate.mjs down to ${errors}.\n`,
  )
} else {
  console.log(`\n✓ eslint errors at baseline (${BASELINE_ERRORS}), none added.\n`)
}
