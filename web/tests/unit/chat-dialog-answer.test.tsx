/**
 * Answering a TUI dialog from chat (fase A4 T7).
 * ─────────────────────────────────────────────────────────────────────────────
 * This is the file that stands between a tap on a card and a keystroke in
 * somebody's session, so it is written the way the sequence is: every test
 * asserts EXACTLY what went on the wire, and most of them assert that nothing
 * did. The lens readings come from the a0 captures (`tests/fixtures/tui/`), the
 * same bytes the registry's own claims were made against; where a test needs a
 * caret somewhere else it moves the caret on a real reading rather than
 * inventing a dialog that never existed.
 *
 * The four refusals, each with its own test:
 *   · the screen could not be read              → nothing sent
 *   · the dialog changed / went away            → nothing sent
 *   · the caret did not move by exactly one row → the navigation keys sent so
 *                                                 far, and NO Enter
 *   · the same dialog survived the commit       → said out loud, committed:true
 *
 * No DOM for the sequence (it is pure), `renderToStaticMarkup` for the card.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { describe, expect, test } from 'bun:test'
import * as React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'

import { ChatConversation } from '../../src/components/chat/conversation'
import {
  answerDialog,
  answerNotice,
  applyLatch,
  chooseable,
  dialogCardView,
  hardDisable,
  resolutionLine,
  sightingKey,
  visibleResolution,
  DIALOG_TERMINAL_NOTE,
  RESOLUTION_MS,
  type AnswerDeps,
  type DialogCardView,
} from '../../src/components/chat/dialog-answer'
import { DialogCard } from '../../src/components/chat/live-layer'
import { readLens, type PeekLens } from '../../src/components/chat/peek-lens'
import type { KeyName } from '../../src/lib/session-input/types'
import type { TileSession } from '../../src/components/session-tile/types'

const DIR = join(import.meta.dir, '../fixtures/tui')
const lensOf = (name: string): PeekLens => readLens(readFileSync(join(DIR, name), 'utf8'))

const PERM = lensOf('perm-bash.txt')
const EDIT = lensOf('perm-edit.txt')
const PLAN = lensOf('plan-approval.txt')
const CLEAR = lensOf('composer-idle.txt')

/** The same reading with the caret somewhere else — what a concurrent client
 *  moving the selection looks like to this app. */
function caretAt(lens: PeekLens, index: number | null): PeekLens {
  return { ...lens, dialog: { ...lens.dialog!, caretIndex: index } }
}

interface Rig {
  deps: AnswerDeps
  sent: KeyName[]
  peeks: number
}

/**
 * A scripted session: a queue of what each `/peek` returns (the last entry
 * repeats), and a recording `sendKey`. `null` in the queue is a peek that
 * FAILED, which is a different fact from a clear screen and has to stay one.
 */
function rig(
  captures: readonly (PeekLens | null)[],
  opts: { pin?: string | null; rejectAt?: number } = {},
): Rig {
  const sent: KeyName[] = []
  const state = { i: 0 }
  const deps: AnswerDeps = {
    pin: opts.pin === undefined ? '2.1.231' : opts.pin,
    wait: async () => {},
    refresh: async () => captures[Math.min(state.i++, captures.length - 1)] ?? null,
    sendKey: async (key) => {
      if (opts.rejectAt === sent.length) throw new Error('session is not running')
      sent.push(key)
    },
  }
  return {
    deps,
    sent,
    get peeks() {
      return state.i
    },
  }
}

const req = (target: number | 'escape', lens: PeekLens = PERM, id = 'permission.bash' as const) => ({
  entryId: id,
  target,
  key: sightingKey(lens.dialog!),
})

/* ── 1. the happy paths ─────────────────────────────────────────────────── */

