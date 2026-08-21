// KBDEBUG OVERLAY — the on-device iOS-composer runtime probe (flag-gated).
//
// Rendered ONLY when `kbdebugFlagOn()` is true (see lib/kbdebug-flag.ts): the
// shell reads that flag ONCE at mount and lazy-imports this module, so for a
// normal user this file is never fetched, never mounted, and does no work — and
// it lives in its OWN code-split chunk, out of the entry/main bundle.
//
// The offline rig cannot render the real iOS soft keyboard, so the black-bar /
// composer-pinning behaviour is only observable on a real device. This overlay
// dumps everything needed to diagnose it into a fixed, high-contrast, monospace
// readout so a SINGLE on-device screenshot is self-explanatory:
//
//   · a LIVE block, re-measured on window/visualViewport resize + scroll
//     (coalesced through one rAF), and
//   · a SETTLED snapshot, re-measured on a rAF ~250ms AFTER the last
//     focus/resize — iOS reports a stale `visualViewport` mid-keyboard-animation,
//     so the settled read is the trustworthy one for a screenshot.
//
// READ-ONLY: it measures, it never mutates app state or the DOM under test. The
// only interactive affordance is a small close button. No app value is read
// through React — it queries the live DOM directly so it reflects exactly what
// the browser resolved, independent of the app's own hooks.

import * as React from 'react'

const COMPOSER_SELECTOR = '[data-testid="chat-composer"]'
const SETTLE_MS = 250

interface AncestorRow {
  tag: string
  cls: string
  position: string
  height: string
  bottom: string
  transform: string
  overflow: string
  contain: string
  /** True when this ancestor establishes a containing block for `fixed`
   *  (transform / perspective / filter / backdrop-filter / will-change /
   *  contain: layout|paint|strict|content). */
  cbFixed: boolean
  /** True when this ancestor establishes a containing block for `absolute`
   *  (position !== static, OR any fixed-CB trigger). */
  cbAbs: boolean
}

interface ComposerSnap {
  found: boolean
  position: string
  bottom: string
  top: string
  height: string
  transform: string
  rectTop: number
  rectBottom: number
  rectHeight: number
  chain: AncestorRow[]
}

interface Snap {
  t: string
  innerHeight: number
  innerWidth: number
  vvHeight: number | null
  vvWidth: number | null
  vvOffsetTop: number | null
  vvOffsetLeft: number | null
  vvScale: number | null
  varVvh: string
  varVvOffsetTop: string
  varKb: string
  varKbSafeBottom: string
  safeAreaBottomPx: string
  standalone: boolean
  viewportMeta: string
  composer: ComposerSnap
}

/** Does `cs` establish a containing block for `position: fixed` descendants?
 *  (Also implies one for `absolute`.) Mirrors the CSS spec triggers. */
function establishesFixedCB(cs: CSSStyleDeclaration): boolean {
  if (cs.transform && cs.transform !== 'none') return true
  if (cs.perspective && cs.perspective !== 'none') return true
  if (cs.filter && cs.filter !== 'none') return true
  const bf =
    cs.backdropFilter || (cs as unknown as { webkitBackdropFilter?: string }).webkitBackdropFilter
  if (bf && bf !== 'none') return true
  const wc = cs.willChange || ''
  if (/transform|perspective|filter/.test(wc)) return true
  const contain = cs.contain || ''
  if (/\b(layout|paint|strict|content)\b/.test(contain)) return true
  return false
}

function shortClass(el: Element): string {
  const c = (el.getAttribute('class') || '').trim()
  if (!c) return '—'
  return c.length > 48 ? c.slice(0, 45) + '…' : c
}

