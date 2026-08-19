// /dev/browser-takeover — the shared-browser takeover panel, on a bench.
//
// DEV-only + lazy, like every other /dev/* page: neither the route nor its
// fixture reaches the production bundle. Phase 3 puts this surface on the
// connector card; until then this is where it lives, and it is what the
// offline Playwright rig screenshots.
//
//   ?session=NAME  attach to a REAL session's browser context over the live
//                  takeover socket (`/ws/browser/{name}/takeover`).
//   ?mock=1        no server at all: a fake socket replays an authentic
//                  captured JPEG + a HUMAN_DRIVING mode, so the canvas, the
//                  pill and the hand-back button can be driven offline.
//   ?mode=agent    start the mock in AGENT_DRIVING (the read-only state).
//   ?theme=dark    force the dark slab (the rig shoots both).
//   ?overlay=1     render the in-chat TAKEOVER CARD with its overlay already
//                  open on the mock socket — the LIVE driving surface (status
//                  pill, trust line, one hand-back), which the bare panel bench
//                  cannot show because it has no host chrome around it.
import * as React from 'react'

import { TakeoverPanel } from '@/components/browser/takeover-panel'
import { TakeoverCard } from '@/components/chat/ui/takeover-card'
import type { TakeoverOptions } from '@/lib/browser/takeover-socket'

export default function DevBrowserTakeover() {
  const params = new URLSearchParams(
    typeof window === 'undefined' ? '' : window.location.search,
  )
  const session = params.get('session') ?? 'demo'
  const mock = params.get('mock') === '1'
  const agent = params.get('mode') === 'agent'
  const dark = params.get('theme') === 'dark'
  const overlay = params.get('overlay') === '1'

  const [options, setOptions] = React.useState<TakeoverOptions | undefined>(undefined)
  const [ready, setReady] = React.useState(!mock)

  // The fixture carries a 17 KB base64 frame; import it only when the bench
  // actually asks for the offline mode.
  React.useEffect(() => {
    if (!mock) return
    let alive = true
    void import('./dev-browser-takeover.fixture').then((m) => {
      if (!alive) return
      setOptions(m.mockOptions(agent ? 'agent_driving' : 'human_driving'))
      setReady(true)
    })
    return () => {
      alive = false
    }
  }, [mock, agent])

  return (
    <div
      data-theme={dark ? 'dark' : 'light'}
      className={dark ? 'dark min-h-dvh bg-background' : 'min-h-dvh bg-background'}
    >
      <div className="mx-auto flex min-h-dvh max-w-[720px] flex-col gap-4 p-4">
        <h1 className="text-sm font-medium text-foreground">
          Shared browser — takeover {mock ? '(offline bench)' : `· ${session}`}
        </h1>
        <div
          data-vr={`takeover-${dark ? 'dark' : 'light'}${agent ? '-agent' : ''}`}
          className={
            overlay
              ? ''
              : 'h-[520px] overflow-hidden rounded-2xl border border-border shadow-[var(--sm-card-shadow)]'
          }
        >
          {!ready ? null : overlay ? (
            <TakeoverCard
              ask={{
                session,
                reason: 'sign in to bank.example and approve the 2FA push on your phone',
              }}
              botName="Ada"
              panelOptions={options}
              defaultOpen
            />
          ) : (
            <TakeoverPanel session={session} options={options} className="h-full" />
          )}
        </div>
      </div>
    </div>
  )
}