describe('answering, when everything checks out', () => {
  test('option 3 on a permission sends Down, Down, Enter — and nothing else', async () => {
    // The caret starts on row 0 (a0's capture), so "No" is two rows down. No
    // digit is sent, ever: `KEY_ALLOWLIST` has none.
    const r = rig([PERM, caretAt(PERM, 1), caretAt(PERM, 2), CLEAR])
    const out = await answerDialog(r.deps, req(2))
    expect(out.ok).toBe(true)
    expect(out.effect).toBe('deny')
    expect(r.sent).toEqual(['Down', 'Down', 'Enter'])
  })

  test('the caret already on the row sends only Enter', async () => {
    const r = rig([PERM, CLEAR])
    const out = await answerDialog(r.deps, req(0))
    expect(out.ok).toBe(true)
    expect(out.effect).toBe('accept')
    expect(r.sent).toEqual(['Enter'])
  })

  test('moving UP uses Up, never Down×N — no evidence the list wraps', async () => {
    const from2 = caretAt(PERM, 2)
    const r = rig([from2, caretAt(PERM, 1), caretAt(PERM, 0), CLEAR])
    await answerDialog(r.deps, { ...req(0), key: sightingKey(from2.dialog!) })
    expect(r.sent).toEqual(['Up', 'Up', 'Enter'])
  })

  test('Escape on a permission is the feedback branch — one key, effect feedback', async () => {
    const r = rig([PERM, CLEAR])
    const out = await answerDialog(r.deps, req('escape'))
    expect(out.ok).toBe(true)
    expect(out.effect).toBe('feedback')
    expect(r.sent).toEqual(['Escape'])
  })

  test('a DIFFERENT dialog after the commit is a success, not a survivor', async () => {
    // Accepting one permission routinely raises the next one inside a second.
    const r = rig([PERM, caretAt(PERM, 1), caretAt(PERM, 2), EDIT])
    const out = await answerDialog(r.deps, req(2))
    expect(out.ok).toBe(true)
    expect(r.sent).toEqual(['Down', 'Down', 'Enter'])
  })

  test('plan approval answers its three real 2.1.231 labels', async () => {
    const r = rig([PLAN, caretAt(PLAN, 1), CLEAR])
    const out = await answerDialog(r.deps, req(1, PLAN, 'plan.approval'))
    expect(out.ok).toBe(true)
    expect(out.effect).toBe('accept')
    expect(r.sent).toEqual(['Down', 'Enter'])
  })

  test('no answer, on any family, ever puts a digit on the wire', async () => {
    for (const [lens, id] of [
      [PERM, 'permission.bash'],
      [EDIT, 'permission.edit'],
      [PLAN, 'plan.approval'],
    ] as const) {
      for (const target of [0, 1, 2] as const) {
        const r = rig([lens, caretAt(lens, 1), caretAt(lens, 2), CLEAR])
        await answerDialog(r.deps, req(target, lens, id))
        expect(r.sent.some((k) => /^\d$/.test(k))).toBe(false)
      }
    }
  })
})

/* ── 2. the refusals ────────────────────────────────────────────────────── */

