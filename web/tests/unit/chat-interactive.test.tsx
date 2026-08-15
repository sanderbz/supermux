/**
 * The chat surface as a CONTROL surface (fase A4 T3).
 * ─────────────────────────────────────────────────────────────────────────────
 * A3's tests pin what the surface LOOKS like; this pins what it DOES — and,
 * more importantly, what it refuses to do. Three things are asserted here,
 * because each one is a failure the user cannot see coming:
 *
 *   1. THE KEY CONTRACT. Enter sends, Shift+Enter breaks the line, and an IME
 *      composition owns its own Enter. Get the last one wrong and the composer
 *      sends half a word in Japanese and every keystroke in Korean — with no
 *      error, on a device the author probably never tested.
 *   2. THE PRE-SEND GATE. `POST /send` types into whatever is at the TUI's
 *      prompt: a draft the user left there gets CONCATENATED and submitted with
 *      the chat message. The gate is a truth table so it can be read at a
 *      glance and so a peek OUTAGE can never be mistaken for a clear screen.
 *   3. THE SURFACE'S HONESTY. Once the input plane is live the read-only line
 *      is gone, and while a turn runs the send control admits it is now a Stop.
 *
 * No DOM: the behaviour lives in pure functions and a module-level draft store
 * precisely so it can be asserted in `bun test`, which is what the whole app's
 * unit net runs on.
 */
import { describe, expect, test } from 'bun:test'
import * as React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'

import { ChatComposer } from '../../src/components/chat/composer'
import { ChatConversation } from '../../src/components/chat/conversation'
import type { PeekLens } from '../../src/components/chat/peek-lens'
import type { PendingSend } from '../../src/components/chat/pending'
import {
  composerSessionInput,
  getDraft,
  insertIntoComposer,
  setDraft,
} from '../../src/components/chat/composer-draft'
import {
  composerKeyIntent,
  sendGate,
  type ComposerHandle,
} from '../../src/components/chat/use-composer'
import type { TileSession } from '../../src/components/session-tile/types'

const NAME = 'release-train'

// ── 1. The key contract ─────────────────────────────────────────────────────

describe('the composer’s key contract', () => {
  const idle = { draft: '', active: false }
  const typed = { draft: 'ship it', active: false }
  const running = { draft: '', active: true }

  test('Enter sends, Shift+Enter breaks the line', () => {
    expect(composerKeyIntent({ key: 'Enter' }, typed)).toBe('submit')
    expect(composerKeyIntent({ key: 'Enter', shiftKey: true }, typed)).toBe('newline')
  })

  test('an IME composition owns its Enter — three ways of saying so', () => {
    // The standard flag…
    expect(composerKeyIntent({ key: 'Enter', isComposing: true }, typed)).toBe('pass')
    // …the React synthetic event's native one…
    expect(
      composerKeyIntent({ key: 'Enter', nativeEvent: { isComposing: true } }, typed),
    ).toBe('pass')
    // …and keyCode 229, the Android/GBoard fallback this repo already relies on
    // in `hooks/use-live-term.ts:1349` and `lib/android-ime.ts`, because soft
    // keyboards deliver nearly everything as composition and some never set
    // `isComposing` on the keydown that commits.
    expect(composerKeyIntent({ key: 'Enter', keyCode: 229 }, typed)).toBe('pass')
  })

  test('a modified Enter belongs to somebody else', () => {
    expect(composerKeyIntent({ key: 'Enter', metaKey: true }, typed)).toBe('pass')
    expect(composerKeyIntent({ key: 'Enter', ctrlKey: true }, typed)).toBe('pass')
  })

  test('one Escape, one meaning', () => {
    // Text in the box: Escape is "forget this sentence".
    expect(composerKeyIntent({ key: 'Escape' }, typed)).toBe('clear')
    expect(composerKeyIntent({ key: 'Escape' }, { draft: 'x', active: true })).toBe('clear')
    // Empty box, a turn running: Escape is the interrupt.
    expect(composerKeyIntent({ key: 'Escape' }, running)).toBe('stop')
    // Empty box, nothing running: Escape is the terminal's, not ours.
    expect(composerKeyIntent({ key: 'Escape' }, idle)).toBe('pass')
  })

  test('a composition owns ESCAPE too, not just Enter', () => {
    // Escape mid-conversion means "cancel this candidate" to every CJK IME. If
    // the composer swallowed it to clear the draft, one of the most-pressed keys
    // in Japanese input would delete the whole message — the Enter bug above,
    // wearing a different hat.
    expect(composerKeyIntent({ key: 'Escape', isComposing: true }, typed)).toBe('pass')
    expect(composerKeyIntent({ key: 'Escape', keyCode: 229 }, typed)).toBe('pass')
    expect(
      composerKeyIntent({ key: 'Escape', nativeEvent: { isComposing: true } }, running),
    ).toBe('pass')
  })

  test('every other key is the browser’s', () => {
    expect(composerKeyIntent({ key: 'a' }, typed)).toBe('pass')
    expect(composerKeyIntent({ key: 'Tab' }, typed)).toBe('pass')
    expect(composerKeyIntent({ key: 'ArrowUp' }, typed)).toBe('pass')
  })
})

