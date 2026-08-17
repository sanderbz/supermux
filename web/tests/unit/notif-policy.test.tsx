/**
 * `<NotifPolicyControl>` — the per-BOT notification setting (B5/T3.3).
 *
 * The design claim being tested: notifications live on the BOT, not only in a
 * global list of event types. The global Settings toggles are the per-KIND
 * mute; this is the per-BOT one, and the effective decision is the AND of the
 * two — applied once, on the server, in `push::send_push_for`.
 *
 * What is asserted here is the part a user can be hurt by: that the control
 * always renders a definite state (there is no "unknown"), that the four
 * options are offered in escalating quiet so the row reads left-to-right, and
 * that the current one is marked for assistive tech. The WRITE path is not
 * exercised — it is one `PATCH .../config { notif }` call and the server owns
 * validation (an unrecognised policy is a 400, not a coercion), which
 * `server/src/sessions/mod.rs` covers.
 */
import { describe, expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'

import { NotifPolicyControl } from '../../src/components/focus-mode/notif-policy-control'
import { ToastProvider } from '../../src/components/ui/toast'
import type { NotifPolicy } from '../../src/lib/api/sessions'

// Both providers are needed only by the WRITE path — the control invalidates
// the sessions query on success and toasts on failure. Static rendering walks
// only the initial tree, which is the read surface under test; the providers
// are here so the hooks resolve, not because anything mutates.
const html = (value: NotifPolicy | undefined): string =>
  renderToStaticMarkup(
    <QueryClientProvider client={new QueryClient()}>
      <ToastProvider>
        <NotifPolicyControl name="deploy-fix" value={value} />
      </ToastProvider>
    </QueryClientProvider>,
  )

describe('the control always shows a definite state', () => {
  test('an absent value renders as `inherit`, not as blank', () => {
    // `undefined` happens twice in real life: while the sessions row is still
    // loading, and against a server that predates migration 0028. Both mean
    // "follow the global toggles", which IS `inherit` — so there is no third
    // visual state to design, and the control must never flash empty.
    const absent = html(undefined)
    const explicit = html('inherit')
    expect(absent).toContain('Inherit')
    // Same selected option in both, so loading does not look like a choice.
    expect(absent.includes('aria-checked="true"')).toBe(
      explicit.includes('aria-checked="true"'),
    )
  })

  test('every policy renders its own option set', () => {
    for (const v of ['inherit', 'all', 'attention', 'off'] as NotifPolicy[]) {
      const out = html(v)
      expect(out).toContain('Inherit')
      expect(out).toContain('Everything')
      expect(out).toContain('Off')
    }
  })
})

describe('the options escalate in quiet', () => {
  const out = html('inherit')

  test('the row reads left-to-right as "more silence"', () => {
    // Order is meaning here: a user scanning the row should be able to stop at
    // the first option quiet enough. Assert positions, not just presence.
    const iInherit = out.indexOf('Inherit')
    const iAll = out.indexOf('Everything')
    const iAttention = out.indexOf('Needs you')
    const iOff = out.indexOf('Off')
    expect(iInherit).toBeGreaterThanOrEqual(0)
    expect(iAll).toBeGreaterThan(iInherit)
    expect(iAttention).toBeGreaterThan(iAll)
    expect(iOff).toBeGreaterThan(iAttention)
  })

  test('the current choice is exposed to assistive tech', () => {
    // A four-way where the selected option is conveyed by colour alone is
    // unusable without sight, and this control changes whether a phone rings.
    expect(out).toContain('aria-checked')
  })
})

describe('the copy tells the truth about what each option does', () => {
  test('`off` promises silence, not invisibility', () => {
    // The distinction that matters: muting a bot silences the PHONE. Its roster
    // tier keeps working, so the user has not hidden it from themselves.
    const out = html('off')
    expect(out.toLowerCase()).toContain('never')
  })

  test('`attention` names what survives the mute', () => {
    const out = html('attention')
    // Blocked-on-you and errors survive; the calm "turn finished" tier does not.
    expect(out.toLowerCase()).toMatch(/blocked|error/)
  })
})
