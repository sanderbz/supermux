import * as React from 'react'
import { AnimatePresence, motion, useReducedMotion } from 'framer-motion'
import { useQueryClient } from '@tanstack/react-query'
import { Archive, GitBranch, X } from 'lucide-react'

import { springs, eases } from '@/lib/springs'
import { MISC } from '@/brand/copy'
import { sessionsApi, type ApiSession } from '@/lib/api'
import { SESSIONS_KEY } from '@/hooks/use-sessions'
import { ARCHIVED_SESSIONS_KEY } from '@/hooks/use-archived-sessions'
import { useToast } from '@/components/ui/use-toast'
import { useMediaQuery } from '@/hooks/use-media-query'
import { useLongPress } from '@/hooks/use-long-press'
import {
  usePeekType,
  PEEK_STICKY_MS,
  PEEK_LEAVE_GRACE_MS,
} from '@/hooks/use-peek-type'
import { usePeekPrewarm } from '@/hooks/use-peek-prewarm'
import type { UseLiveTermResult } from '@/hooks/use-live-term'
import { useUI } from '@/stores/ui-store'
import {
  MIN_OVERVIEW_SIZE,
  getOverviewSizeConfig,
  type OverviewSize,
} from '@/lib/overview-size'
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
import {
  StoppedSessionActions,
  type StoppedSessionActionsHandle,
} from '@/components/terminal/stopped-session'
import type { TileSession } from './types'

// Idle geometry (px) — the slot reserves exactly the idle tile height so the
// card can be absolutely positioned inside that slot and its hover-growth can
// overflow downward over the next row WITHOUT reflowing the grid (Codex #8:
// container-only morph, not canvas).
const HEADER_H = 12 + 32 + 16 + 4 // pt-3 + title row + meta row + mt-1
const TAIL_LINE_H = 14
const TAIL_PAD = 8
// Hover ceiling for the `expanded` (non-live) preview mode — grows the static
// tail beyond the idle line count so the hover-peek shows meaningfully more.
const EXPANDED_LINES_BONUS = 14

/** Per-tier-resolved tile geometry. The chrome (HEADER_H, font sizes) does NOT
 *  change — only the spatial mass (tail line count, idle bonus height, live-zoom
 *  pane height) — so type hierarchy reads the same at every tier and the
 *  live-zoom xterm keeps its native font size while FitAddon picks up more
 *  cols×rows in the bigger container (the user mandate: scale the container,
 *  don't warp xterm).
 *
 *  Tier-1 baseline is +20px taller than the historical pre-rework default
 *  (`idleBonusPx`) so the preview area breathes without a jolt; tier 2 adds
 *  ~50% more vertical room via a higher `idleLines`; tiers 3 & 4 hold the
 *  tier-2 vertical room and drop a column instead (cards get wider, not
 *  taller). All live-peek heights scale proportionally so the hover stays
 *  representative of the tile size. */
function geometryForTier(tier: OverviewSize) {
  const cfg = getOverviewSizeConfig(tier)
  const idleLines = cfg.idleLines
  const expandedLines = idleLines + EXPANDED_LINES_BONUS
  const livePreviewH = cfg.livePreviewPx
  const idleH = HEADER_H + idleLines * TAIL_LINE_H + TAIL_PAD + cfg.idleBonusPx
  return { idleLines, expandedLines, livePreviewH, idleH }
}

function formatTokens(n: number): string {
  if (n < 1000) return `${n}`
  if (n < 1_000_000) return `${(n / 1000).toFixed(n < 10_000 ? 1 : 0)}k`
  return `${(n / 1_000_000).toFixed(1)}m`
}

/** Animated status border overlay (§4.3) — the CARD-level "attention" glow.
 *  The pulse lives HERE on the card, not on the status dot (the dot is a static
 *  colour indicator). Model:
 *
 *    • `active`  (loading / working) → NO glow. While the agent is loading or
 *      thinking the top-right active spinner dot already carries the "busy"
 *      signal; a pulsing card on top of it reads as an alarm and was the
 *      unwanted "pulse while loading" (the detector classifies a freshly-booted
 *      session `active` the moment its boot output streams, so an `active` glow
 *      = a loading-phase glow). Keep the loading tile calm; the spinner is enough.
 *    • `idle`    (turn ended / done → green) → a SUBTLE green "ready" breath.
 *      Lower peak opacity (0.30 vs 0.55) and a slower cadence (2.8s) than the
 *      waiting pulse so a finished session announces itself as a calm "ready",
 *      never an alarm.
 *    • `waiting` (needs input) → the blue attention pulse (2.2s), kept.
 *    • `error`   → static calm orange border (no pulse), kept.
 *    • `starting` / `stopped` → no glow (boot stays calm; stopped is "off").
 *
 *  Reduce Motion → static border at the token's resting opacity (no pulse).
 *  Lives on its own inset overlay so it never competes with the card's
 *  hover-scale transform. */
