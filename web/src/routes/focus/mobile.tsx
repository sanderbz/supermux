// MobileFocus — M15 focus-mode mobile route (TECH_PLAN §4.4 mobile, §4.4.1).
//
// Composes the hero mobile interaction around the M13 LiveTerminal:
//   <MobileSheet>            ← Vaul drag-detent sheet (peek 40% / full 100%)
//     <FocusHeader minimal />← 44px top bar
//     <LiveTerminal />       ← the M13 terminal (flex-1) — REUSED, not rebuilt
//     <MobileDock />         ← session-pill + kbd + specials + input + send
//   <SessionPickerSheet />   ← Vaul half-sheet (full list)
//   <SpecialsSheet />        ← Vaul half-sheet (kbd-groups 2×2 pager)
//   edge-of-next peek         ← left-edge drag reveals the next session
//
// Edge gestures (CEO M15 amplification): left-edge swipe-right → overview;
// right-edge swipe-left → next session (pinned-then-active order). The left-edge
// drag renders a live peek-of-next that springs back below 40% width.
//
// Single source of truth: the terminal handle from <LiveTerminal onReady> drives
// EVERY key path (dock send, specials, joystick) — the same `useLiveTerm` the
// desktop tile/focus use. No duplicate WS, no second xterm. The auth token is
// never referenced here; it lives in `window._AMUX_AUTH_TOKEN` (env.ts).

import * as React from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { AnimatePresence, motion, useReducedMotion } from 'framer-motion'

import { useNavigateMorph } from '@/components/view-transitions/morph'

import { LiveTerminal } from '@/components/terminal/live-terminal'
import { Joystick } from '@/components/joystick/joystick'
import type { UseLiveTermResult } from '@/hooks/use-live-term'
import { useSessions } from '@/hooks/use-sessions'
import type { ApiSession, SessionStatus } from '@/lib/api'
import { springs } from '@/lib/springs'
import { StatusDot } from '@/components/session-tile/status-dot'

import { MobileSheet } from '@/components/focus-mode/mobile-sheet'
import { FocusHeader } from '@/components/focus-mode/focus-header'
import { MobileDock } from '@/components/focus-mode/dock'
import { SessionPickerSheet } from '@/components/focus-mode/session-picker-sheet'
import { SpecialsSheet } from '@/components/focus-mode/specials-sheet'
import { SnippetPanel } from '@/components/snippets/snippet-panel'
import { useEdgeGestures } from '@/components/focus-mode/use-edge-gestures'
import { neighborSession } from '@/components/focus-mode/session-order'

/** Synthesize a minimal session from the route param so the terminal mounts even
 *  before the (M12) sessions query has delivered this row. */
function placeholderSession(name: string): ApiSession {
  return {
    name,
    status: 'idle' as SessionStatus,
    dir: '',
    provider: '',
    preview_lines: [],
    updated_at: '',
  }
}