describe('answering, when it must refuse', () => {
  test('a peek that could not look sends nothing at all', async () => {
    const r = rig([null])
    const out = await answerDialog(r.deps, req(0))
    expect(out.ok).toBe(false)
    expect(out.failure).toBe('peek-failed')
    expect(out.committed).toBe(false)
    expect(r.sent).toEqual([])
  })

  test('a dialog that is already gone sends nothing', async () => {
    const r = rig([CLEAR])
    const out = await answerDialog(r.deps, req(0))
    expect(out.failure).toBe('no-dialog')
    expect(r.sent).toEqual([])
  })

  test('a different dialog on screen than the card was drawn for sends nothing', async () => {
    const r = rig([EDIT])
    const out = await answerDialog(r.deps, req(0))
    expect(out.failure).toBe('changed')
    expect(r.sent).toEqual([])
  })

  test('a list that GAINED a row mid-answer sends nothing — the "No becomes always-allow" hazard', async () => {
    // THE named failure of the whole registry (a0 §3, `registry/index.ts`): the
    // card was drawn for a three-row dialog and the screen now has four, so the
    // row the user read as "No" is not the row two Downs would land on. Both
    // guards must catch it independently, so this asserts it from the drawn
    // card's key AND after the first navigation key has already gone.
    const grown: PeekLens = {
      ...PERM,
      dialog: {
        ...PERM.dialog!,
        options: [PERM.dialog!.options[0], 'Yes, and always allow this session', ...PERM.dialog!.options.slice(1)],
        caretIndex: 0,
      },
    }
    // Caught before any key: the shape check fails, so the entry comes back
    // degraded and every option with it — and the refusal QUOTES the reason
    // rather than shrugging.
    const before = rig([grown])
    const out = await answerDialog(before.deps, req(2))
    expect(out.ok).toBe(false)
    expect(out.failure).toBe('not-actionable')
    expect(before.sent).toEqual([])
    expect(answerNotice(out)).toMatch(/not the ones this mapping was captured against/)

    // Caught mid-flight: one Down had already gone when the row appeared.
    const during = rig([PERM, grown])
    const mid = await answerDialog(during.deps, req(2))
    expect(mid.ok).toBe(false)
    expect(mid.committed).toBe(false)
    expect(during.sent).toEqual(['Down'])
    expect(during.sent).not.toContain('Enter')
  })

  test('a moved caret aborts the sequence and sends no Enter', async () => {
    // One Down goes out; the re-peek says the selection is on row 2, i.e. two
    // rows from where it started. Something else is typing — stop.
    const r = rig([PERM, caretAt(PERM, 2)])
    const out = await answerDialog(r.deps, req(2))
    expect(out.ok).toBe(false)
    expect(out.failure).toBe('caret-drift')
    expect(out.attention).toBe('dialog-unmapped')
    expect(out.committed).toBe(false)
    expect(r.sent).toEqual(['Down'])
    expect(out.detail).toMatch(/something else is typing/i)
  })

  test('a caret that disappears mid-sequence aborts, with no Enter', async () => {
    const r = rig([PERM, caretAt(PERM, null)])
    const out = await answerDialog(r.deps, req(2))
    expect(out.failure).toBe('no-caret')
    expect(r.sent).toEqual(['Down'])
  })

  test('no caret at all: nothing is sent, because no movement could be checked', async () => {
    const r = rig([caretAt(PERM, null)])
    const out = await answerDialog(r.deps, req(2))
    expect(out.failure).toBe('no-caret')
    expect(r.sent).toEqual([])
  })

  test('a peek that dies mid-sequence stops it where it is', async () => {
    const r = rig([PERM, null])
    const out = await answerDialog(r.deps, req(2))
    expect(out.failure).toBe('peek-failed')
    expect(r.sent).toEqual(['Down'])
  })

  test('a rejected key is reported, and nothing further is sent', async () => {
    const r = rig([PERM, caretAt(PERM, 1)], { rejectAt: 1 })
    const out = await answerDialog(r.deps, req(2))
    expect(out.failure).toBe('send-failed')
    expect(out.detail).toMatch(/not running/i)
    expect(r.sent).toEqual(['Down'])
  })

  test('the SAME dialog surviving the commit raises Attention, and admits the key went', async () => {
    const r = rig([PERM, CLEAR === PERM ? PERM : PERM, PERM, PERM, PERM])
    const out = await answerDialog(r.deps, req(0))
    expect(out.ok).toBe(false)
    expect(out.failure).toBe('still-open')
    expect(out.committed).toBe(true)
    expect(out.attention).toBe('dialog-unmapped')
    expect(r.sent).toEqual(['Enter'])
  })

  test('a peek that cannot look AFTER the commit says so, and does not claim nothing happened', async () => {
    const r = rig([PERM, null, null])
    const out = await answerDialog(r.deps, req(0))
    expect(out.failure).toBe('peek-failed')
    expect(out.committed).toBe(true)
    expect(out.detail).toMatch(/could not be read afterwards/i)
    expect(r.sent).toEqual(['Enter'])
  })

  test('bash option 2 can never be pressed, even if a caller asks', async () => {
    // a0 left its persistence unverified; 2.1.233 answered it and the answer is
    // WORSE than unknown — one row, two grants, one of them a rule written to
    // disk (`registry/claude.ts`, `tests/fixtures/tui/cc233/README.md`). The card
    // disables it; this is the second lock, on the logic, so removing an
    // attribute cannot open it.
    const r = rig([PERM])
    const out = await answerDialog(r.deps, req(1))
    expect(out.failure).toBe('not-actionable')
    expect(out.detail).toMatch(/settings\.local\.json/i)
    expect(r.sent).toEqual([])
  })

  test('plan Esc can never be pressed — a0 never captured it', async () => {
    const r = rig([PLAN])
    const out = await answerDialog(r.deps, req('escape', PLAN, 'plan.approval'))
    expect(out.failure).toBe('not-actionable')
    expect(r.sent).toEqual([])
  })

  test('a version the fingerprint was never captured against sends nothing', async () => {
    const r = rig([PERM], { pin: '2.2.0' })
    const out = await answerDialog(r.deps, req(0))
    expect(out.failure).toBe('not-actionable')
    expect(out.attention).toBe('registry-version-mismatch')
    expect(r.sent).toEqual([])
    // Naming BOTH versions — the one this session booted and the ones the
    // fingerprint was checked against. "Could not confirm" is not the reason.
    expect(answerNotice(out)).toMatch(/2\.2\.0/)
    expect(answerNotice(out)).toMatch(/2\.1\.227/)
  })

  test('a session whose banner could not be read sends nothing either', async () => {
    const r = rig([PERM], { pin: null })
    const out = await answerDialog(r.deps, req(0))
    expect(out.attention).toBe('registry-version-mismatch')
    expect(r.sent).toEqual([])
  })
})