function StatusBorder({
  status,
  reduce,
}: {
  status: TileSession['status']
  reduce: boolean | null
}) {
  let token: string | null = null
  let duration = 2.2
  // Peak halo opacity at the bright end of the breath. The green "ready" glow
  // is deliberately subtler than the blue "needs input" attention pulse.
  let peak = 0.55
  // Resting opacity used for the static (Reduce Motion / error) border.
  let restOpacity = 0.9
  if (status === 'waiting') {
    token = '--status-waiting'
    duration = 2.2
    peak = 0.55
  } else if (status === 'idle') {
    // Done / ready — subtle green card glow. Lower peak + slower breath so it
    // reads as a calm "ready", distinct from (and gentler than) the blue pulse.
    token = '--status-ready'
    duration = 2.8
    peak = 0.3
    restOpacity = 0.6
  } else if (status === 'error') token = '--status-error'
  // NOTE: no `active` branch — loading/working shows no card glow by design.

  if (!token) return null

  const isStatic = reduce || status === 'error'
  return (
    <motion.span
      aria-hidden
      className="pointer-events-none absolute inset-0 z-10 rounded-xl"
      animate={
        isStatic
          ? { boxShadow: `inset 0 0 0 1.5px hsl(var(${token}) / ${restOpacity})` }
          : {
              boxShadow: [
                `inset 0 0 0 1.5px hsl(var(${token}) / ${peak})`,
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
  /** Density tier (card-sizes-rework). 1 = default (current baseline + 20px
   *  idle height); 2 = ~+50% taller (same column count); 3+ = one fewer column
   *  per step (cards get wider). Title/font sizes do NOT scale — only spatial
   *  mass — so hierarchy stays consistent across tiers. Default 1 preserves
   *  the baseline for non-overview call sites (e.g. dev-tiles). */
  sizeTier?: OverviewSize
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
export function SessionTile({
  session,
  onReattach,
  onRemove,
  sizeTier = MIN_OVERVIEW_SIZE,
}: SessionTileProps) {
  const reduce = useReducedMotion()
  const {
    idleLines: IDLE_LINES,
    expandedLines: EXPANDED_LINES,
    livePreviewH: LIVE_PREVIEW_H,
    idleH: IDLE_H,
  } = React.useMemo(() => geometryForTier(sizeTier), [sizeTier])
  const fine = useMediaQuery('(pointer: fine)')
  const coarse = useMediaQuery('(pointer: coarse)')
  const navigateMorph = useNavigateMorph()
  const hoverPreview = useUI((s) => s.hoverPreview)
  // Master preview mode (Settings → "Overview preview"). `text` is a hard
  // override: the tile shows ONLY the static text tail — no live xterm peek and
  // no live WS peek connection (no hover-warm, no on-hover connect), at rest and
  // on hover. `live` keeps the existing behaviour, with `hoverPreview` choosing
  // between the live terminal and the expanded-text hover. One source of truth:
  // this store field (the same one Settings writes), so the switch is reactive.
  const overviewPreview = useUI((s) => s.overviewPreview)
  const liveModeEnabled = overviewPreview === 'live'
  const [hovered, setHovered] = React.useState(false)
  const [peekOpen, setPeekOpen] = React.useState(false)
  // Pins the stopped-peek surface EXPANDED while the Resume picker is open,
  // independent of hover. The picker (a ResponsiveSheet) lives inside the
  // hover-gated stopped-peek surface, so moving the mouse to the picker drops
  // `hovered` → the surface (and the open picker) would unmount. Conceptually
  // the same "keep open regardless of hover" idea as `peekOpen` does for the
  // mobile long-press quick-peek; kept as its own flag because the stopped-peek
  // gate is fine-pointer-only and must collapse the instant the picker closes.
  const [resumePickerOpen, setResumePickerOpen] = React.useState(false)
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
    enabled:
      liveModeEnabled && fine && hoverPreview === 'live' && liveCapableEarly,
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
  // ── Stickiness, decoupled into TWO distinct timers (fix-peek-sticky) ────────
  //
  // The sticky window has TWO jobs that used to be conflated into one long
  // (PEEK_STICKY_MS = 4s) silence timer — which is exactly what caused the bug:
  // a mouse-leave right after typing did NOTHING (onHoverEnd early-returned
  // while `sticky` was true) and dismissal waited out the FULL 4s of keystroke
  // silence. The user wants a prompt shrink on mouse-leave WITHOUT losing the
  // "don't vanish while I'm actively typing" guarantee.
  //
  //   1. WHILE STILL HOVERING — bridge inter-keystroke gaps + brief pointer
  //      drift. This is the long PEEK_STICKY_MS window: re-armed on every
  //      keystroke, marks the peek `sticky` so a momentary hover-leave (mouse
  //      grazes the card edge) can't kill a half-typed message. This window is
  //      KEPT — do NOT shrink it; its whole point is to be forgiving while the
  //      pointer is in/around the tile.
  //
  //   2. AFTER A GENUINE MOUSE-LEAVE — a SHORT grace (PEEK_LEAVE_GRACE_MS).
  //      Once the pointer is actually gone, we no longer owe the user the full
  //      4s: we dismiss after a brief grace UNLESS a keystroke arrives (which
  //      means they're still typing with the pointer parked elsewhere — that
  //      re-arms and re-starts the grace, so continuous typing holds the peek
  //      open even with the mouse away).
  //
  // DO NOT "restore" a single 4s timer here: that re-introduces the ~4s linger
  // on mouse-leave-after-typing. The two timers MUST stay separate.
  const stickyTimerRef = React.useRef<number | null>(null)
  // Pending post-mouse-leave dismissal. Distinct from the sticky window so a
  // real leave shrinks promptly while keystrokes can still cancel/re-arm it.
  const leaveGraceRef = React.useRef<number | null>(null)
  const mouseInsideRef = React.useRef(false)
  const [sticky, setSticky] = React.useState(false)
  const clearStickyTimer = React.useCallback(() => {
    if (stickyTimerRef.current !== null) {
      window.clearTimeout(stickyTimerRef.current)
      stickyTimerRef.current = null
    }
  }, [])
  const clearLeaveGrace = React.useCallback(() => {
    if (leaveGraceRef.current !== null) {
      window.clearTimeout(leaveGraceRef.current)
      leaveGraceRef.current = null
    }
  }, [])
  // Arm the SHORT post-mouse-leave grace: dismiss after PEEK_LEAVE_GRACE_MS
  // unless a keystroke re-arms it (continuous typing keeps the peek alive even
  // with the pointer gone). Re-entering the tile cancels it (onHoverStart).
  const armLeaveGrace = React.useCallback(() => {
    clearLeaveGrace()
    leaveGraceRef.current = window.setTimeout(() => {
      leaveGraceRef.current = null
      // Guard: only dismiss if the pointer is still outside (a re-entry would
      // have cleared this timer, but belt-and-suspenders against races).
      if (!mouseInsideRef.current) {
        clearStickyTimer()
        setSticky(false)
        setHovered(false)
      }
    }, PEEK_LEAVE_GRACE_MS)
  }, [clearLeaveGrace, clearStickyTimer])
  // Called on every captured keystroke. Re-arms the long while-hovering sticky
  // window AND, if the pointer is currently outside, re-arms the short leave
  // grace — so a user typing with the mouse parked elsewhere keeps the peek
  // open, and it shrinks promptly the moment they STOP typing.
  const armSticky = React.useCallback(() => {
    clearStickyTimer()
    setSticky(true)
    stickyTimerRef.current = window.setTimeout(() => {
      stickyTimerRef.current = null
      setSticky(false)
      // Silence-window expiry while the pointer is already outside: dismiss now
      // (covers the case where the pointer left WITHOUT us arming a leave grace,
      // e.g. the leave fired before any keystroke). Normally the short leave
      // grace beats this timer to the punch.
      if (!mouseInsideRef.current) {
        setHovered(false)
      }
    }, PEEK_STICKY_MS)
    // If the pointer already left while the user keeps typing, restart the short
    // grace so it dismisses ~PEEK_LEAVE_GRACE_MS after the LAST keystroke — not
    // after the full silence window.
    if (!mouseInsideRef.current) armLeaveGrace()
  }, [clearStickyTimer, armLeaveGrace])
  React.useEffect(
    () => () => {
      clearStickyTimer()
      clearLeaveGrace()
    },
    [clearStickyTimer, clearLeaveGrace],
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

  // ── Archive affordance (feat-archive-every-tile) ───────────────────────────
  // Archive used to be reachable ONLY on a stopped tile's hover-peek, so on an
  // active/idle/waiting tile there was literally nothing to click. We surface a
  // single hover-revealed icon on EVERY tile (no extra clicks — per the user's
  // strong preference). A stray hover-click can't archive: the first click flips
  // an inline confirm (the icon swaps to a clear "confirm/cancel" pair), and only
  // the second click commits — the same guard the focus-pane stopped-actions use,
  // important because archiving a RUNNING session also stops + tears it down.
  const qc = useQueryClient()
  const { toast } = useToast()
  const [archiveConfirm, setArchiveConfirm] = React.useState(false)
  const [archiving, setArchiving] = React.useState(false)
  // While `archiving`, the tile plays a self-contained exit (the slot collapses
  // its own height + fades + scales via springs.cardExpand). The cache removal
  // fires on the exit's animation-complete, so the tile springs OUT instead of
  // vanishing instantly — and it's gone from the cache by the time the spring
  // settles, so no flicker / double-render.
  const archiveConfirmTimer = React.useRef<number | null>(null)
  React.useEffect(
    () => () => {
      if (archiveConfirmTimer.current !== null) {
        window.clearTimeout(archiveConfirmTimer.current)
      }
    },
    [],
  )

  const removeFromCache = React.useCallback(() => {
    qc.setQueryData<ApiSession[]>(SESSIONS_KEY, (prev) =>
      (prev ?? []).filter((s) => s.name !== session.name),
    )
  }, [qc, session.name])

  // Undo flips `archived = 0` server-side; the SSE `sessions` delta re-adds the
  // full row so the tile springs back into the overview live (every tab). We
  // also optimistically re-insert here so the local tab doesn't wait on the
  // round-trip — `applyDelta` merges the authoritative SSE row in by name.
  const undoArchive = React.useCallback(() => {
    const snapshot = qc.getQueryData<ApiSession[]>(SESSIONS_KEY)
    const has = snapshot?.some((s) => s.name === session.name)
    if (!has && snapshot) {
      // Re-insert the row we just removed so the user sees it immediately.
      qc.setQueryData<ApiSession[]>(SESSIONS_KEY, (prev) => [
        ...(prev ?? []),
        session as unknown as ApiSession,
      ])
    }
    sessionsApi
      .unarchive(session.name)
      .then(() => {
        // The session left the archived set — refresh the Archived sheet's
        // count/list so the overflow item and any open sheet stay in sync.
        void qc.invalidateQueries({ queryKey: ARCHIVED_SESSIONS_KEY })
      })
      .catch(() => {
        // The server rejected the unarchive — drop the optimistic row back out
        // and tell the user. Rare (the row exists; this is just a flag flip).
        removeFromCache()
        toast({ message: 'Couldn’t undo archive', tone: 'error' })
      })
  }, [qc, session, removeFromCache, toast])

  // Commit: fire the server archive, start the exit animation, and (on success)
  // remove from cache + show the Undo toast. The exit plays regardless of the
  // server round-trip latency (optimistic), reverting only on outright failure.
  const commitArchive = React.useCallback(() => {
    if (archiving) return
    setArchiveConfirm(false)
    setArchiving(true)
    // The toast label uses the same title the tile shows (chat summary, else
    // the session name) — computed inline so this callback doesn't depend on
    // the `title` const declared after the missing-tile early return.
    const label = session.task_summary || session.name
    sessionsApi
      .archive(session.name)
      .then(() => {
        // The session entered the archived set — refresh the Archived sheet's
        // count/list so the overflow item reflects it without a manual reopen.
        void qc.invalidateQueries({ queryKey: ARCHIVED_SESSIONS_KEY })
        toast({
          message: `Archived ${label}`,
          duration: 5000,
          action: { label: 'Undo', onClick: undoArchive },
        })
      })
      .catch(() => {
        // Roll the exit back — the tile stays put and the user can retry.
        setArchiving(false)
        toast({ message: 'Couldn’t archive session', tone: 'error' })
      })
  }, [qc, archiving, session.task_summary, session.name, toast, undoArchive])

  const onArchiveClick = React.useCallback(
    (e: React.MouseEvent | React.KeyboardEvent) => {
      // Never let the archive control's click bubble to the tile's onClick
      // (which navigates to focus view).
      e.stopPropagation()
      if (!archiveConfirm) {
        setArchiveConfirm(true)
        // Auto-cancel the confirm after a few seconds so the tile doesn't sit in
        // a half-armed state if the user moves on.
        if (archiveConfirmTimer.current !== null) {
          window.clearTimeout(archiveConfirmTimer.current)
        }
        archiveConfirmTimer.current = window.setTimeout(() => {
          setArchiveConfirm(false)
          archiveConfirmTimer.current = null
        }, 4000)
        return
      }
      commitArchive()
    },
    [archiveConfirm, commitArchive],
  )

  const cancelArchiveConfirm = React.useCallback(
    (e: React.MouseEvent | React.KeyboardEvent) => {
      e.stopPropagation()
      setArchiveConfirm(false)
      if (archiveConfirmTimer.current !== null) {
        window.clearTimeout(archiveConfirmTimer.current)
        archiveConfirmTimer.current = null
      }
    },
    [],
  )

  // Computed BEFORE the early-return for `session.missing` so the type-on-hover
  // hook below stays in the same call order on every render (rules-of-hooks).
  // A missing-tmux tile renders <TileError>, no preview area, no peek → the
  // hook is naturally disabled and a no-op.
  // `resumePickerOpen` pins the surface expanded while the Resume picker sheet
  // is open — without it, leaving the card to interact with the picker drops
  // `hovered` and unmounts the picker (the bug). It only ever flips true on a
  // stopped tile (the Resume button lives in the stopped-peek), so it can't
  // affect the live-peek path. Collapses normally the moment the picker closes.
  const expanded =
    (hovered || resumePickerOpen) && fine && !reduce && !session.missing
  // The live terminal is only viable for a session with a live tmux backing —
  // a stopped agent has no pty to stream, so it falls back to the static tail.
  const liveCapable =
    session.status !== 'stopped' && session.status !== 'error'
  // Stopped peek (feat-stopped-peek-actions): a stopped tile's hover surface
  // mounts the Start + Archive actions DIRECTLY — skipping the dead-terminal
  // peek (no WS connection, no empty-black void, no last-static-preview that
  // can't be acted on). Running/active/idle/booting tiles fall through to the
  // existing live-zoom / static-tail behaviour, unchanged.
  const isStoppedPeek = expanded && session.status === 'stopped'
  // `text` mode short-circuits the live terminal entirely (no WS opened): the
  // tile falls through to the static `TailPreview` at rest and on hover.
  const showLiveTerm =
    liveModeEnabled &&
    expanded &&
    hoverPreview === 'live' &&
    liveCapable &&
    !isStoppedPeek
  // The hover-revealed archive control shows whenever a fine-pointer user hovers
  // the tile (independent of Reduce Motion — it's an affordance, not motion) and
  // the tile isn't already exiting. Coarse pointers (touch) reach archive via the
  // focus pane / stopped-peek actions, so we don't clutter the touch tile.
  //
  // EXCEPT on a STOPPED tile (P2 polish): the stopped hover-peek already mounts
  // its own Start + Archive cluster (<StoppedSessionActions>), so showing this
  // header icon too would surface Archive TWICE on the same hovered tile. Suppress
  // the header icon when stopped — one archive affordance per tile state (the peek
  // owns it for stopped; this header icon owns it for active/idle/waiting/error).
  const showArchiveControl =
    (hovered || archiveConfirm) &&
    fine &&
    !archiving &&
    !session.missing &&
    session.status !== 'stopped'

  // Stopped peek's keyboard shortcut: Enter → primary "Start" action (power-
  // user nicety; the visible primary button makes the affordance obvious),
  // Esc → close. No pty to type into so the rest of usePeekType is silenced.
  const stoppedActionsRef = React.useRef<StoppedSessionActionsHandle | null>(
    null,
  )
  const onStoppedKeyDown = React.useCallback(
    (e: KeyboardEvent) => {
      // Same safety as usePeekType: never hijack keys away from an input or
      // a focused button (e.g. the user is mid-tab through the actions —
      // their Enter should activate the focused button, not double-fire).
      const el = document.activeElement as HTMLElement | null
      if (el && el !== document.body && el !== document.documentElement) {
        const tag = el.tagName
        if (
          tag === 'INPUT' ||
          tag === 'TEXTAREA' ||
          tag === 'SELECT' ||
          tag === 'BUTTON' ||
          el.isContentEditable
        ) {
          return
        }
      }
      if (e.metaKey || e.ctrlKey || e.altKey) return
      if (e.key === 'Enter') {
        e.preventDefault()
        stoppedActionsRef.current?.start()
        return
      }
      if (e.key === 'Escape') {
        e.preventDefault()
        setHovered(false)
      }
    },
    [],
  )
  React.useEffect(() => {
    // While the Resume picker sheet is open it owns the keyboard (its own
    // Enter/Escape semantics) — don't let the tile's capture-phase handler
    // hijack Enter (would start a fresh session) or Escape (would collapse the
    // tile out from under the open sheet). The sheet's onOpenChange(false) flips
    // `resumePickerOpen` off, re-arming this handler.
    if (!isStoppedPeek || resumePickerOpen) return
    document.addEventListener('keydown', onStoppedKeyDown, { capture: true })
    return () => {
      document.removeEventListener('keydown', onStoppedKeyDown, {
        capture: true,
      })
    }
  }, [isStoppedPeek, resumePickerOpen, onStoppedKeyDown])

  // Peek is "active" for typing while the live-zoom preview is showing for THIS
  // tile. usePeekType only installs its document listener while enabled — so
  // un-hovered tiles add zero global keyboard overhead. Stopped peeks never
  // enable type-on-hover (no pty target).
  const peekTypable = showLiveTerm
  const { claimed } = usePeekType({
    enabled: peekTypable,
    onText: (text) => termRef.current?.send(text),
    onKey: (k) => termRef.current?.sendKey(k),
    onDismiss: () => {
      // Esc closes the peek without sending Esc to the pty (policy a — the web
      // norm). Clear BOTH timers + drop hover so the live terminal unmounts and
      // the WS closes via useLiveTerm teardown.
      setSticky(false)
      clearStickyTimer()
      clearLeaveGrace()
      setHovered(false)
    },
    onActivity: () => armSticky(),
  })

  // A MISSING tmux backing is the only hard error; an "error" *status* agent is
  // still a normal, navigable tile (calm orange border via <StatusBorder>).
  if (session.missing) {
    return (
      <motion.div
        className="relative"
        animate={{ height: IDLE_H }}
        transition={reduce ? { duration: 0 } : springs.cardExpand}
        initial={false}
      >
        <TileError
          session={session}
          onReattach={onReattach}
          onRemove={onRemove}
          className="absolute inset-x-0 top-0"
        />
      </motion.div>
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
  // the live mode's fallback for a session with no pty). Stopped peek skips
  // the tail expansion — the actions panel sits over the (still-rendered)
  // idle tail so the user has scene continuity without a height shift.
  const tailLines =
    expanded && !showLiveTerm && !isStoppedPeek ? EXPANDED_LINES : IDLE_LINES
  // Stopped peek matches the LIVE peek's height (per-tier LIVE_PREVIEW_H).
  // Earlier this was a tight 44+12+12 actions-row, but that made the peeked
  // stopped tile SHORTER than the idle stopped tile (idle = 6 tail lines) — a
  // jarring shrink right when the user committed to interacting. Matching the
  // live peek height also keeps the grid feel consistent across statuses: the
  // tile grows by the same amount whether the peek reveals a live terminal or
  // the Start + Archive actions, which sit centred in the larger surface.
  // Height the preview area springs to. The card grows with it (the tail-pad is
  // already inside `TailPreview`'s own sizing, so the live height is exact).
  const previewH = showLiveTerm
    ? LIVE_PREVIEW_H
    : isStoppedPeek
      ? LIVE_PREVIEW_H
      : tailLines * TAIL_LINE_H + TAIL_PAD

  return (
    // The slot reserves the idle height; the card floats inside it so hover
    // growth never reflows neighbours. The slot height itself springs when the
    // active density tier changes (feat-overview-sizes), so the whole grid
    // reflows with the same `springs.cardExpand` motion used inside the tile —
    // one consistent feel; no `transition: all`. `initial={false}` skips the
    // mount-time spring so the first paint is exact at the current tier.
    <motion.div
      className="relative"
      // While archiving, the slot plays a self-contained exit — collapse the
      // reserved height + fade + slight scale-down via the SAME springs.cardExpand
      // the tile already uses. `removeFromCache` fires on the exit's completion
      // so the row is gone from the cache exactly as the spring settles: the tile
      // springs OUT instead of vanishing instantly (the residual UX defect), and
      // the LayoutGroup wrapper in the overview reflows neighbours smoothly into
      // the gap. Reduce Motion → instant removal (height/opacity 0 with no spring).
      animate={
        archiving
          ? { height: 0, opacity: 0, scale: 0.94 }
          : { height: IDLE_H, opacity: 1, scale: 1 }
      }
      style={{ transformOrigin: 'top center' }}
      transition={reduce ? { duration: 0 } : springs.cardExpand}
      onAnimationComplete={() => {
        if (archiving) removeFromCache()
      }}
      initial={false}
    >
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
          // Re-entry cancels any pending post-leave dismissal (the user came
          // back before the short grace elapsed — keep the peek up).
          clearLeaveGrace()
          setHovered(true)
        }}
        onHoverEnd={() => {
          mouseInsideRef.current = false
          // A genuine mouse-leave. If the user is mid-typing (or just typed —
          // `sticky` is alive), we DON'T dismiss immediately (a stray drift or
          // an in-flight keystroke shouldn't kill a half-typed message), but we
          // also DON'T wait out the full PEEK_STICKY_MS silence window (the old
          // bug). Instead we arm a SHORT grace: dismiss in ~PEEK_LEAVE_GRACE_MS
          // unless a keystroke re-arms it. Continuous typing => stays open;
          // stopped typing + pointer gone => prompt shrink.
          if (sticky) {
            armLeaveGrace()
            return
          }
          // Not sticky (plain hover, no typing) → dismiss promptly as before.
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
            {session.status === 'waiting' && !showArchiveControl && (
              <span className="shrink-0 rounded-full bg-status-waiting/15 px-1.5 py-0.5 text-[10px] font-semibold leading-none text-status-waiting">
                {MISC.needsInputPill}
              </span>
            )}
            {isStopped && !showArchiveControl && (
              // Sentence-case "Stopped" pill — neutral muted treatment, NOT
              // red. Mirrors the needs-input pill geometry so the row stays
              // balanced. Reads at a glance: this tile is OFF.
              <span className="shrink-0 rounded-full bg-muted px-1.5 py-0.5 text-[10px] font-semibold leading-none text-muted-foreground">
                {STATUS_LABEL.stopped}
              </span>
            )}
            {/* Archive affordance — a single hover-revealed icon, on EVERY tile
                (no kebab, no extra clicks). Swaps in over the status dot on
                hover so the resting tile stays calm. First click arms an inline
                confirm (icon → confirm/cancel pair) so a stray hover-click can't
                archive a running session (archive also stops + tears it down).
                44pt hit targets via the touch-target padding trick (the visible
                glyph is small, the clickable area is ≥44px). */}
            <AnimatePresence mode="wait" initial={false}>
              {showArchiveControl ? (
                archiveConfirm ? (
                  <motion.div
                    key="archive-confirm"
                    initial={reduce ? false : { opacity: 0, scale: 0.9 }}
                    animate={{ opacity: 1, scale: 1 }}
                    exit={reduce ? undefined : { opacity: 0, scale: 0.9 }}
                    transition={reduce ? { duration: 0 } : springs.snappy}
                    className="-mr-1 -mt-1 flex shrink-0 items-center gap-0.5"
                  >
                    <button
                      type="button"
                      aria-label="Cancel archive"
                      onClick={cancelArchiveConfirm}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter' || e.key === ' ')
                          cancelArchiveConfirm(e)
                      }}
                      className="grid size-11 place-items-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring [&_svg]:size-4"
                    >
                      <X aria-hidden />
                    </button>
                    <button
                      type="button"
                      aria-label="Confirm archive"
                      onClick={onArchiveClick}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter' || e.key === ' ') onArchiveClick(e)
                      }}
                      className="grid size-11 place-items-center rounded-md text-status-error transition-colors hover:bg-status-error/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring [&_svg]:size-4"
                    >
                      <Archive aria-hidden />
                    </button>
                  </motion.div>
                ) : (
                  <motion.button
                    key="archive-icon"
                    type="button"
                    aria-label={`Archive ${title}`}
                    onClick={onArchiveClick}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' || e.key === ' ') onArchiveClick(e)
                    }}
                    initial={reduce ? false : { opacity: 0, scale: 0.9 }}
                    animate={{ opacity: 1, scale: 1 }}
                    exit={reduce ? undefined : { opacity: 0, scale: 0.9 }}
                    transition={reduce ? { duration: 0 } : springs.snappy}
                    className="-mr-1 -mt-1 grid size-11 shrink-0 place-items-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring [&_svg]:size-4"
                  >
                    <Archive aria-hidden />
                  </motion.button>
                )
              ) : (
                <motion.span
                  key="status-dot"
                  initial={false}
                  animate={{ opacity: 1 }}
                  className="shrink-0"
                >
                  <StatusDot status={session.status} className="mt-1" />
                </motion.span>
              )}
            </AnimatePresence>
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
                height={LIVE_PREVIEW_H}
                reduce={!!reduce}
                onReady={onLiveReady}
              />
            )}
          </AnimatePresence>
          {/* Stopped peek surface (feat-stopped-peek-actions). Instead of a
              dead live-terminal mount, hover on a stopped tile reveals the
              Start + Archive actions DIRECTLY — same component the focus
              pane uses, so behaviour + visuals stay consistent. Sits OVER
              the dimmed static tail with a frosted scrim so the buttons
              have legible contrast without losing scene continuity. */}
          <AnimatePresence>
            {isStoppedPeek && (
              <motion.div
                key="stopped-actions"
                initial={reduce ? false : { opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={reduce ? undefined : { opacity: 0 }}
                transition={reduce ? { duration: 0 } : springs.snappy}
                className="absolute inset-0 z-10 flex items-center justify-center bg-card/85 backdrop-blur-sm"
              >
                <StoppedSessionActions
                  name={session.name}
                  compact
                  onAfterArchive={() => setHovered(false)}
                  onResumeOpenChange={setResumePickerOpen}
                  triggerRef={stoppedActionsRef}
                />
              </motion.div>
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
    </motion.div>
  )
}

// ── Peek crossfade layer (polish-pass #2) ─────────────────────────────────────
//
// Owns the local `liveReady` state so it auto-resets on each fresh mount via
// React's standard component lifecycle (no setState-in-effect lint friction,
// no synchronous setState during render). Mounts immediately so the underlying
// WS starts — but stays opacity:0 UNTIL the first real pty frame arrives, so
// the tile never flashes a blank-black void during the WS handshake. Crossfade
// IN is short (~120-180ms via springs.snappy); under Reduce Motion the swap is
// instant. The static tail underneath stays at full opacity throughout.
//
// DISMISSAL (no `exit` opacity tween). When the peek closes (hover-out without
// typing, or stickiness timer expiry) we DO NOT crossfade the live layer back
// out. Reason: the static tail sits BEHIND this layer, so an opacity 1 → 0
// spring on the live surface would visually BLEND the two — the user sees a
// transient half-transparent state of "live terminal + tail showing through"
// before the layer fully unmounts. That double-image is the bug the user
// reported ("eerst naar soort halve transparant state, voordat hij echt weg
// gaat"). Instead, the live layer unmounts atomically while the container's
// height spring (springs.cardExpand) and the card's hover-scale revert
// (springs.tileHover) carry the dismissal as a SINGLE motion. Net effect:
// one clean shrink, no half-transparent flash — same vibe as pre-polish-pass.
//
// BOTTOM-ANCHOR + FIXED FINAL HEIGHT (fix-peek-render). The wrapper is NOT
// `absolute inset-0` — that would make xterm's FitAddon snap its grid to the
// *animating* parent height (small mid-spring), and the debounced ResizeObserver
// only catches up at the end → the user saw the terminal render at the TOP with
// empty space below, then "jump to bottom" when the spring finished. Instead we
// pin to the bottom of the container at its FINAL height (`height` prop =
// LIVE_PREVIEW_H) from t=0. The parent's `overflow-hidden` naturally reveals
// the bottom portion of the live terminal as the container grows — which IS
// the natural direction for a terminal (new lines push old up, bottom-anchored
// buffer). FitAddon runs once at the final size, never mid-animation.
function LivePeekLayer({
  name,
  width,
  height,
  reduce,
  onReady,
}: {
  name: string
  width: number
  height: number
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
      // No `exit` — intentional. See block comment above: an opacity tween
      // on dismissal would blend the live surface with the static tail behind
      // it, producing the "half-transparent intermediate" state. AnimatePresence
      // still unmounts the layer (just without a custom exit animation).
      transition={reduce ? { duration: 0 } : springs.snappy}
      className="absolute inset-x-0 bottom-0"
      style={{ height }}
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
