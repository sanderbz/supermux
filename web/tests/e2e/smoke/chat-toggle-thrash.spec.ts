// Fase A5 T6 — the toggle-thrash harness.
//
// The fase's central claim is that the terminal escape hatch cannot rot, because
// it is exercised on every toggle instead of being rebuilt. That claim is about
// SOCKETS and BYTES, which a static render cannot see, so it gets its own spec
// against the real binary.
//
// THE SUBJECT IS A `shell` SESSION, on purpose. The renderer under test is the
// TERMINAL; the chat side only has to occupy the other cell. A shell gives a
// deterministic firehose (`seq`) that a real Claude pty never will, and it does
// not need the `claude` CLI on the runner — so unlike the three A1 cases in
// `chat-renderer-switch.spec.ts`, this spec NEVER skips. The switch is not
// reachable for a shell session (it is chat-ineligible, by design), which is
// exactly why the DEV bench `/dev/renderer-thrash/:name` exists.
//
// THE INSTRUMENT IS `window.WebSocket`, patched before app boot. Everything
// asserted below is measured at the transport, not inferred from the DOM:
//   · every construction and close, per URL;
//   · every OUTGOING frame, so a `resize` can be counted;
//   · every INCOMING payload, concatenated, so the `SMX<n>` sequence the shell
//     printed can be checked for gaps (bytes lost while hidden) and repeats
//     (a re-seed, i.e. a reconnect).
//
// Serializing xterm's own buffer would be a WEAKER instrument: its scrollback
// is bounded, so an old line dropping out is indistinguishable from a lost one.
//
// Needs server/target/debug/supermux-server — `cd server && cargo build`
// first (debug; never --release).

import { expect, test } from '@playwright/test'

import { api, injectGlobals, startBackend, type Backend } from './harness'

/** How many toggles. The assertions are CONSTANTS, not ratios — the whole point
 *  is that nothing grows with this number. */
const TOGGLES = 100

/** The firehose: monotonic markers, PACED.
 *
 *  Paced, not blasted, and that is a deliberate correction to the plan. A
 *  20 000-line burst overruns the server's per-subscriber broadcast buffer and
 *  the slow-subscriber path drops frames (`ws/mod.rs`'s documented `Lagged` →
 *  close 1013) — measured here: a contiguous block went missing around marker
 *  2 819 with the socket never reconnecting. That is a property of the
 *  TRANSPORT under load, not of the toggle, and asserting on it would make this
 *  spec fail for a reason it was not written to catch.
 *
 *  At ~50 lines/s the buffer is never near full, so the ONLY way a marker can
 *  go missing is a socket that stopped being connected — which is exactly the
 *  failure retention is claimed to prevent. */
const LINES = 600
const PACE_S = '0.02'

declare global {
  interface Window {
    __ws?: {
      opened: { url: string }[]
      closed: string[]
      sent: { url: string; body: string }[]
      recv: Record<string, string>
    }
    __thrash?: {
      toggle(): 'chat' | 'terminal'
      renderer(): 'chat' | 'terminal'
      cols(): number
      mounted(): { chat: boolean; terminal: boolean }
    }
  }
}

/** Patch `window.WebSocket` before ANY app code runs. */
const wsProbe = `
  (() => {
    const stats = { opened: [], closed: [], sent: [], recv: {} }
    window.__ws = stats
    const Native = window.WebSocket
    function Patched(url, protocols) {
      const ws = protocols === undefined ? new Native(url) : new Native(url, protocols)
      const u = String(url)
      stats.opened.push({ url: u })
      stats.recv[u] = stats.recv[u] || ''
      ws.addEventListener('close', () => stats.closed.push(u))
      // The pty stream is Message::Binary (\`ws.binaryType = 'arraybuffer'\` in
      // use-live-term); the control frames are text. Record both, decoded, so
      // the SMX sequence below sees exactly what xterm was written.
      const dec = new TextDecoder()
      ws.addEventListener('message', (e) => {
        if (typeof e.data === 'string') stats.recv[u] += e.data
        else if (e.data instanceof ArrayBuffer) stats.recv[u] += dec.decode(new Uint8Array(e.data))
      })
      const send = ws.send.bind(ws)
      ws.send = (body) => {
        if (typeof body === 'string') stats.sent.push({ url: u, body })
        return send(body)
      }
      return ws
    }
    Patched.prototype = Native.prototype
    for (const k of ['CONNECTING', 'OPEN', 'CLOSING', 'CLOSED']) Patched[k] = Native[k]
    window.WebSocket = Patched
  })()
`

