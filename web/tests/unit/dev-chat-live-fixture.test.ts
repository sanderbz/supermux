/**
 * The `/dev/chat-live` fixture — is the bench still a review surface?
 * ─────────────────────────────────────────────────────────────────────────────
 * A visual bench is only worth screenshotting if it provably shows every state
 * the surface can be in. This asserts exactly that, the same way
 * `dev-marks-cast.test.ts` does for the marks: the page claims eight states, and
 * each one has to actually CARRY the thing it is named after — a permission
 * state with no `permission_request` is a screenshot of nothing.
 *
 * It also pins the two indexes the bench stands in for (pins by slug, display
 * names by slug), because both were bugs once: the boards' coral Release Train
 * rendered in whatever `release-train` happened to hash to, and the arrival
 * divider read "Message from ●patch".
 */
import { describe, expect, test } from 'bun:test'

import { readDelegateIntent } from '../../src/components/chat/delegate-intent'
import { toDisplayList } from '../../src/components/chat/entries'
import { mentionSegments } from '../../src/components/chat/grouping'
import {
  atRows,
  classifySlash,
  readTrigger,
  slashRows,
} from '../../src/components/chat/slash'
import {
  BENCH_COMMANDS,
  BENCH_ROSTER,
  liveStates,
  MENTIONABLE,
  MENTIONS,
  NAMES,
  PINS,
  pinFor,
  STATE_IDS,
  TRACKED_FILES,
} from '../../src/routes/dev-chat-live.fixture'

const NOW = 1_760_000_000_000
const states = liveStates(NOW)
const byId = new Map(states.map((s) => [s.id, s]))