function measure(): Snap {
  const de = document.documentElement
  const rootCS = getComputedStyle(de)
  const vv = window.visualViewport ?? null

  // env(safe-area-inset-bottom) is not readable directly — probe it via a hidden
  // element whose padding-bottom resolves the env() to a concrete px, then read
  // the computed value back. Created and torn down inline so nothing lingers.
  let safeAreaBottomPx = 'n/a'
  try {
    const probe = document.createElement('div')
    probe.style.cssText =
      'position:fixed;left:-9999px;top:-9999px;width:0;height:0;padding-bottom:env(safe-area-inset-bottom);visibility:hidden;pointer-events:none'
    document.body.appendChild(probe)
    safeAreaBottomPx = getComputedStyle(probe).paddingBottom || '0px'
    document.body.removeChild(probe)
  } catch {
    safeAreaBottomPx = 'err'
  }

  const meta = document.querySelector('meta[name="viewport"]')
  const viewportMeta = meta?.getAttribute('content') || '(none)'
  const standalone =
    (navigator as unknown as { standalone?: boolean }).standalone === true ||
    window.matchMedia?.('(display-mode: standalone)').matches === true

  // The composer + its ancestor chain up to <body>.
  const composer: ComposerSnap = {
    found: false,
    position: '',
    bottom: '',
    top: '',
    height: '',
    transform: '',
    rectTop: 0,
    rectBottom: 0,
    rectHeight: 0,
    chain: [],
  }
  const el = document.querySelector(COMPOSER_SELECTOR) as HTMLElement | null
  if (el) {
    composer.found = true
    const cs = getComputedStyle(el)
    const r = el.getBoundingClientRect()
    composer.position = cs.position
    composer.bottom = cs.bottom
    composer.top = cs.top
    composer.height = cs.height
    composer.transform = cs.transform
    composer.rectTop = Math.round(r.top)
    composer.rectBottom = Math.round(r.bottom)
    composer.rectHeight = Math.round(r.height)
    let node: Element | null = el.parentElement
    while (node && node !== document.body.parentElement) {
      const acs = getComputedStyle(node)
      const cbFixed = establishesFixedCB(acs)
      const cbAbs = cbFixed || acs.position !== 'static'
      composer.chain.push({
        tag: node.tagName.toLowerCase(),
        cls: shortClass(node),
        position: acs.position,
        height: acs.height,
        bottom: acs.bottom,
        transform: acs.transform === 'none' ? 'none' : acs.transform,
        overflow: `${acs.overflowX}/${acs.overflowY}`,
        contain: acs.contain || 'none',
        cbFixed,
        cbAbs,
      })
      if (node === document.body) break
      node = node.parentElement
    }
  }

  return {
    t: new Date().toISOString().slice(11, 23),
    innerHeight: window.innerHeight,
    innerWidth: window.innerWidth,
    vvHeight: vv ? Math.round(vv.height * 100) / 100 : null,
    vvWidth: vv ? Math.round(vv.width * 100) / 100 : null,
    vvOffsetTop: vv ? Math.round(vv.offsetTop * 100) / 100 : null,
    vvOffsetLeft: vv ? Math.round(vv.offsetLeft * 100) / 100 : null,
    vvScale: vv ? Math.round(vv.scale * 1000) / 1000 : null,
    varVvh: rootCS.getPropertyValue('--vvh').trim() || '(unset)',
    varVvOffsetTop: rootCS.getPropertyValue('--vv-offset-top').trim() || '(unset)',
    varKb: rootCS.getPropertyValue('--kb').trim() || '(unset)',
    varKbSafeBottom: rootCS.getPropertyValue('--kb-safe-bottom').trim() || '(unset)',
    safeAreaBottomPx,
    standalone,
    viewportMeta,
    composer,
  }
}

function Row({ k, v }: { k: string; v: React.ReactNode }) {
  return (
    <div style={{ display: 'flex', gap: 8, lineHeight: 1.45 }}>
      <span style={{ color: '#7fd4ff', flex: '0 0 13ch' }}>{k}</span>
      <span style={{ color: '#eafff2', wordBreak: 'break-all' }}>{v}</span>
    </div>
  )
}

