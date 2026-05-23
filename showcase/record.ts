/**
 * record.ts — drive the supermux dashboard through a 9-beat storyboard and
 * capture it as one continuous video (via Playwright's contextOptions.recordVideo).
 *
 * Storyboard (target ~45s, slow enough to be readable):
 *   1. Hook                  3s
 *   2. Hover-peek            5s
 *   3. Type-on-hover         4s
 *   4. Open + return         8s
 *   5. Attention-grabber     3s
 *   6. Cmd+K                 4s
 *   7. Size tier & sort      6s
 *   8. Mobile reveal         8s
 *   9. Outro                 3s
 *
 * The server is expected to be running at SUPERMUX_HOST (default 127.0.0.1:8833)
 * with the auth token at /tmp/sm-showcase-data/auth_token. Run `seed.ts` first
 * to populate the 8 demo sessions.
 *
 * Output: showcase/out/recording-<n>.webm (Chromium writes one per context).
 */

import { readFileSync, existsSync, mkdirSync, rmSync, readdirSync, renameSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { chromium, type Page } from 'playwright'

const HOST = process.env.SUPERMUX_HOST ?? 'http://127.0.0.1:8833'
const TOKEN =
  process.env.SUPERMUX_TOKEN ??
  readFileSync('/tmp/sm-showcase-data/auth_token', 'utf8').trim()

const OUT_DIR = join(import.meta.dir, 'out')
const VIDEO_DIR = join(OUT_DIR, 'video-tmp')

// Geometry — desktop hero is 1440×900, mobile reveal is 390×844 (iPhone 15-ish).
const DESKTOP = { width: 1440, height: 900 }
const MOBILE = { width: 390, height: 844 }

const SLOWMO_MS = 60 // small per-action delay; bigger pauses go in waitForTimeout

async function pause(page: Page, ms: number): Promise<void> {
  await page.waitForTimeout(ms)
}

/** Find the tile element for a session by its accessible name (the title text). */
function tileLocator(page: Page, name: string) {
  // Tile title text lives in the <span class="line-clamp-1 …"> child of the role="button"
  // ancestor. We match by exact session name with a partial title match.
  return page.locator('div[role="button"]', { hasText: name }).first()
}

/** The hero overlay is injected on the page so the final outro fades to the brand. */
async function injectOutroOverlay(page: Page): Promise<void> {
  await page.evaluate(() => {
    const id = 'sm-outro-overlay'
    if (document.getElementById(id)) return
    const el = document.createElement('div')
    el.id = id
    el.style.cssText = [
      'position:fixed',
      'inset:0',
      'z-index:99999',
      'display:flex',
      'flex-direction:column',
      'align-items:center',
      'justify-content:center',
      'gap:18px',
      'background:radial-gradient(ellipse at center, rgba(8,10,14,0.78), rgba(8,10,14,0.96))',
      'backdrop-filter:blur(18px)',
      '-webkit-backdrop-filter:blur(18px)',
      'opacity:0',
      'transition:opacity 520ms cubic-bezier(.2,.7,.2,1)',
      'font-family:ui-sans-serif,system-ui,-apple-system,"SF Pro Text",Segoe UI,Roboto,Inter,sans-serif',
      'color:#f3f4f7',
    ].join(';')
    el.innerHTML = `
      <div style="font-size:64px;font-weight:700;letter-spacing:-0.025em;line-height:1">supermux</div>
      <div style="font-size:20px;color:#a3a8b3;font-weight:400;max-width:680px;text-align:center;line-height:1.35">
        Self-hosted parallel AI coding sessions — overview, peek, focus, mobile.
      </div>
      <div style="margin-top:6px;font-size:13px;color:#7f8593;font-family:ui-monospace,SFMono-Regular,Menlo,Monaco,Consolas,monospace;padding:8px 14px;border:1px solid rgba(255,255,255,0.08);border-radius:999px;background:rgba(255,255,255,0.03)">
        github.com/sanderbz/supermux
      </div>
    `
    document.body.appendChild(el)
    requestAnimationFrame(() => {
      el.style.opacity = '1'
    })
  })
}

/** A tiny on-screen caption tag, top-center, that subtly labels each beat. Optional
 *  — adds context without overwhelming. Auto-dismisses after `ms`. */
async function caption(page: Page, text: string, ms: number = 2400): Promise<void> {
  await page.evaluate(
    ({ text, ms }) => {
      const id = 'sm-caption'
      let el = document.getElementById(id) as HTMLDivElement | null
      if (!el) {
        el = document.createElement('div')
        el.id = id
        el.style.cssText = [
          'position:fixed',
          'top:18px',
          'left:50%',
          'transform:translateX(-50%) translateY(-8px)',
          'z-index:99998',
          'padding:7px 14px',
          'background:rgba(15,18,24,0.78)',
          'color:#e7e9ee',
          'font-family:ui-sans-serif,system-ui,-apple-system,sans-serif',
          'font-size:13px',
          'font-weight:500',
          'letter-spacing:0.005em',
          'border:1px solid rgba(255,255,255,0.08)',
          'border-radius:999px',
          'backdrop-filter:blur(12px)',
          '-webkit-backdrop-filter:blur(12px)',
          'opacity:0',
          'transition:opacity 220ms ease, transform 220ms cubic-bezier(.2,.7,.2,1)',
          'pointer-events:none',
          'box-shadow:0 6px 28px -10px rgba(0,0,0,0.45)',
        ].join(';')
        document.body.appendChild(el)
      }
      el.textContent = text
      // animate-in
      requestAnimationFrame(() => {
        el!.style.opacity = '1'
        el!.style.transform = 'translateX(-50%) translateY(0)'
      })
      window.clearTimeout((el as any).__t)
      ;(el as any).__t = window.setTimeout(() => {
        el!.style.opacity = '0'
        el!.style.transform = 'translateX(-50%) translateY(-8px)'
      }, ms)
    },
    { text, ms },
  )
}

/** Inject a CSS override that slightly slows the pulsing dots so the eye catches them. */
async function injectPulseSlowdown(page: Page): Promise<void> {
  await page.addStyleTag({
    content: `
      /* slow the status pulse a touch so the camera can follow it */
      [class*="animate-pulse"] { animation-duration: 1.6s !important; }
      /* also slow the waiting ping so it's more deliberate */
      [class*="animate-ping"] { animation-duration: 1.8s !important; }
    `,
  })
}

async function main() {
  // Clean output dir.
  if (existsSync(OUT_DIR)) rmSync(OUT_DIR, { recursive: true, force: true })
  mkdirSync(VIDEO_DIR, { recursive: true })

  console.log(`launching chromium → ${HOST}`)
  const browser = await chromium.launch({
    headless: true,
    args: ['--disable-blink-features=AutomationControlled'],
  })

  const context = await browser.newContext({
    viewport: DESKTOP,
    deviceScaleFactor: 2,
    colorScheme: 'dark',
    reducedMotion: 'no-preference',
    recordVideo: {
      dir: VIDEO_DIR,
      size: DESKTOP, // start at desktop; we resize mid-recording
    },
  })

  context.setDefaultTimeout(10_000)
  const page = await context.newPage()
  page.setDefaultTimeout(10_000)

  // Suppress the onboarding "welcome back" banner — it intercepts pointer events
  // and steals the eye in the wrong direction. Setting the first-launch flag
  // BEFORE any React renders means OnboardingHost sees "returning user" and stays
  // quiet for the whole recording.
  await context.addInitScript(() => {
    try {
      window.localStorage.setItem('supermux-first-launch', String(Date.now()))
    } catch {}
  })

  // Hide the cursor's noise — Playwright doesn't draw a cursor; we'll inject one
  // that follows page.mouse so the storyboard reads as "a person clicking". This
  // keeps the visual narrative clear without faking input.
  await page.addInitScript(() => {
    window.addEventListener('DOMContentLoaded', () => {
      const id = 'sm-fake-cursor'
      const c = document.createElement('div')
      c.id = id
      c.style.cssText = [
        'position:fixed',
        'top:0',
        'left:0',
        'width:18px',
        'height:18px',
        'pointer-events:none',
        'z-index:99997',
        'transform:translate(-9px,-9px) scale(1)',
        'transition:transform 80ms ease',
      ].join(';')
      c.innerHTML = `
        <svg viewBox="0 0 24 24" width="22" height="22" xmlns="http://www.w3.org/2000/svg">
          <path d="M5 3 L19 13 L12 14 L17 21 L14 22 L9 15 L5 19 Z"
            fill="#fff" stroke="rgba(0,0,0,0.85)" stroke-width="1.2" stroke-linejoin="round"/>
        </svg>`
      document.body.appendChild(c)
      window.addEventListener('mousemove', (e) => {
        c.style.left = e.clientX + 'px'
        c.style.top = e.clientY + 'px'
      })
      window.addEventListener('mousedown', () => {
        c.style.transform = 'translate(-9px,-9px) scale(0.85)'
      })
      window.addEventListener('mouseup', () => {
        c.style.transform = 'translate(-9px,-9px) scale(1)'
      })
    })
  })

  // ── Navigate ────────────────────────────────────────────────────────────────
  const url = `${HOST}/?_token=${encodeURIComponent(TOKEN)}`
  await page.goto(url, { waitUntil: 'domcontentloaded' })
  // The auth token comes via the injected `window._SUPERMUX_AUTH_TOKEN`. The
  // _token query is just a fallback for the public router; the SPA itself
  // reads window. Either way, the api calls now work.
  await page.waitForSelector('div[role="button"]', { timeout: 10_000 })
  await injectPulseSlowdown(page)
  await pause(page, 500)

  // ────────────────────────────────────────────────────────────────────────────
  // BEAT 1 — Hook (3s). Land on the overview, let live tiles paint.
  // ────────────────────────────────────────────────────────────────────────────
  console.log('beat 1 — hook')
  await caption(page, 'supermux — every tmux session at a glance', 2400)
  await page.mouse.move(720, 450, { steps: 25 })
  await pause(page, 2800)

  // ────────────────────────────────────────────────────────────────────────────
  // BEAT 2 — Hover-peek (5s). Hover over the "tile-polish" tile (active spinner).
  // ────────────────────────────────────────────────────────────────────────────
  console.log('beat 2 — hover peek')
  await caption(page, 'Hover any tile — it zooms in, live.', 2800)
  const tilePolish = tileLocator(page, 'tile-polish')
  const tpBox = await tilePolish.boundingBox()
  if (!tpBox) throw new Error('tile-polish not found')
  // Glide the cursor across, then over the tile.
  await page.mouse.move(tpBox.x + tpBox.width / 2, tpBox.y + tpBox.height / 2, { steps: 28 })
  await tilePolish.hover()
  await pause(page, 4400)

  // ────────────────────────────────────────────────────────────────────────────
  // BEAT 3 — Type-on-hover (4s). While the peek is open, type a message — it
  // lands in the real session via the WS.
  // ────────────────────────────────────────────────────────────────────────────
  console.log('beat 3 — type on hover')
  await caption(page, 'Type while hovering — it lands in the real session.', 3000)
  // type-on-hover uses document-level keydown when the peek is live (see usePeekType)
  // — so a sequence of page.keyboard.press calls reaches the pty.
  for (const ch of 'echo "hi from the showcase"') {
    await page.keyboard.type(ch, { delay: 55 })
  }
  await pause(page, 700)
  await page.keyboard.press('Enter')
  await pause(page, 1800)
  // Move cursor away — let the peek collapse before the next beat.
  await page.mouse.move(60, 60, { steps: 18 })
  await pause(page, 800)

  // ────────────────────────────────────────────────────────────────────────────
  // BEAT 4 — Open + return (8s). Click a tile → View-Transitions zoom into
  // focus mode. Stay a beat. Press Esc → smooth zoom back.
  // ────────────────────────────────────────────────────────────────────────────
  console.log('beat 4 — focus zoom')
  await caption(page, 'Click → smooth zoom into focus mode.', 2800)
  const target = tileLocator(page, 'sse-stream')
  const tbox = await target.boundingBox()
  if (!tbox) throw new Error('sse-stream not found')
  await page.mouse.move(tbox.x + tbox.width / 2, tbox.y + tbox.height / 2, { steps: 24 })
  await pause(page, 350)
  await target.click()
  // Wait for the focus route to mount. The header has session name text.
  await page.waitForURL(/\/focus\//, { timeout: 6_000 })
  await pause(page, 3000)
  // Return to overview. Focus mode captures every keystroke (Ctrl-C, Tab, Esc,
  // …) so Esc goes to the pty — we click the explicit "Back to overview" chip.
  // That fires the same View-Transitions exit animation we want to showcase.
  await caption(page, 'Click back — smooth zoom, in reverse.', 2200)
  const back = page.getByRole('button', { name: 'Back to overview' })
  if (await back.count()) {
    await back.first().click()
  } else {
    await page.goBack()
  }
  await page
    .waitForURL((u) => !u.pathname.startsWith('/focus/'), { timeout: 6_000 })
    .catch(() => {})
  await pause(page, 1800)

  // ────────────────────────────────────────────────────────────────────────────
  // BEAT 5 — Attention-grabber (3s). The "fix-flake" tile pulses (waiting).
  // ────────────────────────────────────────────────────────────────────────────
  console.log('beat 5 — needs input pulse')
  await caption(page, 'Sessions that need you pulse for attention.', 2600)
  const waiting = tileLocator(page, 'fix-flake')
  const wbox = await waiting.boundingBox()
  if (wbox) {
    await page.mouse.move(wbox.x + wbox.width / 2, wbox.y + wbox.height / 2, { steps: 26 })
  }
  await pause(page, 2400)

  // ────────────────────────────────────────────────────────────────────────────
  // BEAT 6 — Cmd+K (4s). Open palette, type to filter, Esc.
  // ────────────────────────────────────────────────────────────────────────────
  console.log('beat 6 — cmd+k')
  await caption(page, '⌘K — jump anywhere.', 2600)
  // Move cursor off the waiting tile so opening palette doesn't trap focus on it.
  await page.mouse.move(60, 60, { steps: 12 })
  await pause(page, 200)
  await page.keyboard.press('Meta+K')
  await pause(page, 700)
  for (const ch of 'auth') {
    await page.keyboard.type(ch, { delay: 95 })
  }
  await pause(page, 1500)
  await page.keyboard.press('Escape')
  await pause(page, 700)

  // ────────────────────────────────────────────────────────────────────────────
  // BEAT 7 — Density tier + sort (6s). +/− on the density buttons; switch sort.
  // ────────────────────────────────────────────────────────────────────────────
  console.log('beat 7 — density + sort')
  await caption(page, 'Density and sort — your overview, your way.', 3000)
  // Click "Larger" twice → tier up.
  const larger = page.getByRole('button', { name: 'Larger' })
  const smaller = page.getByRole('button', { name: 'Smaller' })
  if (await larger.count()) {
    await larger.first().hover()
    await pause(page, 350)
    await larger.first().click()
    await pause(page, 700)
    await larger.first().click()
    await pause(page, 900)
  }
  // Then bring it back down once for symmetry.
  if (await smaller.count()) {
    await smaller.first().click()
    await pause(page, 900)
  }
  // Open sort dropdown.
  const sortBtn = page.getByRole('button', { name: /^Sort: / })
  if (await sortBtn.count()) {
    await sortBtn.first().hover()
    await pause(page, 300)
    await sortBtn.first().click()
    await pause(page, 700)
    const azItem = page.getByRole('menuitem', { name: /A–Z|Alphabetical/i })
    if (await azItem.count()) {
      await azItem.first().click()
      await pause(page, 1100)
    }
  }

  // ────────────────────────────────────────────────────────────────────────────
  // BEAT 8 — Mobile preview embedded INSIDE the desktop canvas.
  //
  // Chromium's recordVideo size is fixed at context-create, so we cannot resize
  // the canvas mid-recording. Instead of resizing the viewport (which letterboxes
  // the page in the leftmost 390px column and leaves browser-chrome grey on the
  // right), we keep the desktop viewport, render a phone-bezel SVG centered in
  // the canvas, and use a fixed-position <iframe> inside the page that points
  // at a mobile-emulated URL. The iframe carries its own viewport, the body
  // re-renders responsively, and the bezel surrounds it — all inside the same
  // 1440×900 frame the rest of the recording uses.
  // ────────────────────────────────────────────────────────────────────────────
  console.log('beat 8 — mobile reveal')
  await caption(page, 'Same dashboard, mobile-first.', 2200)
  // KEEP the desktop viewport — the iframe carries its own 390×844 dimensions,
  // which is enough for the React app inside to see a mobile size and render
  // its mobile layout. Resizing the outer viewport would collapse the canvas
  // into the left 390px and break the bezel overlay.

  // 1. Dim everything BUT the bezel + tagline (a soft brand backdrop).
  // 2. Mount an <iframe> sized to a real phone viewport (390×844), pointed at
  //    `/` with the same auth token, inside a CSS phone-bezel.
  // 3. Tagline + sub copy live to the right of the bezel.
  // The iframe is a real navigation — the React app boots inside it at 390px
  // wide, so all responsive layout, the bottom tab bar, the FAB, etc. all
  // render as they would on a phone.
  const tokenForIframe = TOKEN
  await page.evaluate((tok) => {
    const id = 'sm-mobile-stage'
    if (document.getElementById(id)) return
    const stage = document.createElement('div')
    stage.id = id
    stage.style.cssText = [
      'position:fixed',
      'inset:0',
      'z-index:99996',
      'display:flex',
      'align-items:center',
      'justify-content:center',
      'gap:56px',
      'background:radial-gradient(ellipse at top, #161922 0%, #0a0c11 60%, #06080c 100%)',
      'font-family:ui-sans-serif,system-ui,-apple-system,"SF Pro Text",sans-serif',
      'color:#e7e9ee',
    ].join(';')
    stage.innerHTML = `
      <div style="
        position:relative;
        width:414px;
        height:868px;
        border-radius:48px;
        border:2px solid rgba(255,255,255,0.10);
        box-shadow:0 32px 100px -20px rgba(0,0,0,0.65), inset 0 0 0 4px rgba(0,0,0,0.85);
        overflow:hidden;
        background:#000;
      ">
        <div style="
          position:absolute;top:14px;left:50%;transform:translateX(-50%);
          width:118px;height:24px;background:rgba(0,0,0,0.95);border-radius:14px;z-index:2;
        "></div>
        <iframe
          id="sm-mobile-frame"
          src="/?_token=${encodeURIComponent(tok)}"
          style="
            position:absolute;inset:0;width:100%;height:100%;border:0;
            background:transparent;
          ">
        </iframe>
      </div>
      <div style="max-width:380px;line-height:1.4">
        <div style="font-size:38px;font-weight:700;letter-spacing:-0.022em;line-height:1.05;margin-bottom:16px">Same dashboard, on your phone.</div>
        <div style="font-size:16px;color:#a3a8b3;font-weight:400">Bottom sheet detents, kbd accessory bar, drag-to-reorder — the whole desktop UI, mobile-first.</div>
      </div>
    `
    document.body.appendChild(stage)
  }, tokenForIframe)

  // Let the iframe paint (it loads the same SPA, just rendered at 390×844).
  await pause(page, 3500)

  // Tap a tile inside the iframe via JS — the iframe runs the real app so this
  // is a true navigation that triggers the focus route (which on a coarse
  // pointer mounts the bottom-sheet). We pick whichever tile is currently
  // first to keep the script stable across reseeds.
  await page.evaluate(() => {
    const iframe = document.getElementById('sm-mobile-frame') as HTMLIFrameElement | null
    const doc = iframe?.contentDocument
    if (!doc) return
    const tile = doc.querySelector('div[role="button"]') as HTMLElement | null
    tile?.click()
  })
  await pause(page, 3200)

  // Tear down so the outro is clean.
  await page.evaluate(() => {
    const stage = document.getElementById('sm-mobile-stage')
    if (stage) stage.remove()
  })

  // ────────────────────────────────────────────────────────────────────────────
  // BEAT 9 — Outro (3s). Brand overlay fades in.
  // ────────────────────────────────────────────────────────────────────────────
  console.log('beat 9 — outro')
  await page.setViewportSize(DESKTOP)
  await pause(page, 900)
  await injectOutroOverlay(page)
  await pause(page, 3200)

  // ── Finalize recording ──────────────────────────────────────────────────────
  console.log('finalizing recording…')
  await context.close()
  await browser.close()

  // Move the recording out of the tmp folder to a stable name.
  const files = readdirSync(VIDEO_DIR).filter((f) => f.endsWith('.webm'))
  if (!files.length) throw new Error('no recording was produced')
  // Take the biggest webm (the page's recording, vs any blank popups).
  files.sort(
    (a, b) =>
      statSync(join(VIDEO_DIR, b)).size - statSync(join(VIDEO_DIR, a)).size,
  )
  const src = join(VIDEO_DIR, files[0])
  const dst = join(OUT_DIR, 'recording.webm')
  renameSync(src, dst)
  console.log(`recording: ${dst}`)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