/* ── 3. the card, as data ───────────────────────────────────────────────── */

describe('the card the surface draws', () => {
  test('a permission card is answerable, with option 2 rendered and inert', () => {
    const view = dialogCardView(PERM, '2.1.231')!
    expect(view.id).toBe('permission.bash')
    expect(view.disabled).toBe(false)
    expect(view.options.map((o) => o.actOn)).toEqual([true, false, true])
    // The board's product voice for 1 and 3; the DIALOG's own sentence for 2,
    // because what that grant covers differs per variant.
    expect(view.options[0].label).toBe('Allow once')
    expect(view.options[2].label).toBe('Not now')
    expect(view.options[1].label).toMatch(/always allow/i)
    expect(view.options.map((o) => o.kbd)).toEqual(['1', '2', '3'])
    expect(view.escape).toMatchObject({ actOn: true })
    expect(view.attention).toBeNull()
  })

  test('a plan card carries the real labels, the plan path, and a dead Esc', () => {
    const view = dialogCardView(PLAN, '2.1.231')!
    expect(view.id).toBe('plan.approval')
    expect(view.options.map((o) => o.label)).toEqual([
      'Yes, and use auto mode',
      'Yes, manually approve edits',
      'Tell Claude what to change',
    ])
    expect(view.options.every((o) => o.actOn)).toBe(true)
    expect(view.planPath).toMatch(/^~\/\.claude\/plans\/plan-.*\.md$/)
    expect(view.escape?.actOn).toBe(false)
  })

  test('an unpinned version renders every option, and presses none', () => {
    const view = dialogCardView(PERM, '2.2.0')!
    expect(view.disabled).toBe(true)
    expect(view.options.every((o) => !o.actOn)).toBe(true)
    expect(view.escape?.actOn).toBe(false)
    expect(view.note).toBe(DIALOG_TERMINAL_NOTE)
    expect(view.attention).toBe('registry-version-mismatch')
    expect(view.verifiedVersions).toEqual(['2.1.227', '2.1.231', '2.1.232', '2.1.233'])
  })

  test('no dialog, no card', () => {
    expect(dialogCardView(CLEAR, '2.1.231')).toBeNull()
  })

  test('hardDisable puts one reason on every control', () => {
    const view = hardDisable(dialogCardView(PERM, '2.1.231')!, 'the caret moved')
    expect(view.options.every((o) => !o.actOn && o.reason === 'the caret moved')).toBe(true)
    expect(view.escape?.actOn).toBe(false)
    expect(view.disabled).toBe(true)
    // …and it is the note the card actually PRINTS. A `title` attribute is not
    // a sentence a phone can read, and the generic terminal line would hide the
    // one fact that matters — that a key had already gone (safety review).
    expect(view.note).toBe('the caret moved')
    expect(hardDisable(dialogCardView(PERM, '2.1.231')!, '').note).toBe(DIALOG_TERMINAL_NOTE)
  })

  test('a refusal always leaves a sentence, and never claims a sent key was a no-op', () => {
    // The abort's own words when it has them…
    expect(
      answerNotice({ ok: false, sent: ['Down'], committed: false, detail: 'the caret drifted' }),
    ).toBe('the caret drifted')
    // …and an honest fallback when it does not. The committed half is the one
    // that may never be dressed up: a key left this client.
    expect(answerNotice({ ok: false, sent: [], committed: false })).toMatch(/nothing was sent/)
    expect(answerNotice({ ok: false, sent: ['Enter'], committed: true })).toMatch(
      /key was sent.*could not confirm/i,
    )
    expect(answerNotice({ ok: false, sent: ['Enter'], committed: true })).not.toMatch(
      /nothing was sent/,
    )
  })

  test('the refusal sentence outlives the dialog it was about', () => {
    // THE SILENT-FAILURE HOLE (safety review). The most common abort is the one
    // where the sighting vanishes — somebody answered it in the terminal while
    // the tap was in flight — and the latch dies with its sighting by design.
    // If the notice went with it, a tap that sent NOTHING would look exactly
    // like one that worked. It rides the resolution channel instead, which is
    // keyed to the sighting and outlives it.
    const live = dialogCardView(PERM, '2.1.231')!
    const notice = answerNotice({
      ok: false,
      sent: [],
      committed: false,
      failure: 'no-dialog',
      detail: 'The prompt was gone by the time this was answered — something else answered it.',
    })
    const res = { key: live.key, line: notice, atMs: 1_000 }
    // While the question is still up, the latched CARD carries it — one voice.
    expect(visibleResolution(res, live, 1_100)).toBeNull()
    // The moment it is gone, the sentence is what is left on screen.
    expect(visibleResolution(res, null, 1_100)).toBe(notice)
  })

  test('the sighting key ignores the caret and notices the rows', () => {
    expect(sightingKey(PERM.dialog!)).toBe(sightingKey(caretAt(PERM, 2).dialog!))
    expect(sightingKey(PERM.dialog!)).not.toBe(sightingKey(EDIT.dialog!))
  })

  test('what the hook will actually let a tap through to', () => {
    const live = dialogCardView(PERM, '2.1.231')!
    expect(chooseable(live, null, 0)).toBe(true)
    expect(chooseable(live, null, 'escape')).toBe(true)
    // The unverified grant, the card that is already answering, the degraded
    // card, the latched card, and no card at all.
    expect(chooseable(live, null, 1)).toBe(false)
    expect(chooseable(live, 0, 2)).toBe(false)
    expect(chooseable(dialogCardView(PERM, '2.2.0'), null, 0)).toBe(false)
    expect(chooseable(hardDisable(live, 'the caret moved'), null, 0)).toBe(false)
    expect(chooseable(null, null, 0)).toBe(false)
    // An index nobody drew.
    expect(chooseable(live, null, 7)).toBe(false)
  })

  test('an aborted sequence leaves the card readable, inert, and explained', () => {
    // The visible half of every refusal: the question stays on screen, nothing
    // on it can be pressed again, the sentence quoting what happened is on each
    // control, and the Attention cause is the ABORT's — not the registry's
    // (which, for a perfectly good pinned dialog, is nothing at all).
    const base = dialogCardView(PERM, '2.1.231')!
    const latch = {
      key: base.key,
      detail: 'After Down, the terminal’s selection sits on option 3 instead of 2.',
      attention: 'dialog-unmapped' as const,
    }
    const out = applyLatch(base, latch)
    expect(out.card!.disabled).toBe(true)
    expect(out.card!.options.every((o) => !o.actOn && o.reason === latch.detail)).toBe(true)
    expect(out.card!.options.map((o) => o.label)).toEqual(base.options.map((o) => o.label))
    expect(out.attention).toBe('dialog-unmapped')
    expect(chooseable(out.card, null, 0)).toBe(false)
  })

  test('the latch belongs to its own sighting, and to no other question', () => {
    const perm = dialogCardView(PERM, '2.1.231')!
    const latch = { key: 'some-other-dialog', detail: 'x', attention: 'dialog-unmapped' as const }
    const out = applyLatch(perm, latch)
    expect(out.card!.disabled).toBe(false)
    expect(out.attention).toBeNull()
    expect(applyLatch(null, latch)).toEqual({ card: null, attention: null })
  })

  test('the outcome line waits for the dialog to go, then expires', () => {
    const live = dialogCardView(PERM, '2.1.231')!
    const res = { key: live.key, line: 'Allowed · bash', atMs: 1_000 }
    // Still on screen (the dismissal check has not run yet): say nothing.
    expect(visibleResolution(res, live, 1_100)).toBeNull()
    expect(visibleResolution(res, null, 1_100)).toBe('Allowed · bash')
    // A NEW question outranks the old answer immediately.
    expect(visibleResolution(res, dialogCardView(PLAN, '2.1.231'), 1_100)).toBe('Allowed · bash')
    expect(visibleResolution(res, null, 1_000 + RESOLUTION_MS)).toBeNull()
    expect(visibleResolution(null, null, 5)).toBeNull()
  })

  test('the outcome line names the decision, not the keystroke', () => {
    expect(resolutionLine('accept', { family: 'permission', variant: 'bash' })).toBe('Allowed · bash')
    expect(resolutionLine('deny', { family: 'permission', variant: 'edit' })).toBe('Denied · edit')
    expect(resolutionLine('accept-session', { family: 'plan' })).toMatch(/this session · plan/)
    expect(resolutionLine('feedback', { family: 'plan' })).toMatch(/instead/i)
  })
})