function ChainTable({ chain }: { chain: AncestorRow[] }) {
  // Flag the FIRST ancestor that establishes a containing block for fixed (or,
  // failing that, for absolute) — that is the element the composer's
  // `position:fixed/absolute` actually pins to.
  const firstFixedIdx = chain.findIndex((r) => r.cbFixed)
  const firstAbsIdx = chain.findIndex((r) => r.cbAbs)
  return (
    <div style={{ marginTop: 4 }}>
      {chain.map((r, i) => {
        const isFirstFixedCB = i === firstFixedIdx
        const isFirstAbsCB = i === firstAbsIdx && firstFixedIdx !== i
        return (
          <div
            key={i}
            style={{
              borderTop: '1px solid #2a3a44',
              padding: '3px 0',
              color: isFirstFixedCB ? '#ffd166' : '#cfe8ff',
            }}
          >
            <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
              <span style={{ color: '#8affc1' }}>
                {i}·&lt;{r.tag}&gt;
              </span>
              <span style={{ color: '#9fb4c2' }}>.{r.cls}</span>
              {isFirstFixedCB && (
                <span style={{ color: '#ffd166', fontWeight: 700 }}>
                  ◀ CB for FIXED (composer pins here)
                </span>
              )}
              {isFirstAbsCB && (
                <span style={{ color: '#ffb3c1', fontWeight: 700 }}>◀ CB for ABSOLUTE</span>
              )}
            </div>
            <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', color: '#bcd' }}>
              <span>pos:{r.position}</span>
              <span>h:{r.height}</span>
              <span>bottom:{r.bottom}</span>
              <span>tf:{r.transform === 'none' ? 'none' : 'yes'}</span>
              <span>of:{r.overflow}</span>
              <span>contain:{r.contain}</span>
            </div>
          </div>
        )
      })}
    </div>
  )
}

function ComposerBlock({ c }: { c: ComposerSnap }) {
  if (!c.found) {
    return (
      <div style={{ color: '#ff6b6b' }}>composer: {COMPOSER_SELECTOR} NOT FOUND</div>
    )
  }
  return (
    <div>
      <Row k="composer pos" v={c.position} />
      <Row k="  top/bottom" v={`${c.top} / ${c.bottom}`} />
      <Row k="  height" v={c.height} />
      <Row k="  transform" v={c.transform === 'none' ? 'none' : c.transform} />
      <Row k="  rect T/B/H" v={`${c.rectTop} / ${c.rectBottom} / ${c.rectHeight}`} />
      <div style={{ color: '#7fd4ff', marginTop: 4 }}>ancestor chain → body:</div>
      <ChainTable chain={c.chain} />
    </div>
  )
}

function SnapView({ s }: { s: Snap }) {
  return (
    <div>
      <Row k="inner W×H" v={`${s.innerWidth} × ${s.innerHeight}`} />
      <Row
        k="vv W×H"
        v={s.vvWidth === null ? 'no visualViewport' : `${s.vvWidth} × ${s.vvHeight}`}
      />
      <Row
        k="vv off T/L"
        v={s.vvOffsetTop === null ? '—' : `${s.vvOffsetTop} / ${s.vvOffsetLeft}`}
      />
      <Row k="vv scale" v={s.vvScale === null ? '—' : String(s.vvScale)} />
      <Row k="--vvh" v={s.varVvh} />
      <Row k="--vv-offset-top" v={s.varVvOffsetTop} />
      <Row k="--kb" v={s.varKb} />
      <Row k="--kb-safe-bottom" v={s.varKbSafeBottom} />
      <Row k="env safe-bottom" v={s.safeAreaBottomPx} />
      <Row k="display" v={s.standalone ? 'PWA standalone' : 'browser'} />
      <Row k="viewport meta" v={s.viewportMeta} />
      <div style={{ borderTop: '1px solid #2a3a44', margin: '6px 0' }} />
      <ComposerBlock c={s.composer} />
    </div>
  )
}

