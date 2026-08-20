// /dev/kbd-probe — DEV-ONLY iOS keyboard DIAGNOSTIC readout.
//
// A self-contained (no app chrome), mobile-first, LIVE-updating page so the
// owner can read the real iOS-WebKit viewport / keyboard numbers off their
// iPhone and screenshot "keyboard closed" vs "keyboard open". It exists to
// device-verify the fix/ios-zoom-composer black-bar work — the exact figures
// that fix relies on (visualViewport geometry, the keyboardInset formula,
// env(safe-area-inset-bottom), and whether any ancestor breaks position:fixed
// via a transform/filter/etc. containing block).
//
// Registered behind `import.meta.env.DEV` in App.tsx and lazy-loaded, exactly
// like every other /dev/* route, so it never lands in a production bundle and
// the base app is byte-identical for real users.
//
// Everything here is inline / <style>-scoped and reads from `window` directly
// so the page stands alone with no dependency on the app shell, and adapts to
// both light and dark via prefers-color-scheme.

import * as React from 'react'

type Snapshot = {
  innerWidth: number
  innerHeight: number
  vvWidth: number | null
  vvHeight: number | null
  vvOffsetTop: number | null
  vvOffsetLeft: number | null
  vvScale: number | null
  keyboardInset: number | null
  safeAreaBottom: number
  barTop: number | null
  barBottom: number | null
  barPosition: string
  barTransform: string
  containingBlockAncestor: string | null
  standalone: boolean
  displayMode: string
  viewportMeta: string
}

function readSafeAreaBottom(probe: HTMLElement | null): number {
  if (!probe) return 0
  // The probe's padding-bottom is set to env(safe-area-inset-bottom) in CSS;
  // its computed pixel value is the resolved inset.
  const px = getComputedStyle(probe).paddingBottom
  const n = parseFloat(px)
  return Number.isFinite(n) ? n : 0
}

// Walk up from the test bar; report the first ancestor whose computed style
// establishes a containing block for position:fixed (transform / filter /
// perspective / will-change / contain other than `none`). On iOS that is what
// makes a `position:fixed` bar stop tracking the layout viewport.
function findContainingBlockAncestor(el: HTMLElement | null): string | null {
  let node = el?.parentElement ?? null
  while (node && node !== document.documentElement) {
    const cs = getComputedStyle(node)
    const breaks: string[] = []
    if (cs.transform && cs.transform !== 'none') breaks.push(`transform:${cs.transform}`)
    if (cs.filter && cs.filter !== 'none') breaks.push(`filter:${cs.filter}`)
    if (cs.perspective && cs.perspective !== 'none') breaks.push(`perspective:${cs.perspective}`)
    if (cs.willChange && cs.willChange !== 'auto' && cs.willChange !== 'none')
      breaks.push(`will-change:${cs.willChange}`)
    if (cs.contain && cs.contain !== 'none' && cs.contain !== 'normal')
      breaks.push(`contain:${cs.contain}`)
    if (breaks.length > 0) {
      const tag = node.tagName.toLowerCase()
      const cls =
        typeof node.className === 'string' && node.className.trim()
          ? '.' + node.className.trim().split(/\s+/).join('.')
          : ''
      return `<${tag}${cls}> — ${breaks.join(' ; ')}`
    }
    node = node.parentElement
  }
  return null
}

function readViewportMeta(): string {
  const meta = document.querySelector('meta[name="viewport"]') as HTMLMetaElement | null
  return meta?.content ?? '(none)'
}

function readDisplayMode(): string {
  const modes = ['standalone', 'fullscreen', 'minimal-ui', 'browser']
  for (const m of modes) {
    if (window.matchMedia(`(display-mode: ${m})`).matches) return m
  }
  return '(unknown)'
}

function collect(bar: HTMLElement | null, probe: HTMLElement | null): Snapshot {
  const vv = window.visualViewport ?? null
  const rect = bar?.getBoundingClientRect() ?? null
  const barCs = bar ? getComputedStyle(bar) : null
  const keyboardInset =
    vv != null
      ? window.innerHeight - vv.height - vv.offsetTop
      : null
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const standalone = (window.navigator as any).standalone === true
  return {
    innerWidth: window.innerWidth,
    innerHeight: window.innerHeight,
    vvWidth: vv ? vv.width : null,
    vvHeight: vv ? vv.height : null,
    vvOffsetTop: vv ? vv.offsetTop : null,
    vvOffsetLeft: vv ? vv.offsetLeft : null,
    vvScale: vv ? vv.scale : null,
    keyboardInset,
    safeAreaBottom: readSafeAreaBottom(probe),
    barTop: rect ? rect.top : null,
    barBottom: rect ? rect.bottom : null,
    barPosition: barCs ? barCs.position : '(n/a)',
    barTransform: barCs ? barCs.transform : '(n/a)',
    containingBlockAncestor: findContainingBlockAncestor(bar),
    standalone,
    displayMode: readDisplayMode(),
    viewportMeta: readViewportMeta(),
  }
}

