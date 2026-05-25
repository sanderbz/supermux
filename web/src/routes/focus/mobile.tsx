// MobileFocus — M15 focus-mode mobile route (TECH_PLAN §4.4 mobile, §4.4.1).
//
// Composes the hero mobile interaction around the M13 LiveTerminal:
//   <MobileSheet>            ← Vaul drag-detent sheet (peek 40% / full 100%),
//                              its height driven by useKeyboardViewport so it
//                              shrinks to sit ABOVE the soft keyboard (no page slide)
//     <FocusHeader minimal />← 44px top bar
//     <LiveTerminal />       ← the M13 terminal (flex-1) — REUSED, the LIVE-TYPE
//                              keystroke-capture (tap focuses it → keyboard up)
//     <MobileDock />         ← accessory bar: session-pill + ⌨ + slash + specials
//                              + snippets + dictate + keyboard-pinned key strip
//                              (Esc/Tab/^C/arrows). NO text composer (live-type).
//   <SessionPickerSheet />   ← Vaul half-sheet (full list)
//   <QuickKeysSheet /> + <SnippetPanel />
//                            ← the two action panels, both hosted in the ONE
//                              shared Vaul shell (<MobileActionSheet>) so dots/+
//                              share one quirk-free sheet. (DOCK: the slash sheet
//                              was removed — slash commands now run from the
//                              Claude Tools sheet's Commands tab.)
//   edge-of-next peek         ← left-edge drag reveals the next session
//
// Edge gestures (CEO M15 amplification): left-edge swipe-right → overview;
// right-edge swipe-left → next session (pinned-then-active order). The left-edge
// drag renders a live peek-of-next that springs back below 40% width.
//
// Single source of truth: the terminal handle from <LiveTerminal onReady> drives
// EVERY key path (dock send, specials, joystick) — the same `useLiveTerm` the
// desktop tile/focus use. No duplicate WS, no second xterm. The auth token is
// never referenced here; it lives in `window._SUPERMUX_AUTH_TOKEN` (env.ts).

import * as React from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { AnimatePresence, motion, useReducedMotion } from 'framer-motion'

import { useNavigateMorph } from '@/components/view-transitions/morph'

import { LiveTerminal } from '@/components/terminal/live-terminal'
import { StoppedSession } from '@/components/terminal/stopped-session'
import { Joystick } from '@/components/joystick/joystick'
import type { UseLiveTermResult } from '@/hooks/use-live-term'
import { useSessions } from '@/hooks/use-sessions'
import type { ApiSession, SessionStatus } from '@/lib/api'
import { springs } from '@/lib/springs'
import { StatusDot } from '@/components/session-tile/status-dot'