export default function KbDebugOverlay() {
  const [live, setLive] = React.useState<Snap>(() => measure())
  const [settled, setSettled] = React.useState<Snap>(() => measure())
  const [closed, setClosed] = React.useState(false)

  React.useEffect(() => {
    if (closed) return
    let raf = 0
    let settleRaf = 0
    let settleTimer: ReturnType<typeof setTimeout> | undefined

    const scheduleLive = () => {
      if (raf) return
      raf = window.requestAnimationFrame(() => {
        raf = 0
        setLive(measure())
      })
    }
    // Re-measure the SETTLED snapshot on a rAF ~250ms after the LAST focus/resize
    // — iOS reports a stale visualViewport mid-keyboard-animation, so we wait for
    // the animation to finish before freezing the trustworthy read.
    const scheduleSettle = () => {
      if (settleTimer) clearTimeout(settleTimer)
      settleTimer = setTimeout(() => {
        if (settleRaf) cancelAnimationFrame(settleRaf)
        settleRaf = window.requestAnimationFrame(() => {
          settleRaf = 0
          setSettled(measure())
        })
      }, SETTLE_MS)
    }

    const onAny = () => {
      scheduleLive()
      scheduleSettle()
    }

    const vv = window.visualViewport
    vv?.addEventListener('resize', onAny)
    vv?.addEventListener('scroll', onAny)
    window.addEventListener('resize', onAny)
    document.addEventListener('focusin', onAny)
    document.addEventListener('focusout', onAny)
    // Prime a settled read shortly after mount too.
    scheduleSettle()

    return () => {
      if (raf) cancelAnimationFrame(raf)
      if (settleRaf) cancelAnimationFrame(settleRaf)
      if (settleTimer) clearTimeout(settleTimer)
      vv?.removeEventListener('resize', onAny)
      vv?.removeEventListener('scroll', onAny)
      window.removeEventListener('resize', onAny)
      document.removeEventListener('focusin', onAny)
      document.removeEventListener('focusout', onAny)
    }
  }, [closed])

  if (closed) return null

  return (
    <div
      data-testid="kbdebug-overlay"
      style={{
        position: 'fixed',
        left: 0,
        right: 0,
        bottom: 0,
        maxHeight: '85vh',
        zIndex: 2147483647,
        overflow: 'auto',
        WebkitOverflowScrolling: 'touch',
        background: 'rgba(3, 10, 14, 0.94)',
        color: '#eafff2',
        font: '11px/1.4 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
        padding: '8px 10px 14px',
        borderTop: '2px solid #37e0a0',
        boxShadow: '0 -8px 24px rgba(0,0,0,0.6)',
        pointerEvents: 'auto',
      }}
    >
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          position: 'sticky',
          top: 0,
        }}
      >
        <span style={{ color: '#37e0a0', fontWeight: 700, fontSize: 13 }}>
          KBDEBUG · live {live.t}
        </span>
        <button
          type="button"
          onClick={() => setClosed(true)}
          style={{
            color: '#03212a',
            background: '#37e0a0',
            border: 'none',
            borderRadius: 4,
            padding: '2px 10px',
            fontWeight: 700,
            cursor: 'pointer',
          }}
        >
          ✕
        </button>
      </div>

      <div style={{ marginTop: 6 }}>
        <div style={{ color: '#37e0a0', fontWeight: 700 }}>▶ LIVE</div>
        <SnapView s={live} />
      </div>

      <div
        style={{
          marginTop: 10,
          paddingTop: 6,
          borderTop: '2px dashed #ffd166',
        }}
      >
        <div style={{ color: '#ffd166', fontWeight: 700 }}>
          ▣ SETTLED @ +{SETTLE_MS}ms after last focus/resize · {settled.t}
        </div>
        <SnapView s={settled} />
      </div>
    </div>
  )
}