// ── 2. The pre-send gate ────────────────────────────────────────────────────

const CLEAR: PeekLens = { bannerVersion: '2.1.231', composerDraft: null, dialog: null }

describe('the pre-send peek gate', () => {
  test('a clear screen sends', () => {
    expect(sendGate(CLEAR)).toEqual({ send: true })
  })

  test('a draft sitting in the TERMINAL blocks the send and is quoted back', () => {
    const gate = sendGate({ ...CLEAR, composerDraft: 'half a thought' })
    expect(gate.send).toBe(false)
    expect(gate).toMatchObject({ notice: { kind: 'tui-draft', detail: 'half a thought' } })
  })

  test('an open dialog blocks the send, and says so instead of guessing', () => {
    const gate = sendGate({
      ...CLEAR,
      dialog: { family: 'permission', variant: 'bash', options: ['Yes'], caretIndex: 0 },
    })
    expect(gate).toEqual({ send: false, notice: { kind: 'dialog' } })
  })

  test('the dialog outranks a draft read in the same frame', () => {
    const gate = sendGate({
      ...CLEAR,
      composerDraft: '1. Yes',
      dialog: { family: 'plan', options: ['Yes'], caretIndex: null },
    })
    expect(gate).toMatchObject({ notice: { kind: 'dialog' } })
  })

  test('a FAILED peek sends anyway — "I could not look" is not "you cannot type"', () => {
    // The watchdog (T4) is the honest layer for a send that vanishes; a peek
    // outage must never make the composer unusable.
    expect(sendGate(null)).toEqual({ send: true })
  })
})

// ── 3. The insert seam ──────────────────────────────────────────────────────

describe('every insert surface writes into the REACT composer', () => {
  test('an insert with no composer mounted still lands, at the end of the draft', () => {
    setDraft(NAME, 'fix')
    insertIntoComposer(NAME, '@src/main.rs')
    expect(getDraft(NAME)).toBe('fix @src/main.rs')
    setDraft(NAME, '')
  })

  test('the composer plane stages INSERTS and still sends SUBMITS', async () => {
    const sent: string[] = []
    const pasted: string[] = []
    const base = {
      submit: (t: string) => {
        sent.push(t)
        return Promise.resolve()
      },
      insert: (t: string) => {
        pasted.push(t)
        return Promise.resolve()
      },
      sendKey: () => Promise.resolve(),
      focus: () => {},
      blur: () => {},
    }
    const input = composerSessionInput(NAME, base)

    await input.insert('/compact')
    // NOT `/paste`d at a `❯` nobody is looking at: staged where it can be read
    // and edited (master plan §3).
    expect(pasted).toEqual([])
    expect(getDraft(NAME)).toBe('/compact')

    await input.submit('ship it')
    expect(sent).toEqual(['ship it'])
    setDraft(NAME, '')
  })
})

// ── 4. What the surface says ────────────────────────────────────────────────

function handle(over: Partial<ComposerHandle> = {}): ComposerHandle {
  return {
    draft: '',
    setDraft: () => {},
    ref: React.createRef<HTMLTextAreaElement>(),
    sending: false,
    notice: null,
    dismissNotice: () => {},
    submit: () => {},
    stop: () => {},
    insert: () => {},
    onChange: () => {},
    onKeyDown: () => {},
    ...over,
  }
}

const composer = (over: Partial<ComposerHandle> = {}, active = false) =>
  renderToStaticMarkup(
    <ChatComposer name={NAME} label="Release Train" handle={handle(over)} active={active} />,
  )

const text = (html: string) => html.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim()

