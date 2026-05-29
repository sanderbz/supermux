// Hermetic guard for the mobile/desktop mouse-reporting fix (no backend).
//
// THE BUG: xterm 5.5's own touch-scroll listeners early-return while
// `coreMouseService.areMouseEventsActive` is true, and a desktop drag becomes a
// mouse report instead of a text selection. Claude Code 2.1.156 turns mouse
// tracking ON (DECSET ?1000/?1002/?1003/?1006) and ignores the server-side
// CLAUDE_CODE_DISABLE_MOUSE env, so one-finger scroll + select-to-copy died.
//
// THE FIX: `disableXtermMouseTracking(term)` (lib/disable-xterm-mouse.ts)
// swallows those DECSET sequences in the parser so xterm never enters mouse mode.
//
// This spec bundles the REAL function + REAL xterm and proves, in one test, both
// halves: a plain Terminal DOES enter mouse mode on ?1000h (the gate is real),
// and a guarded Terminal does NOT — even after ?1000h/?1002h/?1006h. The full
// touch-drag behaviour is covered by mobile-terminal-scroll-mouse-tracking.spec.

import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect, test } from '@playwright/test'

const __dirname = dirname(fileURLToPath(import.meta.url))

let bundle = ''
test.beforeAll(() => {
  const entry = resolve(__dirname, 'fixtures', 'xterm-mouse-fixture.ts')
  const out = join(mkdtempSync(join(tmpdir(), 'xterm-mouse-')), 'bundle.js')
  // Bundle the fixture (xterm + our function) into one IIFE that, when loaded as
  // a classic <script>, assigns window.__xtermMouseFixture.
  execFileSync('bun', ['build', entry, '--format=iife', '--outfile', out], {
    stdio: 'pipe',
  })
  bundle = readFileSync(out, 'utf8')
})

test('xterm refuses to enter mouse-tracking mode when guarded', async ({ page }) => {
  await page.goto('about:blank')
  await page.addScriptTag({ content: bundle })

  const result = await page.evaluate(async () => {
    const fx = window.__xtermMouseFixture!
    const active = (t: unknown): boolean | null =>
      (t as { _core?: { coreMouseService?: { areMouseEventsActive?: boolean } } })
        ._core?.coreMouseService?.areMouseEventsActive ?? null
    const writeSync = (t: { write: (d: string, cb: () => void) => void }, d: string) =>
      new Promise<void>((res) => t.write(d, res))

    // Baseline (the bug condition): a plain terminal enters mouse mode on ?1000h.
    const host1 = document.createElement('div')
    document.body.appendChild(host1)
    const base = new fx.Terminal({ cols: 80, rows: 24 })
    base.open(host1)
    await writeSync(base as never, '\x1b[?1000h')
    const baselineActive = active(base)

    // Fixed: a guarded terminal does NOT, even after the modes Claude emits.
    const host2 = document.createElement('div')
    document.body.appendChild(host2)
    const fixed = new fx.Terminal({ cols: 80, rows: 24 })
    fx.disableXtermMouseTracking(fixed)
    fixed.open(host2)
    await writeSync(fixed as never, '\x1b[?1000h')
    await writeSync(fixed as never, '\x1b[?1002h')
    await writeSync(fixed as never, '\x1b[?1006h')
    const fixedActive = active(fixed)

    return { baselineActive, fixedActive }
  })

  // The gate is real: without the fix, mouse tracking activates.
  expect(result.baselineActive, 'baseline ?1000h must activate mouse tracking').toBe(true)
  // The fix holds: guarded terminal never enters mouse mode.
  expect(result.fixedActive, 'guarded terminal must NOT enter mouse mode').toBe(false)
})