import { MobileSheet } from '@/components/focus-mode/mobile-sheet'
import { FocusHeader } from '@/components/focus-mode/focus-header'
import { MobileDock } from '@/components/focus-mode/dock'
import { useKeyboardViewport } from '@/hooks/use-keyboard-viewport'
import { SessionPickerSheet } from '@/components/focus-mode/session-picker-sheet'
import { QuickKeysSheet } from '@/components/focus-mode/quick-keys-sheet'
import { SnippetPanel } from '@/components/snippets/snippet-panel'
import { MobileComposeSheet } from '@/components/focus-mode/mobile-compose-sheet'
import { useExternalEdit } from '@/components/focus-mode/use-external-edit'
import { SessionInfoPanel } from '@/components/focus-mode/session-info-panel'
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
  // Auto-focus the terminal on session entry (polish-pass #4) so keystrokes
  // (hardware keyboard, or the iOS soft keyboard once the user taps in) route
  // to xterm IMMEDIATELY — the focus pane is the terminal, not the dock
  // input. Re-armed per session-name change so jumping sessions follows focus.
  //
  // DEPS — `name` only. Mirrors the desktop fix: agent status flips many times
  // during a session, and each flip re-firing `term.focus()` could synchronously
  // emit a focusin event whose reporting bytes (`\x1b[I` under DECSET ?1004)
  // land back at the pty as part of the phantom-Enter symptom path. Status
  // changes don't warrant re-focusing the terminal.
  const wantFocusRef = React.useRef(false)
  React.useEffect(() => {
    if (current.status === 'stopped' || current.status === 'error') {
      wantFocusRef.current = false
      return
    }
    wantFocusRef.current = true
    const raf = window.requestAnimationFrame(() => {
      if (wantFocusRef.current && termRef.current) {
        termRef.current.focus()
        wantFocusRef.current = false
      }
    })
    return () => window.cancelAnimationFrame(raf)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [name])
  const onTermReady = React.useCallback((t: UseLiveTermResult) => {
    termRef.current = t
    if (wantFocusRef.current) {
      wantFocusRef.current = false
      t.focus()
    }
  }, [])

  // ── Keyboard-viewport layout (the "page slides weirdly" fix) ────────────────
  // visualViewport drives the sheet's exact height so the terminal shrinks to
  // sit DIRECTLY above the soft keyboard (no page scroll), and the accessory
  // dock rides the keyboard top. No-op on desktop / closed keyboard (height is
  // null → the sheet falls back to its 100dvh CSS height).
  const {
    height: vvHeight,
    keyboardInset,
    keyboardOpen,
  } = useKeyboardViewport()

  // Imperative summon/dismiss of the keyboard. Tapping the terminal must focus
  // xterm INSIDE the user gesture (iOS only opens the keyboard on a real touch),
  // so these are passed to both the terminal pane tap-handler and the dock's
  // ⌨ toggle / accessory strip. xterm is the single keyboard owner — no dock
  // textarea to compete (LIVE-TYPE).
  const focusTerm = React.useCallback(() => termRef.current?.focus(), [])
  const blurTerm = React.useCallback(() => termRef.current?.blur(), [])

  // ── Tap-vs-swipe gate for the terminal body (mobile keyboard fix) ───────────
  // The terminal body now scrolls its scrollback on a one-finger swipe (R5). But
  // focusing xterm on EVERY pointer-up also summoned the iOS soft keyboard at the
  // END of a scroll gesture. So we only focus on a genuine TAP: same pointer,
  // tiny movement (< slop), short duration. A swipe (movement) just scrolls —
  // xterm's `.xterm-viewport` already handled it — and never opens the keyboard.
  //
  // A second pointer going down (multi-touch, e.g. the joystick's 2-finger
  // gesture) INVALIDATES the candidate so an armed gesture is never a "tap".
  const TAP_SLOP_PX = 10 // max total finger travel that still counts as a tap
  const TAP_MAX_MS = 500 // max press duration that still counts as a tap
  const tapRef = React.useRef<{
    x: number
    y: number
    t: number
    id: number
  } | null>(null)
  const onTermPointerDown = React.useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      // A second concurrent pointer = multi-touch → not a tap. Invalidate.
      if (tapRef.current && tapRef.current.id !== e.pointerId) {
        tapRef.current = null
        return
      }
      tapRef.current = {
        x: e.clientX,
        y: e.clientY,
        t: Date.now(),
        id: e.pointerId,
      }
    },
    [],
  )
  const onTermPointerUp = React.useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      const cand = tapRef.current
      tapRef.current = null
      if (!cand || cand.id !== e.pointerId) return // multi-touch / no candidate
      const dist = Math.hypot(e.clientX - cand.x, e.clientY - cand.y)
      const elapsed = Date.now() - cand.t
      const isTap = dist < TAP_SLOP_PX && elapsed < TAP_MAX_MS
      // A genuine tap = "I want to type" → focus xterm so iOS raises the keyboard
      // INSIDE this user gesture. A swipe just scrolled the scrollback — do
      // nothing (no keyboard). Stopped sessions never focus.
      if (isTap && current.status !== 'stopped') focusTerm()
    },
    [current.status, focusTerm],
  )
  const onTermPointerCancel = React.useCallback(() => {
    tapRef.current = null
  }, [])
  // M18: the dock registers its `insert` here so the snippet panel can
  // tap-to-insert a snippet body without prop-drilling. Post LIVE-TYPE the dock's
  // `insert` sends the body STRAIGHT to the terminal (no composer buffer).
  const composerInsert = React.useRef<((text: string) => void) | null>(null)
  const registerInsert = React.useCallback(
    (fn: ((text: string) => void) | null) => {
      composerInsert.current = fn
    },
    [],
  )

  // Stream literal text into the pty — the one send path the dock, snippets,
  // dictation, and the compose sheet all funnel through.
  const sendToTerm = React.useCallback(
    (text: string) => termRef.current?.send(text),
    [],
  )

  const [pickerOpen, setPickerOpen] = React.useState(false)
  const [specialsOpen, setSpecialsOpen] = React.useState(false)
  const [snippetsOpen, setSnippetsOpen] = React.useState(false)
  // The on-demand native EDITOR sheet (feat-edit-in-native-editor). The dock's
  // bottom-left Edit field is its trigger: tapping it sends Ctrl+G to the pty,
  // Claude lifts its current `❯` input into the supermux bridge, and the sheet
  // opens on the `external-edit` SSE event PRE-FILLED with that buffer. Save writes
  // the edited text back to Claude's buffer (no auto-submit). Live-type + the
  // accessory strip remain the default for interactive TUIs — this is additive.
  const edit = useExternalEdit(name)
  // Tap the Edit field → Ctrl+G (the EDIT trigger). We do NOT open the sheet here;
  // it opens when Claude's bridge fires the SSE event with the real buffer.
  const onEdit = React.useCallback(
    () => termRef.current?.sendKey('Ctrl-G'),
    [],
  )
  // feat-session-info — the title-click info panel (a bottom Sheet on mobile).
  const [infoOpen, setInfoOpen] = React.useState(false)
  // DOCK — the slash panel was removed: slash commands now run from the Claude
  // Tools sheet's Commands tab (tap a command → it runs in the focused terminal).
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
        <MobileSheet
          onDismiss={goOverview}
          contentHeight={vvHeight}
          keyboardInset={keyboardInset}
        >
          {/* R5 — the title-bar "···" overflow was removed: it opened the SAME
              SessionPickerSheet the bottom-left session pill already opens (the
              pill is the richer, more discoverable affordance — name + status +
              swipe). Dropping the redundant dots clears the naming confusion so
              the only "dots" left is the bottom Specials/Quick-keys trigger. */}
          <FocusHeader
            name={current.name}
            status={current.status}
            activity={current.activity}
            error={current.error}
            mode={current.mode}
            provider={current.provider}
            onBack={goOverviewMorph}
            onTitleClick={() => setInfoOpen(true)}
          />

          {/* M17 — the LiveTerminal with the joystick + 2-finger gesture
              layered on top. `relative` so the joystick's absolute layer scopes
              to the terminal viewport (excludes header/dock). The joystick
              drives the SAME `termRef` handle the dock uses — no second WS.

              R5 SCROLL FIX — the joystick no longer blankets the terminal with a
              `touch-none` capturing overlay (that ate every touch before xterm's
              own scroll handler ran). It now observes pointer gestures via
              NON-blocking listeners on this wrapper and only captures once ARMED,
              so a plain one-finger drag falls through to `.xterm-viewport` and
              pans the scrollback natively. See joystick.tsx.

              `data-vaul-no-drag` (kept — still load-bearing): Vaul wires drag on
              the whole Drawer.Content, so a downward swipe over the terminal
              would otherwise drag the SHEET to dismiss instead of scrolling
              scrollback. This attr makes Vaul's `shouldDrag` short-circuit for
              touches starting in the terminal body, releasing the gesture to
              xterm (`.xterm-viewport` gets `touch-action: pan-y` in globals.css).
              The FocusHeader/handle + MobileDock sit OUTSIDE this region, so
              drag-the-header-to-dismiss is unchanged. */}
          <div
            className="relative min-h-0 flex-1"
            data-vaul-no-drag
            // Tap-to-focus (LIVE-TYPE): a genuine TAP anywhere in the terminal
            // body focuses xterm INSIDE the touch gesture so iOS summons the soft
            // keyboard reliably (it only opens the keyboard on a real user
            // gesture; a deferred/rAF focus is silently ignored). A SWIPE just
            // scrolls the scrollback (xterm's `.xterm-viewport` handled it) and
            // must NOT raise the keyboard — so we gate focus behind tap detection
            // (onTermPointerDown/Up: same pointer, <10px travel, <500ms). We use
            // pointer events (not onClick) so it fires for the actual touch even
            // if xterm's own pointer handling stops the click; harmless on mouse.
            onPointerDown={onTermPointerDown}
            onPointerUp={onTermPointerUp}
            onPointerCancel={onTermPointerCancel}
          >
            {current.status === 'stopped' ? (
              /* The session's tmux pty is gone — render the calm stopped state
                 instead of mounting a live WS that would 101-upgrade then get
                 closed in a no-backoff loop. No joystick: nothing to drive. */
              <StoppedSession name={name} />
            ) : (
              <>
                {/* Pass the session's cached last-screen capture so the terminal
                    shows the CURRENT screen INSTANTLY on open (no blank, no
                    replay scroll), then crossfades to the live xterm. The
                    `current` row is the shared SSE-merged source the overview
                    tiles render, so the static screen matches what the user just
                    tapped (cached-tail crossfade). */}
                <LiveTerminal
                  name={name}
                  onReady={onTermReady}
                  previewAnsi={current.preview_ansi}
                  previewLines={current.preview_lines}
                />
                <Joystick
                  enabled={gestureOn}
                  sendKey={(key) => termRef.current?.sendKey(key)}
                />
              </>
            )}
          </div>

          {/* The M16 swipeable kbd-accessory bar (formerly mounted here) was
              removed in the mobile-finishing pass: it sat ABOVE the MobileDock
              as a second toolbar, and its Pager chips no-op'd silently because
              the terminal imperative handle wasn't registered until after the
              terminal mounted via onTermReady — leaving users tapping a dead
              bar. The lower MobileDock already covers the same shortcuts
              (keyboard toggle, specials/SpecialsSheet, snippets, send),
              and `kbdGroups` are still exposed via the "···" Specials sheet
              below. Clean removal — no orphaned import. */}

          <MobileDock
            current={current}
            prevSession={prev}
            nextSession={next}
            onOpenPicker={() => setPickerOpen(true)}
            onOpenSpecials={() => setSpecialsOpen(true)}
            onOpenSnippets={() => setSnippetsOpen(true)}
            onEdit={onEdit}
            editOpen={edit.open}
            onSwitchSession={goSession}
            onSend={sendToTerm}
            onSendKey={(key) => termRef.current?.sendKey(key)}
            onFocusTerm={focusTerm}
            onBlurTerm={blurTerm}
            keyboardOpen={keyboardOpen}
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

      {/* DOCK — the action panels share the one Vaul shell
          (<MobileActionSheet>): the quick-keys sheet (was SpecialsSheet) and the
          snippets sheet. Each opens with a backdrop + tap-away + drag-down
          dismiss; only their CONTENT differs. (The slash sheet was removed —
          slash commands now run from the Claude Tools sheet's Commands tab.) */}
      <QuickKeysSheet
        open={specialsOpen}
        onOpenChange={setSpecialsOpen}
        onKey={(key) => termRef.current?.sendKey(key)}
        onSend={(text) => termRef.current?.send(text)}
      />

      <SnippetPanel
        open={snippetsOpen}
        onOpenChange={setSnippetsOpen}
        onInsert={(body) => composerInsert.current?.(body)}
        onRun={(body) => termRef.current?.send(body + '\r')}
      />

      {/* The on-demand native EDITOR sheet (feat-edit-in-native-editor) — morphs
          from the dock Edit field via a shared `layoutId`. It opens PRE-FILLED with
          Claude's current `❯` input (delivered over the `external-edit` SSE event)
          and on Save writes the edited text (+ any attachment path) back into
          Claude's input buffer via the submit endpoint — NO Enter, so the user
          submits with Enter themselves. A dismiss cancels (buffer left unchanged). */}
      <MobileComposeSheet
        open={edit.open}
        onOpenChange={edit.setOpen}
        buffer={edit.buffer}
        onSave={edit.save}
      />

      {/* feat-session-info — the title-click info panel (bottom Sheet on mobile).
          Cloning an agent navigates to its focus route via `goSession`. The
          panel's content only mounts while open (Vaul unmounts when closed). */}
      <SessionInfoPanel
        name={name}
        open={infoOpen}
        onOpenChange={setInfoOpen}
        onNavigate={goSession}
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
