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
import type { UseLiveTermResult } from '@/hooks/use-live-term'
import type { TileSession } from '@/components/session-tile/types'
import { CompactTile } from './compact-tile'
import { DesktopFocusHeader } from './focus-header'
import { DesktopDock } from './dock'
import { useKeyboardCapture } from './use-keyboard-capture'
import { SnippetPanel } from '@/components/snippets/snippet-panel'

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
  /** ⌘K palette / "/" slash / "+" snippet hooks — wired by M18 downstream. */
  onPalette?: () => void
  onSlash?: () => void
  onSnippets?: () => void
}

export function DesktopSplit({
  name,
  sessions,
  current,
  onSelect,
  onDetach,
  onStop,
  onPalette,
  onSlash,
  onSnippets,
}: DesktopSplitProps) {
  // One imperative LiveTerminal handle, shared by the dock chips + the keyboard
  // shortcuts. Captured via the M13 `onReady` callback — no re-subscribe.
  const termRef = React.useRef<UseLiveTermResult | null>(null)

  // M18 snippet panel — the dock's "+" button opens it; desktop has no separate
  // text composer, so both tap-insert and long-press-run send straight to xterm.
  const [snippetsOpen, setSnippetsOpen] = React.useState(false)

  // Jump to the N-th (0-indexed) strip row — Cmd+1..9.
  const jump = React.useCallback(
    (index: number) => {
      const target = sessions[index]
      if (target && target.name !== name) onSelect(target.name)
    },
    [sessions, name, onSelect],
  )

  // The single document-level keydown capture (PRINCIPLE). All non-shortcut keys
  // pass straight through to xterm.
  useKeyboardCapture({
    onPalette: () => onPalette?.(),
    onDetach,
    onStop,
    onJump: jump,
  })

  const status = current?.status ?? 'starting'
  const title = current?.task_summary || name

  return (
    <div className="flex h-full w-full bg-background">
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
          onDetach={onDetach}
          onStop={onStop}
        />

        <div className="min-h-0 flex-1">
          {/* M13 LiveTerminal — reused verbatim. The keydown capture deliberately
              does NOT preventDefault on ordinary keys, so Ctrl-C / arrows / Tab /
              Shift+Tab / Esc / text all reach xterm's onData → the M4 pty WS. */}
          <LiveTerminal name={name} onReady={(t) => (termRef.current = t)} />
        </div>

        <DesktopDock
          onSendKey={(label) => termRef.current?.sendKey(label)}
          onPalette={onPalette}
          onSlash={onSlash}
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
    </div>
  )
}

export default DesktopSplit
