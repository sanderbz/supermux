// KBDEBUG OVERLAY — the on-device iOS-composer runtime probe (flag-gated).
//
// Rendered ONLY when `kbdebugFlagOn()` is true (see lib/kbdebug-flag.ts): the
// shell reads that flag ONCE at mount and lazy-imports this module, so for a
// normal user this file is never fetched, never mounted, and does no work — and
// it lives in its OWN code-split chunk, out of the entry/main bundle.
//
// The offline rig cannot render the real iOS soft keyboard, so the black-bar /
// composer-pinning behaviour is only observable on a real device. The whole
// point of this overlay is to be usable DURING a real session — the owner has
// to open a real chat, tap the composer, raise the soft keyboard and READ the
// numbers while the keyboard is up. So the overlay is NOT a full-screen panel:
//
//   · a SMALL, DRAGGABLE, NON-BLOCKING floating chip pinned to a corner shows a
//     COMPACT live summary — the "band" px (composer.rectBottom − vvHeight)
//     prominently, plus vvh / --kb-safe-bottom / env / display in tiny text.
//   · the root wrapper is pointer-events:none EXCEPT the chip/panel, so the
//     app, the composer, the keyboard and navigation underneath stay fully
//     interactive. There is NO backdrop.
//   · TAP the chip to expand the FULL readout (LIVE + SETTLED dump) in a
//     compact, scrollable, still-non-blocking card; × collapses back to the
//     chip. Collapsed by default.
//   · DRAG the chip to reposition it so it never permanently occludes the
//     composer; its position is persisted in localStorage.
//
// The readout still carries the two measurement modes it always had:
//   · a LIVE block, re-measured on window/visualViewport resize + scroll
//     (coalesced through one rAF), and
//   · a SETTLED snapshot, re-measured on a rAF ~250ms AFTER the last
//     focus/resize — iOS reports a stale `visualViewport` mid-keyboard-animation,
//     so the settled read is the trustworthy one for a screenshot.
//
// READ-ONLY: it measures, it never mutates app state or the DOM under test. No
// app value is read through React — it queries the live DOM directly so it
// reflects exactly what the browser resolved, independent of the app's hooks.

import * as React from 'react'

// The composer probe tries these in order and reports the FIRST that matches,
// so the band is measured against the real bottom edge of whatever composer the
// open surface actually mounts:
//   1. the phone/desktop chat composer bar,
//   2. the focus mobile bottom panel (the pill bar when chat is folded),
//   3. the chat composer's own contenteditable/textarea field,
//   4. the focus edit-sheet composer textarea (the raise-to-edit sheet).
// On a surface with no composer (e.g. settings) none match and the chip shows
// `composer —` instead of a scary red NOT FOUND.
const COMPOSER_SELECTORS = [
  '[data-testid="chat-composer"]',
  '[data-vr="mobile-bottom-panel"]',
  '[data-testid="chat-composer-field"]',
  '[data-vr="edit-sheet-textarea"]',
] as const

const SETTLE_MS = 250
const POS_KEY = 'kbdebug-pos'
const DRAG_SLOP = 6 // px of movement before a press becomes a drag (not a tap)

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
  /** Which selector matched (empty when none did). */
  selector: string
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
  /** The headline number: composer.rectBottom − visualViewport.height, rounded.
   *  How far the composer's bottom edge sits BELOW the visual viewport (the gap
   *  the keyboard leaves). null when there is no composer or no visualViewport. */
  band: number | null
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

/** Resolve the first composer selector that matches, in priority order. */
function findComposer(): { el: HTMLElement | null; selector: string } {
  for (const sel of COMPOSER_SELECTORS) {
    const el = document.querySelector(sel) as HTMLElement | null
    if (el) return { el, selector: sel }
  }
  return { el: null, selector: '' }
}

