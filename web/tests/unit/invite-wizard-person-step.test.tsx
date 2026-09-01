/**
 * "Add people" must not imply an email it cannot send.
 * ─────────────────────────────────────────────────────────────────────────────
 * Witnessed live: the owner added sander@internetventures.nl and waited for an
 * invitation mail. None came, and none ever could — supermux has NO mailer.
 * `POST /api/companies/{id}/humans` inserts the `human_users` row and returns a
 * `login_url`; nothing is sent anywhere. The step's shape said otherwise: an
 * email field, an "Invite" button, an "Invited" chip.
 *
 * So the step now says it before the row is made, and then hands the owner the
 * two things that actually deliver it — the link, and their own mail client,
 * prefilled. These tests pin the sentence, the affordances and the vocabulary.
 *
 * `PersonStep` is rendered for real (`renderToStaticMarkup`) with the roster
 * primed into the query cache, so the assertions are about what is ON SCREEN,
 * not about a helper in isolation.
 */
import { describe, expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'

import { PersonStep } from '../../src/components/companies/invite-wizard-sheet'
import {
  inviteMailto,
  neverSignedIn,
  shareItYourselfLine,
  shareLinkLabel,
} from '../../src/lib/invite-wizard'
import { companyHumansKey } from '../../src/hooks/use-external-access'
import type { HumanInvitee } from '../../src/lib/api'

const COMPANY = { id: 5, slug: 'reisposter-ai', display_name: 'Reisposter AI' }
const LIVE = 'https://reisposter-ai.iwd.nl'

const human = (over: Partial<HumanInvitee> = {}): HumanInvitee => ({
  id: 1,
  email: 'sander@internetventures.nl',
  display_name: 'sander',
  company_id: 5,
  role: 'member',
  created_at: 0,
  status: 'invited',
  ...over,
})

const step = (humans: HumanInvitee[], quick = false): string => {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } })
  qc.setQueryData(companyHumansKey(COMPANY.id), humans)
  return renderToStaticMarkup(
    <QueryClientProvider client={qc}>
      <PersonStep company={COMPANY} liveUrl={LIVE} quick={quick} />
    </QueryClientProvider>,
  )
}

/** `mailto:` bodies are percent-encoded; read them back the way a mail client would. */
const mailBody = (href: string): string =>
  decodeURIComponent(new URL(href).searchParams.get('body') ?? '')

describe('the step says there is no mailer, before anyone is added', () => {
  test('both paths state it plainly', () => {
    expect(shareItYourselfLine(false)).toContain('doesn’t send email')
    expect(shareItYourselfLine(false)).toContain('sign-in address')
    expect(shareItYourselfLine(true)).toContain('doesn’t send email')
    expect(shareItYourselfLine(true)).toContain('personal link')
  })

  test('it is on screen with an empty roster — not only after the first add', () => {
    const html = step([])
    expect(html).toContain('data-vr="no-mailer"')
    expect(html).toContain('doesn’t send email')
  })

  test('the button says what it does: it adds a person, it does not send', () => {
    const html = step([])
    expect(html).toContain('>Add<')
    expect(html).not.toContain('Inviting…')
  })
})

describe('the share affordance is the hero of an added row', () => {
  test('a person who has never signed in gets the link and a prefilled mail', () => {
    const html = step([human()])
    expect(html).toContain('data-vr="share-link"')
    expect(html).toContain(shareLinkLabel(false, 'sander@internetventures.nl'))
    // The link itself, copyable.
    expect(html).toContain(LIVE)
    // …and the mail the owner was going to write by hand.
    expect(html).toContain('data-vr="email-the-link"')
    expect(html).toContain('Email the link')
    expect(html).toContain('mailto:sander@internetventures.nl?subject=Join%20Reisposter%20AI')
  })

  test('the prefilled mail carries the company, the address and how to sign in', () => {
    const mail = inviteMailto({
      email: 'sander@internetventures.nl',
      company: 'Reisposter AI',
      loginUrl: LIVE,
      quick: false,
    })
    expect(mail.subject).toBe('Join Reisposter AI')
    expect(mail.href.startsWith('mailto:sander@internetventures.nl?')).toBe(true)
    const body = mailBody(mail.href)
    expect(body).toContain('Reisposter AI')
    expect(body).toContain(LIVE)
    expect(body).toContain('Sign in with your Google account (sander@internetventures.nl)')
    // The permanent path is NOT a personal one-shot link — do not say it is.
    expect(body).not.toContain('personal link')
  })

  test('the quick-tunnel mail describes the personal link it actually is', () => {
    const body = mailBody(
      inviteMailto({
        email: 'sander@internetventures.nl',
        company: 'Reisposter AI',
        loginUrl: 'https://e2e.trycloudflare.com/auth/invite?token=abc',
        quick: true,
      }).href,
    )
    expect(body).toContain('personal link')
    expect(body).toContain('expires in 7 days')
    expect(body).toContain('token=abc')
    expect(body).not.toContain('Google')
  })

  test('someone who already signed in is not offered a link they do not need', () => {
    expect(neverSignedIn('invited')).toBe(true)
    expect(neverSignedIn('unknown-future-status')).toBe(true)
    expect(neverSignedIn('pending')).toBe(false)
    expect(neverSignedIn('active')).toBe(false)
    const html = step([human({ status: 'active' })])
    expect(html).not.toContain('data-vr="share-link"')
    expect(html).not.toContain('data-vr="email-the-link"')
  })

  test('a quick-tunnel row whose one-shot link is gone says so instead of pretending', () => {
    const html = step([human()], true)
    expect(html).not.toContain('data-vr="share-link"')
    expect(html).toContain('shown once, when you added them')
  })
})

describe('the chip never implies a delivery', () => {
  test('never-signed-in reads as work still on the owner’s desk', () => {
    const html = step([human()])
    expect(html).toContain('Link ready — share it')
    expect(html).not.toContain('>Invited<')
  })

  test('“pending” no longer claims a first login that already happened', () => {
    const html = step([human({ status: 'pending' })])
    expect(html).toContain('Signed out')
    expect(html).not.toContain('Pending first login')
  })

  test('an active colleague still reads Active', () => {
    expect(step([human({ status: 'active' })])).toContain('Active')
  })
})
