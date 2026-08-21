// DEV bench (/dev/new-session) — the task-first "Hire a new bot" sheet (Plan 1 /
// Workflow A), offline. No server behind it: the real `NewSessionSheet` is
// rendered open with `botVoiced`, the connector step is fed the curated fallback
// catalog so it renders populated, and the roster/host queries simply return
// empty. Query params drive one clean capture per page load:
//
//   ?theme=light|dark   the global theme (stamped on <html>, since the sheet
//                        portals to document.body and escapes any wrapper)
//   ?grok=1             the [data-grok] skin (also stamped on <html> for the
//                        portaled sheet; the DevSkin parent only wraps the route)
//   ?step=describe|connect   which step to mount on
//   ?adv=1              start with the Advanced disclosure open (Step 1)
//
// Not a product route — DEV-gated + lazy in App.tsx, so the production bundle
// never includes it and the base app is byte-identical.
import * as React from 'react'
import { useLocation } from 'react-router-dom'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'

import { ToastProvider } from '@/components/ui/toast'
import { TooltipProvider } from '@/components/ui/tooltip'
import { NewSessionSheet } from '@/components/session-tile/new-session-sheet'
import { CURATED_FALLBACK } from '@/components/store/catalog'

const BENCH_QC = new QueryClient({
  defaultOptions: { queries: { retry: false, staleTime: Infinity } },
})

export default function DevNewSession() {
  const { search } = useLocation()
  const params = new URLSearchParams(search)
  const theme = params.get('theme') === 'dark' ? 'dark' : 'light'
  const grok = params.get('grok') === '1'
  const step = params.get('step') === 'connect' ? 'connect' : 'describe'
  const adv = params.get('adv') === '1'

  // The sheet portals to <body>, escaping the DevSkin wrapper — so the theme and
  // the grok skin have to live on <html> for the portaled content to inherit
  // them. Set them imperatively for the capture, and restore on unmount so the
  // bench does not leak state between navigations.
  React.useEffect(() => {
    const el = document.documentElement
    const hadDark = el.classList.contains('dark')
    const hadGrok = el.hasAttribute('data-grok')
    el.classList.toggle('dark', theme === 'dark')
    if (grok) el.setAttribute('data-grok', '')
    else el.removeAttribute('data-grok')
    return () => {
      el.classList.toggle('dark', hadDark)
      if (hadGrok) el.setAttribute('data-grok', '')
      else el.removeAttribute('data-grok')
    }
  }, [theme, grok])

  // Open the Advanced disclosure once the sheet is mounted (Step 1 expanded
  // capture). We click the real disclosure button so the captured state is the
  // product's, not a bench prop.
  React.useEffect(() => {
    if (step !== 'describe' || !adv) return
    const id = window.setTimeout(() => {
      const btn = document.querySelector<HTMLButtonElement>('[aria-controls="ns-advanced"]')
      if (btn && btn.getAttribute('aria-expanded') !== 'true') btn.click()
    }, 60)
    return () => window.clearTimeout(id)
  }, [step, adv])

  return (
    <QueryClientProvider client={BENCH_QC}>
      <ToastProvider>
        <TooltipProvider delayDuration={0}>
          <div
            data-bench="new-session"
            className="min-h-dvh w-full bg-background text-foreground"
          >
            <NewSessionSheet
              open
              onOpenChange={() => {}}
              onCreated={() => {}}
              botVoiced
              bench={{
                initialStep: step,
                mockConnectors: CURATED_FALLBACK,
              }}
            />
          </div>
        </TooltipProvider>
      </ToastProvider>
    </QueryClientProvider>
  )
}
