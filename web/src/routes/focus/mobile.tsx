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
// EVERY key path (dock send, specials, future joystick) — the same `useLiveTerm`
// the desktop tile/focus use. No duplicate WS, no second xterm. The auth token is
// never referenced here; it lives in `window._AMUX_AUTH_TOKEN` (env.ts).

import * as React from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { AnimatePresence, motion, useReducedMotion } from 'framer-motion'

import { LiveTerminal } from '@/components/terminal/live-terminal'
import type { UseLiveTermResult } from '@/hooks/use-live-term'
import { useSessions } from '@/hooks/use-sessions'
import type { ApiSession, SessionStatus } from '@/lib/api'
import { springs } from '@/lib/springs'
import { StatusDot } from '@/components/session-tile/status-dot'

import { MobileSheet } from '@/components/focus-mode/mobile-sheet'
import { FocusHeader } from '@/components/focus-mode/focus-header'
import { MobileDock } from '@/components/focus-mode/dock'
import { AccessoryBar } from '@/components/kbd-accessory/accessory-bar'
import { useKbdGroups } from '@/hooks/use-kbd-groups'
import { SessionPickerSheet } from '@/components/focus-mode/session-picker-sheet'
import { SpecialsSheet } from '@/components/focus-mode/specials-sheet'
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

  const [pickerOpen, setPickerOpen] = React.useState(false)
  const [specialsOpen, setSpecialsOpen] = React.useState(false)

  // M16 — the table-backed kbd-groups, shared so the accessory bar and the
  // SpecialsSheet ("More" all-groups list) render the SAME live groups.
  const { groups: kbdGroups } = useKbdGroups()

  const goSession = React.useCallback(
    (target: string) => navigate(`/focus/${encodeURIComponent(target)}`),
    [navigate],
  )
  const goOverview = React.useCallback(() => navigate('/'), [navigate])

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
            onBack={goOverview}
            onOverflow={() => setPickerOpen(true)}
          />

          <div className="min-h-0 flex-1">
            <LiveTerminal
              name={name}
              onReady={(t) => (termRef.current = t)}
            />
          </div>

          {/* M16 — swipeable kbd-accessory bar, pinned directly above the
              dock so it sits over the keyboard. `onMore` reuses the M15
              SpecialsSheet (all-groups vertical list). The Gesture / slash /
              snippet plug-in props are intentionally left for M17 / M18 to
              wire WITHOUT editing accessory-bar.tsx (§29 dep-graph fix). */}
          <AccessoryBar
            onKey={(key) => termRef.current?.sendKey(key)}
            onBack={goOverview}
            onHideKeyboard={() => {
              const el = document.activeElement
              if (el instanceof HTMLElement) el.blur()
            }}
            onMore={() => setSpecialsOpen(true)}
          />

          <MobileDock
            current={current}
            prevSession={prev}
            nextSession={next}
            onOpenPicker={() => setPickerOpen(true)}
            onOpenSpecials={() => setSpecialsOpen(true)}
            onSwitchSession={goSession}
            onSend={(text) => termRef.current?.send(text)}
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
        groups={kbdGroups}
        onKey={(key) => termRef.current?.sendKey(key)}
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
