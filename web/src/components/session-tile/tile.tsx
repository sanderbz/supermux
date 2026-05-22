import * as React from 'react'
import { AnimatePresence, motion, useReducedMotion } from 'framer-motion'
import { GitBranch } from 'lucide-react'

import { springs, eases } from '@/lib/springs'
import { MISC } from '@/brand/copy'
import { useMediaQuery } from '@/hooks/use-media-query'
import { useLongPress } from '@/hooks/use-long-press'
import { usePeekType, PEEK_STICKY_MS } from '@/hooks/use-peek-type'
import { usePeekPrewarm } from '@/hooks/use-peek-prewarm'
import type { UseLiveTermResult } from '@/hooks/use-live-term'
import { useUI } from '@/stores/ui-store'
import {
  useNavigateMorph,
  vtSessionName,
  supportsViewTransitions,
} from '@/components/view-transitions/morph'
import { StatusDot, STATUS_LABEL } from './status-dot'
import { TailPreview } from './tail-preview'
import { TileLiveTerminal } from './tile-live-terminal'
import { TileError } from './tile-error'
import { QuickPeekModal } from './quick-peek-modal'
import type { TileSession } from './types'

// Idle geometry (px) — must match the header + 6-line tail so the grid slot
// reserves exactly the idle height. The card is absolutely positioned inside
// that slot, so its hover-growth overflows downward over the next row WITHOUT
// reflowing the grid (Codex #8: container-only morph, not canvas).
const HEADER_H = 12 + 32 + 16 + 4 // pt-3 + title row + meta row + mt-1
const TAIL_LINE_H = 14
const TAIL_PAD = 8
const IDLE_LINES = 6
// Hover ceilings. `live` mode shows a fixed-height zoomed terminal; `expanded`
// mode grows the static tail to ~20 lines (vs the 6 idle lines).
const EXPANDED_LINES = 20
const LIVE_PREVIEW_H = 230 // px — the scaled live-terminal viewport
const IDLE_H = HEADER_H + IDLE_LINES * TAIL_LINE_H + TAIL_PAD // 156

function formatTokens(n: number): string {
  if (n < 1000) return `${n}`
  if (n < 1_000_000) return `${(n / 1000).toFixed(n < 10_000 ? 1 : 0)}k`
  return `${(n / 1_000_000).toFixed(1)}m`
}

/** Animated status border overlay (§4.3). Active = amber pulse 1.6s, Waiting =
 *  blue pulse 2.2s, Error = static calm orange. Reduce Motion → static
 *  full-opacity border (no pulse). Lives on its own inset overlay so it never
 *  competes with the card's hover-scale transform. */
function StatusBorder({
  status,
  reduce,
}: {
  status: TileSession['status']
  reduce: boolean | null
}) {
  let token: string | null = null
  let duration = 1.6
  if (status === 'active' || status === 'starting') token = '--status-active'
  else if (status === 'waiting') {
    token = '--status-waiting'
    duration = 2.2
  } else if (status === 'error') token = '--status-error'

  if (!token) return null

  const isStatic = reduce || status === 'error'
  return (
    <motion.span
      aria-hidden
      className="pointer-events-none absolute inset-0 z-10 rounded-xl"
      animate={
        isStatic
          ? { boxShadow: `inset 0 0 0 1.5px hsl(var(${token}) / 0.9)` }
          : {
              boxShadow: [
                `inset 0 0 0 1.5px hsl(var(${token}) / 0.55)`,
                `inset 0 0 0 1.5px hsl(var(${token}) / 0)`,
              ],
            }
      }
      transition={
        isStatic
          ? { duration: 0 }
          : { repeat: Infinity, duration, ease: eases.inOut }
      }
    />
  )
}

export interface SessionTileProps {
  session: TileSession
  onReattach?: (name: string) => void
  onRemove?: (name: string) => void
}