function fmt(n: number | null, digits = 1): string {
  if (n == null) return '—'
  return Number.isInteger(n) ? String(n) : n.toFixed(digits)
}

function Row({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="kp-row">
      <div className="kp-label">
        {label}
        {hint ? <span className="kp-hint">{hint}</span> : null}
      </div>
      <div className="kp-value">{value}</div>
    </div>
  )
}

function Readout({ s }: { s: Snapshot }) {
  return (
    <>
      <Row label="window.innerWidth" value={fmt(s.innerWidth)} />
      <Row label="window.innerHeight" value={fmt(s.innerHeight)} />
      <Row label="visualViewport.width" value={fmt(s.vvWidth)} />
      <Row label="visualViewport.height" value={fmt(s.vvHeight)} />
      <Row label="visualViewport.offsetTop" value={fmt(s.vvOffsetTop)} />
      <Row label="visualViewport.offsetLeft" value={fmt(s.vvOffsetLeft)} />
      <Row label="visualViewport.scale" value={fmt(s.vvScale, 3)} />
      <Row
        label="keyboardInset"
        hint="innerHeight − vv.height − vv.offsetTop"
        value={fmt(s.keyboardInset)}
      />
      <Row
        label="env(safe-area-inset-bottom)"
        hint="computed px of a hidden probe"
        value={fmt(s.safeAreaBottom)}
      />
      <Row label="TEST COMPOSER rect.top" value={fmt(s.barTop)} />
      <Row label="TEST COMPOSER rect.bottom" value={fmt(s.barBottom)} />
      <Row label="TEST COMPOSER position" value={s.barPosition} />
      <Row label="TEST COMPOSER transform" value={s.barTransform} />
      <Row
        label="Fixed containing-block breaker"
        hint="first ancestor w/ transform/filter/perspective/will-change/contain ≠ none"
        value={s.containingBlockAncestor ?? 'none (fixed tracks viewport ✓)'}
      />
      <Row
        label="display mode"
        hint="navigator.standalone / display-mode"
        value={`${s.standalone ? 'PWA (standalone=true)' : 'browser'} · ${s.displayMode}`}
      />
      <Row label="viewport meta" value={s.viewportMeta} />
    </>
  )
}

export default function DevKbdProbe() {
  const barRef = React.useRef<HTMLDivElement | null>(null)
  const probeRef = React.useRef<HTMLDivElement | null>(null)
  const [live, setLive] = React.useState<Snapshot | null>(null)
  const [frozen, setFrozen] = React.useState<Snapshot | null>(null)

  React.useEffect(() => {
    let raf = 0
    const update = () => setLive(collect(barRef.current, probeRef.current))
    const loop = () => {
      update()
      raf = requestAnimationFrame(loop)
    }
    raf = requestAnimationFrame(loop)

    const onAny = () => update()
    window.addEventListener('resize', onAny)
    window.addEventListener('scroll', onAny, { passive: true })
    const vv = window.visualViewport
    vv?.addEventListener('resize', onAny)
    vv?.addEventListener('scroll', onAny)
    update()

    return () => {
      cancelAnimationFrame(raf)
      window.removeEventListener('resize', onAny)
      window.removeEventListener('scroll', onAny)
      vv?.removeEventListener('resize', onAny)
      vv?.removeEventListener('scroll', onAny)
    }
  }, [])

  const snapshot = () =>
    setFrozen(collect(barRef.current, probeRef.current))

  return (
    <div className="kp-root">
      <style>{KP_CSS}</style>

      {/* hidden safe-area probe: padding-bottom resolves env(safe-area-inset-bottom) */}
      <div ref={probeRef} className="kp-safe-probe" aria-hidden="true" />

      <header className="kp-head">
        <h1>iOS keyboard probe</h1>
        <p>
          Live iOS-WebKit viewport &amp; keyboard readout. Tap the field to raise
          the keyboard, then hit <strong>SNAPSHOT</strong> and screenshot closed
          vs open.
        </p>
      </header>

      <label className="kp-input-label" htmlFor="kp-raise">
        Tap here to open the keyboard
      </label>
      <textarea
        id="kp-raise"
        className="kp-input"
        rows={2}
        placeholder="Tap / type to raise the iOS keyboard…"
      />

      <button type="button" className="kp-snap" onClick={snapshot}>
        SNAPSHOT → freeze as “KEYBOARD OPEN”
      </button>

      <section className="kp-panel kp-live">
        <h2>LIVE {live ? '' : '(reading…)'}</h2>
        <div className="kp-grid">{live ? <Readout s={live} /> : null}</div>
      </section>

      {frozen ? (
        <section className="kp-panel kp-frozen">
          <h2>KEYBOARD OPEN (snapshot)</h2>
          <div className="kp-grid">
            <Readout s={frozen} />
          </div>
        </section>
      ) : (
        <p className="kp-note">
          No snapshot yet — raise the keyboard, then press SNAPSHOT to freeze a
          “KEYBOARD OPEN” block here for a side-by-side screenshot.
        </p>
      )}

      {/* The fixed test composer whose geometry the readout reports. */}
      <div ref={barRef} className="kp-testbar" data-kbd-testbar="">
        TEST COMPOSER
      </div>
    </div>
  )
}

