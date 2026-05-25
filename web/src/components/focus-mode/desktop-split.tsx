// DesktopSplit — M14 (TECH_PLAN §4.4 desktop + §4.4.3 dock).
//
// The desktop focus mode: a two-column flex — a 320px session-strip on the left
// (vertical scroll of <CompactTile>, current row highlighted via a spring), and
// a flex-1 main pane on the right (FocusHeader 44px / LiveTerminal flex-1 /
// DesktopDock 56px).
//
// Keyboard capture lives here: a document-level keydown listener (useKeyboard
// capture) intercepts ONLY ⌘K / ⌘D / ⌘W / ⌘1..9; all other keys flow to the
// xterm (M13 LiveTerminal) untouched. The dock send-row chips and the keyboard
// shortcuts share one imperative LiveTerminal handle captured via `onReady`.
//
// The LiveTerminal (M13) is REUSED verbatim — we do not reimplement xterm. The
// session-strip reuses the overview `TileSession` data via `useFocusSessions`
// (single source of truth — no second fetch, WebSocket/SSE-driven downstream).

import * as React from 'react'

import { LiveTerminal } from '@/components/terminal/live-terminal'
import { StoppedSession } from '@/components/terminal/stopped-session'
import type { UseLiveTermResult } from '@/hooks/use-live-term'
import type { TileSession } from '@/components/session-tile/types'
import { CompactTile } from './compact-tile'
import { DesktopFocusHeader } from './focus-header'
import { DesktopDock } from './dock'
import { TerminalCaptureIndicator } from './terminal-capture-indicator'
import { useKeyboardCapture } from './use-keyboard-capture'
import { SnippetPanel } from '@/components/snippets/snippet-panel'
import { SessionInfoPanel } from './session-info-panel'

export interface DesktopSplitProps {
  /** Focused session name (route param). */
  name: string
  /** The strip rows — canonical session list (single source). */
  sessions: TileSession[]
  /** The focused row (may be null before the store resolves). */
  current: TileSession | null
  /** Navigate to another focus route (Cmd+1..9 + compact-tile click). */
  onSelect: (name: string) => void
  /** Detach (⌘D): leave to overview, keep the session alive. */
  onDetach: () => void
  /** Stop (⌘W): stop the session, then leave. */
  onStop: () => void
  /** Optional hook to open the snippet drawer from the parent (the dock owns its
   *  own state too; this is just for route-level openers). */
  onSnippets?: () => void
}

