/**
 * The sign-in card — what it shows, and what it refuses to show.
 *
 * The interesting assertions here are the negative ones. This card is the only
 * place in the app that takes an OAuth code, and the rules that make it safe are
 * invisible in a screenshot: the field is a masked `password` input, a URL that
 * could not be reassembled becomes a sentence rather than a dead link, the
 * external link carries `noopener`, and `Login successful` is a state that still
 * needs a press — that press is what writes `hasCompletedOnboarding`, and a card
 * that celebrated and stopped would leave every later session on the host
 * booting into the first-run wizard holding valid credentials.
 *
 * Rendered with `renderToStaticMarkup`, the same way every other component test
 * in this directory works (there is no DOM environment in the unit runner — see
 * `chat-surface.test.tsx`). The interactive half of the contract — that a
 * malformed paste never reaches the pty — lives in `login-lens-parity.test.ts`
 * on `loginCodeProblem`, which is the function the submit handler gates on.
 */
import { describe, expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'

import { LoginCard } from '../../src/components/chat/login-card'
import type { LoginSighting } from '../../src/components/chat/login-lens'

const URL_ = 'https://claude.com/cai/oauth/authorize?code=true&amp;state=abc'
const RAW_URL = 'https://claude.com/cai/oauth/authorize?code=true&state=abc'

const paste = (over: Partial<LoginSighting> = {}): LoginSighting => ({
  stage: 'paste_prompt',
  flow: 'account',
  url: RAW_URL,
  options: [],
  ...over,
})

const noop = () => {}
const html = (el: React.ReactElement) => renderToStaticMarkup(el)

describe('the sign-in card', () => {
  test('renders nothing at all when no login is on screen', () => {
    expect(html(<LoginCard sighting={null} onSubmitCode={noop} />)).toBe('')
  })

  test('offers the URL as a real, tappable, safely-targeted link', () => {
    const out = html(<LoginCard sighting={paste()} onSubmitCode={noop} />)
    expect(out).toContain(`href="${URL_}"`)
    expect(out).toContain('target="_blank"')
    // A credential page opened with `target=_blank` and no `noopener` hands the
    // opened page a `window.opener` handle back into this app.
    expect(out).toContain('noopener')
    // And the whole URL in selectable text, for the browser where neither the
    // link nor the clipboard can be used.
    expect(out).toContain('<code')
  })

  test('says so instead of rendering a dead link when the URL could not be read', () => {
    // The URL is scraped off a VT grid that hard-wraps it; a capture taken
    // mid-redraw yields none, and `href=""` looks like a working button.
    const out = html(<LoginCard sighting={paste({ url: undefined })} onSubmitCode={noop} />)
    expect(out).not.toContain('login-open-link')
    expect(out).toContain('has not appeared on the screen yet')
  })

  test('the code field is masked and offers nothing to a password manager', () => {
    const out = html(<LoginCard sighting={paste()} onSubmitCode={noop} />)
    expect(out).toContain('type="password"')
    // (React's static renderer emits these attributes in their JSX spelling.)
    expect(out).toContain('autoComplete="off"')
    expect(out).toContain('spellCheck="false"')
    // A single-use credential must not be remembered, corrected or capitalised.
    expect(out).toContain('autoCapitalize="off"')
    expect(out).toContain('autoCorrect="off"')
  })

  test('a rejection is shown verbatim, with the field still in place', () => {
    // Never a respawn: the PKCE verifier that makes the next code valid exists
    // only inside the process that is waiting for it.
    const out = html(
      <LoginCard
        sighting={paste({
          stage: 'invalid',
          message: 'Invalid code. Please make sure the full code was copied',
        })}
        onSubmitCode={noop}
      />,
    )
    expect(out).toContain('Invalid code. Please make sure the full code was copied')
    expect(out).toContain('type="password"')
    expect(out).toContain('data-stage="invalid"')
  })

  test('success is a state that still needs a press', () => {
    const out = html(
      <LoginCard
        sighting={{ stage: 'success', flow: 'account', options: [], email: 'a@b.com' }}
        onSubmitCode={noop}
        onConfirm={noop}
      />,
    )
    expect(out).toContain('a@b.com')
    expect(out).toContain('login-confirm')
    expect(out).toContain('One more press to finish')
    // Nothing to paste any more.
    expect(out).not.toContain('type="password"')
  })

  test('a design login does not claim to be an account login', () => {
    const out = html(<LoginCard sighting={paste({ flow: 'design' })} onSubmitCode={noop} />)
    expect(out).toContain('data-flow="design"')
    expect(out).toContain('design-system access')
    expect(out).not.toContain('Sign in to Claude')
  })

  test('claims the freeze only when the server said so', () => {
    const cold = html(<LoginCard sighting={paste()} onSubmitCode={noop} />)
    expect(cold).not.toContain('Nothing else will write')
    const warm = html(<LoginCard sighting={paste()} frozen onSubmitCode={noop} />)
    expect(warm).toContain('Nothing else will write')
  })

  test('the method selector draws one control per row, in TUI order', () => {
    const out = html(
      <LoginCard
        sighting={{
          stage: 'method_select',
          flow: 'account',
          options: ['Claude account with subscription', 'Anthropic Console account'],
        }}
        onSubmitCode={noop}
        onChooseMethod={noop}
      />,
    )
    expect(out.indexOf('Claude account with subscription')).toBeGreaterThan(-1)
    expect(out.indexOf('Anthropic Console account')).toBeGreaterThan(
      out.indexOf('Claude account with subscription'),
    )
  })

  test('an error surfaces the CLI’s own sentence and offers the terminal', () => {
    const out = html(
      <LoginCard
        sighting={{
          stage: 'error',
          flow: 'account',
          options: [],
          message: 'OAuth error: Authentication timeout',
        }}
        onSubmitCode={noop}
        onOpenTerminal={noop}
        onCancel={noop}
      />,
    )
    expect(out).toContain('OAuth error: Authentication timeout')
    expect(out).toContain('Open terminal')
  })
})