/** The hero surface (§4.3). One tile = one agent: title (Claude chat summary),
 *  status, tail-preview, hover-peek (desktop) / long-press quick-peek (mobile),
 *  click → focus with a View Transition.
 *
 *  The tail-preview always renders the agent's REAL ANSI terminal colours
 *  (`preview_ansi`). On desktop hover the tile shows — per the Settings
 *  "Overview hover preview" choice — either a scaled-down LIVE terminal
 *  (default) or ~20 lines of the coloured static tail. The live terminal opens
 *  exactly ONE WebSocket, only while hovered, torn down on hover-leave. */
export function SessionTile({ session, onReattach, onRemove }: SessionTileProps) {
  const reduce = useReducedMotion()
  const fine = useMediaQuery('(pointer: fine)')
  const coarse = useMediaQuery('(pointer: coarse)')
  const navigateMorph = useNavigateMorph()
  const hoverPreview = useUI((s) => s.hoverPreview)
  const [hovered, setHovered] = React.useState(false)
  const [peekOpen, setPeekOpen] = React.useState(false)
  const prevStatus = React.useRef(session.status)

  // Tile content width — the scale target for the zoomed live terminal. Tracked
  // with a ResizeObserver so the grid's responsive column count is respected.
  const cardRef = React.useRef<HTMLDivElement | null>(null)
  const [cardWidth, setCardWidth] = React.useState(0)
  React.useEffect(() => {
    const el = cardRef.current
    if (!el) return
    setCardWidth(el.clientWidth)
    const ro = new ResizeObserver(() => setCardWidth(el.clientWidth))
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  // Viewport-aware connection pre-warm (polish-pass — "instant hover-zoom").
  // While this tile is visible AND the user has Live preview enabled AND the
  // session is live-capable, the prewarm registry opens a headless WS in the
  // background and buffers recent pty bytes. On hover-enter the live-terminal
  // hook adopts that WS+buffer and hydrates xterm in a single rAF — perceived
  // latency drops from the ~50-300ms handshake cost to ≈ <16ms. The cap of
  // 12 concurrent pre-warms keeps memory + server fan-out bounded; tiles
  // beyond the cap fall through to the existing on-hover-connect path (the
  // polish-pass crossfade is the visual cover for that fallback).
  //
  // Enabled gating mirrors the same conditions that gate `showLiveTerm`
  // below — pointless to pre-warm a connection the hover will never use.
  const liveCapableEarly =
    session.status !== 'stopped' && session.status !== 'error'
  usePeekPrewarm(session.name, cardRef, {
    enabled: fine && hoverPreview === 'live' && liveCapableEarly,
  })

  const goFocus = React.useCallback(
    () => navigateMorph(`/focus/${session.name}`),
    [navigateMorph, session.name],
  )

  // ── Type-on-hover wiring (v2 pattern, ported per user spec) ────────────────
  // Document-level keydown listener forwards quick interjections ("go on",
  // "stop", Enter, Esc) into the peeked session's pty via the SAME M13 wire
  // the focus terminal uses. Safety filters live in `usePeekType` — never
  // hijack inputs, browser shortcuts, or pre-engagement Tab/arrows.
  const termRef = React.useRef<UseLiveTermResult | null>(null)
  const onLiveReady = React.useCallback((t: UseLiveTermResult) => {
    termRef.current = t
  }, [])
  // Sliding stickiness timer. While alive, hover-leave does NOT dismiss the
  // peek (mouse drift would otherwise kill mid-typing). Reset on every
  // captured keystroke; clears itself after PEEK_STICKY_MS of silence — and
  // when it clears, if the mouse is no longer over the card, we dismiss now
  // (otherwise the peek would be orphaned with no event to release it).
  const stickyTimerRef = React.useRef<number | null>(null)
  const mouseInsideRef = React.useRef(false)
  const [sticky, setSticky] = React.useState(false)
  const armSticky = React.useCallback(() => {
    if (stickyTimerRef.current !== null) {
      window.clearTimeout(stickyTimerRef.current)
    }
    setSticky(true)
    stickyTimerRef.current = window.setTimeout(() => {
      stickyTimerRef.current = null
      setSticky(false)
      if (!mouseInsideRef.current) {
        setHovered(false)
      }
    }, PEEK_STICKY_MS)
  }, [])
  React.useEffect(
    () => () => {
      if (stickyTimerRef.current !== null) {
        window.clearTimeout(stickyTimerRef.current)
        stickyTimerRef.current = null
      }
    },
    [],
  )

  // One-shot haptic on transition into "waiting" (§4.3), debounced via ref so a
  // re-render with the same status never re-fires.
  React.useEffect(() => {
    if (session.status === 'waiting' && prevStatus.current !== 'waiting') {
      if ('vibrate' in navigator) navigator.vibrate?.(8)
    }
    prevStatus.current = session.status
  }, [session.status])

  const longPress = useLongPress({
    onLongPress: () => setPeekOpen(true),
    onClick: goFocus,
  })

  // Computed BEFORE the early-return for `session.missing` so the type-on-hover
  // hook below stays in the same call order on every render (rules-of-hooks).
  // A missing-tmux tile renders <TileError>, no preview area, no peek → the
  // hook is naturally disabled and a no-op.
  const expanded = hovered && fine && !reduce && !session.missing
  // The live terminal is only viable for a session with a live tmux backing —
  // a stopped agent has no pty to stream, so it falls back to the static tail.
  const liveCapable =
    session.status !== 'stopped' && session.status !== 'error'
  const showLiveTerm = expanded && hoverPreview === 'live' && liveCapable

  // Peek is "active" for typing while the live-zoom preview is showing for THIS
  // tile. usePeekType only installs its document listener while enabled — so
  // un-hovered tiles add zero global keyboard overhead.
  const peekTypable = showLiveTerm
  const { claimed } = usePeekType({
    enabled: peekTypable,
    onText: (text) => termRef.current?.send(text),
    onKey: (k) => termRef.current?.sendKey(k),
    onDismiss: () => {
      // Esc closes the peek without sending Esc to the pty (policy a — the web
      // norm). Clear sticky + drop hover so the live terminal unmounts and the
      // WS closes via useLiveTerm teardown.
      setSticky(false)
      if (stickyTimerRef.current !== null) {
        window.clearTimeout(stickyTimerRef.current)
        stickyTimerRef.current = null
      }
      setHovered(false)
    },
    onActivity: () => armSticky(),
  })

  // A MISSING tmux backing is the only hard error; an "error" *status* agent is
  // still a normal, navigable tile (calm orange border via <StatusBorder>).
  if (session.missing) {
    return (
      <div className="relative" style={{ height: IDLE_H }}>
        <TileError
          session={session}
          onReattach={onReattach}
          onRemove={onRemove}
          className="absolute inset-x-0 top-0"
        />
      </div>
    )
  }

  const title = session.task_summary || session.name
  const tokens =
    typeof session.tokens === 'number' ? formatTokens(session.tokens) : null
  // Stopped UX (polish-pass): a stopped tile is visually distinct AT A GLANCE
  // — the whole card dims to the app's "muted" treatment (token-driven, no
  // ad-hoc colour) and a sentence-case "Stopped" pill replaces the running
  // chrome. The neutral grey status dot already comes from STATUS_COLOR
  // (status-idle), not a destructive red — stopped is just "not running".
  const isStopped = session.status === 'stopped'

  // Tail line count: 6 idle → 20 when expanded in "expanded text" mode (or as
  // the live mode's fallback for a session with no pty).
  const tailLines = expanded && !showLiveTerm ? EXPANDED_LINES : IDLE_LINES
  // Height the preview area springs to. The card grows with it (the tail-pad is
  // already inside `TailPreview`'s own sizing, so the live height is exact).
  const previewH = showLiveTerm
    ? LIVE_PREVIEW_H
    : tailLines * TAIL_LINE_H + TAIL_PAD

  return (
    // The slot reserves the idle height; the card floats inside it so hover
    // growth never reflows neighbours.
    <div className="relative" style={{ height: IDLE_H }}>
      <motion.div
        ref={cardRef}
        role="button"
        tabIndex={0}
        aria-label={`${title} — ${STATUS_LABEL[session.status]}`}
        onClick={fine ? goFocus : undefined}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault()
            goFocus()
          }
        }}
        {...(coarse ? longPress : null)}
        onHoverStart={() => {
          mouseInsideRef.current = true
          setHovered(true)
        }}
        onHoverEnd={() => {
          mouseInsideRef.current = false
          // Stickiness: while the user is mid-typing (or within the sliding
          // window after the last keystroke), refuse to dismiss on mouse-leave
          // — mouse drift would otherwise kill an in-progress interjection.
          // When the sticky timer expires it checks `mouseInsideRef` and
          // dismisses then if the mouse is still outside.
          if (sticky) return
          setHovered(false)
        }}
        whileHover={
          fine && !reduce
            ? {
                scale: 1.06,
                zIndex: 10,
                boxShadow: '0 12px 36px -8px rgba(0,0,0,0.18)',
                // Restore full opacity on hover so a stopped tile's preview is
                // legible while peeked — the dim only signals at-rest state.
                opacity: 1,
              }
            : undefined
        }
        whileTap={
          reduce
            ? undefined
            : { scale: 0.96, transition: { duration: 0.1, ease: eases.out } }
        }
        transition={springs.tileHover}
        style={
          supportsViewTransitions
            ? { viewTransitionName: vtSessionName(session.name) }
            : undefined
        }
        className={
          // Stopped UX (polish-pass #1): a stopped tile dims to 60% via the
          // token-driven muted treatment so it reads "off" AT A GLANCE next to
          // live siblings — but stays fully interactive (tap → focus →
          // Resume/Archive). Only the resting state dims; hover restores full
          // opacity (whileHover.opacity:1) so the peek is readable.
          'absolute inset-x-0 top-0 flex cursor-pointer flex-col overflow-hidden rounded-xl border border-border bg-card pt-3 outline-none focus-visible:ring-2 focus-visible:ring-ring' +
          (isStopped ? ' opacity-60' : '')
        }
      >
        <StatusBorder status={session.status} reduce={reduce} />

        {/* Title row (32px) + meta row (16px) */}
        <div className="px-3">
          <div className="flex h-8 items-start gap-2">
            <span className="line-clamp-1 flex-1 text-sm font-medium leading-tight">
              {title}
            </span>
            {session.status === 'waiting' && (
              <span className="shrink-0 rounded-full bg-status-waiting/15 px-1.5 py-0.5 text-[10px] font-semibold leading-none text-status-waiting">
                {MISC.needsInputPill}
              </span>
            )}
            {isStopped && (
              // Sentence-case "Stopped" pill — neutral muted treatment, NOT
              // red. Mirrors the needs-input pill geometry so the row stays
              // balanced. Reads at a glance: this tile is OFF.
              <span className="shrink-0 rounded-full bg-muted px-1.5 py-0.5 text-[10px] font-semibold leading-none text-muted-foreground">
                {STATUS_LABEL.stopped}
              </span>
            )}
            <StatusDot status={session.status} className="mt-1" />
          </div>
          <div className="flex h-4 items-center gap-2 text-xs text-muted-foreground">
            {tokens && <span className="shrink-0">{tokens} tokens</span>}
            {session.branch && (
              <span className="flex min-w-0 items-center gap-1">
                <GitBranch className="size-3 shrink-0" />
                <span className="truncate">{session.branch}</span>
              </span>
            )}
          </div>
        </div>

        {/* Preview area. The container owns the height (springs 6-line idle →
            live 230px / 20-line on hover) and clips its children, so neither
            the live terminal nor the long tail can bleed past the card. The
            coloured static tail fills it; the live zoomed terminal cross-fades
            in OVER it (live mode) — gated on the WS's FIRST real pty frame so
            the tile never flashes a blank-black void during the handshake. */}
        <motion.div
          className="relative mt-1 overflow-hidden"
          animate={{ height: previewH }}
          transition={reduce ? { duration: 0 } : springs.cardExpand}
        >
          <TailPreview
            lines={session.preview_lines}
            ansiLines={session.preview_ansi}
            fill
          />
          <AnimatePresence>
            {showLiveTerm && cardWidth > 0 && (
              <LivePeekLayer
                key="live"
                name={session.name}
                width={cardWidth}
                reduce={!!reduce}
                onReady={onLiveReady}
              />
            )}
          </AnimatePresence>
          {/* Type-on-hover indicator. Sentence case, glass-on-dark pill,
              positioned bottom-right so it never covers the freshest line of
              terminal output. Only renders once the user has clearly engaged
              (one printable keystroke captured) — mere hover stays silent. */}
          <AnimatePresence>
            {peekTypable && claimed && (
              <motion.div
                key="typing-pill"
                initial={reduce ? false : { opacity: 0, y: 4 }}
                animate={{ opacity: 1, y: 0 }}
                exit={reduce ? undefined : { opacity: 0, y: 4 }}
                transition={reduce ? { duration: 0 } : springs.snappy}
                className="pointer-events-none absolute bottom-1.5 right-1.5 z-20 flex h-6 items-center gap-1.5 rounded-full bg-black/55 px-2 text-[10px] font-medium leading-none text-white/90 shadow-sm backdrop-blur-sm"
              >
                <span
                  aria-hidden
                  className="size-1.5 rounded-full bg-status-active"
                />
                <span className="truncate">Typing → {session.name}</span>
                <span className="opacity-70">· Esc to close</span>
              </motion.div>
            )}
          </AnimatePresence>
        </motion.div>
      </motion.div>

      {coarse && (
        <QuickPeekModal
          session={session}
          open={peekOpen}
          onOpenChange={setPeekOpen}
        />
      )}
    </div>
  )
}

