/**
 * `<ViewerBoundary>` — the identity gate the whole app hangs off.
 * ─────────────────────────────────────────────────────────────────────────────
 * Mounted in `App.tsx` ABOVE the routes AND above `<OnboardingHost>`, because the
 * ordering is the fix: before this, the Bot-Mode onboarding intro (a `fixed
 * inset-0` opaque modal) was the first thing an anonymous visitor saw on a
 * company host. Nothing could log in, because nothing had asked who they were.
 *
 *   pending → render NOTHING (one frame at most; the owner never reaches it)
 *   anon    → the branded `<LoginGate>`, replacing the app entirely
 *   owner   → children, byte-identical to before this file existed
 *   member  → children, plus the one-time welcome/name sheet
 *
 * THE OWNER PATH COSTS NOTHING. `useViewer`'s initial state is already
 * `{kind:'owner'}` whenever the shell carries the spliced admin bearer (or on a
 * `?mock` / `/dev/*` bench), so an owner load renders `children` on the FIRST
 * paint with no fetch and no extra frame — which is what every existing e2e
 * fixture depends on.
 */
import * as React from 'react'

import { useCompanies } from '@/hooks/use-companies'
import { needsDisplayName } from '@/lib/viewer'
import { useViewer } from '@/stores/viewer-store'

// Lazy: neither the gate nor the welcome sheet belongs on the owner's cold hero
// path — an owner never renders either one, and the intro-story argument that
// made `BotModeIntro` lazy applies verbatim here.
// ONE chunk for both: they are mutually exclusive (anon vs member) and neither
// is ever fetched by an owner, so two chunks would only buy two module preambles.
const LazyLoginGate = React.lazy(() =>
  import('./surfaces').then((m) => ({ default: m.LoginGate })),
)
const LazyMemberWelcomeSheet = React.lazy(() =>
  import('./surfaces').then((m) => ({ default: m.MemberWelcomeSheet })),
)

export function ViewerBoundary({ children }: { children: React.ReactNode }) {
  const viewer = useViewer((s) => s.viewer)
  // Which sign-in paths this host actually offers — resolved by the SAME
  // `/auth/me` call that produced `anon`, so the gate paints its final face on
  // the first frame instead of growing a Google button a moment later.
  const login = useViewer((s) => s.login)
  const resolve = useViewer((s) => s.resolve)
  const adopt = useViewer((s) => s.adopt)
  // Dismissing the welcome sheet is for THIS load only — nothing is persisted,
  // so a member who closed it without naming themselves is asked again next
  // time. That is the honest behaviour for a courtesy: it goes away when you
  // push it away, and it comes back because the question is still open.
  const [welcomeDismissed, setWelcomeDismissed] = React.useState(false)

  // One resolution per load. The store guards re-entry itself (StrictMode
  // double-mounts effects in dev), so this is a plain fire-and-forget.
  React.useEffect(() => {
    void resolve()
  }, [resolve])

  if (viewer.kind === 'pending') return null
  if (viewer.kind === 'anon') {
    return (
      <React.Suspense fallback={null}>
        <LazyLoginGate google={login.google} />
      </React.Suspense>
    )
  }
  if (viewer.kind === 'member') {
    return (
      <>
        {children}
        {needsDisplayName(viewer) && !welcomeDismissed && (
          <React.Suspense fallback={null}>
            <MemberWelcome
              onSaved={(displayName) => adopt({ ...viewer, displayName })}
              onDismiss={() => setWelcomeDismissed(true)}
            />
          </React.Suspense>
        )}
      </>
    )
  }
  return <>{children}</>
}

/** The welcome sheet, wired to the member's own company name. Split out so the
 *  `useCompanies` query is only mounted for the member who actually needs it. */
function MemberWelcome({
  onSaved,
  onDismiss,
}: {
  onSaved: (displayName: string) => void
  onDismiss: () => void
}) {
  const { companies } = useCompanies()
  // A member's `/api/companies` is fenced to exactly their own company
  // (`companies_list_shows_a_member_only_their_own_company`), so the first row IS
  // theirs. "your workspace" covers the frame before the query settles — the
  // sheet must not wait on a network round-trip to ask a name.
  const companyName = companies[0]?.display_name ?? 'your workspace'
  return (
    <LazyMemberWelcomeSheet
      open
      companyName={companyName}
      onSaved={onSaved}
      onDismiss={onDismiss}
    />
  )
}
