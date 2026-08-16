// /dev/shell — the shell bench (fase B1 T6.5).
//
// DEV-only + lazy, and — unlike the other /dev/* pages — mounted INSIDE a real
// shell of its own rather than on bare paper, because the thing under review IS
// the shell: the painted substrate's three columns, the chrome floors, and
// `<ShellOverlay>` in both variants at the real container-query size.
//
// Every VR shot in B1's gate comes from here, so the page is built to be
// deterministic and URL-driven: each control writes a query param, so a
// screenshot rig can request a state instead of clicking to it.
//
//   ?theme=dark|light     force the theme (also togglable in-page)
//   ?overlay=1            open the overlay
//   ?variant=frame|pane   which overlay form
//   ?keyboard=1           shim `visualViewport` to a keyboard-open viewport
//
// The "fake keyboard" toggle exists because the one thing that breaks a shell
// substrate is invisible until a soft keyboard is up (see
// tests/e2e/smoke/shell-containing-block.spec.ts) and Playwright cannot open
// one.

import * as React from 'react'
import { useSearchParams } from 'react-router-dom'

import { cn } from '@/lib/utils'
import { ShellOverlay } from '@/components/shell/shell-overlay'
import {
  ShellOverlayProvider,
  useShellOverlayProvider,
} from '@/components/shell/use-shell-overlay'
import { frameBinding, frameSize } from '@/components/shell/shell-overlay-frame'
import { isShellSubstrateEnabled } from '@/lib/shell-substrate-flag'

/** Shim `window.visualViewport` to report a keyboard-shrunken viewport. Exactly
 *  the shim the containing-block e2e installs, so the bench and the spec agree
 *  on what "keyboard open" means. */
function useFakeKeyboard(on: boolean, px = 320) {
  React.useEffect(() => {
    const vv = window.visualViewport
    if (!vv || !on) return
    const desc = Object.getOwnPropertyDescriptor(
      Object.getPrototypeOf(vv),
      'height',
    )
    Object.defineProperty(vv, 'height', {
      configurable: true,
      get: () => window.innerHeight - px,
    })
    vv.dispatchEvent(new Event('resize'))
    return () => {
      if (desc) Object.defineProperty(vv, 'height', desc)
      else delete (vv as unknown as Record<string, unknown>).height
      vv.dispatchEvent(new Event('resize'))
    }
  }, [on, px])
}

function Chip({
  active,
  onClick,
  children,
}: {
  active?: boolean
  onClick: () => void
  children: React.ReactNode
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        'rounded-full border border-hairline px-3 py-1 text-xs font-medium transition-colors',
        active ? 'bg-agent/15 text-ink' : 'text-ink-2 hover:text-ink',
      )}
    >
      {children}
    </button>
  )
}

/** An Attention-card-shaped placeholder at the real container-query size. The
 *  master plan's intended first overlay consumer was the Attention card; A4
 *  shipped its attention surface IN-PANE instead, so this stands in for
 *  whatever the next full-fidelity consumer turns out to be, and keeps the
 *  frame honest about the content size it actually has to hold. */
function AttentionShaped() {
  return (
    <div className="flex flex-col gap-3">
      <div className="h-3 w-24 rounded bg-fill-soft-2" />
      <div className="h-2 w-full rounded bg-fill-soft" />
      <div className="h-2 w-5/6 rounded bg-fill-soft" />
      <div className="mt-2 grid gap-2">
        {['Approve the plan', 'Ask for changes', 'Stop here'].map((label) => (
          <div
            key={label}
            className="rounded-xl border border-hairline px-3 py-2 text-sm text-ink"
          >
            {label}
          </div>
        ))}
      </div>
      <div className="mt-2 h-2 w-2/3 rounded bg-fill-soft" />
    </div>
  )
}