function measure(): Snap {
  const de = document.documentElement
  const rootCS = getComputedStyle(de)
  const vv = window.visualViewport ?? null
  const vvHeight = vv ? Math.round(vv.height * 100) / 100 : null

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
    selector: '',
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
  const { el, selector } = findComposer()
  if (el) {
    composer.found = true
    composer.selector = selector
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

  const band =
    composer.found && vvHeight !== null ? Math.round(composer.rectBottom - vvHeight) : null

  return {
    t: new Date().toISOString().slice(11, 23),
    innerHeight: window.innerHeight,
    innerWidth: window.innerWidth,
    vvHeight,
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
    band,
  }
}

// ── server sink: POST the keyboard-OPEN snapshot ──────────────────────────
//
// The chip is `position: fixed` and scrolls out of view the instant the iOS
// soft keyboard opens, so an on-device SCREENSHOT can never capture the
// keyboard-OPEN geometry — which is exactly the state whose numbers we need to
// know why the black band persists on the owner's real device. So on the
// keyboard-open transition (and again once it settles) the overlay POSTs a
// compact snapshot to `/api/_internal/kbdebug`, a best-effort server sink that
// appends it to a log the owner can read. This is the ONLY thing that reaches
// the network, still only when the flag is on (the overlay is otherwise never
// mounted), and every error is swallowed.

const SINK_URL = '/api/_internal/kbdebug'
/** innerHeight − visualViewport.height beyond which we call the keyboard OPEN. */
const KB_OPEN_THRESHOLD = 150

interface FocusSheetComputed {
  position: string
  height: string
  transform: string
  bottom: string
  top: string
}

/** The flat wire snapshot POSTed to the sink — the fields the owner needs to
 *  diagnose the keyboard band on the real device. Distinct from the rich in-UI
 *  `Snap`: flatter, stable field names, safe to append as one JSON line. */
interface PostSnap {
  ts: string
  innerHeight: number
  visualViewportHeight: number | null
  visualViewportOffsetTop: number | null
  safeBottom: string
  kbSafeBottom: string
  vvh: string
  kb: string
  display: string
  composerSel: string
  composerPaddingBottom: string | null
  composerRectBottom: number | null
  focusSheetRectBottom: number | null
  focusSheetRectHeight: number | null
  focusSheetComputed: FocusSheetComputed | null
  /** round(composerRectBottom − visualViewport.height) — the black-band px. */
  bandPx: number | null
}

/** The focus-mode raise-to-edit sheet surface (the pinned sheet whose bottom
 *  edge the keyboard is supposed to hug). Null on any other surface. */
function findFocusSheet(): HTMLElement | null {
  return document.querySelector('[data-vr="edit-sheet-surface"]') as HTMLElement | null
}

/** Gather the flat wire snapshot straight off the live DOM. */
function buildPostSnap(): PostSnap {
  const de = document.documentElement
  const rootCS = getComputedStyle(de)
  const vv = window.visualViewport ?? null
  const vvHeight = vv ? Math.round(vv.height * 100) / 100 : null

  const { el, selector } = findComposer()
  let composerPaddingBottom: string | null = null
  let composerRectBottom: number | null = null
  if (el) {
    composerPaddingBottom = getComputedStyle(el).paddingBottom
    composerRectBottom = Math.round(el.getBoundingClientRect().bottom)
  }

  const sheet = findFocusSheet()
  let focusSheetRectBottom: number | null = null
  let focusSheetRectHeight: number | null = null
  let focusSheetComputed: FocusSheetComputed | null = null
  if (sheet) {
    const r = sheet.getBoundingClientRect()
    focusSheetRectBottom = Math.round(r.bottom)
    focusSheetRectHeight = Math.round(r.height)
    const cs = getComputedStyle(sheet)
    focusSheetComputed = {
      position: cs.position,
      height: cs.height,
      transform: cs.transform === 'none' ? 'none' : cs.transform,
      bottom: cs.bottom,
      top: cs.top,
    }
  }

  const standalone =
    (navigator as unknown as { standalone?: boolean }).standalone === true ||
    window.matchMedia?.('(display-mode: standalone)').matches === true

  const bandPx =
    composerRectBottom !== null && vvHeight !== null
      ? Math.round(composerRectBottom - vvHeight)
      : null

  return {
    ts: new Date().toISOString(),
    innerHeight: window.innerHeight,
    visualViewportHeight: vvHeight,
    visualViewportOffsetTop: vv ? Math.round(vv.offsetTop * 100) / 100 : null,
    safeBottom: rootCS.getPropertyValue('--safe-bottom').trim(),
    kbSafeBottom: rootCS.getPropertyValue('--kb-safe-bottom').trim(),
    vvh: rootCS.getPropertyValue('--vvh').trim(),
    kb: rootCS.getPropertyValue('--kb').trim(),
    display: standalone ? 'standalone' : 'browser',
    composerSel: selector,
    composerPaddingBottom,
    composerRectBottom,
    focusSheetRectBottom,
    focusSheetRectHeight,
    focusSheetComputed,
    bandPx,
  }
}

/** Fire-and-forget POST to the sink with the app's bearer token. Best-effort:
 *  any error (no token, offline, blocked) is swallowed. */
function postSnapshot(snap: PostSnap): void {
  try {
    const token = (window as { _SUPERMUX_AUTH_TOKEN?: string })._SUPERMUX_AUTH_TOKEN
    void fetch(SINK_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify(snap),
      keepalive: true,
    }).catch(() => {
      /* best-effort — network errors are irrelevant to a debug probe */
    })
  } catch {
    /* JSON/stringify/global access blew up — ignore */
  }
}

