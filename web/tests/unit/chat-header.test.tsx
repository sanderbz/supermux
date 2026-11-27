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
import { readFileSync } from 'node:fs'

import { describe, expect, test } from 'bun:test'
import type { ReactNode } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'

import {
  SessionHeaderPill,
  WorkflowChip,
  type HeaderWorkflow,
} from '../../src/components/chat/header-pill'
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

  test('the phone card does NOT reserve the notch as internal padding', () => {
    // The floating card floats BELOW the safe area — the reservation is the
    // overlay wrapper's `top` offset (`chat-surface.tsx`,
    // `calc(var(--safe-top) + 6px)`), NOT `pt-safe` inside the card. A
    // `pt-safe` here painted ~47px of empty glass above the name and doubled the
    // card's height on a notched device (invisible in the env=0 review rig).
    const phone = renderToStaticMarkup(
      <SessionHeaderPill name={FOCUS} session={session()} surface="phone" />,
    )
    expect(phone).not.toContain('pt-safe')
    // Desktop is not notched; the pinned bar keeps its harmless-at-env=0 inset.
    expect(pill(session())).toContain('pt-safe')
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
  // A binary Chat ⇄ Terminal toggle (`auto` retired). What is pinned here is the
  // e2e hooks only; the switch's own behaviour AND its A3 metrics (30px hairline
  // pill, 13.4px labels, the capsule that moves with the selection) have their
  // own file, `chat-renderer-switch.test.tsx`.
  const html = (value: 'chat' | 'terminal') =>
    renderToStaticMarkup(
      <RendererSwitch value={value} onChange={() => undefined} />,
    )

  test('keeps the hooks the e2e suite clicks', () => {
    const out = html('chat')
    expect(out).toContain('data-testid="renderer-chat"')
    expect(out).toContain('data-testid="renderer-terminal"')
    expect(out).toContain('role="tablist"')
    expect(out).toContain('role="tab"')
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
              onChange={() => undefined}
            />
          )
        }
      />,
    )

  test('the name carries a floor on the phone, and none on the desktop', () => {
    // The floor dropped to a small legible stub (56px) when the trailing cluster
    // went INLINE (single row): a wide reconnecting chip + the renderer toggle
    // beside a hard 112px floor overflowed the card, so the name yields first and
    // truncates the rest. The floor still exists — it just guards a stub, not a
    // full name.
    expect(phone(session({ display_name: 'Release Train' }))).toContain('min-width:56px')
    expect(pill(session({ display_name: 'Release Train' }))).not.toContain('min-width')
  })

  test('the trailing cluster is ONE inline row, not a stacked column', () => {
    // The header is a single iOS-style bar: the renderer toggle sits inline on
    // the one row, `flex-none` keeping the cluster's intrinsic width so the name
    // gives first.
    const out = phone(session({ display_name: 'ipc', mode: 'bypass' }))
    // The NAME may stack its model subtitle under it (a column that costs no
    // width); the TRAILING cluster may not.
    const trailing = out.slice(out.indexOf('flex flex-none items-center justify-end'))
    expect(trailing).not.toContain('flex-col')
    expect(out).toContain('flex-none')
    expect(text(out)).toContain('ipc')
  })

  test('the mobile chat header shows NO mode dot (owner: back · avatar · name · pill, no dots)', () => {
    // The owner stripped the phone chat header to its essentials — the mode dot
    // (condensed glyph or worded chip) no longer rides this cluster at all. Even
    // a `bypass` session paints no mode affordance in the header; the mode still
    // reaches the desktop header's worded `ModeChip` (below) and every other
    // caller, just not this bar.
    const out = phone(session({ display_name: 'ipc', mode: 'bypass' }))
    expect(out).not.toContain('Bypass mode')
    expect(text(out)).not.toContain('Bypass')
  })

  test('the mobile chat header shows NO presence dot (owner: no dots)', () => {
    // The presence dot was dropped from the phone chat header along with the mode
    // and connection dots — the header is back · avatar · name · Chat/Console
    // pill, nothing else. The dot survives on the desktop name row (next test)
    // and on the overview tile.
    const out = renderToStaticMarkup(
      <SessionHeaderPill name={FOCUS} session={session()} surface="phone" />,
    )
    expect(out).not.toContain('bg-status-ready')
    expect(out).not.toContain('sm-status-spinner')
  })

  test('the desktop keeps the presence dot on the name row', () => {
    // Only the phone strips its dots; the desktop header is unchanged, dot inline.
    const out = pill(session())
    expect(out).not.toContain('flex-col')
    expect(out).toContain('bg-status-ready')
  })

  test('labels="selected" drops the unselected WORD, never its name', () => {
    const out = renderToStaticMarkup(
      <RendererSwitch
        size="sm"
        labels="selected"
        value="chat"
        onChange={() => undefined}
      />,
    )
    // Only the active cell keeps its word; the unselected renderer condenses to
    // a glyph, which is what the phone header's width budget needs.
    expect(text(out)).toBe('Chat')
    expect(out).toContain('aria-label="Terminal"')
    expect(out).toContain('data-testid="renderer-terminal"')
    // The default is untouched — the desktop seam still reads both words.
    expect(
      text(
        renderToStaticMarkup(
          <RendererSwitch value="chat" onChange={() => undefined} />,
        ),
      ),
    ).toBe('Chat Terminal')
  })
})

