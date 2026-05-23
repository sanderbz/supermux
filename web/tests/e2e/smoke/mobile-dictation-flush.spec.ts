// R5 e2e — mic→terminal dictation flush (iOS-reliable).
//
// REGRESSION GUARD for the R5 mic fix. The dictation flush used to be gated
// ENTIRELY on Web Speech firing `onend` (listening→idle). On iOS Safari /
// WKWebView `onend` is unreliable, so a dictated transcript never reached the
// pty. The fix surfaces FINAL segments via `onFinal` the instant they commit and
// sends them straight to the pty (same sendRaw path as keystrokes), independent
// of `onend`. A dedupe cursor prevents a late `onend` flush from double-sending.
//
// We stub `webkitSpeechRecognition` so the test fully controls the lifecycle:
//   1. fire a FINAL `onresult` WITHOUT firing `onend` → the segment must reach
//      the pty (proves the flush no longer depends on onend).
//   2. THEN fire `onend` → the same text must NOT land again (no double-send).
// Verification is renderer-agnostic via the backend pane capture (CanvasAddon
// means xterm paints to <canvas> with no readable DOM text).

import { devices, expect, test } from '@playwright/test'
import { api, injectGlobals, startBackend, type Backend } from './harness'

test.use({ ...devices['iPhone 14 Pro'] })

// Inject a controllable fake Web Speech API BEFORE the app mounts. The dock's
// useDictation picks it up via `window.webkitSpeechRecognition`. We expose the
// live instance + a result-builder on `window.__fakeSR` for the test to drive.
function injectFakeSpeechRecognition(): string {
  return `
    (function () {
      class FakeRecognition {
        constructor() {
          this.lang = ''
          this.continuous = false
          this.interimResults = false
          this.onresult = null
          this.onerror = null
          this.onend = null
          this._started = false
        }
        start() {
          this._started = true
          window.__fakeSR.instance = this
        }
        stop() {
          // Real engines async-fire onend on stop; our fake does NOT auto-fire
          // it, so the test can prove the flush works WITHOUT onend, then fire
          // onend explicitly to check for double-send.
          this._started = false
        }
        abort() {
          this._started = false
        }
      }
      window.webkitSpeechRecognition = FakeRecognition;
      window.SpeechRecognition = FakeRecognition;
      window.__fakeSR = {
        instance: null,
        // Build a cumulative results list (Web Speech delivers the whole list
        // each onresult; entries can be interim or final).
        emit(segments) {
          const inst = window.__fakeSR.instance;
          if (!inst || !inst.onresult) return false;
          const results = segments.map(function (s) {
            return { 0: { transcript: s.text }, isFinal: !!s.final, length: 1 };
          });
          results.resultIndex = 0;
          inst.onresult({ resultIndex: 0, results: results });
          return true;
        },
        end() {
          const inst = window.__fakeSR.instance;
          if (inst && inst.onend) inst.onend();
        },
      };
    })();
  `
}

test.describe('mobile: dictation flushes without onend', () => {
  let backend: Backend

  test.beforeEach(async () => {
    backend = await startBackend()
  })
  test.afterEach(async () => {
    await backend?.dispose()
  })

  test('final result reaches the pty without onend; onend does not double-send', async ({
    page,
  }) => {
    test.setTimeout(60_000)
    await page.addInitScript(injectGlobals(backend.token))
    await page.addInitScript(() => {
      localStorage.setItem('supermux-a2hs-dismissed', String(Date.now()))
    })
    await page.addInitScript(injectFakeSpeechRecognition())

    const A = api(backend)
    const created = await A.createSession({
      name: 'mob-dictate',
      provider: 'shell',
      dir: backend.dataDir,
    })
    expect(created.status, 'create session').toBe(201)
    const started = await A.startSession('mob-dictate')
    expect(started.ok, 'start session').toBeTruthy()

    await page.goto(`${backend.baseUrl}/focus/mob-dictate`)

    const surface = page.locator('[data-state="live"]')
    await expect(surface).toBeVisible({ timeout: 15_000 })

    // The mic button shows only when dictation.supported (our fake makes it true).
    // `exact` so the session-pill name ("Running mob-dictate") can't match it.
    const mic = page.getByRole('button', { name: 'Dictate', exact: true })
    await expect(mic).toBeVisible({ timeout: 10_000 })

    // Start dictation — this constructs + starts the fake recognition.
    await mic.click()
    await expect.poll(() => page.evaluate(() => !!window.__fakeSR?.instance), {
      timeout: 5_000,
    }).toBe(true)

    // A distinctive token so the pane assertion can't false-match shell chrome.
    // Kept SHORT so the narrow mobile terminal doesn't wrap it across rows (a
    // wrapped token would inject a newline mid-match). We also strip whitespace
    // from the captured pane before matching, belt-and-suspenders.
    const TOKEN = 'DICTOKEN'
    const stripped = (s: string) => s.replace(/\s+/g, '')

    // (1) Fire a FINAL result WITHOUT firing onend. The flush must NOT wait for
    // onend — the segment should be sent to the pty immediately via onFinal.
    const emitted = await page.evaluate(
      (tok) => window.__fakeSR.emit([{ text: tok, final: true }]),
      TOKEN,
    )
    expect(emitted, 'fake onresult delivered').toBe(true)

    // The dictated token must land in the pty WITHOUT any onend having fired.
    await expect(async () => {
      const pane = await A.peek('mob-dictate', 60)
      const n = (stripped(pane).match(new RegExp(TOKEN, 'g')) ?? []).length
      expect(
        n,
        `pane should contain the dictated token (sent w/o onend): ${JSON.stringify(pane.slice(-200))}`,
      ).toBeGreaterThanOrEqual(1)
    }).toPass({ timeout: 6_000 })

    // Snapshot the occurrence count after the onFinal send.
    const countAfterFinal = await (async () => {
      const pane = await A.peek('mob-dictate', 80)
      return (stripped(pane).match(new RegExp(TOKEN, 'g')) ?? []).length
    })()
    expect(countAfterFinal, 'token present once after onFinal').toBeGreaterThanOrEqual(1)

    // (2) NOW fire onend. The dedupe cursor must prevent re-sending the same
    // already-finalized text — the count must NOT increase.
    await page.evaluate(() => window.__fakeSR.end())

    // Give any errant late flush a chance to (incorrectly) fire, then assert the
    // count is unchanged (no double-send).
    await page.waitForTimeout(800)
    const countAfterEnd = await (async () => {
      const pane = await A.peek('mob-dictate', 80)
      return (stripped(pane).match(new RegExp(TOKEN, 'g')) ?? []).length
    })()
    expect(
      countAfterEnd,
      `onend must NOT double-send (after-final=${countAfterFinal} after-end=${countAfterEnd})`,
    ).toBe(countAfterFinal)
  })
})

declare global {
  interface Window {
    __fakeSR: {
      instance: { onresult: ((e: unknown) => void) | null; onend: (() => void) | null } | null
      emit: (segments: { text: string; final: boolean }[]) => boolean
      end: () => void
    }
  }
}
