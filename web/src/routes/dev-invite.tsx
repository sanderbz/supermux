// /dev/invite — the offline bench for the Companies onboarding wizard
// (`<InviteWizardSheet>`). DEV-ONLY and lazy (`App.tsx`), so it costs the shipped
// bundle nothing.
//
// The wizard's whole data plane routes to the in-memory mock
// (`external-access-mock.ts`) when `?mock` is present, so this page exercises the
// FULL stepper — Cloudflare token → tunnel "Connecting… → Connected ✓" → Google
// login (with a first-try redirect_uri_mismatch that clears on Check again) →
// invite people → success — with NO live token, Google app, or server.
//
// Open at:  /dev/invite?mock=1            (entry A — the full box setup)
//           /dev/invite?mock=1&entry=B    (box set up, one URL to add for a new company)
//           /dev/invite?mock=1&entry=C    (already reachable — the repeat-invite path)
//
// On a 390px viewport the ResponsiveSheet renders as the Vaul bottom-sheet; on a
// wide viewport it is the desktop side sheet.

import * as React from 'react'
import { useSearchParams } from 'react-router-dom'

import { InviteWizardSheet } from '@/components/companies/invite-wizard-sheet'
import { resetExternalAccessMock } from '@/lib/external-access-mock'

const MOCK_COMPANY = { id: 42, slug: 'acme', display_name: 'Acme' }

export default function DevInvite() {
  const [params, setParams] = useSearchParams()
  const grok = params.get('grok') === '1'
  const mockOn = params.has('mock')
  const entry = (params.get('entry') ?? 'A').toUpperCase()
  const [open, setOpen] = React.useState(true)

  // Fresh mock state on every mount so a re-run of the rig starts clean.
  React.useEffect(() => {
    resetExternalAccessMock()
  }, [])

  return (
    <main
      data-grok={grok ? '' : undefined}
      className="min-h-dvh bg-[var(--sm-bg-chrome,var(--background))] p-6"
    >
      <h1 className="mb-1 text-[15px] font-semibold text-foreground">
        /dev/invite — onboarding wizard
      </h1>
      <p className="mb-4 max-w-prose text-[12px] text-muted-foreground">
        entry <code>{entry}</code> · mock {mockOn ? 'ON' : 'OFF'}. The wizard opens
        automatically; if you closed it, reopen below. Add <code>?mock=1</code> for the offline
        state machine (required with no server), and <code>&amp;entry=B|C</code> to see the resumable
        entry points.
      </p>

      {!mockOn && (
        <p className="mb-4 rounded-lg border border-dashed border-border px-3 py-2 text-[12px] text-destructive">
          No <code>?mock</code> — the wizard will try to hit a live server and error. Append{' '}
          <code>?mock=1</code>.
        </p>
      )}

      <div className="flex flex-wrap gap-2">
        <button
          type="button"
          onClick={() => setOpen(true)}
          className="rounded-md px-3 py-1.5 text-sm"
          style={{ background: 'var(--sm-accent-fill)', color: 'var(--gr-onaccent)' }}
        >
          Open wizard
        </button>
        {(['A', 'B', 'C'] as const).map((e) => (
          <button
            key={e}
            type="button"
            onClick={() => {
              const next = new URLSearchParams(params)
              next.set('mock', '1')
              next.set('entry', e)
              setParams(next)
              resetExternalAccessMock()
              setOpen(true)
            }}
            className="rounded-md border border-border px-3 py-1.5 text-sm text-foreground"
          >
            Entry {e}
          </button>
        ))}
      </div>

      <InviteWizardSheet open={open} onOpenChange={setOpen} company={MOCK_COMPANY} />
    </main>
  )
}