export default function DevShell() {
  const [params, setParams] = useSearchParams()
  const theme = params.get('theme') === 'light' ? 'light' : 'dark'
  const overlayOpen = params.get('overlay') === '1'
  const variant = params.get('variant') === 'pane' ? 'pane' : 'frame'
  const keyboard = params.get('keyboard') === '1'
  const [substrate] = React.useState(isShellSubstrateEnabled)
  const [attachHost, hostValue] = useShellOverlayProvider()

  useFakeKeyboard(keyboard)

  const set = (k: string, v: string) => {
    const next = new URLSearchParams(params)
    next.set(k, v)
    setParams(next, { replace: true })
  }

  // What the frame math resolves to for the CURRENT host box — printed on the
  // page so a screenshot carries its own evidence.
  const [box, setBox] = React.useState({ cqw: 0, cqh: 0 })
  const hostEl = hostValue.element
  React.useEffect(() => {
    const el = hostEl
    if (!el) return
    const ro = new ResizeObserver(() => {
      setBox({ cqw: el.clientWidth, cqh: el.clientHeight })
    })
    ro.observe(el)
    return () => ro.disconnect()
  }, [hostEl])

  return (
    <ShellOverlayProvider value={hostValue}>
      <div
        data-theme={theme}
        data-substrate={substrate ? '' : undefined}
        className="flex h-dvh w-full text-ink"
      >
        {/* Nav rail — the substrate's deepest column. */}
        <nav
          aria-label="Primary"
          data-shell-rail=""
          className="hidden w-16 shrink-0 flex-col items-center gap-2 border-r border-border bg-card pb-4 pt-4 md:flex"
        >
          {['◱', '>_', '▤', '▣', '⚙'].map((g, i) => (
            <div
              key={g}
              className={cn(
                'flex size-11 items-center justify-center rounded-xl text-sm',
                i === 0 ? 'bg-agent/20 text-ink' : 'text-ink-3',
              )}
            >
              {g}
            </div>
          ))}
        </nav>

        <div className="flex min-w-0 flex-1 flex-col">
          {/* Route header on the 56px floor — the chrome contract, visible. */}
          <header className="glass safe-header flex shrink-0 items-center gap-3 border-b border-hairline px-4">
            <span className="text-[17px] font-semibold tracking-tight">Shell bench</span>
            <span className="text-xs text-ink-3">
              substrate {substrate ? 'on' : 'off'} · host {box.cqw}×{box.cqh} ·
              frame {Math.round(frameSize(box))}px ({frameBinding(box)}-bound)
            </span>
          </header>

          <main ref={attachHost} data-shell-content="" className="min-h-0 flex-1 overflow-auto">
            <div className="mx-auto flex max-w-3xl flex-col gap-5 p-6">
              <div className="flex flex-wrap items-center gap-2">
                <Chip active={theme === 'light'} onClick={() => set('theme', 'light')}>
                  Light
                </Chip>
                <Chip active={theme === 'dark'} onClick={() => set('theme', 'dark')}>
                  Dark
                </Chip>
                <span className="w-3" />
                <Chip
                  active={overlayOpen}
                  onClick={() => set('overlay', overlayOpen ? '0' : '1')}
                >
                  Overlay {overlayOpen ? 'open' : 'closed'}
                </Chip>
                <Chip active={variant === 'frame'} onClick={() => set('variant', 'frame')}>
                  frame
                </Chip>
                <Chip active={variant === 'pane'} onClick={() => set('variant', 'pane')}>
                  pane
                </Chip>
                <span className="w-3" />
                <Chip
                  active={keyboard}
                  onClick={() => set('keyboard', keyboard ? '0' : '1')}
                >
                  Fake keyboard {keyboard ? 'up' : 'down'}
                </Chip>
              </div>

              {/* Mock route content, so the scrim has something to dim. */}
              {Array.from({ length: 6 }, (_, i) => (
                <div
                  key={i}
                  className="rounded-2xl border border-hairline bg-paper p-4 shadow-[var(--sm-bubble-shadow)]"
                >
                  <div className="mb-2 h-3 w-32 rounded bg-fill-soft-2" />
                  <div className="mb-1.5 h-2 w-full rounded bg-fill-soft" />
                  <div className="h-2 w-4/5 rounded bg-fill-soft" />
                </div>
              ))}
            </div>

            <ShellOverlay
              open={overlayOpen}
              onOpenChange={(o) => set('overlay', o ? '1' : '0')}
              variant={variant}
              title="Needs your call"
              description="Attention-shaped placeholder, at the real frame size"
            >
              <AttentionShaped />
            </ShellOverlay>
          </main>

          {/* Mobile tab bar — the third substrate column. */}
          <nav
            aria-label="Primary"
            data-shell-tabs=""
            className="flex shrink-0 items-stretch justify-around border-t border-border bg-card md:hidden"
          >
            {['◱', '▤', '▣', '⚙'].map((g, i) => (
              <div
                key={g}
                className={cn(
                  'flex min-h-14 flex-1 flex-col items-center justify-center text-sm',
                  i === 0 ? 'text-ink' : 'text-ink-3',
                )}
              >
                {g}
              </div>
            ))}
          </nav>
        </div>
      </div>
    </ShellOverlayProvider>
  )
}