// ── Peek crossfade layer (polish-pass #2) ─────────────────────────────────────
//
// Owns the local `liveReady` state so it auto-resets on each fresh mount via
// React's standard component lifecycle (no setState-in-effect lint friction,
// no synchronous setState during render). Mounts immediately so the underlying
// WS starts — but stays opacity:0 UNTIL the first real pty frame arrives, so
// the tile never flashes a blank-black void during the WS handshake. Crossfade
// is short (~120-180ms via springs.snappy); under Reduce Motion the swap is
// instant. The static tail underneath stays at full opacity throughout.
function LivePeekLayer({
  name,
  width,
  reduce,
  onReady,
}: {
  name: string
  width: number
  reduce: boolean
  /** Forwarded to the underlying <TileLiveTerminal> so the parent type-on-hover
   *  layer can capture the imperative `send`/`sendKey` handle the moment the
   *  WS is wired — keystrokes flow even before the crossfade completes. */
  onReady?: (term: UseLiveTermResult) => void
}) {
  const [liveReady, setLiveReady] = React.useState(false)
  return (
    <motion.div
      initial={reduce ? false : { opacity: 0 }}
      animate={{ opacity: liveReady ? 1 : 0 }}
      exit={reduce ? undefined : { opacity: 0 }}
      transition={reduce ? { duration: 0 } : springs.snappy}
      className="absolute inset-0"
    >
      <TileLiveTerminal
        name={name}
        width={width}
        onFirstFrame={() => setLiveReady(true)}
        onReady={onReady}
      />
    </motion.div>
  )
}
