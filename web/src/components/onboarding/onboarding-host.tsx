// OnboardingHost — Time to Wow.
//
// The orchestrator for the first-60-seconds unboxing. Mounted once near the app
// root (inside the Router + QueryClient). It owns the first-launch decision and
// drives the "v2-migrated" branch:
//
//   • First-launch flag absent + sessions already exist (count > 0)
//        → these are migrated v2 sessions. Show the non-blocking WelcomeBanner;
//          if the user taps "Take the tour", run the 4-step TourOverlay.
//          Dismiss / finish → completeFirstLaunch().
//
//   • First-launch flag absent + ZERO sessions
//        → the fresh-install branch. The host stays silent — the overview's own
//          empty state carries the primary CTA, and the host adds the
//          secondary "boot a demo agent" button there. The host marks
//          first-launch complete once the empty state is shown so the unboxing
//          isn't re-armed every load while the user has no sessions yet; the
//          replay link in Settings is the deliberate way back.
//
//   • Flag present → returning user. The host renders nothing.
//
// It only surfaces on the overview route (`/`) — the unboxing belongs on the
// home screen, not mid-focus. It reads the SHARED `['sessions']` query cache
// (same key the overview's useSessions populates) so it adds no extra fetch and
// no second SSE subscription.

import * as React from 'react'
import { useLocation } from 'react-router-dom'
import { AnimatePresence } from 'framer-motion'
import { useQuery } from '@tanstack/react-query'

import { sessionsApi, type ApiSession } from '@/lib/api'
import { SESSIONS_KEY } from '@/hooks/use-sessions'
import {
  completeFirstLaunch,
  isFirstLaunch,
} from '@/lib/onboarding'
import { WelcomeBanner } from './welcome-banner'
import { TourOverlay } from './tour-overlay'

// Where the user is in the migrated-v2 unboxing. `null` = the user has taken
// over (started the tour, or dismissed) — see `step`.
type Step = 'banner' | 'tour' | 'done'

export function OnboardingHost() {
  const location = useLocation()
  const onOverview = location.pathname === '/'

  // Decide first-launch eligibility ONCE, at mount — a later write of the flag
  // (from this very component) must not retroactively flip the branch.
  const [eligible] = React.useState(isFirstLaunch)

  // DEV-only `?mock=1` seeds the `['sessions']` cache from the overview. In
  // that mode the host MUST NOT run its own fetch: a backend-less dev server
  // answers `/api/sessions` with the SPA index.html (history fallback), which
  // the client coerces to `[]` — that would otherwise race the mock seed and
  // wrongly seal first-launch. The query still SUBSCRIBES to the shared cache
  // key, so the mock seed propagates here either way.
  const mock =
    import.meta.env.DEV &&
    typeof window !== 'undefined' &&
    new URLSearchParams(window.location.search).has('mock')

  // Share the overview's sessions cache: same query key → TanStack dedupes, so
  // this neither double-fetches nor opens a second SSE stream. `enabled` is
  // gated on eligibility so a returning user pays nothing.
  const { data: sessions, isLoading } = useQuery({
    queryKey: SESSIONS_KEY,
    queryFn: sessionsApi.list,
    staleTime: 30_000,
    enabled: eligible && !mock,
  })

  // `step` is null until the user acts. The DERIVED phase below decides what
  // shows: once data lands, count>0 → 'banner' (overridable by `step`),
  // count===0 → 'done'. No setState-in-effect — the branch is pure-derived.
  const [step, setStep] = React.useState<Step | null>(null)

  const dataReady = eligible && !isLoading && sessions !== undefined
  const count = dataReady ? (sessions as ApiSession[]).length : 0
  const branch: Step | 'pending' = !eligible
    ? 'done'
    : !dataReady
      ? 'pending'
      : count > 0
        ? 'banner'
        : 'done'

  // The fresh-install branch (count === 0) has no UI here — the overview empty
  // state owns the CTA. Mark first-launch complete so it isn't re-armed every
  // load; this is a side effect with NO setState, guarded by a ref so it runs
  // exactly once.
  const sealed = React.useRef(false)
  React.useEffect(() => {
    if (branch === 'done' && eligible && !sealed.current) {
      sealed.current = true
      completeFirstLaunch()
    }
  }, [branch, eligible])

  const finish = () => {
    completeFirstLaunch()
    setStep('done')
  }

  // The visible phase: the user's choice (`step`) wins; otherwise the derived
  // branch. A 'done'/'pending' branch with no user action shows nothing.
  const phase: Step | 'pending' = step ?? branch
  if (phase === 'pending' || phase === 'done') return null

  return (
    <>
      <AnimatePresence>
        {phase === 'banner' && onOverview && (
          <WelcomeBanner
            key="welcome-banner"
            sessionCount={count}
            onStartTour={() => setStep('tour')}
            onSkip={finish}
          />
        )}
      </AnimatePresence>
      <AnimatePresence>
        {phase === 'tour' && <TourOverlay key="tour" onComplete={finish} />}
      </AnimatePresence>
    </>
  )
}