/* ── 4. the pixels ──────────────────────────────────────────────────────── */

const session: TileSession = {
  name: 'release-train',
  display_name: 'Release Train',
  status: 'active',
  dir: '/opt/projects/supermux/server',
} as TileSession

describe('the card, rendered', () => {
  test('an inert option is really disabled, and says why', () => {
    const html = renderToStaticMarkup(
      <DialogCard view={dialogCardView(PERM, '2.1.231')!} onChoose={() => {}} />,
    )
    expect(html).toContain('data-state="idle"')
    expect(html).toContain('Allow once')
    // The inert one carries `disabled` and its reason, and it is still readable.
    expect(html).toContain('Yes, and always allow access to tmp/ from this project')
    expect(html).toContain('data-disabled="true"')
    expect(html).toMatch(/settings\.local\.json/i)
  })

  test('mid-sequence the whole card is inert and names what it is doing', () => {
    const html = renderToStaticMarkup(
      <DialogCard view={dialogCardView(PERM, '2.1.231')!} busy={2} onChoose={() => {}} />,
    )
    expect(html).toContain('data-state="answering"')
    expect(html).toContain('Checking the terminal between each key')
    // Every control, including the ones that WOULD be live.
    expect(html.match(/disabled=""/g)?.length).toBe(4)
  })

  test('a degraded card shows the dialog-terminal copy and no live control', () => {
    const html = renderToStaticMarkup(
      <DialogCard view={dialogCardView(PERM, '2.2.0')!} onChoose={() => {}} />,
    )
    expect(html).toContain('data-state="degraded"')
    expect(html).toContain(DIALOG_TERMINAL_NOTE)
    expect(html.match(/disabled=""/g)?.length).toBe(4)
  })

  test('an aborted card prints the abort, not a tooltip', () => {
    const base = dialogCardView(PERM, '2.1.231')!
    const detail =
      'After Down, the terminal’s selection sits on option 3 instead of 2 — something else is typing into this session, so nothing further was sent.'
    const { card } = applyLatch(base, { key: base.key, detail, attention: 'dialog-unmapped' })
    const html = renderToStaticMarkup(<DialogCard view={card!} onChoose={() => {}} />)
    expect(html).toContain('data-state="degraded"')
    // In the TEXT, not only in a `title` a finger cannot hover.
    expect(html.replace(/<[^>]*>/g, ' ')).toContain('something else is typing into this session')
    expect(html.match(/disabled=""/g)?.length).toBe(4)
  })

  test('a plan card asks about the plan and shows its file', () => {
    const html = renderToStaticMarkup(<DialogCard view={dialogCardView(PLAN, '2.1.231')!} />)
    expect(html).toContain('data-family="plan"')
    expect(html).toContain('Ready to go ahead')
    expect(html).toMatch(/plans\/plan-/)
  })

  test('the surface draws the answerable card INSTEAD of A3’s honesty line', () => {
    const html = renderToStaticMarkup(
      <ChatConversation
        name="release-train"
        session={session}
        items={[]}
        nowMs={0}
        turnStart={null}
        dialog={dialogCardView(PERM, '2.1.231')}
        onChooseDialog={() => {}}
      />,
    )
    expect(html).toContain('data-testid="chat-dialog-card"')
    expect(html).not.toContain('chat can’t answer this one yet')
  })

  test('a hook without a sighting still draws the A3 card, unanswerable', () => {
    const html = renderToStaticMarkup(
      <ChatConversation
        name="release-train"
        session={{ ...session, permission_request: { tool: 'Bash', summary: 'cargo test', kind: 'bash' } }}
        items={[]}
        nowMs={0}
        turnStart={null}
        dialog={null}
      />,
    )
    expect(html).toContain('data-testid="chat-permission-card"')
    expect(html).toContain('chat can’t answer this one yet')
  })

  test('the mode chip stays inert while a dialog is on screen', () => {
    // `POST /mode` converges by pressing BTab, and BTab inside a permission
    // dialog ACCEPTS it (a0 §3, live-verified). The chat header's mode chip is
    // therefore a label and not a control — gated by construction, which is the
    // only gate that cannot be forgotten. This test is the tripwire: the first
    // person to make the chip actionable has to come back and gate it on
    // `lens.dialog == null`.
    const html = renderToStaticMarkup(
      <ChatConversation
        name="release-train"
        session={{ ...session, mode: 'accept_edits' }}
        items={[]}
        nowMs={0}
        turnStart={null}
        dialog={dialogCardView(PERM, '2.1.231')}
        onChooseDialog={() => {}}
      />,
    )
    const header = html.slice(0, html.indexOf('data-testid="chat-live-layer"'))
    expect(header).toContain('Accept edits')
    expect(header).not.toContain('<button')
  })

  test('the outcome line lands once the dialog is gone', () => {
    const html = renderToStaticMarkup(
      <ChatConversation
        name="release-train"
        session={session}
        items={[]}
        nowMs={0}
        turnStart={null}
        dialog={null}
        dialogResolved="Allowed · bash"
      />,
    )
    expect(html).toContain('Allowed · bash')
  })
})

/** Type-only: the view the bench builds is the view the card takes. */
export type _ViewIsShared = DialogCardView
