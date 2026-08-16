// The toggle-thrash bench (fase A5 T6) — DEV ONLY, never a product surface.
//
// `tests/e2e/smoke/chat-toggle-thrash.spec.ts` needs to toggle the renderer a
// hundred times against a REAL pty while it is firehosing, and assert that not
// one byte was lost, no socket was rebuilt and no resize frame was sent. Three
// things make that impossible on the real focus route:
//
//   · the renderer switch only exists for a chat-ELIGIBLE session, and the only
//     provider that qualifies is `claude` — which needs the CLI on the runner,
//     so the spec would skip exactly where it matters most;
//   · a `shell` session gives a DETERMINISTIC firehose (`seq`), which a real
//     Claude pty never will;
//   · the assertion is about the shell's mechanism, not the seam's policy, and
//     mixing the two would make a failure ambiguous.
//
// So this route mounts the REAL `<RendererShell>` with the REAL `<LiveTerminal>`
// in one cell and a cheap stand-in in the other, and exposes `window.__thrash`.
// Everything the spec measures about the SOCKETS it measures itself, by
// patching `window.WebSocket` before boot — this route hands it only the two
// things it cannot see from outside: the toggle, and xterm's column count.
//
// It is registered behind `import.meta.env.DEV` in `App.tsx` (the same lazy
// pattern `/dev/focus`, `/dev/term`, `/dev/tiles` use), so it is absent from a
// production bundle — asserted in T8 (`dist/assets` contains no
// `dev-renderer-thrash`).

import * as React from 'react'
import { useParams } from 'react-router-dom'

import { LiveTerminal } from '@/components/terminal/live-terminal'
import { RendererShell } from '@/components/chat/renderer-shell'
import type { UseLiveTermResult } from '@/hooks/use-live-term'

declare global {
  interface Window {
    __thrash?: {
      /** Flip the visible renderer. Returns the new one. */
      toggle(): 'chat' | 'terminal'
      /** What is visible right now. */
      renderer(): 'chat' | 'terminal'
      /** xterm's current column count — must be identical before and after the
       *  thrash, which is invariant T3.1 restated as a number. */
      cols(): number
      /** Is the terminal pane still in the DOM? (Retention, from the outside.) */
      mounted(): { chat: boolean; terminal: boolean }
    }
  }
}

export default function DevRendererThrash() {
  const { name = '' } = useParams<{ name: string }>()
  const [renderer, setRenderer] = React.useState<'chat' | 'terminal'>('terminal')
  const termRef = React.useRef<UseLiveTermResult | null>(null)
  const [cols, setCols] = React.useState(0)

  const onReady = React.useCallback((t: UseLiveTermResult) => {
    termRef.current = t
  }, [])

  // The handle is a value, not a stream — poll its `cols` so the bench can read
  // the CURRENT fit rather than the one at attach time. 250 ms is far coarser
  // than a resize would be, and this route is never shipped.
  React.useEffect(() => {
    const id = window.setInterval(() => setCols(termRef.current?.cols ?? 0), 250)
    return () => window.clearInterval(id)
  }, [])

  React.useEffect(() => {
    window.__thrash = {
      toggle: () => {
        let next: 'chat' | 'terminal' = 'terminal'
        setRenderer((r) => {
          next = r === 'chat' ? 'terminal' : 'chat'
          return next
        })
        return next
      },
      renderer: () => renderer,
      cols: () => termRef.current?.cols ?? 0,
      mounted: () => ({
        chat: !!document.querySelector('[data-testid="renderer-pane-chat"]'),
        terminal: !!document.querySelector('[data-testid="renderer-pane-terminal"]'),
      }),
    }
    return () => {
      delete window.__thrash
    }
  }, [renderer])

  return (
    <div className="flex h-dvh w-full flex-col bg-paper">
      <div
        data-testid="thrash-status"
        data-renderer={renderer}
        data-cols={cols}
        className="flex h-8 shrink-0 items-center gap-4 border-b border-hairline px-3 text-[12px] text-ink-2"
      >
        <span>{name}</span>
        <span>renderer: {renderer}</span>
        <span>cols: {cols}</span>
      </div>
      <div className="relative min-h-0 flex-1">
        <RendererShell
          key={name}
          name={name}
          // The bench drives the shell with the same two booleans the seams
          // compute — it just computes them from a `useState` instead of from
          // eligibility, which is the only thing that differs from production.
          chatActive={renderer === 'chat'}
          terminalMounts={renderer === 'terminal'}
          onTerminalHidden={() => termRef.current?.blur()}
          chat={
            // Deliberately NOT `<ChatPanel>`: the assertion is about the pty
            // socket, and a second live socket in the other cell would make a
            // WebSocket count ambiguous.
            <div
              data-testid="thrash-chat"
              className="grid h-full w-full place-items-center text-ink-3"
            >
              chat stand-in
            </div>
          }
          terminal={<LiveTerminal name={name} onReady={onReady} />}
        />
      </div>
    </div>
  )
}