/**
 * T6.3 — the honesty tell.
 *
 * A workflow OCCUPIES the bot's thread: its steps arrive in this pane as real
 * submissions, and the human can type into the same pane mid-chain. v1 does not
 * lock the pane — locking a user out of their own agent is worse than the
 * interleaving — so it DISCLOSES instead. The chip is the disclosure: it says a
 * run is in flight, how far along it is, where to read it, and how to stop it.
 *
 * The chip is pure (props, no queries) for the same reason everything else in
 * `header-pill.tsx` is: this module is rendered by `bun test`, whose resolver
 * reads the root tsconfig and its empty `paths`. The wiring — which workflow,
 * and the cancel mutation behind Stop — lives in the data plane and is asserted
 * against that source.
 */
describe('the chat-header workflow chip', () => {
  const chip = (over: Partial<HeaderWorkflow> = {}) =>
    renderToStaticMarkup(
      <WorkflowChip
        workflow={{
          id: 'WF-7',
          step: 2,
          steps: 4,
          href: '/workflows/WF-7',
          onOpen: () => undefined,
          onStop: () => undefined,
          ...over,
        }}
      />,
    )

  test('shows a "Workflow · step 2/4" chip while a run is in flight', () => {
    expect(text(chip())).toContain('Workflow · step 2/4')
  })

  test('the chip opens the run timeline', () => {
    // The run history lives on the workflow's own page — the chip is a way in,
    // not a second, smaller timeline.
    expect(chip()).toContain('href="/workflows/WF-7"')
  })

  test('offers Stop', () => {
    const out = chip()
    expect(out).toContain('data-testid="chat-header-workflow-stop"')
    expect(text(out)).toContain('Stop')
  })

  test('shows nothing when no run is in flight', () => {
    expect(renderToStaticMarkup(<WorkflowChip workflow={null} />)).toBe('')
    // …and the header itself carries no chip when the prop is absent, which is
    // every session that is not mid-chain.
    expect(text(pill(session()))).not.toContain('Workflow ·')
  })

  test('the header renders the chip when a run IS in flight', () => {
    const out = renderToStaticMarkup(
      <SessionHeaderPill
        name={FOCUS}
        session={session()}
        workflow={{
          id: 'WF-7',
          step: 2,
          steps: 4,
          href: '/workflows/WF-7',
          onOpen: () => undefined,
          onStop: () => undefined,
        }}
      />,
    )
    expect(text(out)).toContain('Workflow · step 2/4')
  })

  test('Stop is wired to the cancel mutation, and the chip to the live progress', () => {
    // A render cannot prove which endpoint Stop hits; the data plane can.
    const src = readFileSync(
      new URL('../../src/components/chat/chat-panel.tsx', import.meta.url).pathname,
      'utf8',
    )
    expect(src).toContain('useCancelRun')
    expect(src).toContain('useWorkflowProgress')
    // `cancel` is POST /api/workflows/{id}/cancel — asserted where it is spelled.
    const api = readFileSync(
      new URL('../../src/lib/api/workflows.ts', import.meta.url).pathname,
      'utf8',
    )
    expect(api).toContain('/cancel')
  })
})

/**
 * The header NAME is the door to the bot's details.
 * ─────────────────────────────────────────────────────────────────────────────
 * The terminal chrome has had a title-click into the panel since
 * feat-session-info (`<FocusHeader onTitleClick>`); under CHAT the same header
 * slot was an inert `<span>`, so on the phone — where the chat card IS the
 * route's header — there was no way to reach the bot's settings at all. The pill
 * now takes the same optional handler, and the desktop seam (which does not pass
 * one) must keep the span it always had.
 */