describe('the composer, live', () => {
  test('at rest the boards’ mic keeps its cell — no send button on an empty draft', () => {
    const html = composer()
    expect(html).toContain('sm-mic')
    expect(html).not.toContain('data-testid="chat-send"')
    expect(html).not.toContain('data-testid="chat-stop"')
  })

  test('a draft arms Send', () => {
    const html = composer({ draft: 'ship it' })
    expect(html).toContain('data-testid="chat-send"')
    // …and the field is a REAL controlled input now, not a read-only prop.
    expect(html).toContain('data-testid="chat-composer-field"')
    expect(html).toContain('ship it')
  })

  test('Stop replaces Send while the turn runs — same cell, no reflow', () => {
    const html = composer({ draft: 'ship it' }, true)
    expect(html).toContain('data-testid="chat-stop"')
    expect(html).not.toContain('data-testid="chat-send"')
  })

  test('a refusal names the reason, quotes the evidence and offers the terminal', () => {
    const html = renderToStaticMarkup(
      <ChatComposer
        name={NAME}
        label="Release Train"
        handle={handle({
          draft: 'ship it',
          notice: { kind: 'tui-draft', detail: 'half a thought' },
        })}
        onOpenTerminal={() => {}}
      />,
    )
    expect(html).toContain('data-notice="tui-draft"')
    expect(text(html)).toContain('The terminal has an unsent draft.')
    expect(text(html)).toContain('half a thought')
    expect(html).toContain('data-testid="chat-composer-open-terminal"')
  })

  test('the dialog refusal points at the card rather than at the terminal’s draft', () => {
    const html = composer({ draft: 'ship it', notice: { kind: 'dialog' } })
    expect(text(html)).toContain('answer it first')
  })

  test('a Stop that never landed says the turn is still running', () => {
    // The one failure this surface may not absorb into a console warning: the
    // user pressed Stop, the POST was rejected, and the agent kept going.
    const html = composer({ notice: { kind: 'stop-failed' } }, true)
    expect(html).toContain('data-notice="stop-failed"')
    expect(text(html)).toContain('still running')
  })

  test('every refusal is announced — the banner sits in a live region', () => {
    // A refusal is learned by NOT getting what you asked for; a screen-reader
    // user gets nothing at all unless the region is there before the text is.
    const html = composer({ draft: 'ship it', notice: { kind: 'dialog' } })
    expect(html).toContain('role="status"')
    expect(html).toContain('aria-live="polite"')
  })
})

describe('the surface once input is live', () => {
  const session: TileSession = {
    name: NAME,
    display_name: 'Release Train',
    status: 'idle',
    dir: '/opt/projects/supermux/server',
    provider: 'claude',
    preview_lines: [],
    updated_at: '2026-08-14T10:00:00Z',
  }

  const surface = (composerSlot?: React.ReactNode) =>
    renderToStaticMarkup(
      <ChatConversation
        name={NAME}
        session={session}
        items={[]}
        nowMs={1_760_000_000_000}
        turnStart={null}
        composer={composerSlot}
      />,
    )

  test('the read-only honesty line is gone once the composer can send', () => {
    const live = surface(
      <ChatComposer name={NAME} label="Release Train" handle={handle()} />,
    )
    expect(text(live)).not.toContain('Read-only preview')
    expect(live).toContain('data-testid="chat-composer-field"')
    // The composer still floats in exactly the box A3 measured off the boards.
    expect(live).toContain('data-testid="chat-composer"')
    expect(live).toContain('absolute inset-x-0 bottom-0')
  })

  test('without the slot the surface is still A3’s read-only shell', () => {
    // The A3 regression net renders this component with no input plane at all —
    // and `/dev/chat-live`'s static states do too. The fallback is what keeps
    // both of them honest instead of forked.
    expect(text(surface())).toContain('Read-only preview')
  })
})

describe('a send in flight', () => {
  test('Send stays put and disables — it does not flip back to the mic mid-tap', () => {
    const html = renderToStaticMarkup(
      <ChatComposer
        name={NAME}
        label="Release Train"
        handle={handle({ draft: 'ship it', sending: true })}
      />,
    )
    expect(html).toContain('data-testid="chat-send"')
    expect(html).toContain('disabled')
    // Disabled is not a delivery claim either way — T4's watchdog owns that.
    expect(html).toContain('aria-busy="true"')
  })
})