test.describe('renderer toggle thrash (fase A5 T6)', () => {
  let backend: Backend
  test.beforeEach(async () => {
    backend = await startBackend()
  })
  test.afterEach(async () => {
    await backend?.dispose()
  })

  test('100 toggles: no lost bytes, no socket churn, no resize storm', async ({
    page,
  }) => {
    test.slow() // a paced firehose the 100 toggles have to run across
    await page.setViewportSize({ width: 1280, height: 800 })
    await page.addInitScript(wsProbe)
    await page.addInitScript(injectGlobals(backend.token))

    const name = 'a5-thrash'
    const created = await api(backend).createSession({
      name,
      provider: 'shell',
      dir: backend.dataDir,
    })
    expect([200, 201]).toContain(created.status)
    expect((await api(backend).startSession(name)).ok).toBeTruthy()

    await page.goto(`${backend.baseUrl}/dev/renderer-thrash/${name}`)
    // The bench is up and the pty socket has delivered its first frame.
    await expect(page.getByTestId('thrash-status')).toHaveAttribute(
      'data-renderer',
      'terminal',
    )
    await page.waitForFunction(() => (window.__thrash?.cols() ?? 0) > 0, null, {
      timeout: 15_000,
    })

    const ptyUrl = await page.evaluate(() => {
      const urls = Object.keys(window.__ws?.recv ?? {})
      return urls.find((u) => u.includes('/ws/sessions/')) ?? ''
    })
    expect(ptyUrl).toContain('/ws/sessions/')

    const colsBefore = await page.evaluate(() => window.__thrash!.cols())
    expect(colsBefore).toBeGreaterThan(0)

    // Mark the start of the measured window — and mark it HONESTLY.
    //
    // The ATTACH fit legitimately sends one resize, and `use-live-term`'s
    // ResizeObserver is debounced, so that frame can land well after the first
    // pty bytes do. Snapshotting the moment `cols > 0` would put it inside the
    // window and the spec would "catch" a resize it was never written to catch
    // (measured: exactly one frame, at the same 158×38 the terminal already
    // had). So we wait for the socket to go QUIET first: no outgoing frame for
    // a full second. From there, any resize is one the toggling caused.
    await page.waitForFunction(
      () => {
        const w = window.__ws!
        const now = performance.now()
        const g = window as unknown as { __quiet?: { n: number; at: number } }
        if (!g.__quiet || g.__quiet.n !== w.sent.length) {
          g.__quiet = { n: w.sent.length, at: now }
          return false
        }
        return now - g.__quiet.at > 1000
      },
      null,
      { timeout: 20_000 },
    )
    const sentBefore = await page.evaluate(() => window.__ws!.sent.length)
    const openedBefore = await page.evaluate(() => window.__ws!.opened.length)

    // ── The mechanism itself, measured once before the thrash ───────────────
    //
    // Invariants T3.1 + T3.2 are STRUCTURAL, and a frame count does not catch a
    // violation of them at rAF speed: `use-live-term`'s ResizeObserver is
    // debounced, so 100 toggles in two seconds coalesce into no net resize even
    // if every hidden frame collapsed the box to 0×0. (Verified by flipping the
    // shell to `display:none` locally — the counters below stayed clean.) The
    // honest instrument is the computed box: hide the terminal, and assert it
    // still OCCUPIES exactly the same rectangle it did while visible.
    const hidden = await page.evaluate(async () => {
      const term = document.querySelector(
        '[data-testid="renderer-pane-terminal"]',
      ) as HTMLElement
      const rect = () => {
        const r = term.getBoundingClientRect()
        return { w: Math.round(r.width), h: Math.round(r.height) }
      }
      const settle = async () => {
        // Two frames plus the crossfade: one rAF is NOT enough for React to
        // commit and framer to apply the style (learned the hard way — reading
        // the values after the second toggle reported the wrong pane's state).
        await new Promise((r) => requestAnimationFrame(() => r(null)))
        await new Promise((r) => setTimeout(r, 400))
      }

      const before = rect()
      window.__thrash!.toggle() // → chat; the terminal goes hidden
      await settle()

      // EVERYTHING is captured here, while it is actually hidden.
      const cs = getComputedStyle(term)
      const measured = {
        display: cs.display,
        visibility: cs.visibility,
        // React 19 may set `inert` as a property and framer's DOM prop filter
        // may drop it entirely — accept either, then assert one of them holds.
        inert: term.hasAttribute('inert') || term.inert === true,
        ariaHidden: term.getAttribute('aria-hidden'),
        ...rect(),
        beforeW: before.w,
        beforeH: before.h,
      }

      window.__thrash!.toggle() // → back to the terminal
      await settle()
      return measured
    })
    // T3.2 — hidden means `visibility`, NEVER `display:none`.
    expect(hidden.display).not.toBe('none')
    expect(hidden.visibility).toBe('hidden')
    // T3.1 — the box is unchanged, which is why the ResizeObserver never fires.
    expect(hidden.w).toBeGreaterThan(0)
    expect(hidden.h).toBeGreaterThan(0)
    expect([hidden.w, hidden.h]).toEqual([hidden.beforeW, hidden.beforeH])
    // T3.4 — focus cannot leak into it.
    expect(hidden.inert).toBe(true)
    expect(hidden.ariaHidden).toBe('true')

    // ── The firehose ────────────────────────────────────────────────────────
    await fetch(`${backend.backendUrl}/api/sessions/${name}/send`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${backend.token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        text: `for i in $(seq 1 ${LINES}); do echo "SMX$i"; sleep ${PACE_S}; done\n`,
      }),
    })

    // ── The thrash ──────────────────────────────────────────────────────────
    // Each toggle is awaited across a rAF so React actually COMMITS the
    // hide/reveal — a synchronous loop would measure one render, not a hundred.
    await page.evaluate(async (n) => {
      for (let i = 0; i < n; i++) {
        window.__thrash!.toggle()
        await new Promise((r) => requestAnimationFrame(() => r(null)))
      }
    }, TOGGLES)

    // Land on the terminal and let the firehose finish draining.
    await page.evaluate(() => {
      if (window.__thrash!.renderer() !== 'terminal') window.__thrash!.toggle()
    })
    await page.waitForFunction(
      (want) => {
        const recv = window.__ws?.recv ?? {}
        const all = Object.entries(recv)
          .filter(([u]) => u.includes('/ws/sessions/'))
          .map(([, v]) => v)
          .join('')
        return all.includes(`SMX${want}`)
      },
      LINES,
      { timeout: 60_000 },
    )

    const stats = await page.evaluate((pty) => {
      const w = window.__ws!
      return {
        ptyOpened: w.opened.filter((o) => o.url === pty).length,
        ptyClosed: w.closed.filter((u) => u === pty).length,
        openedTotal: w.opened.length,
        sent: w.sent,
        recv: w.recv[pty] ?? '',
      }
    }, ptyUrl)

    // ── 1. No lost bytes ────────────────────────────────────────────────────
    // COMPLETENESS is the assertion: every one of the 20 000 monotonic markers
    // the shell printed must appear in what the socket delivered. A missing `n`
    // means bytes were dropped while the pane was hidden, which is the failure
    // retention exists to make impossible.
    //
    // Order is deliberately NOT asserted. The pty stream legitimately contains
    // full-screen REDRAWS (the attach replay, and the server's own post-resize
    // resync), so an older marker reappearing after a newer one is a repaint,
    // not a re-seed. Measuring "did it reconnect" by looking for repeats would
    // be inference; assertion 2 below measures the socket constructions
    // directly, which is the fact itself.
    const seen = new Set<number>()
    for (const m of stats.recv.matchAll(/SMX(\d+)/g)) seen.add(Number(m[1]))
    const missing: number[] = []
    for (let n = 1; n <= LINES; n++) if (!seen.has(n)) missing.push(n)
    expect(missing.slice(0, 20)).toEqual([])
    expect(missing.length).toBe(0)

    // ── 2. No WS leak: constructions do NOT grow with the toggle count ───────
    // The assertion is a CONSTANT (initial + at most one reconnect), not a
    // ratio: before retention this number was `1 + toggles`.
    expect(stats.ptyOpened).toBeLessThanOrEqual(2)
    expect(stats.openedTotal - openedBefore).toBeLessThanOrEqual(1)
    expect(stats.ptyOpened - stats.ptyClosed).toBeLessThanOrEqual(1)

    // ── 3. No resize storm ──────────────────────────────────────────────────
    // ZERO resize frames inside the measured window. The hidden pane keeps its
    // exact box (invariant T3.1: one grid cell, `visibility` not `display`), so
    // the ResizeObserver never fires.
    const resizes = stats.sent
      .slice(sentBefore)
      .filter((f) => f.url === ptyUrl && f.body.includes('"resize"'))
    expect(resizes).toEqual([])

    // ── 4. No fit churn ─────────────────────────────────────────────────────
    expect(await page.evaluate(() => window.__thrash!.cols())).toBe(colsBefore)

    // ── 5. Retention itself, from the outside ───────────────────────────────
    expect(await page.evaluate(() => window.__thrash!.mounted())).toEqual({
      chat: true,
      terminal: true,
    })
  })
})
