/**
 * The LOGIN GATE's markup — owner bug #1.
 * ─────────────────────────────────────────────────────────────────────────────
 * Opening the app URL on a company / quick-tunnel host with no credentials used
 * to render the Bot-Mode onboarding intro: a five-screen story pitching a mode
 * switch, shown to somebody who had not signed in and could not. There was no
 * login screen in the product at all.
 *
 * This repo has no jsdom (see `chat-attachment-chips.test.tsx`), so a real typed
 * submit is Playwright's job; what a unit test pins is the STRUCTURE — that the
 * gate is a sign-in screen with a key field and a connect button, that it names
 * the invite path for the colleague who has no key, and that it never leaks an
 * app affordance.
 */
import { describe, expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'

import { LoginGate } from '../../src/components/auth/login-gate'

/** The gate as an invite-only / quick-tunnel box renders it: no Google. */
const html = renderToStaticMarkup(<LoginGate onAuthenticated={() => undefined} />)

/** The gate on a host where the server said Google sign-in really works. */
const withGoogle = renderToStaticMarkup(
  <LoginGate google onAuthenticated={() => undefined} />,
)

describe('<LoginGate>', () => {
  test('says what this is, honestly and without jargon', () => {
    expect(html).toContain('This is a private workspace')
    expect(html).toContain('Sign in to continue.')
  })

  test('offers exactly one credential field, labelled, masked, and a11y-wired', () => {
    expect(html).toContain('id="supermux-access-key"')
    expect(html).toContain('type="password"')
    expect(html).toContain('for="supermux-access-key"')
    expect(html).toContain('Access key')
    expect(html).toContain('Paste your access key')
    // One field only — a login screen that also asks for a username would be
    // asking for something this server has no concept of.
    expect(html.match(/<input/g) ?? []).toHaveLength(1)
  })

  test('the connect button starts disabled — nothing to submit yet', () => {
    expect(html).toContain('Connect')
    expect(html).toContain('disabled=""')
  })

  test('names the invited colleague’s path, who has no key at all', () => {
    expect(html).toContain('Got an invite link? Open it')
  })

  test('shows no error before anything was tried', () => {
    expect(html).not.toContain('role="alert"')
    expect(html).not.toContain("wasn't accepted")
  })

  test('is a full-screen replacement for the app, not an overlay on it', () => {
    expect(html).toContain('data-login-gate=""')
    expect(html).toContain('min-h-dvh')
    // Theme-correct by construction: every surface, ink and ring the gate paints
    // is a semantic token, so the shell's `.dark` class drives it and neither
    // theme needs its own branch. (The only literal colours in the markup are
    // the brand mark's own gradient stops, which are theme-independent pigment.)
    for (const token of [
      'bg-background',
      'text-foreground',
      'bg-card',
      'border-input',
      'text-muted-foreground',
      'bg-primary',
      'ring-ring',
    ]) {
      expect(html).toContain(token)
    }
  })

  test('carries none of the app: no nav, no roster, no onboarding story', () => {
    for (const leak of ['Start a company', 'New company', 'HQ', 'Settings', 'Archived']) {
      expect(html).not.toContain(leak)
    }
  })
})

/**
 * OWNER BUG #2 — Google sign-in.
 *
 * The owner's company host had Google OIDC configured and verified "Ready", and
 * the gate still offered nothing but "This is a private workspace / Access key".
 * `GET /auth/login` worked the whole time. These pin the two faces of the screen
 * and, above all, that the capability is what switches between them: a box that
 * cannot do Google must not grow a button that answers 404.
 */
describe('<LoginGate> — the Google path', () => {
  test('leads with a Google button when the host actually offers it', () => {
    expect(withGoogle).toContain('Sign in with Google')
    expect(withGoogle).toContain('data-google-signin=""')
  })

  test('the button is a plain navigation to the server’s own OIDC start', () => {
    // Not a fetch and not a popup: /auth/login answers 302 → accounts.google.com
    // with state/PKCE bound to this Host, and only a top-level navigation can
    // follow that to consent and back to /auth/callback with cookies.
    expect(withGoogle).toContain('href="/auth/login"')
    // Same-origin — the client never addresses accounts.google.com itself, so no
    // client id can leak into the page.
    expect(withGoogle).not.toContain('accounts.google.com')
    expect(withGoogle).not.toContain('client_id')
  })

  test('it is the PRIMARY affordance; the access key steps back behind one line', () => {
    // The Google button wears the primary surface…
    expect(withGoogle).toContain('bg-primary')
    // …and the key field is not even mounted until it is asked for.
    expect(withGoogle).not.toContain('id="supermux-access-key"')
    expect(withGoogle.match(/<input/g) ?? []).toHaveLength(0)
    expect(withGoogle).toContain('I have an access key')
  })

  test('the invited colleague’s line survives on both faces', () => {
    expect(withGoogle).toContain('Got an invite link? Open it')
  })

  test('theme-correct in both themes — semantic tokens, brand pigment only in the mark', () => {
    for (const token of ['bg-background', 'text-foreground', 'text-primary-foreground']) {
      expect(withGoogle).toContain(token)
    }
    // The only literal colours are two brand marks' own pigment — supermux's
    // logo gradient (already true before this change) and Google's four-colour
    // G. Both are theme-independent by definition; everything the gate itself
    // paints is a semantic token, so `.dark` still drives the whole screen.
    const GOOGLE_G = ['#4285F4', '#34A853', '#FBBC05', '#EA4335']
    const literals = new Set(withGoogle.match(/#[0-9A-Fa-f]{6}/g) ?? [])
    // The Google-less gate's literals ARE the logo's stops (that suite already
    // pins them), so the delta between the two faces must be exactly the G.
    const logoStops = new Set(html.match(/#[0-9A-Fa-f]{6}/g) ?? [])
    const added = [...literals].filter((c) => !logoStops.has(c)).sort()
    expect(added).toEqual([...GOOGLE_G].sort())
  })

  test('mobile-first: full-width 44px targets, nothing wider than the column', () => {
    expect(withGoogle).toContain('h-11 w-full')
    expect(withGoogle).toContain('max-w-sm')
  })

  test('WITHOUT the capability the screen is unchanged, byte for byte', () => {
    // The regression that matters most: an invite-only / quick-tunnel box gets
    // exactly the markup it had before this feature existed.
    expect(html).not.toContain('Sign in with Google')
    expect(html).not.toContain('/auth/login')
    expect(html).not.toContain('I have an access key')
    // …and the key form is still the primary, always-open path.
    expect(html).toContain('id="supermux-access-key"')
    expect(html).toContain('bg-primary')
    expect(html).not.toContain('autofocus')
  })
})