export function DesktopSplit({
  name,
  sessions,
  current,
  onSelect,
  onDetach,
  onStop,
  onSnippets,
}: DesktopSplitProps) {
  // One imperative LiveTerminal handle, shared by the dock chips + the keyboard
  // shortcuts. Captured via the M13 `onReady` callback — no re-subscribe.
  const termRef = React.useRef<UseLiveTermResult | null>(null)
  // The pane that wraps xterm — used as the DOM-focus anchor for the capture
  // indicator: when focus moves anywhere INSIDE this subtree (xterm's hidden
  // textarea, the read-only screen) the indicator shows; click outside (the
  // dock, the session strip, the header) releases.
  const termPaneRef = React.useRef<HTMLDivElement | null>(null)
  // Live capture indicator (polish-pass #4) — flips on when the terminal has
  // DOM focus, off when focus moves elsewhere. `focusin`/`focusout` on the
  // pane subtree is the cleanest signal; xterm's hidden textarea is the
  // focusable element, so the document-level `activeElement` check inside the
  // listener is what actually drives the badge.
  const [capturingInput, setCapturingInput] = React.useState(false)

  // M18 snippet panel — the dock's "+" button opens it; desktop has no separate
  // text composer, so both tap-insert and long-press-run send straight to xterm.
  const [snippetsOpen, setSnippetsOpen] = React.useState(false)

  // feat-session-info — the title-click info panel. `titleRef` is the Popover's
  // anchor (the title <button> in the header); the panel only mounts while open.
  const [infoOpen, setInfoOpen] = React.useState(false)
  const titleRef = React.useRef<HTMLButtonElement>(null)

  // Auto-focus the terminal on session entry (polish-pass #4) so keystrokes go
  // to the terminal IMMEDIATELY — no second click. The flag is armed on mount
  // / on session change, then consumed by either the rAF below (handle already
  // installed) or by <LiveTerminal onReady> (the first onReady AFTER arming).
  // Either path focuses xterm exactly once per session entry, so we never
  // steal focus away from a user who has Tab'd into the dock input.
  //
  // DEPS — `name` only. The polish pass originally also depended on
  // `current?.status`, but agent status flips many times during a session
  // (idle → active → idle on every command), and each flip would re-arm
  // wantFocusRef + re-call `term.focus()`. Refocusing a textarea that is
  // already focused can synchronously fire a focusin event on some browsers,
  // and combined with DECSET ?1004 (focus-event reporting) that emits
  // `\x1b[I` / `\x1b[O` back into the pty — which is half of the path that
  // caused the phantom-Enter symptom. The stopped/error guard is now a check
  // INSIDE the mount-time effect: a stopped session has no pty to focus, but
  // a later transition to stopped doesn't need to re-run anything (the user
  // can re-enter the route to retry).
  const wantFocusRef = React.useRef(false)
  React.useEffect(() => {
    if (current?.status === 'stopped' || current?.status === 'error') {
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

  const handleTermReady = React.useCallback((t: UseLiveTermResult) => {
    termRef.current = t
    // Consume a pending auto-focus request on the first onReady after a
    // mount/session-change — xterm's container is laid out by now, so
    // focus() lands on the real hidden textarea.
    if (wantFocusRef.current) {
      wantFocusRef.current = false
      t.focus()
    }
  }, [])

  // Track DOM focus inside the terminal pane. `focusin` / `focusout` bubble,
  // so one pair of listeners on the pane wrapper catches xterm's hidden
  // textarea (the element that actually receives keys). `focusout` fires
  // BEFORE focus lands, so we re-read `document.activeElement` after a
  // microtask to know whether focus left the subtree entirely.
  React.useEffect(() => {
    const pane = termPaneRef.current
    if (!pane) return
    const refresh = () => {
      const active = document.activeElement
      setCapturingInput(!!active && pane.contains(active))
    }
    const onFocusIn = () => refresh()
    const onFocusOut = () => {
      // Defer to the next tick so the freshly-focused element (if any) is the
      // one we read — `focusout` fires before the new `focusin` lands.
      window.setTimeout(refresh, 0)
    }
    pane.addEventListener('focusin', onFocusIn)
    pane.addEventListener('focusout', onFocusOut)
    return () => {
      pane.removeEventListener('focusin', onFocusIn)
      pane.removeEventListener('focusout', onFocusOut)
    }
  }, [])

  // Jump to the N-th (0-indexed) strip row — Cmd+1..9.
  const jump = React.useCallback(
    (index: number) => {
      const target = sessions[index]
      if (target && target.name !== name) onSelect(target.name)
    },
    [sessions, name, onSelect],
  )

  // The single document-level keydown capture (PRINCIPLE). All non-shortcut keys
  // pass straight through to xterm. ⌘K is intentionally NOT routed through here
  // anymore — the global <CommandPalette> in <Layout> owns the shortcut so it
  // works on every route, not just /focus. We keep the slot for ⌘D / ⌘W / ⌘1-9.
  useKeyboardCapture({
    onDetach,
    onStop,
    onJump: jump,
  })

  const status = current?.status ?? 'starting'
  const title = current?.task_summary || name

  return (
    <div className="flex h-full w-full bg-background" data-testid="desktop-split">
      {/* Left: 320px session-strip (vertical scroll). */}
      <aside className="flex w-80 shrink-0 flex-col border-r border-border bg-background/60">
        <div className="flex h-11 shrink-0 items-center px-3 text-[13px] font-semibold tracking-tight text-muted-foreground">
          Sessions
        </div>
        <div className="min-h-0 flex-1 space-y-1.5 overflow-y-auto px-3 pb-3">
          {sessions.length === 0 ? (
            <p className="px-1 pt-2 text-[13px] text-muted-foreground">
              No other sessions.
            </p>
          ) : (
            sessions.map((s) => (
              <CompactTile
                key={s.name}
                session={s}
                current={s.name === name}
                onSelect={onSelect}
              />
            ))
          )}
        </div>
      </aside>

      {/* Right: main pane — header / terminal / dock. */}
      <main className="flex min-w-0 flex-1 flex-col">
        <DesktopFocusHeader
          name={name}
          title={title}
          status={status}
          activity={current?.activity}
          error={current?.error}
          mode={current?.mode}
          provider={current?.provider}
          onDetach={onDetach}
          onStop={onStop}
          // Open only — Radix closes the popover on outside-click / Escape, so a
          // toggle here would race its onOpenChange(false) and re-open it.
          onTitleClick={() => setInfoOpen(true)}
          titleRef={titleRef}
        />

        {/* `relative` so the capture indicator (polish-pass #4) can position
            itself in the top-right corner of the terminal pane WITHOUT
            overlaying the terminal viewport — a small chrome element, not an
            overlay over content. The pane ref is the focus boundary used to
            detect when xterm has DOM focus (focusin/focusout listener). */}
        <div ref={termPaneRef} className="relative min-h-0 flex-1">
          {/* A `stopped` session's tmux pty is gone — opening the live WS would
              just 101-upgrade then get closed in a loop. Detect it up front from
              the session row and render the calm StoppedSession surface instead.
              When it transitions back to running, this swaps to LiveTerminal. */}
          {status === 'stopped' ? (
            <StoppedSession name={name} />
          ) : (
            /* M13 LiveTerminal — reused verbatim. The keydown capture deliberately
               does NOT preventDefault on ordinary keys, so Ctrl-C / arrows / Tab /
               Shift+Tab / Esc / text all reach xterm's onData → the M4 pty WS. */
            <LiveTerminal name={name} onReady={handleTermReady} />
          )}
          {/* Subtle "Capturing input" pill — only visible while xterm holds DOM
              focus. Click outside (header / dock / strip) releases. Esc is NOT
              the release because Esc must reach the terminal (vim, REPLs). */}
          <TerminalCaptureIndicator
            capturing={capturingInput && status !== 'stopped'}
          />
        </div>

        <DesktopDock
          onSendKey={(label) => termRef.current?.sendKey(label)}
          onRunSlash={(cmd) => termRef.current?.send(cmd + '\r')}
          onSnippets={() => {
            onSnippets?.()
            setSnippetsOpen(true)
          }}
          onDetach={onDetach}
          onStop={onStop}
        />
      </main>

      {/* M18 snippet panel — slides up over the dock; tap-insert and long-press
          both fire the snippet body into xterm (no separate composer here). */}
      <SnippetPanel
        open={snippetsOpen}
        onOpenChange={setSnippetsOpen}
        onInsert={(body) => termRef.current?.send(body)}
        onRun={(body) => termRef.current?.send(body + '\r')}
      />

      {/* feat-session-info — the title-click info panel (Popover on desktop). The
          body only mounts while open (PopoverContent portals on open). Cloning an
          agent navigates to its focus route via the route's select handler. */}
      <SessionInfoPanel
        name={name}
        open={infoOpen}
        onOpenChange={setInfoOpen}
        triggerRef={titleRef}
        onNavigate={onSelect}
      />
    </div>
  )
}

export default DesktopSplit
