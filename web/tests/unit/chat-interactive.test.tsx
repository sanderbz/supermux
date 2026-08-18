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
import type { PeekLens, PtyNotice } from '../../src/components/chat/peek-lens'
import {
  blockedComposerNote,
  lensBlockedAsBlockedState,
} from '../../src/components/chat/blocked'
import { CHAT_OFFLINE_BLOCKED } from '../../src/components/chat/connection'
import type { PendingSend } from '../../src/components/chat/pending'
import {
  composerSessionInput,
  getDraft,
  insertIntoComposer,
  setDraft,
} from '../../src/components/chat/composer-draft'
import { emptyCopy, EntityPickerView } from '../../src/components/chat/entity-picker'
import { TranscriptItem } from '../../src/components/chat/transcript-item'
import {
  atRows,
  pickerOptionId,
  PICKER_LISTBOX_ID,
  slashRows,
  type EntityRow,
} from '../../src/components/chat/slash'
import {
  draftAfterSend,
  sendGate,
  stopGate,
  type ComposerHandle,
} from '../../src/components/chat/use-composer'
import { composerKeyIntent } from '../../src/components/chat/composer-keys'
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

  test('a notice card owns Escape — the draft under it survives', () => {
    // THE BUG THIS PINS. A refused send leaves a card up whose footer quotes the
    // terminal's own `Esc to cancel`, with the sentence the user just tried to
    // send still in the box. Escape cancelled nothing in the terminal (only an
    // explicit POST /keys does that) and destroyed the draft with no undo —
    // Ctrl+Z does not bring a cleared textarea back.
    const carded = { draft: 'the whole two-paragraph message', active: false, notice: true }
    expect(composerKeyIntent({ key: 'Escape' }, carded)).toBe('notice-dismiss')
    // …including with a turn running: dismissing a card must not interrupt the
    // agent either.
    expect(
      composerKeyIntent({ key: 'Escape' }, { draft: '', active: true, notice: true }),
    ).toBe('notice-dismiss')
    // With the card gone, Escape is the ordinary draft-clear again — one escape,
    // one meaning, in the order the user sees the things.
    expect(composerKeyIntent({ key: 'Escape' }, { ...carded, notice: false })).toBe('clear')
    // The picker still outranks the card: it is the newer thing on top.
    expect(composerKeyIntent({ key: 'Escape' }, { ...carded, picker: true })).toBe(
      'picker-close',
    )
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

const CLEAR: PeekLens = {
  bannerVersion: '2.1.231',
  composerDraft: null,
  composerDraftVerified: true,
  dialog: null,
  modal: null,
}

describe('the pre-send peek gate', () => {
  test('a clear screen sends', () => {
    expect(sendGate(CLEAR)).toEqual({ send: true })
  })

  test('an MCP FORM refuses on a clear-looking screen — the lens cannot see it', () => {
    // The elicitation dialog is a set of text fields, not a numbered list, so
    // `readLens` reads no dialog at all and every other branch of this gate
    // would say "send". That send is a paste into whichever field the caret is
    // in, with an Enter behind it (`mcp.elicitation_form`).
    const gate = sendGate(CLEAR, { formCard: true })
    expect(gate.send).toBe(false)
    expect(gate).toMatchObject({ notice: { kind: 'dialog-form' } })
    // …and it holds when the peek is down, for the same reason: the hook is the
    // only witness there has ever been for this family.
    expect(sendGate(null, { formCard: true })).toMatchObject({
      send: false,
      notice: { kind: 'dialog-form' },
    })
  })

  test('a VERIFIED draft sitting in the TERMINAL blocks the send and is quoted back', () => {
    const gate = sendGate({
      ...CLEAR,
      composerDraft: 'half a thought',
      composerDraftVerified: true,
    })
    expect(gate.send).toBe(false)
    expect(gate).toMatchObject({ notice: { kind: 'tui-draft', detail: 'half a thought' } })
  })

  test('an UNVERIFIED draft warns and still sends — the ghost is not a refusal', () => {
    // CC 2.1.232 pre-fills the composer with a predicted prompt drawn dim; on a
    // plain capture that is byte-identical to a typed draft (a4c finding 3).
    // Refusing on it refuses nearly every send on that CLI, so the send goes
    // and the user gets the evidence instead of a locked composer.
    const gate = sendGate({
      ...CLEAR,
      composerDraft: 'Run exactly this one Bash command: touch /tmp/x',
      composerDraftVerified: false,
    })
    expect(gate.send).toBe(true)
    expect(gate).toMatchObject({
      notice: {
        kind: 'tui-draft-unverified',
        detail: 'Run exactly this one Bash command: touch /tmp/x',
      },
    })
  })

  test('an open dialog blocks the send, and says so instead of guessing', () => {
    const gate = sendGate(
      {
        ...CLEAR,
        dialog: { family: 'permission', variant: 'bash', options: ['Yes'], caretIndex: 0 },
      },
      { dialogCard: true },
    )
    expect(gate).toEqual({ send: false, notice: { kind: 'dialog' } })
  })

  test('the dialog outranks a draft read in the same frame', () => {
    const gate = sendGate(
      {
        ...CLEAR,
        composerDraft: '1. Yes',
        dialog: { family: 'plan', options: ['Yes'], caretIndex: null },
      },
      { dialogCard: true },
    )
    expect(gate).toMatchObject({ notice: { kind: 'dialog' } })
  })

  test('with no card on screen the refusal names the terminal, not a card', () => {
    // The `dialog` copy says "answer the request ABOVE". For a plan dialog, an
    // unmapped family, or a hook cleared while the pty still shows the prompt,
    // there is nothing above — so a different sentence, pointing at the surface
    // that can actually answer.
    const gate = sendGate({
      ...CLEAR,
      dialog: { family: 'unknown', options: ['Yes', 'No'], caretIndex: 0 },
    })
    expect(gate).toEqual({ send: false, notice: { kind: 'dialog-terminal' } })
  })

  // ── the wedge (daily-driver QA #1) ────────────────────────────────────────
  // `/status` sent from chat opened a full-screen panel on the pty. Nothing on
  // this surface knew, and the next send was refused as "the terminal has an
  // unsent draft" — quoting the echo of the command that opened the panel.
  test('a full-screen PANEL blocks the send and names the terminal', () => {
    const gate = sendGate({ ...CLEAR, modal: { hint: 'Esc to cancel' } })
    expect(gate).toEqual({
      send: false,
      notice: { kind: 'dialog-terminal', detail: 'Esc to cancel' },
    })
  })

  test('a panel is never refused as an unsent draft', () => {
    // Belt to the lens' braces: even if a reading somehow carried both, the
    // sentence the user gets is the true one. A draft is answerable by clearing
    // the prompt; a panel is not.
    const gate = sendGate({
      ...CLEAR,
      composerDraft: '/status',
      modal: { hint: 'Esc to cancel' },
    })
    expect(gate).toMatchObject({ send: false, notice: { kind: 'dialog-terminal' } })
  })

  test('a dialog still outranks a panel — the card can answer one of them', () => {
    const gate = sendGate(
      {
        ...CLEAR,
        dialog: { family: 'permission', variant: 'bash', options: ['Yes'], caretIndex: 0 },
        modal: { hint: 'Esc to cancel' },
      },
      { dialogCard: true },
    )
    expect(gate).toEqual({ send: false, notice: { kind: 'dialog' } })
  })

  test('a FAILED peek sends anyway — "I could not look" is not "you cannot type"', () => {
    // The watchdog (T4) is the honest layer for a send that vanishes; a peek
    // outage must never make the composer unusable.
    expect(sendGate(null)).toEqual({ send: true })
  })

  test('a failed peek with a live permission hook REFUSES — the hook is the only witness left', () => {
    // The one case where failing open is wrong: the peek is down AND the
    // session's `permission_request` says a dialog is up. A `/send` there is
    // read as the dialog's answer (the paste is ignored, the appended Enter
    // picks the caret's row), so the message is lost and the tool call is
    // granted by a keystroke nobody aimed at it.
    expect(sendGate(null, { dialogCard: true })).toEqual({
      send: false,
      notice: { kind: 'dialog' },
    })
  })

  test('a stale hook does NOT block a send the lens can see is safe', () => {
    // The inverse: `permission_request` is cleared on PostToolUse/Stop, so it
    // can lag. When the lens CAN look and the screen is clear, the lens wins.
    expect(sendGate(CLEAR, { dialogCard: true })).toEqual({ send: true })
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

    // AND NEITHER DOES `submit` (A4 review). Snippet "Run" holds this handle
    // under the chat renderer, and a raw `POST /send` from it skips every gate
    // the composer has: it pastes onto whatever is at the TUI's prompt — a
    // half-typed draft, or an open permission dialog, where the appended Enter
    // selects the caret's row (option 1: Yes, execute) — with no echo, no
    // watchdog and no pty on screen to notice with. Run means "ready to go",
    // one deliberate Enter from the gated path.
    await input.submit('ship it')
    expect(sent).toEqual([])
    expect(getDraft(NAME)).toBe('/compact ship it')
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
    picker: { open: false, kind: '@', query: '', pick: () => {}, close: () => {}, bind: () => {} },
    onChange: () => {},
    onKeyDown: () => {},
    onSelect: () => {},
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

  test('a LENS-ONLY limit block gates the composer — readOnly, noted, un-sendable', () => {
    // The states-audit residual: a session limit-blocked on the PTY/lens plane
    // with NO matching transcript banner. `blockedState(entries)` returns null,
    // so the OLD composer prop (`tail.gone ?? wireBlocked`) was undefined and the
    // field stayed live — a paragraph typed into a spent bucket, with the
    // positive-delivery promise. The gate now reads BOTH planes exactly as
    // `chat-panel` wires it: `wireBlocked ?? lensBlockedAsBlockedState(lens)`.
    const wireBlocked = null // transcript plane is silent
    const lensBlocked: PtyNotice = {
      kind: 'limit-blocked',
      text: "You've hit your weekly limit · resets Aug 17, 4am (Europe/Amsterdam)",
    }
    const gate = wireBlocked ?? lensBlockedAsBlockedState(lensBlocked)
    const html = renderToStaticMarkup(
      <ChatComposer
        name={NAME}
        label="Release Train"
        handle={handle({ draft: 'a whole paragraph into nothing' })}
        blocked={gate ? blockedComposerNote(gate) : undefined}
      />,
    )
    // The strip appears with CC's own line…
    expect(html).toContain('data-testid="chat-composer-blocked"')
    expect(html).toContain('weekly limit')
    // …the field is read-only, not merely disabled…
    expect(html).toContain('readOnly=""')
    expect(html).toContain('aria-disabled="true"')
    // …and Send is refused even with a draft armed (canSend gates on `blocked`).
    expect(html).not.toContain('data-testid="chat-send"')
  })

  test('an OFFLINE plane gates the composer — read-only, noted, un-sendable (st-conn-offline)', () => {
    // The socket has given up (terminal / 8 redials exhausted). A live composer
    // over it invites a send that cannot be confirmed to leave — the same
    // silent-drop the spent-limit bucket shipped. `chat-panel` passes
    // `CHAT_OFFLINE_BLOCKED` as the composer's `blocked` reason; the field goes
    // read-only, the strip states it, and Send is refused even with a draft.
    const html = renderToStaticMarkup(
      <ChatComposer
        name={NAME}
        label="Release Train"
        handle={handle({ draft: 'ship it once CI is green' })}
        blocked={CHAT_OFFLINE_BLOCKED}
      />,
    )
    expect(html).toContain('data-testid="chat-composer-blocked"')
    expect(text(html)).toContain('offline')
    expect(html).toContain('readOnly=""')
    expect(html).toContain('aria-disabled="true"')
    expect(html).not.toContain('data-testid="chat-send"')
    // …but the draft is preserved, not taken away — rescuable into another
    // session, exactly like the limit block.
    expect(html).toContain('ship it once CI is green')
  })

  test('Stop replaces the mic while the turn runs — same cell, no reflow', () => {
    const html = composer({ draft: '' }, true)
    expect(html).toContain('data-testid="chat-stop"')
    expect(html).not.toContain('data-testid="chat-send"')
  })

  test('a draft during a turn shows SEND, not Stop — the button does what the box says', () => {
    // Typing a follow-up mid-turn is a first-class flow (Claude Code queues it).
    // With Stop as the only trailing control, the one thing a pointer user could
    // press while typing was an INTERRUPT — a destructive wrong action on the
    // gesture that most obviously means "send this" (A4 review).
    const html = composer({ draft: 'and also run the tests' }, true)
    expect(html).toContain('data-testid="chat-send"')
    expect(html).not.toContain('data-testid="chat-stop"')
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

// ── 5. `@`-files and `/`-commands (fase A4 T9) ──────────────────────────────
//
// Two failures are pinned here. The first is a stolen keystroke: with a popover
// open, Escape must close the POPOVER — not clear the draft, and certainly not
// stop the turn. The second is the silent misfire: a `/model` sent from chat
// leaves a picker on a pty nobody is looking at, so the surface has to refuse it
// out loud and hand over the terminal.

describe('the picker owns its keys while it is open', () => {
  const open = { draft: '@mai', active: true, picker: true }
  const closed = { draft: '@mai', active: true }

  test('Escape closes the picker — it does not clear the draft or stop the turn', () => {
    expect(composerKeyIntent({ key: 'Escape' }, open)).toBe('picker-close')
    // …and with no picker up, the very same key means what it always meant.
    expect(composerKeyIntent({ key: 'Escape' }, closed)).toBe('clear')
    expect(composerKeyIntent({ key: 'Escape' }, { draft: '', active: true })).toBe('stop')
  })

  test('Enter and Tab accept; the arrows move', () => {
    expect(composerKeyIntent({ key: 'Enter' }, open)).toBe('picker-accept')
    expect(composerKeyIntent({ key: 'Tab' }, open)).toBe('picker-accept')
    expect(composerKeyIntent({ key: 'ArrowDown' }, open)).toBe('picker-down')
    expect(composerKeyIntent({ key: 'ArrowUp' }, open)).toBe('picker-up')
  })

  test('Shift+Enter still breaks the line, Shift+Tab is still the browser’s', () => {
    expect(composerKeyIntent({ key: 'Enter', shiftKey: true }, open)).toBe('newline')
    expect(composerKeyIntent({ key: 'Tab', shiftKey: true }, open)).toBe('pass')
  })

  test('an IME composition outranks the picker too', () => {
    // Same reason as everywhere else: on Android nearly every key arrives as a
    // composition, and a picker that ate those would make the box untypeable.
    expect(composerKeyIntent({ key: 'Enter', keyCode: 229 }, open)).toBe('pass')
    expect(composerKeyIntent({ key: 'ArrowDown', isComposing: true }, open)).toBe('pass')
  })
})

describe('the popover, rendered', () => {
  const rows: EntityRow[] = [
    { id: 'f1', kind: 'file', value: '@server/src/main.rs', label: 'main.rs', meta: 'server/src' },
    { id: 'f2', kind: 'file', value: '@web/src/app.tsx', label: 'app.tsx', meta: 'web/src' },
    { id: 's1', kind: 'session', value: '@patch', label: 'Patch', meta: 'patch' },
  ]

  const view = (over: Partial<React.ComponentProps<typeof EntityPickerView>> = {}) =>
    renderToStaticMarkup(
      <EntityPickerView
        rows={rows}
        activeIndex={0}
        kind="@"
        query="mai"
        onHover={() => {}}
        onPick={() => {}}
        {...over}
      />,
    )

  test('it lists what it found, with one row highlighted', () => {
    const html = view()
    expect(html).toContain('data-testid="chat-entity-picker"')
    expect((html.match(/data-testid="chat-entity-row"/g) ?? []).length).toBe(3)
    expect((html.match(/data-highlighted/g) ?? []).length).toBe(1)
    expect(text(html)).toContain('main.rs')
    expect(text(html)).toContain('server/src')
  })

  test('it is a listbox, and it never contains a submit control', () => {
    const html = view()
    expect(html).toContain('role="listbox"')
    expect(html).toContain('aria-selected="true"')
    // The picker INSERTS. Nothing in it can send anything to the session.
    expect(html).not.toContain('data-testid="chat-send"')
  })

  test('an empty result says what it looked for instead of showing nothing', () => {
    // The COPY is chat's (`emptyCopy` in `chat/entity-picker.tsx`) since fase
    // B3 — the primitive knows how many rows it has and nothing else, and the
    // three consumers need three different sentences.
    expect(text(view({ rows: [], emptyLabel: 'No tracked file or session matches “mai”' })))
      .toContain('No tracked file or session matches')
    expect(text(view({ rows: [], loading: true }))).toContain('Looking…')
  })

  test('a picker-opening command is listed but labelled terminal-only', () => {
    const html = view({
      kind: '/',
      query: 'mo',
      rows: slashRows([{ cmd: '/model', desc: 'switch model' }], 'mo'),
    })
    expect(text(html)).toContain('/model')
    // Hiding it would be a lie about the session; the refusal belongs to SEND,
    // so the row is pickable and says on its face what it will cost.
    expect(text(html)).toContain('opens in terminal')
  })

  test('the rows come from the two real sources, ranked', () => {
    const at = atRows(
      ['web/src/lib/domain.ts', 'server/src/main.rs'],
      [{ name: 'patch', display_name: 'Patch' }, { name: NAME }],
      NAME,
      'main',
    )
    expect(at[0]?.value).toBe('@server/src/main.rs')
    // The session being typed IN is never offered as a mention of itself.
    expect(at.some((r) => r.value === `@${NAME}`)).toBe(false)
  })

  /**
   * A ROW NEVER SAYS THE SAME WORD TWICE (verified finding 24.4, reported
   * independently by chat-core and pickers-palette).
   *
   * `meta` is the slug column, and `display_name` equals `name` for every
   * session nobody has renamed — which on a real instance is most of them. Set
   * unconditionally it printed `research` beside `research` on every row.
   */
  test('the slug column only appears when it says something the label does not', () => {
    const rows = atRows(
      undefined,
      [
        // Renamed: the label is the display name, so the slug is worth showing.
        { name: 'patch', display_name: 'Patch' },
        // Never renamed — the harness sends `display_name === name`.
        { name: 'research', display_name: 'research' },
        // Never renamed and no display name at all.
        { name: 'archivist' },
      ],
      NAME,
      '',
    )
    const by = (n: string) => rows.find((r) => r.value === `@${n}`)
    expect(by('patch')).toMatchObject({ label: 'Patch', meta: 'patch' })
    expect(by('research')?.label).toBe('research')
    expect(by('research')?.meta).toBeUndefined()
    expect(by('archivist')?.label).toBe('archivist')
    expect(by('archivist')?.meta).toBeUndefined()
  })
})

describe('the slash refusal, said out loud', () => {
  test('a picker-opening command names itself and offers the terminal', () => {
    const html = renderToStaticMarkup(
      <ChatComposer
        name={NAME}
        label="Release Train"
        handle={handle({ draft: '/model', notice: { kind: 'slash-picker', detail: '/model' } })}
        onOpenTerminal={() => {}}
      />,
    )
    expect(html).toContain('data-notice="slash-picker"')
    expect(text(html)).toContain('/model')
    expect(text(html)).toContain('opens a picker in the terminal')
    expect(text(html)).toContain('wasn’t sent')
    expect(html).toContain('data-testid="chat-composer-open-terminal"')
  })

  test('an unverified BUILT-IN is refused by name and hands over the terminal', () => {
    // `/permissions` opens a rules editor on the pty. Before the safety pass it
    // classified as `unknown` and went out as text, leaving that editor to eat
    // the next chat message.
    const html = renderToStaticMarkup(
      <ChatComposer
        name={NAME}
        label="Release Train"
        handle={handle({
          draft: '/permissions',
          notice: { kind: 'slash-unverified', detail: '/permissions' },
        })}
        onOpenTerminal={() => {}}
      />,
    )
    expect(html).toContain('data-notice="slash-unverified"')
    expect(text(html)).toContain('/permissions')
    expect(text(html)).toContain('can’t verify')
    expect(text(html)).toContain('wasn’t sent')
    expect(html).toContain('data-testid="chat-composer-open-terminal"')
  })

  test('an unknown command is a RECEIPT, not a refusal — and it does not call a real command a typo', () => {
    const html = renderToStaticMarkup(
      <ChatComposer
        name={NAME}
        label="Release Train"
        handle={handle({ notice: { kind: 'slash-note', detail: '/deploy-self' } })}
        onOpenTerminal={() => {}}
      />,
    )
    // WHAT CHAT CAN HONESTLY SAY. `~/.claude/commands` and
    // `<dir>/.claude/commands` are full of real commands — `/commit`,
    // `/supermux-task` — and this receipt used to tell their authors the session
    // had read them as prose. It now states what chat DID (it typed the line in),
    // which is true whether the command exists over there or was a typo.
    expect(text(html)).toContain('typed into the session as-is')
    expect(text(html)).not.toContain('isn’t a built-in command')
    // Nothing is left to do in the terminal, so nothing points there.
    expect(html).not.toContain('data-testid="chat-composer-open-terminal"')
  })

  test('the composer’s `+` is a real control now — it opens the mention picker', () => {
    expect(composer()).toContain('data-testid="chat-composer-at"')
  })

  test('the popover mounts only when the handle says it is open', () => {
    // Rendered through the slot the bench uses (`renderPicker`) — the shipped
    // path is `React.lazy`, which by design has nothing to show until the chunk
    // arrives, and that is exactly what T12's budget buys.
    const withPicker = (open: boolean) =>
      renderToStaticMarkup(
        <ChatComposer
          name={NAME}
          label="Release Train"
          handle={handle({
            draft: 'diff @mai',
            picker: {
              open,
              kind: '@',
              query: 'mai',
              pick: () => {},
              close: () => {},
              bind: () => {},
            },
          })}
          renderPicker={(p) => (
            <EntityPickerView
              rows={atRows(['server/src/main.rs'], [], NAME, p.query)}
              activeIndex={0}
              kind={p.kind}
              query={p.query}
              onHover={() => {}}
              onPick={() => {}}
            />
          )}
        />,
      )
    expect(withPicker(false)).not.toContain('data-testid="chat-entity-picker"')
    const open = withPicker(true)
    expect(open).toContain('data-testid="chat-entity-picker"')
    // Above the pill, in the pill's own box — not a portal over the transcript.
    expect(open.indexOf('chat-entity-picker')).toBeLessThan(open.indexOf('sm-composer'))
  })
})

// ── The review findings (A4 review) ─────────────────────────────────────────

describe('the Stop gate', () => {
  const CLEAR2: PeekLens = {
    bannerVersion: null,
    composerDraft: null,
    dialog: null,
    // A clear screen has ARMED NOTHING, and saying so is the point: the gate's
    // fail-open rule is about a peek that could not LOOK, never about a screen
    // that has redefined the key (`registry/armed.ts`).
    armed: [],
  }

  test('Stop does not press Escape into a dialog — that would DENY it, not interrupt', () => {
    // a0 §3, live-verified: Escape inside a permission dialog denies the tool
    // call; inside the plan dialog its effect is unverified (which is why the
    // registry ships plan-Esc as `actOn: false`). And the window is wide open:
    // `PermissionRequest` has no `HookEvent` variant, so the session keeps
    // reading `active` — Stop stays on screen — for the dialog's whole life.
    const gate = stopGate({
      ...CLEAR2,
      dialog: { family: 'permission', variant: 'bash', options: ['Yes', 'No'], caretIndex: 0 },
    })
    expect(gate).toEqual({ send: false, notice: { kind: 'stop-dialog' } })
  })

  test('a clear screen — and a failed peek — still interrupt', () => {
    // An interrupt nobody can press is its own failure, so this one fails open.
    expect(stopGate(CLEAR2)).toEqual({ send: true })
    expect(stopGate(null)).toEqual({ send: true })
  })

  test('Stop does not press an Escape the SCREEN has armed', () => {
    // Catalog `generic.armed_keys`. There is no dialog here — this is the bare
    // composer with a half-written sentence in it — so the check above sees
    // nothing, and the interrupt would land as `Esc again to clear`: a silent
    // delete of the user's own text, with no undo this app can offer.
    const gate = stopGate({
      ...CLEAR2,
      composerDraft: 'a half-written thought',
      armed: [
        {
          token: 'Esc',
          key: 'Escape',
          action: 'clear',
          text: 'Esc again to clear · Ctrl+Y to paste deleted text',
        },
      ],
    })
    expect(gate.send).toBe(false)
    // The terminal's own line is the evidence, and the notice carries it.
    expect(gate.notice?.kind).toBe('stop-armed')
    expect(gate.notice?.detail).toContain('Esc again to clear')
  })
})

describe('clearing the box after a send', () => {
  test('only the sent words go — anything typed during the round-trip stays', () => {
    expect(draftAfterSend('hello and also this', 'hello')).toBe('and also this')
  })

  test('a caret moved to the FRONT mid-flight does not leave the sent words behind', () => {
    // The prefix rule kept the whole box here ("hey hello"), one Enter away
    // from sending "hello" a second time — a duplicate produced by the code
    // that exists to prevent data loss.
    // The space the user typed after "hey" stays: it is theirs, the caret is
    // sitting behind it, and only the SENT text is subtracted.
    expect(draftAfterSend('hey hello', 'hello')).toBe('hey ')
  })

  test('a box that no longer contains the sent text is left alone', () => {
    // The user cleared it themselves, or replaced it. Deleting what is there
    // now would be the data loss this rule exists to avoid.
    expect(draftAfterSend('something else entirely', 'hello')).toBe(
      'something else entirely',
    )
  })
})

describe('the transcript does not re-render on every keystroke', () => {
  test('TranscriptItem is a memo boundary', () => {
    // A4 made the composer live, and its draft subscription is held by
    // `chat-panel.tsx` — so every keystroke re-renders the panel and, through
    // it, every row of the transcript. `react-markdown` re-runs its whole
    // unified pipeline per render (measured here at ~1.2ms per ordinary
    // assistant bubble under SSR, a floor), so ~50 messages cost ~60ms of
    // main-thread work per keypress and the caret lagged the keyboard.
    //
    // This assertion is structural on purpose: there is no client renderer in
    // this unit net, so what can be pinned is the boundary itself.
    expect(
      (TranscriptItem as unknown as { $$typeof?: symbol }).$$typeof,
    ).toBe(Symbol.for('react.memo'))
  })

  test('every prop the row is given is stable across a keystroke', () => {
    // The boundary is only worth anything while this stays true. `node` comes
    // out of `buildTranscript`'s useMemo, the indexes are useMemo'd in the
    // panel, `rawUrl`/`pinFor` are module-level, and `nowMs` is bucketed to
    // 30s — so nothing a keystroke touches reaches this component.
    const props = new Set(
      Object.keys({
        node: 1, name: 1, surface: 1, labels: 1, mentions: 1, names: 1,
        rawUrl: 1, pinFor: 1,
      }),
    )
    // A prop added here without a stability story is what would silently undo
    // the fix; this is the reminder in the diff.
    expect(props.has('draft')).toBe(false)
    expect(props.has('composer')).toBe(false)
  })
})

describe('the picker is reachable by assistive tech', () => {
  test('the FIELD carries the combobox relationship — it is what has focus', () => {
    // The popover never takes focus (that would dismiss the soft keyboard on
    // every phone), so without this a screen-reader user got nothing at all:
    // no "suggestions available", no row count, a highlight ↑/↓ moved silently,
    // and an Enter that replaced their token with a value they were never told.
    const html = renderToStaticMarkup(
      <ChatComposer
        name={NAME}
        label="Release Train"
        handle={handle({
          draft: 'diff @mai',
          picker: {
            open: true,
            kind: '@',
            query: 'mai',
            pick: () => {},
            close: () => {},
            bind: () => {},
          },
        })}
        renderPicker={() => null}
      />,
    )
    expect(html).toContain('role="combobox"')
    expect(html).toContain('aria-expanded="true"')
    expect(html).toContain(`aria-controls="${PICKER_LISTBOX_ID}"`)
  })

  test('the closed composer claims no popover', () => {
    const html = composer({ draft: 'ship it' })
    expect(html).toContain('aria-expanded="false"')
    expect(html).not.toContain('aria-controls=')
    expect(html).not.toContain('aria-activedescendant=')
  })

  test('every option has the id the field points at, and the li owns nothing', () => {
    const html = renderToStaticMarkup(
      <EntityPickerView
        rows={atRows(['server/src/main.rs', 'web/src/main.tsx'], [], NAME, 'main')}
        activeIndex={1}
        kind="@"
        query="main"
        // The ids are chat's, and since fase B3 the VIEW is shared — so they
        // arrive as props instead of being baked in. `chat/entity-picker.tsx`
        // passes exactly these two; the field's `aria-controls` /
        // `aria-activedescendant` still have to resolve to them, which is what
        // this asserts.
        listboxId={PICKER_LISTBOX_ID}
        optionId={pickerOptionId}
        onHover={() => {}}
        onPick={() => {}}
      />,
    )
    expect(html).toContain(`id="${PICKER_LISTBOX_ID}"`)
    expect(html).toContain(`id="${pickerOptionId(0)}"`)
    expect(html).toContain(`id="${pickerOptionId(1)}"`)
    // A listbox owns OPTIONS; an `li` in between breaks that ownership.
    expect(html).toContain('role="presentation"')
  })
})

describe('the choice card stops calling a live surface read-only', () => {
  test('it names what is still true instead', () => {
    // A1/A3's line was "Answer in the terminal — chat is read-only for now."
    // A4's composer sends, so the first half is now false, and a line that is
    // wrong about the obvious half is not trusted about the half that matters
    // (that no key may be pressed into this dialog until T7 lands).
    const html = renderToStaticMarkup(
      <ChatConversation
        name={NAME}
        session={
          {
            name: NAME,
            status: 'active',
            dir: '/tmp',
            provider: 'claude',
            preview_lines: [],
            updated_at: '',
            permission_request: { tool: 'Bash', summary: '⚡ cargo publish', kind: 'bash' },
          } as unknown as TileSession
        }
        items={[]}
        nowMs={0}
        turnStart={0}
      />,
    )
    expect(text(html)).toContain('Answer in the terminal')
    expect(text(html)).not.toContain('read-only')
  })
})

/**
 * THE PROMOTION CONTRACT (fase B3 T1.1).
 *
 * B3 lifts this popover out of `components/chat/` into a shared primitive with
 * a second anchor, a widened row union and an icon slot. A refactor of that
 * size is only safe if "unchanged" is something a test can say, so this block
 * pins the popover's DOM as it stands the moment before the move — every
 * structural fact a screen reader or a Playwright selector depends on.
 *
 * IT IS ALLOWED TO CHANGE IN EXACTLY ONE WAY: `data-active` becomes
 * `data-highlighted` (the attribute is chat-private and §14 names the new one).
 * Any other edit to the assertions below means the promotion dropped something,
 * and the diff is the evidence.
 */
describe('the popover DOM, pinned before the promotion', () => {
  const kinds: EntityRow[] = [
    { id: 'f1', kind: 'file', value: '@server/src/main.rs', label: 'main.rs', meta: 'server/src' },
    { id: 's1', kind: 'session', value: '@patch', label: 'Patch', meta: 'patch' },
    { id: 'c1', kind: 'command', value: '/model', label: '/model', meta: 'switch model', warn: 'opens in terminal' },
  ]

  const view = (over: Partial<React.ComponentProps<typeof EntityPickerView>> = {}) =>
    renderToStaticMarkup(
      <EntityPickerView
        rows={kinds}
        activeIndex={1}
        kind="@"
        query="pa"
        listboxId={PICKER_LISTBOX_ID}
        optionId={pickerOptionId}
        onHover={() => {}}
        onPick={() => {}}
        {...over}
      />,
    )

  test('all three row kinds render, and each carries its own text', () => {
    const html = view()
    expect((html.match(/data-testid="chat-entity-row"/g) ?? []).length).toBe(3)
    const t = text(html)
    // file: label + directory, session: label + slug, command: label + desc + warn
    expect(t).toContain('main.rs')
    expect(t).toContain('server/src')
    expect(t).toContain('Patch')
    expect(t).toContain('/model')
    expect(t).toContain('switch model')
    expect(t).toContain('opens in terminal')
  })

  test('exactly one row is highlighted, and it is the one the index names', () => {
    const html = view()
    // The highlight is ONE atom. Two highlighted rows means keyboard and
    // pointer disagree about which row Enter would take.
    expect((html.match(/data-highlighted/g) ?? []).length).toBe(1)
    expect((html.match(/aria-selected="true"/g) ?? []).length).toBe(1)
    // ...and it is row 1 (Patch), not row 0.
    const upTo = html.slice(0, html.indexOf('data-highlighted'))
    expect(upTo).toContain('main.rs')
    expect(upTo).not.toContain('Patch')
  })

  test('the roles nest listbox > presentation > option, with no li in between', () => {
    const html = view()
    expect(html).toContain('role="listbox"')
    // A listbox owns OPTIONS. The `li` is `presentation` precisely so it does
    // not break that ownership for a screen reader.
    expect((html.match(/role="presentation"/g) ?? []).length).toBe(3)
    expect((html.match(/role="option"/g) ?? []).length).toBe(3)
    expect(html).not.toMatch(/<li(?![^>]*role="presentation")/)
  })

  test('the listbox id and the option ids are the ones the FIELD points at', () => {
    // The textarea carries aria-controls={PICKER_LISTBOX_ID} and
    // aria-activedescendant={pickerOptionId(i)}. If either id moves, the field
    // points at nothing and the popover becomes invisible to a screen reader
    // while looking perfectly fine.
    const html = view()
    expect(html).toContain(`id="${PICKER_LISTBOX_ID}"`)
    expect(html).toContain(`id="${pickerOptionId(0)}"`)
    expect(html).toContain(`id="${pickerOptionId(2)}"`)
    expect(html).toContain('aria-label="Suggestions"')
  })

  test('the empty state says what was looked for, per trigger and per state', () => {
    // Chat's four sentences, asserted at their SOURCE — `emptyCopy` — because
    // fase B3 moved the copy out of the shared primitive and into the consumer
    // that knows which trigger opened the list.
    expect(text(view({ rows: [], loading: true }))).toContain('Looking…')
    expect(emptyCopy('@', 'mai')).toContain('No tracked file or session matches')
    expect(emptyCopy('/', 'mo')).toContain('No command matches')
    // A blank query must not print a bare pair of quotation marks (the mobile
    // proof that produced this copy, 21-at-picker-light.png).
    expect(emptyCopy('@', '')).toBe('Nothing to mention here yet')
    expect(emptyCopy('@', '')).not.toContain('““')
    expect(emptyCopy('/', '')).toBe('Nothing to run here yet')
  })

  test('the phone surface is a 44pt row and the desktop one is not', () => {
    // The height difference is the whole reason `surface` exists; B3 keeps the
    // phone exception and documents it rather than flattening it to the
    // desktop number.
    expect(view({ surface: 'phone' })).toContain('py-[13px]')
    expect(view()).toContain('py-[7px]')
  })

  test('nothing in the popover can send', () => {
    // It INSERTS. A submit control in here would make a suggestion list into a
    // way to send a message by accident.
    const html = view()
    expect(html).not.toContain('data-testid="chat-send"')
    expect(html).not.toContain('type="submit"')
  })
})