describe('the header name as the details door', () => {
  test('without a handler the name stays an inert span', () => {
    // The model chip beside the name is its own door; the NAME is the subject.
    const out = pill(session()).replace(
      /<button[^>]*data-testid="chat-header-model"[\s\S]*?<\/button>/,
      '',
    )
    expect(out).toContain(FOCUS)
    expect(out).not.toContain('data-testid="chat-header-title"')
    expect(out).not.toContain('aria-haspopup="dialog"')
  })

  test('with a handler the name is a real button with a 44px target', () => {
    const out = renderToStaticMarkup(
      <SessionHeaderPill
        name={FOCUS}
        session={session()}
        surface="phone"
        onTitleClick={() => undefined}
      />,
    )
    expect(out).toContain('data-testid="chat-header-title"')
    expect(out).toContain('<button')
    expect(out).toContain('aria-haspopup="dialog"')
    // The visible name leads the label (voice control keys on what is on screen).
    expect(out).toContain(`aria-label="${FOCUS} — bot details"`)
    // The row's own hit floor, taken back out of the layout so the card's
    // geometry does not move (the file's one structural promise).
    expect(out).toContain('min-h-11')
    expect(out).toContain('-my-2.5')
    // The name is still the elastic, truncating member it was.
    expect(out).toContain('flex-1')
    expect(out).toContain('truncate')
    expect(text(out)).toContain(FOCUS)
  })

  test('the mobile chat route actually wires it to the details sheet', () => {
    // The pill is only half the fix: the phone's `<ChatPanel>` has to pass the
    // handler that opens the BotPanel sheet, or the button is a dead control.
    const route = readFileSync(
      new URL('../../src/routes/focus/mobile.tsx', import.meta.url),
      'utf8',
    )
    expect(route).toContain('onTitleClick={() => {')
    // …and it opens the SAME sheet the terminal chrome's title opens.
    expect(route).toContain('setInfoOpen(true)')
    const panel = readFileSync(
      new URL('../../src/components/chat/chat-panel.tsx', import.meta.url),
      'utf8',
    )
    expect(panel).toContain('onTitleClick={onTitleClick}')
  })
})

/**
 * The model chip — the main agent's live model beside the name, and the door to
 * the picker. The words are `live_model` (the statusline when tapped, else the
 * transcript's last main-agent signal); unknown reads "Model", never a guess
 * from the launch-line `model`.
 */
describe('the chat-header model chip', () => {
  const FABLE = { id: 'claude-fable-5-2', display_name: 'Fable 5.2' }
  const chipOf = (html: string) =>
    html.match(/<button[^>]*data-testid="chat-header-model"[^>]*>.*?<\/button>/)?.[0]

  test('names the live model in its short form beside the name', () => {
    const chip = chipOf(pill(session({ live_model: FABLE })))
    expect(chip).toBeDefined()
    expect(text(chip!)).toBe('Fable 5.2')
    expect(chip).toContain('aria-label="Model: Fable 5.2 — change model"')
    expect(chip).toContain('aria-haspopup="dialog"')
  })

  test('drops the parenthetical, keeps the version', () => {
    const chip = chipOf(
      pill(session({ live_model: { id: 'claude-opus-5[1m]', display_name: 'Opus 5 (1M context)' } })),
    )
    expect(text(chip!)).toBe('Opus 5')
  })

  test('the phone shows the family alone', () => {
    const out = renderToStaticMarkup(
      <SessionHeaderPill name={FOCUS} session={session({ live_model: FABLE })} surface="phone" />,
    )
    expect(text(chipOf(out)!)).toBe('Fable')
  })

  test('unknown model → a "Model" chip, so a fresh session can pick before its first prompt', () => {
    // No statusline and no reply in the transcript yet. Still a door — and the
    // launch-line model is never used to fill the gap.
    for (const s of [
      session(),
      session({ live_model: null }),
      session({ model: 'opus' } as Partial<TileSession>),
    ]) {
      const chip = chipOf(pill(s))
      expect(text(chip!)).toBe('Model')
      expect(chip).toContain('aria-label="Choose model"')
    }
  })

  test('only for a running Claude session', () => {
    expect(chipOf(pill(session({ provider: 'codex', live_model: FABLE })))).toBeUndefined()
    expect(chipOf(pill(session({ status: 'stopped', live_model: FABLE })))).toBeUndefined()
  })

  test('the picker is lazy — nothing of it renders until the chip is tapped', () => {
    expect(pill(session({ live_model: FABLE }))).not.toContain('model-picker')
    const src = readFileSync(
      new URL('../../src/components/chat/header-pill.tsx', import.meta.url),
      'utf8',
    )
    expect(src).toContain("React.lazy(() => import('./model-picker'))")
  })
})
