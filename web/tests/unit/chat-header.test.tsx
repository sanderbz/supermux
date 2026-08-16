/**
 * The session header pill + the renderer switch (fase A3 T6).
 * ─────────────────────────────────────────────────────────────────────────────
 * T6's deliverable is a header that CANNOT move the conversation under it. Both
 * halves of that promise are structural, so both are asserted here rather than
 * eyeballed on the bench:
 *
 *   1. the slot is a FLOOR plus an ADDITIVE inset (`min-height` + `pt-safe`),
 *      never a fixed height — globals.css's safe-area contract, the one a
 *      `h-14 pt-safe` header gets wrong by squishing its content under the
 *      notch;
 *   2. the swapping inner is OUT OF FLOW (absolute, one grid cell), so the
 *      leaving session and the arriving one overlap instead of queueing: a
 *      session switch is an opacity change inside a box whose height never
 *      depends on what is inside it.
 *
 * Plus the two things a re-dress could quietly break: the status affordance
 * staying in the `--status-*` family (concept contract C7 — the same guard
 * `chat-accent.test.ts` puts on the surface, now on the element that replaced
 * its placeholder), and the renderer switch keeping the hooks the e2e suite
 * clicks (`renderer-chat` / `renderer-terminal`, `role="tablist"`).
 */
import { describe, expect, test } from 'bun:test'
import type { ReactNode } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'

import { SessionHeaderPill } from '../../src/components/chat/header-pill'
import { RendererSwitch } from '../../src/components/chat/renderer-switch'
import { sessionAccentVars } from '../../src/components/chat/session-accent'
import type { TileSession } from '../../src/components/session-tile/types'

const FOCUS = 'release-train'

function session(over: Partial<TileSession> = {}): TileSession {
  return {
    name: FOCUS,
    status: 'idle',
    dir: '/opt/projects/supermux',
    provider: 'claude',
    preview_lines: [],
    updated_at: '2026-08-14T10:00:00Z',
    ...over,
  }
}

const pill = (s: TileSession | null, name = FOCUS) =>
  renderToStaticMarkup(<SessionHeaderPill name={name} session={s} />)

/** Visible text, with element boundaries collapsed to one space. */
const text = (html: string) => html.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim()

/** The single element carrying this accessible name, tag included. */
function element(html: string, label: string): string {
  const m = html.match(new RegExp(`<[a-z]+[^>]*aria-label="${label}"[^>]*>`))
  expect(m).not.toBeNull()
  return m![0]
}

describe('what the pill says', () => {
  test('the display name when there is one, the slug when there is not', () => {
    expect(text(pill(session({ display_name: 'Release Train' })))).toContain('Release Train')
    expect(text(pill(session()))).toContain(FOCUS)
  })

  test('a session that has not loaded yet still names itself', () => {
    // The sessions query resolves after the panel mounts; a header that renders
    // nothing until it lands is a header that flickers in on every switch.
    expect(text(pill(null))).toContain(FOCUS)
  })

  test('the mode chip names a mode in words, and only when there is one to name', () => {
    expect(text(pill(session({ mode: 'plan' })))).toContain('Plan')
    expect(text(pill(session({ mode: 'accept_edits' })))).toContain('Accept edits')
    // `normal` is the absence of a mode, not a mode: a chip that always reads
    // "Normal" is a chip nobody reads.
    expect(text(pill(session({ mode: 'normal' })))).not.toContain('Normal')
    expect(text(pill(session()))).not.toContain('Normal')
  })
})

