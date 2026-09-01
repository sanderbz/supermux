/**
 * The invite sheet has to adapt to the box it is opened on.
 * ─────────────────────────────────────────────────────────────────────────────
 * Witnessed live (owner, phone, a box whose domain + Google login + DNS were ALL
 * configured): "Invite a teammate" opened on "Step 1 of 4", a four-step
 * onboarding rail with Domain "Not set up" and Google login "Not set up", and a
 * bare "Checking access…" line underneath. Two separate failures in one frame:
 *
 *   (a) the rail rendered while `GET /external-access/status` was still in
 *       flight. Every chip reads `status?.box_status…`, so ABSENT and "nothing
 *       is set up" are the same expression — the pessimistic default was on
 *       screen, as a claim about the owner's box, for the whole round-trip.
 *   (b) once loaded, a finished box still got the onboarding stepper, when the
 *       only act left on it is adding a person.
 *
 * These pin the surface the sheet owes each state, the completion rule behind
 * it, and the two doors into the wizard. The pure core is asserted directly; the
 * panel and the loader are RENDERED (`renderToStaticMarkup`) so the assertions
 * are about what is on screen. The sheet shell itself is a portalled
 * Vaul/Radix dialog and cannot be server-rendered, so the two structural
 * guarantees inside it (the loading branch renders no stepper; both menu doors
 * exist) are read off the source — the same idiom `brand-tokens` and
 * `workflows-nav` use.
 */
import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { renderToStaticMarkup } from 'react-dom/server'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'

import {
  InvitePanel,
  InviteSheetSkeleton,
} from '../../src/components/companies/invite-wizard-sheet'
import { resumeStep, setupComplete, sheetView } from '../../src/lib/invite-wizard'
import { companyHumansKey } from '../../src/hooks/use-external-access'
import type { ExternalStatus, HumanInvitee } from '../../src/lib/api'

const COMPANY = { id: 42, slug: 'acme', display_name: 'Acme' }
const LIVE = 'https://acme.example.com'

/** A fully-configured box, exactly as the owner's was: tunnel healthy, Google
 *  configured AND this company's redirect verified, this company's host written. */
function configured(over: Partial<ExternalStatus['box_status']> = {}, company: Partial<NonNullable<ExternalStatus['company']>> = {}): ExternalStatus {
  return {
    box_status: {
      cf_token: 'valid',
      tunnel: 'healthy',
      dns_ok: true,
      google: 'configured',
      base_domain: 'example.com',
      ...over,
    },
    company: {
      company_id: 42,
      company_host_written: true,
      redirect_registered: 'ok',
      reachable: true,
      host: 'acme.example.com',
      redirect_uri: 'https://acme.example.com/auth/callback',
      ...company,
    },
  }
}

/** A box with nothing done — the state the old defaults SILENTLY claimed. */
const fresh: ExternalStatus = {
  box_status: { cf_token: 'none', tunnel: 'none', dns_ok: false, google: 'unset', base_domain: null },
  company: {
    company_id: 42,
    company_host_written: false,
    redirect_registered: 'unknown',
    reachable: false,
    host: '',
    redirect_uri: '',
  },
}

describe('a status that has not landed is not a status that says "not set up"', () => {
  test('in flight, with nothing cached → the loader, never the step list', () => {
    expect(sheetView({ isLoading: true, status: undefined })).toBe('loading')
  })

  test('a status already in hand is never the loader — a background re-read must not blank the panel', () => {
    expect(sheetView({ isLoading: true, status: configured() })).toBe('invite')
    expect(sheetView({ isLoading: true, status: fresh })).toBe('wizard')
  })

  test('a status read that FAILED falls to the wizard, which says so — never to the invite panel', () => {
    // The invite panel would imply a configured box; we could not check one.
    expect(sheetView({ isLoading: false, isError: true, status: undefined })).toBe('wizard')
  })
})

describe('a configured box gets the invite panel, an unfinished one gets the stepper', () => {
  test('domain + Google + host written ⇒ complete', () => {
    expect(setupComplete(configured())).toBe(true)
    expect(sheetView({ isLoading: false, status: configured() })).toBe('invite')
  })

  test('each of the three is REQUIRED — one missing keeps the stepper', () => {
    expect(setupComplete(configured({ tunnel: 'connecting' }))).toBe(false)
    expect(setupComplete(configured({ google: 'unset' }))).toBe(false)
    expect(setupComplete(configured({}, { redirect_registered: 'mismatch' }))).toBe(false)
    expect(setupComplete(configured({}, { company_host_written: false }))).toBe(false)
    for (const s of [
      configured({ tunnel: 'connecting' }),
      configured({ google: 'unset' }),
      configured({}, { company_host_written: false }),
    ]) {
      expect(sheetView({ isLoading: false, status: s })).toBe('wizard')
    }
  })

  test('a temporary quick-tunnel link is a trial, not a finished setup', () => {
    const quick = configured({
      tunnel: 'none',
      google: 'unset',
      quick_tunnel: {
        active: true,
        url: 'https://calm-frog.trycloudflare.com',
        host: 'calm-frog.trycloudflare.com',
        company_id: 42,
        ephemeral: true,
      },
    })
    expect(setupComplete(quick)).toBe(false)
    expect(sheetView({ isLoading: false, status: quick })).toBe('wizard')
  })

  test('nothing set up ⇒ the stepper', () => {
    expect(setupComplete(fresh)).toBe(false)
    expect(setupComplete(undefined)).toBe(false)
  })
})