// ── 4. P10 — the optimistic echo (fase A4 T4) ───────────────────────────────
//
// The echo is the one thing on this surface that is drawn BEFORE it is true.
// What is asserted here is therefore not "does it appear" but "does it ever
// stop admitting what it is": a send in flight claims nothing, an unconfirmed
// one says so quietly, and one the watchdog gave up on says it out loud and
// offers both ways out.

describe('the pending echo band', () => {
  const session: TileSession = {
    name: NAME,
    display_name: 'Release Train',
    status: 'idle',
    dir: '/opt/projects/supermux/server',
    provider: 'claude',
    preview_lines: [],
    updated_at: '2026-08-14T10:00:00Z',
  }

  const echo = (over: Partial<PendingSend>): PendingSend => ({
    id: 'p1',
    text: 'ship it',
    atMs: 1_760_000_000_000,
    state: 'unconfirmed',
    ...over,
  })

  const surface = (pending: readonly PendingSend[], extra: Record<string, unknown> = {}) =>
    renderToStaticMarkup(
      <ChatConversation
        name={NAME}
        session={session}
        items={[
          { type: 'user', uuid: 'u1', ts: 1_760_000_000, text: 'the confirmed one' },
        ]}
        nowMs={1_760_000_000_000}
        turnStart={null}
        pending={pending}
        {...extra}
      />,
    )

  test('a send in flight is drawn at reduced emphasis and claims nothing else', () => {
    const html = surface([echo({ state: 'sending' })])
    expect(html).toContain('data-state="sending"')
    expect(html).toContain('opacity-[0.62]')
    expect(text(html)).toContain('ship it')
    // No "sending…" line yet: the POST has not even come back, so the bubble's
    // own reduced weight is the whole claim.
    expect(text(html)).not.toContain('Sending…')
  })

  test('an unconfirmed send says so — quietly, without an alarm', () => {
    const html = surface([echo({ state: 'unconfirmed' })])
    expect(html).toContain('data-state="unconfirmed"')
    expect(text(html)).toContain('Sending…')
    expect(html).not.toContain('data-testid="chat-pending-retry"')
    expect(html).not.toContain('text-status-error')
  })

  test('an undelivered send says what happened and offers both ways out', () => {
    const html = surface([echo({ state: 'undelivered', note: 'session is not running' })], {
      onOpenTerminal: () => {},
    })
    expect(html).toContain('data-state="undelivered"')
    expect(text(html)).toContain('session is not running')
    expect(html).toContain('data-testid="chat-pending-retry"')
    expect(html).toContain('data-testid="chat-pending-open-terminal"')
    expect(html).toContain('data-testid="chat-pending-dismiss"')
    // Calm orange, never alarmist red — the TOKEN, not a literal. (Sliced to
    // the band: the surface around it carries the session's accent hex, which
    // is B0's business and not this row's.)
    const band = html.slice(
      html.indexOf('data-testid="chat-pending-band"'),
      html.indexOf('data-testid="chat-live-layer"'),
    )
    expect(band).toContain('text-status-error')
    expect(band).not.toContain('#')
  })

  test('an undelivered send with no known reason still states the fact', () => {
    expect(text(surface([echo({ state: 'undelivered' })]))).toContain(
      'didn’t reach the session',
    )
  })

  test('the band sits between the confirmed transcript and the live layer', () => {
    // Where a just-sent message belongs in time: after everything Claude has
    // said, before whatever it is saying now.
    const html = surface([echo({})])
    const confirmed = html.indexOf('the confirmed one')
    const band = html.indexOf('data-testid="chat-pending-band"')
    const live = html.indexOf('data-testid="chat-live-layer"')
    expect(confirmed).toBeGreaterThan(-1)
    expect(band).toBeGreaterThan(confirmed)
    expect(live).toBeGreaterThan(band)
  })

  test('an echo is a user bubble on the user’s side, not a new primitive', () => {
    const html = surface([echo({})])
    expect(html).toContain('data-me="true"')
    expect(html).toContain('data-variant="user"')
  })

  test('the band is a live region before it has anything to announce', () => {
    const html = surface([])
    expect(html).toContain('data-testid="chat-pending-band"')
    expect(html).toContain('aria-live="polite"')
    expect(html).not.toContain('data-testid="chat-pending"')
  })

  test('with no pending prop at all the surface is unchanged from A3', () => {
    const html = surface([])
    expect(text(html)).toContain('the confirmed one')
    expect(html).not.toContain('data-state="unconfirmed"')
  })
})