/** Is the soft keyboard currently OPEN? True when the visual viewport is
 *  materially shorter than the layout viewport. */
function keyboardOpen(): boolean {
  const vv = window.visualViewport
  if (!vv) return false
  return window.innerHeight - vv.height > KB_OPEN_THRESHOLD
}

// ── small helpers ─────────────────────────────────────────────────────────

/** The env safe-area px, stripped to a short number for the chip. */
function shortPx(v: string): string {
  const m = /([\d.]+)/.exec(v)
  return m ? String(Math.round(parseFloat(m[1]))) : v
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
    return <div style={{ color: '#9fb4c2' }}>composer: — (no composer on this surface)</div>
  }
  return (
    <div>
      <Row k="composer sel" v={<span style={{ color: '#8affc1' }}>{c.selector}</span>} />
      <Row k="  pos" v={c.position} />
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
      <Row
        k="band px"
        v={
          s.band === null ? (
            '—'
          ) : (
            <span style={{ color: '#ffd166', fontWeight: 700 }}>{s.band}</span>
          )
        }
      />
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

// ── position persistence ────────────────────────────────────────────────────

interface Pos {
  x: number
  y: number
}

function clampPos(p: Pos, chipW: number, chipH: number): Pos {
  const maxX = Math.max(0, window.innerWidth - chipW)
  const maxY = Math.max(0, window.innerHeight - chipH)
  return { x: Math.min(Math.max(0, p.x), maxX), y: Math.min(Math.max(0, p.y), maxY) }
}

/** Default corner: top-right, tucked under the safe-area top inset. */
function defaultPos(): Pos {
  return { x: Math.max(8, window.innerWidth - 148), y: 10 }
}

function loadPos(): Pos | null {
  try {
    const raw = window.localStorage.getItem(POS_KEY)
    if (!raw) return null
    const p = JSON.parse(raw) as Pos
    if (typeof p?.x === 'number' && typeof p?.y === 'number') return p
  } catch {
    // ignore malformed / blocked storage
  }
  return null
}

function savePos(p: Pos) {
  try {
    window.localStorage.setItem(POS_KEY, JSON.stringify(p))
  } catch {
    // storage blocked — position simply won't persist
  }
}

// ── the overlay ─────────────────────────────────────────────────────────────

export default function KbDebugOverlay() {
  const [live, setLive] = React.useState<Snap>(() => measure())
  const [settled, setSettled] = React.useState<Snap>(() => measure())
  const [closed, setClosed] = React.useState(false)
  const [expanded, setExpanded] = React.useState(false)
  const [pos, setPos] = React.useState<Pos>(() => loadPos() ?? defaultPos())

  const chipRef = React.useRef<HTMLDivElement>(null)
  // Tracks the keyboard-open edge so we POST the sink snapshot exactly on the
  // false→open transition (plus one settled follow-up), never on every frame.
  const wasKbOpenRef = React.useRef(false)
  // Drag bookkeeping — lives in a ref so pointermove doesn't re-render per frame.
  const drag = React.useRef<{
    active: boolean
    moved: boolean
    startX: number
    startY: number
    baseX: number
    baseY: number
  } | null>(null)

  // ── measurement wiring (unchanged behaviour) ──────────────────────────────
  React.useEffect(() => {
    if (closed) return
    let raf = 0
    let settleRaf = 0
    let settleTimer: ReturnType<typeof setTimeout> | undefined
    // A separate timer for the settled sink POST (~250ms after the keyboard-open
    // edge), so the owner also gets the trustworthy post-animation numbers.
    let sinkSettleTimer: ReturnType<typeof setTimeout> | undefined

    // On the false→open transition: POST the live snapshot immediately, then one
    // more ~250ms later once iOS has finished the keyboard animation. Two POSTs
    // per keyboard-open, never a per-frame flood.
    const maybePostOnOpen = () => {
      const nowOpen = keyboardOpen()
      if (nowOpen && !wasKbOpenRef.current) {
        wasKbOpenRef.current = true
        postSnapshot(buildPostSnap())
        if (sinkSettleTimer) clearTimeout(sinkSettleTimer)
        sinkSettleTimer = setTimeout(() => postSnapshot(buildPostSnap()), SETTLE_MS)
      } else if (!nowOpen && wasKbOpenRef.current) {
        wasKbOpenRef.current = false
      }
    }

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
      maybePostOnOpen()
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
      if (sinkSettleTimer) clearTimeout(sinkSettleTimer)
      vv?.removeEventListener('resize', onAny)
      vv?.removeEventListener('scroll', onAny)
      window.removeEventListener('resize', onAny)
      document.removeEventListener('focusin', onAny)
      document.removeEventListener('focusout', onAny)
    }
  }, [closed])

  // Keep the chip on-screen when the viewport changes (rotation / keyboard).
  React.useEffect(() => {
    if (closed) return
    const onResize = () => {
      const el = chipRef.current
      const w = el?.offsetWidth ?? 140
      const h = el?.offsetHeight ?? 30
      setPos((p) => clampPos(p, w, h))
    }
    window.addEventListener('resize', onResize)
    window.visualViewport?.addEventListener('resize', onResize)
    return () => {
      window.removeEventListener('resize', onResize)
      window.visualViewport?.removeEventListener('resize', onResize)
    }
  }, [closed])

  // ── drag / tap on the chip ────────────────────────────────────────────────
  const onPointerDown = (e: React.PointerEvent) => {
    // Ignore the close button etc. (they stopPropagation), primary button only.
    if (e.button !== 0 && e.pointerType === 'mouse') return
    const el = chipRef.current
    drag.current = {
      active: true,
      moved: false,
      startX: e.clientX,
      startY: e.clientY,
      baseX: pos.x,
      baseY: pos.y,
    }
    el?.setPointerCapture?.(e.pointerId)
  }

  const onPointerMove = (e: React.PointerEvent) => {
    const d = drag.current
    if (!d?.active) return
    const dx = e.clientX - d.startX
    const dy = e.clientY - d.startY
    if (!d.moved && Math.hypot(dx, dy) < DRAG_SLOP) return
    d.moved = true
    const el = chipRef.current
    const w = el?.offsetWidth ?? 140
    const h = el?.offsetHeight ?? 30
    setPos(clampPos({ x: d.baseX + dx, y: d.baseY + dy }, w, h))
  }

  const onPointerUp = (e: React.PointerEvent) => {
    const d = drag.current
    drag.current = null
    chipRef.current?.releasePointerCapture?.(e.pointerId)
    if (!d) return
    if (d.moved) {
      // A drag — persist the new position, do NOT toggle.
      setPos((p) => {
        savePos(p)
        return p
      })
    } else {
      // A tap — toggle the expanded readout.
      setExpanded((v) => !v)
    }
  }

  if (closed) return null

  const band = live.band
  const bandColor = band === null ? '#9fb4c2' : band > 0 ? '#ffd166' : '#8affc1'

  return (
    // Full-viewport wrapper that lets ALL taps pass through (pointer-events:none)
    // — only the chip and the expanded card opt back in. No backdrop: the app,
    // the composer, the keyboard and navigation underneath stay fully live.
    <div
      data-testid="kbdebug-overlay"
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 2147483647,
        pointerEvents: 'none',
      }}
    >
      {/* THE CHIP — small, one line tall, draggable, non-blocking. */}
      <div
        ref={chipRef}
        data-testid="kbdebug-chip"
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
        style={{
          position: 'absolute',
          left: pos.x,
          // Never let the collapsed chip hide behind the status bar / dynamic
          // island: floor its top at the safe-area inset (+ a small margin).
          // `max()` keeps drags below that floor honoured while clamping any
          // position that would tuck it under the clock.
          top: `max(${pos.y}px, calc(env(safe-area-inset-top) + 6px))`,
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          maxWidth: '70vw',
          padding: '4px 9px',
          borderRadius: 999,
          background: 'rgba(3, 10, 14, 0.9)',
          color: '#eafff2',
          border: '1px solid #37e0a0',
          boxShadow: '0 2px 10px rgba(0,0,0,0.5)',
          font: '11px/1.2 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
          pointerEvents: 'auto',
          touchAction: 'none',
          cursor: 'grab',
          userSelect: 'none',
          WebkitUserSelect: 'none',
        }}
      >
        <span style={{ color: '#37e0a0', fontWeight: 700, letterSpacing: 0.3 }}>KB</span>
        <span
          style={{
            color: bandColor,
            fontWeight: 700,
            fontSize: 14,
            fontVariantNumeric: 'tabular-nums',
            minWidth: '3ch',
            textAlign: 'right',
          }}
        >
          {band === null ? '—' : band}
        </span>
        <span
          style={{
            display: 'flex',
            flexDirection: 'column',
            lineHeight: 1.15,
            color: '#9fb4c2',
            fontSize: 9,
          }}
        >
          <span>
            vvh {live.vvHeight ?? '—'} · kb {shortPx(live.varKbSafeBottom)}
          </span>
          <span>
            env {shortPx(live.safeAreaBottomPx)} · {live.standalone ? 'pwa' : 'web'} ·{' '}
            {live.composer.found ? 'cmp✓' : 'cmp—'}
          </span>
        </span>
        <span
          aria-hidden
          style={{ color: '#37e0a0', fontSize: 10, opacity: 0.8, marginLeft: 2 }}
        >
          {expanded ? '×' : '▸'}
        </span>
      </div>

      {/* THE EXPANDED CARD — compact, scrollable, still non-blocking. */}
      {expanded && (
        <div
          data-testid="kbdebug-panel"
          style={{
            position: 'absolute',
            left: 8,
            right: 8,
            top: Math.min(pos.y + 40, window.innerHeight * 0.4),
            marginLeft: 'auto',
            marginRight: 'auto',
            maxWidth: 360,
            maxHeight: '55vh',
            overflow: 'auto',
            WebkitOverflowScrolling: 'touch',
            background: 'rgba(3, 10, 14, 0.96)',
            color: '#eafff2',
            border: '1px solid #37e0a0',
            borderRadius: 12,
            boxShadow: '0 8px 28px rgba(0,0,0,0.65)',
            font: '11px/1.4 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
            padding: '8px 10px 12px',
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
              background: 'rgba(3, 10, 14, 0.96)',
              paddingBottom: 4,
            }}
          >
            <span style={{ color: '#37e0a0', fontWeight: 700, fontSize: 12 }}>
              KBDEBUG · live {live.t}
            </span>
            <button
              type="button"
              data-testid="kbdebug-collapse"
              onPointerDown={(e) => e.stopPropagation()}
              onClick={() => setExpanded(false)}
              style={{
                color: '#03212a',
                background: '#37e0a0',
                border: 'none',
                borderRadius: 6,
                padding: '2px 10px',
                fontWeight: 700,
                cursor: 'pointer',
              }}
            >
              ✕
            </button>
          </div>

          <div style={{ marginTop: 4 }}>
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

          <div style={{ marginTop: 10, textAlign: 'right' }}>
            <button
              type="button"
              onPointerDown={(e) => e.stopPropagation()}
              onClick={() => setClosed(true)}
              style={{
                color: '#9fb4c2',
                background: 'transparent',
                border: '1px solid #2a3a44',
                borderRadius: 6,
                padding: '2px 10px',
                cursor: 'pointer',
              }}
            >
              hide overlay
            </button>
          </div>
        </div>
      )}
    </div>
  )
}