describe('the stepper opens on the first unfinished step', () => {
  test('nothing done → Domain', () => {
    expect(resumeStep(fresh)).toBe('domain')
  })

  test('the half-configured box (domain done, Google not) lands on Google — not back at step 1', () => {
    expect(resumeStep(configured({}, { redirect_registered: 'unknown' }))).toBe('google')
    expect(resumeStep(configured({ google: 'unset' }))).toBe('google')
  })

  test('an agent-inbox mid-verification is resumed on its own step', () => {
    const s = configured({}, {
      agent_inbox: {
        address: 'agent@example.com',
        destination: 'owner@example.com',
        verified: false,
        verification_pending: true,
      },
    })
    expect(resumeStep(s)).toBe('inbox')
  })

  test('everything done → Add people', () => {
    expect(resumeStep(configured())).toBe('person')
  })

  test('the settings door starts at the top — nothing is unfinished, the owner came to change something', () => {
    expect(resumeStep(configured(), { settings: true })).toBe('domain')
    expect(sheetView({ isLoading: false, status: configured(), settings: true })).toBe('wizard')
  })
})

// ── What is actually on screen ────────────────────────────────────────────────

const human = (over: Partial<HumanInvitee> = {}): HumanInvitee => ({
  id: 1,
  email: 'dana@acme.co',
  display_name: 'dana',
  company_id: 42,
  role: 'member',
  created_at: 0,
  status: 'invited',
  ...over,
})

const panel = (humans: HumanInvitee[] = []): string => {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } })
  qc.setQueryData(companyHumansKey(COMPANY.id), humans)
  return renderToStaticMarkup(
    <QueryClientProvider client={qc}>
      <InvitePanel company={COMPANY} liveUrl={LIVE} onSettings={() => {}} />
    </QueryClientProvider>,
  )
}

describe('the invite panel', () => {
  test('leads with the sign-in address, once', () => {
    const html = panel()
    expect(html).toContain('data-vr="invite-address"')
    expect(html).toContain('Sign-in address')
    expect(html.split(LIVE).length - 1).toBeGreaterThan(0)
  })

  test('carries no stepper and no step count', () => {
    const html = panel([human()])
    // The rail's own vocabulary: its step count, its chips, its step titles.
    expect(html).not.toContain('Step 1 of')
    expect(html).not.toContain('Not set up')
    expect(html).not.toContain('Agent email')
    expect(html).not.toContain('Temporary link')
  })

  test('is the real Add-people surface, not a copy of it', () => {
    const html = panel([human()])
    expect(html).toContain('data-vr="no-mailer"')
    expect(html).toContain('doesn’t send email')
    expect(html).toContain('data-vr="share-link"')
    expect(html).toContain('dana@acme.co')
  })

  test('keeps a quiet way back into the setup that produced the address', () => {
    expect(panel()).toContain('data-vr="access-settings"')
    expect(panel()).toContain('Access settings')
  })
})

describe('the loading surface', () => {
  const html = renderToStaticMarkup(<InviteSheetSkeleton />)

  test('is ONE announced loading region, not silent shimmer', () => {
    expect(html).toContain('role="status"')
    expect(html).toContain('aria-busy="true"')
    expect(html).toContain('Checking access…')
  })

  test('states nothing about the box while it is still being asked', () => {
    expect(html).not.toContain('Not set up')
    expect(html).not.toContain('Step 1 of')
    expect(html).not.toContain('Domain')
    expect(html).not.toContain('Google')
  })

  test('fades in on the app’s anti-flash delay, so a cached status never blinks a skeleton', () => {
    expect(html).toContain('sm-skel-delay')
  })
})

// ── Structural guards (the portalled shell + the menu) ─────────────────────────

const src = (p: string) => readFileSync(new URL(`../../src/${p}`, import.meta.url), 'utf8')

describe('the sheet shell', () => {
  const sheet = src('components/companies/invite-wizard-sheet.tsx')

  test('the loading branch renders the skeleton and nothing else — the rail is inside the wizard branch', () => {
    const loading = sheet.indexOf("view === 'loading' ? (")
    const stepper = sheet.indexOf('<WizardStepper')
    expect(loading).toBeGreaterThan(0)
    expect(stepper).toBeGreaterThan(loading) // the rail is below, in the else
    expect(sheet).toContain('<InviteSheetSkeleton />')
  })

  test('the header never counts steps over a surface that has none', () => {
    expect(sheet).toContain("view === 'loading'\n          ? 'Checking access…'")
  })
})

describe('the menu carries both doors', () => {
  const switcher = src('components/roster/company-switcher.tsx')

  test('"Invite a teammate" and "External access…" live in the same menu', () => {
    expect(switcher).toContain('Invite a teammate')
    expect(switcher).toContain('External access…')
    expect(switcher).toContain('data-vr="external-access-entry"')
  })

  test('they open the SAME sheet through its two modes', () => {
    expect(switcher).toContain("setWizardMode('invite')")
    expect(switcher).toContain("setWizardMode('settings')")
    expect(switcher).toContain('mode={wizardMode}')
  })
})