const KP_CSS = `
:root {
  --kp-bg: #f4f5f7;
  --kp-fg: #101317;
  --kp-panel: #ffffff;
  --kp-border: #d3d7de;
  --kp-muted: #5b626d;
  --kp-accent: #1668e3;
  --kp-frozen: #0a7d38;
  --kp-value: #06203f;
  --kp-value-bg: #eaf1fb;
}
@media (prefers-color-scheme: dark) {
  :root {
    --kp-bg: #0c0e12;
    --kp-fg: #eef1f5;
    --kp-panel: #161a20;
    --kp-border: #2b313b;
    --kp-muted: #9aa2ad;
    --kp-accent: #5ea0ff;
    --kp-frozen: #4ade80;
    --kp-value: #dbe8ff;
    --kp-value-bg: #182536;
  }
}
.kp-root {
  box-sizing: border-box;
  min-height: 100dvh;
  width: 100%;
  margin: 0;
  padding: 16px 14px calc(120px + env(safe-area-inset-bottom));
  background: var(--kp-bg);
  color: var(--kp-fg);
  font-family: -apple-system, BlinkMacSystemFont, "SF Pro Text", system-ui, sans-serif;
  -webkit-text-size-adjust: 100%;
}
.kp-root * { box-sizing: border-box; }
.kp-safe-probe {
  position: absolute;
  visibility: hidden;
  pointer-events: none;
  height: 0;
  padding-bottom: env(safe-area-inset-bottom);
}
.kp-head h1 { font-size: 26px; font-weight: 800; margin: 0 0 6px; }
.kp-head p { font-size: 15px; line-height: 1.35; color: var(--kp-muted); margin: 0 0 16px; }
.kp-input-label {
  display: block;
  font-size: 15px;
  font-weight: 700;
  margin-bottom: 6px;
}
.kp-input {
  display: block;
  width: 100%;
  font-size: 18px;
  padding: 14px;
  border-radius: 12px;
  border: 2px solid var(--kp-accent);
  background: var(--kp-panel);
  color: var(--kp-fg);
  margin-bottom: 12px;
  resize: none;
}
.kp-snap {
  display: block;
  width: 100%;
  font-size: 17px;
  font-weight: 800;
  padding: 15px;
  border: none;
  border-radius: 12px;
  background: var(--kp-accent);
  color: #fff;
  margin-bottom: 18px;
  cursor: pointer;
}
.kp-snap:active { filter: brightness(0.92); }
.kp-panel {
  border: 1px solid var(--kp-border);
  border-radius: 14px;
  background: var(--kp-panel);
  padding: 12px 12px 6px;
  margin-bottom: 16px;
}
.kp-panel h2 { font-size: 18px; font-weight: 800; margin: 2px 2px 10px; }
.kp-frozen { border-color: var(--kp-frozen); }
.kp-frozen h2 { color: var(--kp-frozen); }
.kp-grid { display: flex; flex-direction: column; gap: 2px; }
.kp-row {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 10px;
  padding: 8px 4px;
  border-top: 1px solid var(--kp-border);
}
.kp-row:first-child { border-top: none; }
.kp-label {
  font-size: 14px;
  font-weight: 600;
  flex: 1 1 auto;
  min-width: 0;
}
.kp-hint {
  display: block;
  font-size: 11px;
  font-weight: 500;
  color: var(--kp-muted);
  margin-top: 2px;
  word-break: break-word;
}
.kp-value {
  flex: 0 0 auto;
  max-width: 55%;
  font-variant-numeric: tabular-nums;
  font-family: ui-monospace, "SF Mono", Menlo, monospace;
  font-size: 17px;
  font-weight: 800;
  color: var(--kp-value);
  background: var(--kp-value-bg);
  padding: 3px 8px;
  border-radius: 7px;
  text-align: right;
  word-break: break-word;
}
.kp-note { font-size: 14px; color: var(--kp-muted); margin: 0 4px 16px; }
.kp-testbar {
  position: fixed;
  left: 0;
  right: 0;
  bottom: 0;
  height: calc(60px + env(safe-area-inset-bottom));
  padding-bottom: env(safe-area-inset-bottom);
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 16px;
  font-weight: 800;
  letter-spacing: 0.04em;
  color: #fff;
  background: linear-gradient(180deg, #d1385f, #b3264c);
  border-top: 2px solid #ffffff55;
  z-index: 2147483000;
}
`
