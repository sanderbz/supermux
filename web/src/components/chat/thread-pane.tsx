// ThreadPane — the desktop side-panel's chat⇄terminal surface (fase Phase 2).
// ─────────────────────────────────────────────────────────────────────────────
// The grok overview's right pane used to mount the chat renderer ONLY, with the
// terminal as an honest escape that LEFT the roster for /focus ("Phase 1 does
// not reproduce the terminal in the pane"). This is Phase 2: the same live
// terminal the /focus route hosts now lives IN the pane, and the SAME renderer
// switch the mobile seam uses toggles between the two — one toggle component
// (`RendererSwitch`), one mode state (the persisted renderer pref via
// `useRenderer`), and the same mounted-but-hidden retention shell
// (`RendererShell`) that keeps both panes warm across a toggle. Nothing here is
// new machinery; it is `desktop-split.tsx`'s composition, reduced to the two
// panes the side-panel needs.
//
// DRY, said explicitly:
//   · the toggle is `RendererSwitch` (mobile header + focus split + here),
//   · the mode is `useRenderer(name, chatOn, …)` → the ui-store pref, so a pin
//     made here is the same pin the /focus route reads (and vice-versa),
//   · the seam decision is `chatPaneActive` / `terminalPaneMounts`, shared,
//   · the retention + crossfade + focus-eviction is `RendererShell`, unchanged.
//
// It does NOT double-mount the pty: `RendererShell` keeps exactly one
// `LiveTerminal` for `name`, keyed so a session change tears it down, and the
// /focus route is a DIFFERENT route (never mounted at the same time as the
// overview), so there is no second xterm on the same pty.
import * as React from 'react'

import { useUI } from '@/stores/ui-store'
import type { TileSession } from '@/components/session-tile/types'
import type { SessionInput } from '@/lib/session-input'
import type { UseLiveTermResult } from '@/hooks/use-live-term'
import { useTerminalGone } from '@/hooks/use-terminal-gone'
import { LiveTerminal } from '@/components/terminal/live-terminal'
import { StoppedSession } from '@/components/terminal/stopped-session'

import { RendererShell } from '@/components/chat/renderer-shell'
import { RendererSwitch } from '@/components/chat/renderer-switch'
import { useRenderer } from '@/components/chat/use-renderer-pref'
import { chatPaneActive, paneIsDead, terminalPaneMounts } from '@/components/chat/seam'

// Lazy: the chat renderer is its own chunk (perf budget) — the same boundary
// `desktop-split.tsx` and the mobile route keep it behind.
const ChatPanel = React.lazy(() => import('@/components/chat/chat-panel'))

export interface ThreadPaneProps {
  /** The session — also the `key` the shell teardown is anchored to. */
  name: string
  /** The row, as a tile. */
  session: TileSession | null
  /** Chat eligibility — the caller's `useChatRenderer(row)` result (bot mode on
   *  + kill-switch + local-Claude). An ineligible session never gets here (the
   *  roster shows its settings page instead), so this is effectively always
   *  true, but it is threaded so the seam reads the SAME gate everywhere. */
  chatOn: boolean
  /** The raw `/send`·`/paste`·`/keys` plane, memoised by the caller. */
  input?: SessionInput
  /** The pane header's own affordances (the crew chip / settings toggle),
   *  passed through to the chat header card's trailing slot alongside the
   *  renderer switch. */
  headerTrailing?: React.ReactNode
}

/**
 * One session's chat + terminal, toggled in place.
 *
 * The switch is reachable in EXACTLY one place at a time (the mobile seam's own
 * rule, `mobileChrome`): the chat header card's trailing slot while chat is up,
 * a slim row above the terminal while the terminal is up. Never both, so the
 * pane never grows two toolbars.
 */
export function ThreadPane({ name, session, chatOn, input, headerTrailing }: ThreadPaneProps) {
  const status = session?.status ?? 'starting'
  // The socket's own "the pty is gone" conclusion, folded in beside the row's —
  // the seam's "a stopped session is never chat" rule needs both (the same
  // substitution `desktop-split.tsx` and the mobile seam make).
  const { gone: termGone, onTermState } = useTerminalGone(status)
  const stopped = paneIsDead(status, termGone, session?.error?.type)

  const chatSetting = useUI((s) => s.botMode)
  const { resolved: renderer, setPref } = useRenderer(name, chatOn, session != null)

  const chatActive = chatPaneActive(
    chatSetting,
    chatOn,
    renderer,
    stopped ? 'stopped' : status,
  )
  const terminalMounts = terminalPaneMounts(chatSetting, renderer, chatActive)

  // The imperative terminal handle — used only to take the keyboard away when
  // the terminal pane goes invisible (invariant 4), the same `onTerminalHidden`
  // the /focus split passes.
  const termRef = React.useRef<UseLiveTermResult | null>(null)
  const handleTermReady = React.useCallback((t: UseLiveTermResult) => {
    termRef.current = t
  }, [])

  return (
    <div className="gr-pane gr-threadpane" data-shell-pane>
      {stopped ? (
        <StoppedSession name={name} />
      ) : (
        <div className="flex h-full min-h-0 flex-col">
          {/* The switch's terminal-side home: a slim row above the pty, shown
              only while the terminal has the pane (chat's own home is the header
              card below). `chatOn` gates it so an ineligible session can never
              grow a control that would switch it to a renderer it may not have. */}
          {!chatActive && chatOn && (
            <div className="flex h-8 shrink-0 items-center justify-end border-b border-border/60 px-3">
              <RendererSwitch value={renderer ?? 'chat'} onChange={setPref} />
            </div>
          )}

          <RendererShell
            key={name}
            name={name}
            chatActive={chatActive}
            terminalMounts={terminalMounts}
            className="min-h-0 flex-1"
            onTerminalHidden={() => termRef.current?.blur()}
            chat={
              <React.Suspense fallback={<div className="h-full w-full" aria-hidden />}>
                <ChatPanel
                  name={name}
                  session={session}
                  input={input}
                  surface="desktop"
                  // A5: the escape hatch writes a PIN, not a nav — "I switched to
                  // the terminal" is a preference, so the toggle here is the same
                  // `setPref('terminal')` the switch drives (no route change).
                  onOpenTerminal={() => setPref('terminal')}
                  // The switch's chat-side home: the header card's trailing slot,
                  // beside the pane's own affordance (crew chip / settings). Same
                  // component, `size="sm" labels="selected"` — the mobile header
                  // card's exact clothes.
                  headerTrailing={
                    <div className="flex items-center gap-2">
                      <RendererSwitch
                        size="sm"
                        labels="selected"
                        value={renderer ?? 'chat'}
                        onChange={setPref}
                      />
                      {headerTrailing}
                    </div>
                  }
                />
              </React.Suspense>
            }
            terminal={
              // LiveTerminal — reused verbatim and told NOTHING about being
              // hidden (RendererShell invariant 3), so the hidden path is
              // byte-identical to the visible one and cannot rot differently.
              <LiveTerminal name={name} onReady={handleTermReady} onStateChange={onTermState} />
            }
          />
        </div>
      )}
    </div>
  )
}

export default ThreadPane