describe('the slot cannot shift', () => {
  const html = pill(session())

  test('a floor plus an additive inset — never a fixed height', () => {
    expect(html).toContain('pt-safe')
    expect(html).toContain('min-height:64px')
    // Tailwind is border-box: a fixed `height` would let env(safe-area-inset-top)
    // eat INTO the bar instead of growing it. `min-height` cannot. Asserted on
    // the bar's own chrome — the two wrappers before the swap cell — because
    // the 28px mark inside it is legitimately 28px tall.
    const chrome = html.slice(0, html.indexOf('<div class="absolute'))
    expect(chrome).toContain('min-height:64px')
    expect(/(?<!min-)height:/.test(chrome)).toBe(false)
    expect(/class="[^"]*\bh-(\[|\d)/.test(chrome)).toBe(false)
  })

  test('the swapping inner is out of flow, in one grid cell', () => {
    // Absolute + `grid-area: 1 / 1` is §11.6's same-cell swap: the outgoing
    // session and the incoming one overlap, and neither can size the slot.
    expect(html).toMatch(/class="[^"]*absolute inset-0[^"]*grid/)
    expect(html).toContain('grid-area:1 / 1')
  })

  test('the inner is addressed by the slug — the crossfade re-keys on it', () => {
    // React keys do not reach the markup; this attribute is their proxy, and it
    // is what a bench screenshot diff can be cropped on.
    expect(pill(session(), 'patch')).toContain('data-pill-session="patch"')
  })
})

describe('C7 — status is status, accent is accent', () => {
  test('the pill carries the session accent', () => {
    const accent = (sessionAccentVars(FOCUS) as Record<string, string>)['--sm-accent']
    expect(pill(session())).toContain(`--sm-accent:${accent}`)
  })

  test('two sessions, two accents — one property write re-skins the header', () => {
    const a = pill(session({ name: FOCUS }), FOCUS)
    const b = pill(session({ name: 'patch' }), 'patch')
    const accentOf = (html: string) => html.match(/--sm-accent:([^;"]+)/)?.[1]
    expect(accentOf(a)).not.toBe(accentOf(b))
  })

  test('the status affordance is in the status family, and nothing else', () => {
    const badge = element(pill(session({ status: 'error' })), 'Error')
    expect(badge).toContain('status-error')
    expect(badge).not.toContain('--sm-accent')
    expect(badge).not.toContain('--sm-session-tint')
  })

  test('the real StatusDot — so the busy states keep their spinner', () => {
    // The placeholder this replaces (`SurfaceStatus`) drew a static disc for
    // every status; T6's whole point is that the header is the app's status
    // affordance, not a lookalike.
    expect(pill(session({ status: 'active' }))).toContain('sm-status-spinner')
    expect(pill(session({ status: 'starting' }))).toContain('sm-status-spinner')
    expect(pill(session({ status: 'waiting' }))).not.toContain('sm-status-spinner')
    expect(element(pill(session({ status: 'waiting' })), 'Needs input')).toContain(
      'bg-status-waiting',
    )
  })
})

describe('the renderer switch', () => {
  const html = (value: 'chat' | 'terminal') =>
    renderToStaticMarkup(<RendererSwitch value={value} onChange={() => undefined} />)

  test('keeps the hooks the e2e suite clicks', () => {
    const out = html('chat')
    expect(out).toContain('data-testid="renderer-chat"')
    expect(out).toContain('data-testid="renderer-terminal"')
    expect(out).toContain('role="tablist"')
    expect(out).toContain('role="tab"')
  })

  test('the selection is a capsule that moves, not a colour on the label', () => {
    const chat = html('chat')
    expect(chat).toContain('bg-fill-soft-2')
    expect(chat).toMatch(/aria-selected="true"[^>]*>[\s\S]*?bg-fill-soft-2/)
    // …and it is the OTHER cell that carries it once the value flips.
    expect(html('terminal')).toMatch(/renderer-terminal[\s\S]*?bg-fill-soft-2/)
  })

  test('the approved metrics: a 30px hairline pill, 13.4px labels', () => {
    const out = html('chat')
    expect(out).toContain('h-[30px]')
    expect(out).toContain('border-hairline')
    expect(out).toContain('text-[13.4px]')
    expect(text(out)).toBe('Chat Terminal')
  })
})

/**
 * Daily-driver QA #6 — the header truncated the session's name to stubs.
 *
 * Measured on the live instance: `spike-qa-daily` rendered as `spike-qa…` (95px
 * shown, 124px needed) and a three-character name, `ipc`, rendered as `i…`,
 * because the mode chip and the Chat/Terminal switch were served first. The
 * trailing controls are the ones that give way now — the switch drops one word,
 * the chip stops sitting BESIDE it — and the name carries a floor.
 */
describe('the phone header gives its width to the name (QA #6)', () => {
  const phone = (s: TileSession, trailing?: ReactNode) =>
    renderToStaticMarkup(
      <SessionHeaderPill
        name={FOCUS}
        session={s}
        surface="phone"
        trailing={trailing ?? <RendererSwitch size="sm" labels="selected" value="chat" onChange={() => undefined} />}
      />,
    )

  test('the name carries a floor on the phone, and none on the desktop', () => {
    expect(phone(session({ display_name: 'Release Train' }))).toContain('min-width:112px')
    expect(pill(session({ display_name: 'Release Train' }))).not.toContain('min-width')
  })

  test('the mode chip stacks over the trailing slot instead of beside it', () => {
    // `ipc` in bypass mode was the worst case: chip + switch took 187px of a
    // 342px row. Stacked, the pair costs the WIDER of the two, not their sum.
    const out = phone(session({ display_name: 'ipc', mode: 'bypass' }))
    expect(out).toContain('flex-col')
    expect(text(out)).toContain('ipc')
    expect(text(out)).toContain('Bypass')
    // …and the cluster can still give way when even that is not enough.
    expect(out).toContain('shrink')
  })

  test('a header with neither a mode nor a trailing slot grows no empty cell', () => {
    const out = renderToStaticMarkup(
      <SessionHeaderPill name={FOCUS} session={session()} surface="phone" />,
    )
    expect(out).not.toContain('flex-col')
  })

  test('labels="selected" drops the unselected WORD, never its name', () => {
    const out = renderToStaticMarkup(
      <RendererSwitch size="sm" labels="selected" value="chat" onChange={() => undefined} />,
    )
    expect(text(out)).toBe('Chat')
    expect(out).toContain('aria-label="Terminal"')
    expect(out).toContain('data-testid="renderer-terminal"')
    // The default is untouched — the desktop seam still reads both words.
    expect(text(renderToStaticMarkup(<RendererSwitch value="chat" onChange={() => undefined} />))).toBe(
      'Chat Terminal',
    )
  })
})