// Self-contained route component (reads the `:name` param like M14's
// <DesktopFocus />) so the focus.tsx fork can call it with no props.
export function MobileFocus() {
  const { name = '' } = useParams()
  const navigate = useNavigate()
  // View-Transition navigate (§M23a): used by the discrete back-button tap so
  // it plays the reverse tile↔header morph. The left-edge SWIPE keeps the plain
  // `navigate` — its own peek-of-next drag IS the iOS-native back transition,
  // and a View Transition would fight the live drag transform.
  const navigateMorph = useNavigateMorph()
  const reduceMotion = useReducedMotion()
  const { sessions } = useSessions()

  const current =
    sessions.find((s) => s.name === name) ?? placeholderSession(name)

  const next = React.useMemo(
    () => neighborSession(sessions, name, 1),
    [sessions, name],
  )
  const prev = React.useMemo(
    () => neighborSession(sessions, name, -1),
    [sessions, name],
  )

  // Imperative terminal handle — the ONE surface every key path drives.
  const termRef = React.useRef<UseLiveTermResult | null>(null)
  // M18: the composer registers its `insert` here so the snippet panel can
  // tap-to-insert a snippet body into the dock's input without prop-drilling.
  const composerInsert = React.useRef<((text: string) => void) | null>(null)
  const registerInsert = React.useCallback(
    (fn: ((text: string) => void) | null) => {
      composerInsert.current = fn
    },
    [],
  )

  const [pickerOpen, setPickerOpen] = React.useState(false)
  const [specialsOpen, setSpecialsOpen] = React.useState(false)
  const [snippetsOpen, setSnippetsOpen] = React.useState(false)
  // M17 — joystick on/off. The M16 accessory bar's "Gesture" toggle flips this
  // via `onGestureToggle`; default ON (joystick wins, per the Termius spec).
  const [gestureOn, setGestureOn] = React.useState(true)
  void setGestureOn // wired by M16's accessory bar; kept for the toggle handoff

  const goSession = React.useCallback(
    (target: string) => navigate(`/focus/${encodeURIComponent(target)}`),
    [navigate],
  )
  const goOverview = React.useCallback(() => navigate('/'), [navigate])
  // Back-button tap → reverse morph; the edge-swipe path still uses `goOverview`.
  const goOverviewMorph = React.useCallback(
    () => navigateMorph('/'),
    [navigateMorph],
  )

  // Edge gestures — disable while a half-sheet is open so they don't double-fire.
  const edge = useEdgeGestures({
    enabled: !pickerOpen && !specialsOpen,
    onSwipeRight: goOverview,
    onSwipeLeft: () => next && goSession(next.name),
    resolveNext: () => next,
  })

  return (
    <>
      {/* Left-edge peek-of-next: the next session's title + status dot revealed
          beneath the dragging view (springs back below the 40% threshold; the
          actual navigate is committed by useEdgeGestures). */}
      <AnimatePresence>
        {edge.dragging && edge.nextSession && (
          <PeekOfNext session={edge.nextSession} />
        )}
      </AnimatePresence>

      <motion.div
        // The whole focus surface tracks the left-edge drag so the peek-of-next
        // reads as "the next session sliding in behind."
        style={{ x: edge.peekX }}
        transition={reduceMotion ? { duration: 0 } : springs.sheetDetent}
        className="h-full w-full"
      >
        <MobileSheet onDismiss={goOverview}>
          <FocusHeader
            name={current.name}
            status={current.status}
            onBack={goOverviewMorph}
            onOverflow={() => setPickerOpen(true)}
          />

          {/* M17 — the LiveTerminal with the joystick + 2-finger gesture
              overlay layered on top. `relative` so the absolute overlay scopes
              to the terminal viewport (excludes header/dock). The overlay
              drives the SAME `termRef` handle the dock uses — no second WS. */}
          <div className="relative min-h-0 flex-1">
            <LiveTerminal
              name={name}
              onReady={(t) => (termRef.current = t)}
            />
            <Joystick
              enabled={gestureOn}
              sendKey={(key) => termRef.current?.sendKey(key)}
            />
          </div>

          <MobileDock
            current={current}
            prevSession={prev}
            nextSession={next}
            onOpenPicker={() => setPickerOpen(true)}
            onOpenSpecials={() => setSpecialsOpen(true)}
            onOpenSnippets={() => setSnippetsOpen(true)}
            onSwitchSession={goSession}
            onSend={(text) => termRef.current?.send(text)}
            registerInsert={registerInsert}
          />
        </MobileSheet>
      </motion.div>

      <SessionPickerSheet
        open={pickerOpen}
        onOpenChange={setPickerOpen}
        sessions={sessions}
        current={name}
        onPick={goSession}
      />

      <SpecialsSheet
        open={specialsOpen}
        onOpenChange={setSpecialsOpen}
        onKey={(key) => termRef.current?.sendKey(key)}
      />

      <SnippetPanel
        open={snippetsOpen}
        onOpenChange={setSnippetsOpen}
        onInsert={(body) => composerInsert.current?.(body)}
        onRun={(body) => termRef.current?.send(body + '\r')}
      />
    </>
  )
}

/** Peek-of-next preview pinned to the right edge during a left-edge drag. */
function PeekOfNext({ session }: { session: ApiSession }) {
  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      transition={springs.smooth}
      className="pointer-events-none fixed right-3 top-1/2 z-40 flex -translate-y-1/2 items-center gap-2 rounded-full border border-border/60 glass px-3 py-2"
    >
      <StatusDot status={session.status} />
      <span className="max-w-[40vw] truncate text-[13px] font-medium">
        {session.name}
      </span>
    </motion.div>
  )
}

export default MobileFocus
