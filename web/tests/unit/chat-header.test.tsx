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
 *   2. the leaving session and the arriving one OVERLAP instead of queueing —
 *      one grid cell, both clusters at `grid-area: 1 / 1` — so a session switch
 *      is one opacity change and never a reflow.
 *
 *      That cell used to be `absolute inset-0` as well, on the stronger claim
 *      that "nothing inside can size the slot". The claim was too strong: an
 *      out-of-flow cell in a `min-height` box does not CLIP its overflow, it
 *      spills it. Measured at 390×844, the phone's trailing stack grew a third
 *      member (mode chip + connection chip + renderer switch = 72px) inside a
 *      60px card, and the renderer switch rendered BELOW the card, on top of
 *      the transcript. The cell is now in flow: the min-height is still a
 *      floor, the overlap is still one cell, and the card contains what it is
 *      given.
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
import { PHONE } from '../../src/components/chat/ui/metrics'
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
    const chrome = html.slice(0, html.indexOf('grid-area:1 / 1'))
    expect(chrome).toContain('min-height:64px')
    expect(/(?<!min-)height:/.test(chrome)).toBe(false)
    expect(/class="[^"]*\bh-(\[|\d)/.test(chrome)).toBe(false)
  })

  test('the swapping inner is one grid cell — the clusters overlap', () => {
    // `grid-area: 1 / 1` on every cluster is §11.6's same-cell swap: the
    // outgoing session and the incoming one occupy the SAME cell, so the switch
    // costs one opacity change and no reflow.
    expect(html).toContain('grid-area:1 / 1')
    // …and the cell is IN FLOW, so the card grows to hold a tall trailing stack
    // instead of spilling it over the transcript (see the file header).
    expect(html).not.toMatch(/class="[^"]*absolute inset-0[^"]*grid/)
    expect(html).toMatch(/class="relative grid"/)
  })

  test('the phone trailing stack fits the card floor', () => {
    const phone = renderToStaticMarkup(
      <SessionHeaderPill name={FOCUS} session={session()} surface="phone" />,
    )
    // The arithmetic the floor is chosen against: mode chip 19 + gap 3 +
    // renderer rail 26 + the row's 12px of vertical padding = 60, exactly
    // `PHONE.head.height`. A third chip pushes past it and the card GROWS —
    // which is the fix — but the two-member case must not grow, or every phone
    // header gets taller for nothing.
    expect(phone).toContain('py-1.5')
    expect(PHONE.head.height).toBe(19 + 3 + 26 + 12)
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

/**
 * Showcase honesty pass — the error/offline surfaces read as healthy.
 * ─────────────────────────────────────────────────────────────────────────────
 * st-error: a session carrying an unrecovered `StopFailure` (`session.error`)
 * showed only the orange StatusDot in the chat header — the same field that draws
 * a legible amber badge on the tile, the list row and the focus header — so it
 * read as idle. st-conn-offline: an offline data plane wore the "Offline" chip
 * while the presence dot stayed live green, the dot contradicting the label.
 */
describe('honesty — the error chip (st-error)', () => {
  test('an unrecovered agent error is a legible chip beside the name, not a bare dot', () => {
    const html = pill(session({ status: 'error', error: { type: 'StopFailure', message: 'cargo check failed' } }))
    expect(html).toContain('data-testid="chat-header-error"')
    // The word is on the chip — a StopFailure classifies to no bucket, so it is
    // the honest generic rather than nothing.
    expect(text(html)).toContain('Error')
    // The full message rides `title`, so the one-word chip stays short.
    expect(html).toContain('cargo check failed')
  })

  test('the chip is calm orange in the status family, never the accent (C7)', () => {
    const chip = pill(session({ error: { type: 'StopFailure', message: 'boom' } }))
      .match(/<span[^>]*data-testid="chat-header-error"[^>]*>/)![0]
    expect(chip).toContain('status-error')
    expect(chip).not.toContain('--sm-accent')
    expect(chip).not.toContain('--sm-session-tint')
  })

  test('a healthy session carries no error chip', () => {
    expect(pill(session({ status: 'idle' }))).not.toContain('chat-header-error')
  })

  test('the chip stands down when the block chip already names the same limit', () => {
    // Both witnesses to one rate-limit → one chip, not two amber nouns for one
    // fact (`statesSameBlock`, the roster's own dedupe).
    const html = pill(
      session({
        blocked: { kind: 'limit', text: "You've hit your weekly limit" },
        error: { type: 'rate_limit', message: "You've hit your weekly limit" },
      }),
    )
    expect(html).not.toContain('chat-header-error')
    expect(html).toContain('chat-header-blocked')
  })
})

describe('honesty — the offline dot (st-conn-offline)', () => {
  test('an offline plane greys the presence dot — no live green, and it names itself', () => {
    const html = renderToStaticMarkup(
      <SessionHeaderPill name={FOCUS} session={session({ status: 'idle' })} offline />,
    )
    // The neutral "unknown" grey, and a name a screen reader gets.
    const dot = element(html, 'Offline')
    expect(dot).toContain('bg-status-idle')
    expect(dot).toContain('data-testid="chat-header-offline-dot"')
    // The live "ready" green disc and the busy spinner are both gone — the dot
    // no longer claims the session is reachable.
    expect(html).not.toContain('bg-status-ready')
    expect(html).not.toContain('sm-status-spinner')
  })

  test('an offline plane greys the dot even while the status still reads active', () => {
    // The contradiction the audit caught: a stale `active` status under a socket
    // that has given up. The dot must not spin as if a turn were live.
    const html = renderToStaticMarkup(
      <SessionHeaderPill name={FOCUS} session={session({ status: 'active' })} offline />,
    )
    expect(html).not.toContain('sm-status-spinner')
    expect(html).toContain('data-testid="chat-header-offline-dot"')
  })

  test('online, the live dot is untouched', () => {
    expect(pill(session({ status: 'idle' }))).not.toContain('chat-header-offline-dot')
    expect(pill(session({ status: 'idle' }))).toContain('bg-status-ready')
  })
})

describe('the renderer switch', () => {
  // Fase A5 T2 added the third cell (`auto`) and the `resolved` prop; these
  // A3 assertions are re-pointed at it rather than rewritten, so the metrics
  // and the e2e hooks stay pinned. The tri-specific behaviour has its own file
  // (`chat-renderer-switch.test.tsx`).
  const html = (value: 'chat' | 'terminal') =>
    renderToStaticMarkup(
      <RendererSwitch value={value} resolved={value} onChange={() => undefined} />,
    )

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
    expect(text(out)).toBe('Auto Chat Terminal')
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
        trailing={
          trailing ?? (
            <RendererSwitch
              size="sm"
              labels="selected"
              value="chat"
              resolved="chat"
              onChange={() => undefined}
            />
          )
        }
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
      <RendererSwitch
        size="sm"
        labels="selected"
        value="chat"
        resolved="chat"
        onChange={() => undefined}
      />,
    )
    // The `A` is the auto cell's glyph — the one word-cell rule applies to the
    // two renderer names, which is what the phone header's width budget needs.
    expect(text(out)).toBe('A Chat')
    expect(out).toContain('aria-label="Terminal"')
    expect(out).toContain('data-testid="renderer-terminal"')
    // The default is untouched — the desktop seam still reads both words.
    expect(
      text(
        renderToStaticMarkup(
          <RendererSwitch value="chat" resolved="chat" onChange={() => undefined} />,
        ),
      ),
    ).toBe('Auto Chat Terminal')
  })
})