describe('coverage: every state the surface can be in', () => {
  test('the page ships exactly the states it advertises', () => {
    expect(states.map((s) => s.id)).toEqual([...STATE_IDS])
  })

  test('every state names the board it is held against', () => {
    for (const s of states) {
      expect(s.title.length).toBeGreaterThan(0)
      expect(s.board.length).toBeGreaterThan(0)
    }
  })

  test('idle has a transcript and NO live turn', () => {
    const s = byId.get('idle')!
    expect(s.turnAgo).toBeUndefined()
    expect(s.session.status).toBe('idle')
    expect(toDisplayList(s.entries).length).toBeGreaterThan(5)
  })

  test('working is a running turn with hook receipts, the last one live', () => {
    const s = byId.get('working')!
    expect(s.session.status).toBe('active')
    expect(s.turnAgo).toBeGreaterThan(5) // past the elapsed clause's first rung
    expect(s.overlay?.length ?? 0).toBeGreaterThan(1)
  })

  test('provisional carries a pty capture', () => {
    const s = byId.get('provisional')!
    expect(s.provisional?.length ?? 0).toBeGreaterThan(3)
  })

  test('permission carries the wire OBJECT, not a string', () => {
    const req = byId.get('permission')!.session.permission_request
    expect(req?.tool).toBe('Bash')
    expect(req?.summary).toContain('cargo publish')
  })

  test('delegation has BOTH ends: an arrival in the transcript, a dispatch in flight', () => {
    const s = byId.get('delegation')!
    expect(s.entries.some((e) => e.kind === 'teammate' && e.label === 'patch')).toBe(true)
    // The pill is drawn by a real DISPATCH now (fase B4 T5), not by grepping
    // the activity string — so the state has to carry one, and it has to name
    // a session that exists.
    expect(s.handoffTo).toBe('patch')
    expect(MENTIONS.get(s.handoffTo!)).toBe('patch')
    // The activity is deliberately kept AND deliberately names Patch: this is
    // the positive twin of the regression guard in `chat-surface.test.tsx`,
    // where the same sentence with no dispatch behind it draws nothing.
    const named = mentionSegments(s.session.activity ?? '', MENTIONS, s.session.name).find(
      (seg) => 'seed' in seg,
    )
    expect(named).toBeDefined()
  })

  test('harness carries one ledger row for EVERY sentence HarnessLine can say', () => {
    // Four surfaced actions, four sentences — and the failed fire, which is the
    // only one with a tone of its own. A bench state missing one of them is a
    // screenshot that cannot review the thing it is named after.
    const s = byId.get('harness')!
    const actions = (s.events ?? []).map((e) => e.action)
    expect(actions).toEqual([
      'session.delegate',
      'session.rename',
      'schedule.create',
      'schedule.run',
    ])
    expect((s.events ?? []).some((e) => e.detail.status === 'error')).toBe(true)
    // Every chip in those sentences has to be able to NAME something: a
    // delegation with no target, or a schedule with no title, renders a
    // sentence with nothing in it.
    for (const e of s.events ?? []) {
      if (e.action === 'session.delegate') expect(e.target.length).toBeGreaterThan(0)
      if (e.action.startsWith('schedule.')) {
        expect(String(e.detail.title ?? '').length).toBeGreaterThan(0)
        expect(e.target).toMatch(/^SCHED-/)
      }
    }
    // The rows have to be INSIDE the transcript's window, or the log renders
    // above the conversation instead of inside it.
    const oldest = Math.min(...s.entries.map((e) => e.ts))
    for (const e of s.events ?? []) expect(e.ts).toBeGreaterThan(oldest)
  })

  test('error is a failed run said calmly — the failure is in the outcome', () => {
    const s = byId.get('error')!
    expect(s.session.status).toBe('error')
    expect(s.entries.some((e) => e.kind === 'tool_use' && e.ok === false)).toBe(true)
  })

  test('offline is the tail itself failing', () => {
    const s = byId.get('offline')!
    expect(s.isError).toBe(true)
    expect(s.entries).toEqual([])
  })

  test('patch is a DIFFERENT session — the accent re-skin has something to re-skin', () => {
    const s = byId.get('patch')!
    expect(s.session.name).not.toBe(byId.get('idle')!.session.name)
    // The approved Patch board's one fenced block is a diff.
    expect(s.entries.some((e) => e.text.includes('```'))).toBe(true)
  })

  // ── the interactive states (fase A4 T9) ───────────────────────────────────
  //
  // A bench state that MERELY LOOKS like an open popover is worth nothing: the
  // point of screenshotting this surface is to catch it lying. So each of these
  // asserts the fixture against the composer's own arithmetic — the trigger is
  // the one `readTrigger` reads, the refusal is the one `classifySlash` makes,
  // and the rows are the ones the shipped builders produce.

  test('composing declares the picker its OWN draft would open', () => {
    const c = byId.get('composing')!.composer!
    expect(c.draft.length).toBeGreaterThan(0)
    const trigger = readTrigger(c.draft, c.draft.length)
    expect(trigger?.kind).toBe(c.picker!.kind)
    expect(trigger?.query).toBe(c.picker!.query)
  })

  test('composing’s popover shows BOTH `@` sources — files and a session', () => {
    // An empty list is not a board, and a list with only one of the two sources
    // would let the mention half of `@` rot unseen.
    const c = byId.get('composing')!.composer!
    const rows = atRows(TRACKED_FILES, MENTIONABLE, 'release-train', c.picker!.query)
    expect(rows.length).toBeGreaterThan(2)
    expect(rows.some((r) => r.kind === 'file')).toBe(true)
    expect(rows.some((r) => r.kind === 'session')).toBe(true)
    expect(rows.every((r) => r.value.startsWith('@'))).toBe(true)
  })

  test('the hand-off states are ones the shipped RULE would actually produce', () => {
    // A bench that merely LOOKS like a relabelled send control is worth
    // nothing. `handoff` must read as an intent through `readDelegateIntent`,
    // and — the important half — `handoff-sent` must NOT, because its draft is
    // empty: a receipt with the control still saying "Hand to" would be a
    // screenshot of a state the app cannot be in.
    const armed = byId.get('handoff')!.composer!
    expect(readDelegateIntent(armed.draft, MENTIONS, 'release-train')).toEqual({
      to: 'patch',
      prompt: 'can you re-run the export test on fix/money?',
    })
    expect(armed.notice).toBeUndefined()

    const sent = byId.get('handoff-sent')!.composer!
    expect(sent.draft).toBe('')
    expect(readDelegateIntent(sent.draft, MENTIONS, 'release-train')).toBeNull()
    expect(sent.notice).toEqual({ kind: 'handoff-sent', detail: 'Patch' })

    // The failure branch's whole claim: the sentence survived.
    const failed = byId.get('handoff-failed')!.composer!
    expect(failed.draft).toBe(armed.draft)
    expect(failed.notice?.kind).toBe('handoff-failed')
    expect(failed.notice?.detail?.length).toBeGreaterThan(0)
  })

  test('the schedule affordance carries a draft, and the draft SURVIVES it', () => {
    // T9.1/T9.2: the clock's whole job is to hand the current draft over as the
    // prompt, and to leave the composer exactly as it was. A state with an
    // empty draft would screenshot the affordance doing nothing, and one whose
    // draft vanished would screenshot the bug.
    const c = byId.get('schedule-draft')!.composer!
    expect(c.schedulable).toBe(true)
    expect(c.draft.trim().length).toBeGreaterThan(0)
    expect(c.notice).toBeUndefined()
    // It is a MESSAGE, not a hand-off and not a command: the clock must not be
    // reviewed on top of a relabelled send button or a refusal banner.
    expect(readDelegateIntent(c.draft, MENTIONS, 'release-train')).toBeNull()
    expect(classifySlash(c.draft)).toBe('pass')
    // No other state draws it, so every pre-B4 board still screenshots the
    // composer it was approved against.
    expect(states.filter((s) => s.composer?.schedulable).map((s) => s.id)).toEqual([
      'schedule-draft',
    ])
  })

  test('slash shows a refusal the classifier actually makes', () => {
    const c = byId.get('slash')!.composer!
    expect(classifySlash(c.draft)).toBe('picker')
    expect(c.notice).toEqual({ kind: 'slash-picker', detail: '/model' })
  })

  test('slash’s popover carries a terminal-only row AND an ordinary one', () => {
    const rows = slashRows(BENCH_COMMANDS, byId.get('slash')!.composer!.picker!.query)
    expect(rows.some((r) => r.warn)).toBe(true)
    expect(slashRows(BENCH_COMMANDS, '').some((r) => !r.warn)).toBe(true)
  })

  test('refused shows a built-in the classifier will NOT send, badged as such', () => {
    const c = byId.get('refused')!.composer!
    expect(classifySlash(c.draft)).toBe('unverified')
    expect(c.notice).toEqual({ kind: 'slash-unverified', detail: '/permissions' })
    // The badge is the warning that arrives in time — before the pick, not
    // after the send — so the bench has to prove it is on the row.
    const rows = slashRows(BENCH_COMMANDS, c.picker!.query)
    expect(rows[0]?.value).toBe('/permissions')
    expect(rows[0]?.warn).toBe('terminal only')
  })

  test('panel refuses a plain message and names the terminal, with the panel’s own footer as evidence', () => {
    // daily-driver QA #1: a full-screen TUI screen (`/status`, `/cost`) is up.
    // There is no card above the composer to point at, so the refusal points at
    // the terminal — and it is NOT the draft refusal, which is what this state
    // exists to keep true.
    const c = byId.get('panel')!.composer!
    expect(classifySlash(c.draft)).toBe('pass') // an ordinary message, not a command
    expect(c.notice).toEqual({ kind: 'dialog-terminal', detail: 'Esc to cancel' })
  })

  test('every other state leaves the composer to A3’s read-only shell', () => {
    const live = states.filter((s) => s.composer)
    expect(live.map((s) => s.id)).toEqual([
      'stopping',
      'queueing',
      'composing',
      'slash',
      'refused',
      'handoff',
      'handoff-sent',
      'handoff-failed',
      'schedule-draft',
      'panel',
      // r2 finding 34: the dialog-question refusal AND the card it points at,
      // on one screen. A composer state because the notice is the composer's
      // banner — and the pair is the whole point, since the failure was the two
      // of them overlapping.
      'question-refused',
      // PTY-07: the Stop that was refused because the terminal armed Escape.
      // A composer state, because the refusal IS the composer's banner.
      'stop-armed',
    ])
  })

  test('the pending band shows all three echo states at once', () => {
    // One screenshot has to be able to catch all three lying, so the bench
    // state carries one of each (fase A4 T4).
    const s = byId.get('pending')!
    expect(s.pending?.map((p) => p.state)).toEqual([
      'sending',
      'unconfirmed',
      'undelivered',
    ])
  })

  test('p1/p2/p3 isolate the three send-escalation PHASES, one per state', () => {
    // The showcase holds these three side by side, so each must drive ONE
    // distinct phase and read as anything but a healthy idle session — the
    // regression is that `?state=p1|p2|p3` had no fixture state and fell back to
    // `idle`, so all three rendered identical (p3-phone was byte-identical to
    // p1). Each carries exactly one pending send in its own state.
    const phases = { p1: 'sending', p2: 'unconfirmed', p3: 'undelivered' } as const
    for (const [id, state] of Object.entries(phases)) {
      const s = byId.get(id)!
      expect(s.pending?.length).toBe(1)
      expect(s.pending?.[0]?.state).toBe(state)
    }
    // p2 states the delivery receipt rather than "Sending…", so its phase is
    // legibly the calm middle one and not a dimmer p1.
    expect(byId.get('p2')!.pending?.[0]?.receipted).toBe(true)
    // p3 carries the reason the watchdog gave up — the row that speaks.
    expect(byId.get('p3')!.pending?.[0]?.note).toBeTruthy()
  })

  test('the attention states carry a cause AND the evidence behind it', () => {
    for (const id of ['attention', 'attention-inline'] as const) {
      const s = byId.get(id)!
      expect(s.attention).toBe('send-unconfirmed')
      // The mini-view's claim is that it reproduces the session's own screen,
      // so the bench feeds it a real truecolour capture, not lorem.
      expect(s.attentionCapture).toContain('Do you want to proceed?')
      expect(s.attentionCapture).toContain('\u001b[')
    }
    expect(byId.get('attention')!.attentionExpanded).toBe(true)
    expect(byId.get('attention-inline')!.attentionExpanded).toBeUndefined()
  })

  test('the three dialog states are built through the real lens + registry', () => {
    // The bench's cards come from a CAPTURE, not from hand-written options: a
    // fingerprint that stops matching breaks this page the same way it breaks
    // the app, instead of the page quietly still looking right (fase A4 T7).
    const answering = byId.get('answering')!
    expect(answering.dialog?.id).toBe('permission.bash')
    expect(answering.dialog?.options.map((o) => o.actOn)).toEqual([true, false, true])
    // Mid-sequence, on the option two rows down from where the caret starts.
    expect(answering.dialogBusy).toBe(2)

    const plan = byId.get('plan-approval')!
    expect(plan.dialog?.id).toBe('plan.approval')
    expect(plan.dialog?.options.map((o) => o.label)).toEqual([
      'Yes, and use auto mode',
      'Yes, manually approve edits',
      'Tell Claude what to change',
    ])
    // The lens is this card's only source — no `PermissionRequest` hook is
    // verified for `ExitPlanMode` (a0 §3).
    expect(plan.session.permission_request).toBeUndefined()
    expect(plan.dialog?.planPath).toMatch(/^~\/\.claude\/plans\/plan-.*\.md$/)
    expect(plan.dialog?.escape?.actOn).toBe(false)

    const refused = byId.get('dialog-refused')!
    expect(refused.dialog?.disabled).toBe(true)
    expect(refused.dialog?.options.every((o) => !o.actOn)).toBe(true)
    expect(refused.attention).toBe('registry-version-mismatch')

    // The headline state: the card as it looks when it CAN be answered. A0's
    // verified set exactly — 1 and 3 live, 2 drawn and inert, Esc live.
    const live = byId.get('dialog-live')!
    expect(live.dialog?.id).toBe('permission.bash')
    expect(live.dialog?.disabled).toBe(false)
    expect(live.dialog?.options.map((o) => o.actOn)).toEqual([true, false, true])
    expect(live.dialog?.escape?.actOn).toBe(true)
    expect(live.dialogBusy).toBeUndefined()

    // The revert path, built through `applyLatch` so the bench shows the real
    // thing: inert, and the abort's own sentence as the card's VISIBLE note.
    const aborted = byId.get('dialog-aborted')!
    expect(aborted.dialog?.disabled).toBe(true)
    expect(aborted.dialog?.options.every((o) => !o.actOn)).toBe(true)
    expect(aborted.dialog?.escape?.actOn).toBe(false)
    expect(aborted.dialog?.note).toMatch(/something else is typing into this session/)
    expect(aborted.attention).toBe('dialog-unmapped')
  })

  test('stopping is a running turn with an EMPTY box; queueing is the same turn with a draft', () => {
    // The two halves of the trailing control's rule, on one page: an empty box
    // during a turn is a Stop, a draft is a Send (A4 review).
    expect(byId.get('stopping')!.session.status).toBe('active')
    expect(byId.get('stopping')!.composer?.draft).toBe('')
    expect(byId.get('queueing')!.session.status).toBe('active')
    expect((byId.get('queueing')!.composer?.draft ?? '').length).toBeGreaterThan(0)
  })
})

describe('the two indexes the bench stands in for', () => {
  test('a pin resolves by slug AND by display name — one character, two keys', () => {
    expect(pinFor('release-train')).toEqual(pinFor('Release Train')!)
    expect(PINS.get('patch')).toEqual(PINS.get('Patch')!)
    // The boards were art-directed: without the pin this is not the same face.
    expect(pinFor('release-train')?.hue).toBe(28)
  })

  test('mentions map both spellings to the slug; names map the slug back', () => {
    expect(MENTIONS.get('patch')).toBe('patch')
    expect(MENTIONS.get('release train')).toBe('release-train')
    expect(NAMES.get('release-train')).toBe('Release Train')
  })

  test('every roster row is one of the cast, so the sidebar and the transcript agree', () => {
    for (const row of BENCH_ROSTER) expect(pinFor(row.seed)).toBeDefined()
  })
})
