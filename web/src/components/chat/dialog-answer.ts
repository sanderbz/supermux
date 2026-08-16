// Answering a dialog — the ARITHMETIC (fase A4 T7).
//
// This module is the only place in the app that decides a key may be pressed
// into somebody's session, and it is pure so that decision is assertable in
// `bun test` with no DOM, no clock and no server (`chat-dialog-answer.test.tsx`
// scripts every branch below, including the ones that must send nothing).
// `use-dialog-answer.ts` is the React state around it; `registry/` is the data
// it reads.
//
// THE SEQUENCE, and why every step is a refusal point (a0-findings §3):
//
//   1  verify-BEFORE-send   re-peek. The FULL, strict fingerprint — including
//                           `Tab to amend` — plus the option rows AND the caret
//                           must still be what the user was looking at. A0
//                           watched a concurrent terminal client move the caret
//                           and resolve dialogs mid-probe, twice.
//   2  navigate             one key at a time, re-peeking between each, and the
//                           caret must have moved by EXACTLY one row in the
//                           direction we pressed. Anything else aborts with the
//                           keys already sent recorded — a caret that moved two
//                           rows means something else is typing too.
//                           These re-peeks (and the dismissal looks below) are
//                           CONTINUITY reads: same question, same option rows,
//                           same title, footer excluded, because CC 2.1.232
//                           redraws the footer as the caret moves and step 1 has
//                           already established what this dialog is. The whole
//                           argument, with its evidence, is in `peek-lens.ts`
//                           beside `DialogContinuity`.
//   3  commit               Enter (or Escape, for the feedback branch).
//   4  dismissal check      2 re-peeks, 300 ms apart: the dialog must be GONE.
//                           A DIFFERENT dialog counts as gone — Claude asking
//                           the next question is what an accepted permission
//                           looks like — the SAME one surviving does not.
//
// Digits are never sent: `KEY_ALLOWLIST` has no `0`-`9` (`registry/plan.ts`),
// so navigation is the plan and the card's digits are hints that bind nothing.
//
// What "abort" means, precisely: nothing further is sent, the caller reverts the
// card to unanswered, hard-disables it, and raises the Attention card with the
// capture that confounded it. The one thing this module may never do is fail
// SILENTLY — every unhappy return carries a cause and a sentence.

import type { KeyName } from '../../lib/session-input/types'

import type { AttentionCause } from './attention'
import { continuityOf, type DialogContinuity, type DialogSighting, type PeekLens } from './peek-lens'
import {
  entryFor,
  keyPlan,
  optionLabel,
  type OptionEffect,
  type RegistryEntry,
  type RegistryId,
} from './registry'

/* ── identity ────────────────────────────────────────────────────────────── */

/**
 * The identity of a SIGHTING, caret excluded.
 *
 * Two peeks of the same dialog must compare equal while the caret walks down
 * it, and a dialog whose ROWS changed must not — that is the difference between
 * "the user is answering the thing they read" and "the option list moved under
 * them", which is how `3. No` becomes `2. Yes, and always allow`.
 */
export function sightingKey(s: DialogSighting): string {
  return `${s.family}/${s.variant ?? '-'}/${s.options.join('|')}`
}

/* ── the outcome vocabulary ──────────────────────────────────────────────── */

export type AnswerFailure =
  /** The screen could not be read at all (peek error, session not running). */
  | 'peek-failed'
  /** Nothing is asking any more — somebody else answered it. */
  | 'no-dialog'
  /** A dialog is up, but not the one the card was drawn for. */
  | 'changed'
  /** The registry will not act on this option (unverified, or version-pinned
   *  out). Reaching this from a press is a bug in the caller, not in the user —
   *  it is still reported rather than ignored. */
  | 'not-actionable'
  /** No caret is visible, so no movement can be verified. */
  | 'no-caret'
  /** The caret did not move by exactly one row in the direction pressed. */
  | 'caret-drift'
  /** The key itself was rejected (POST error). */
  | 'send-failed'
  /** The commit landed and the SAME dialog is still on screen. */
  | 'still-open'

export interface AnswerOutcome {
  ok: boolean
  /** Exactly what went on the wire, in order. Asserted in the tests: a refusal
   *  that "sent nothing" has to be able to prove it. */
  sent: KeyName[]
  /**
   * The committing key left this client.
   *
   * After this the surface may NOT say "nothing was sent" — the session may
   * have acted on it and the response merely got lost. The Attention copy for a
   * post-commit failure has to admit that, which is why it is a field and not an
   * inference from `sent`.
   */
  committed: boolean
  /** What the chosen option does, on success. */
  effect?: OptionEffect
  failure?: AnswerFailure
  /** The card the surface should raise. */
  attention?: AttentionCause
  /** One sentence of evidence, quoting what was actually seen. */
  detail?: string
}

/** The dismissal check's shape: two looks, 300 ms apart. Two because a TUI that
 *  has taken the Enter still has to repaint, and one look at exactly the wrong
 *  moment would accuse it of ignoring the key. */
export const DISMISS_ATTEMPTS = 2
export const DISMISS_DELAY_MS = 300

export interface AnswerDeps {
  /** Peek NOW. `null` = could not look (never `EMPTY_LENS` — "the screen is
   *  clear" and "I could not read the screen" are different facts and this
   *  module refuses on the second one).
   *
   *  `continuing` is passed on every look AFTER the strict one, and only ever
   *  carries a dialog this sequence already sighted strictly. Implementations
   *  hand it to `readLens` and change nothing else; the shared poll frame stays
   *  strict (`use-peek-lens.ts`). */
  refresh: (continuing?: DialogContinuity | null) => Promise<PeekLens | null>
  sendKey: (key: KeyName) => Promise<void>
  /** The session's BOOT-BANNER version (`registry.pinFor`). */
  pin: string | null
  /** Injected for the tests, which must not spend 600 ms proving a refusal. */
  wait?: (ms: number) => Promise<void>
}

export interface AnswerRequest {
  /** Which registry entry the CARD was drawn from. */
  entryId: RegistryId
  /** The option row, or the Escape affordance. */
  target: number | 'escape'
  /** `sightingKey` of what the user was looking at when they pressed. */
  key: string
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))

/**
 * Answer one dialog. Resolves — never throws — with what was sent and why it
 * stopped, so the caller has one shape to render for both halves of the story.
 */
export async function answerDialog(
  deps: AnswerDeps,
  req: AnswerRequest,
): Promise<AnswerOutcome> {
  const sent: KeyName[] = []
  const wait = deps.wait ?? sleep

  const start = await look(deps, req)
  if ('failure' in start) return { ok: false, sent, committed: false, ...start }

  const { entry, sighting } = start
  // Earned by the STRICT look above, and by nothing else: `continuityOf` refuses
  // an `unknown` family and a sighting with no question, so a screen that never
  // passed phase 1 cannot hand itself a phase-2 pass.
  const anchor = continuityOf(sighting)
  const escape = req.target === 'escape'
  const option = escape ? null : entry.options[req.target as number]
  const gate = escape ? entry.escape : option
  if (!gate || !gate.actOn) {
    return {
      ok: false,
      sent,
      committed: false,
      failure: 'not-actionable',
      attention: 'dialog-unmapped',
      detail: gate?.disabledReason,
    }
  }

  // Navigation, one key at a time, with a re-peek between every one.
  if (option) {
    const caret = sighting.caretIndex
    if (caret == null) {
      return {
        ok: false,
        sent,
        committed: false,
        failure: 'no-caret',
        attention: 'dialog-unmapped',
        detail:
          'The terminal is not showing which option is selected, so there is no way to check where a keypress would land.',
      }
    }
    const plan = keyPlan(caret, option.tuiIndex)
    if (plan.length === 0) {
      return {
        ok: false,
        sent,
        committed: false,
        failure: 'changed',
        attention: 'dialog-unmapped',
        detail: 'The option this card names is not where the terminal has it.',
      }
    }
    let at: number = caret
    for (const key of plan.slice(0, -1)) {
      const posted = await press(deps, key)
      if (posted) return { ...posted, sent, committed: false }
      sent.push(key)

      const step = await look(deps, req, anchor)
      if ('failure' in step) return { ok: false, sent, committed: false, ...step }
      const moved: number | null = step.sighting.caretIndex
      const expected = at + (key === 'Down' ? 1 : -1)
      if (moved !== expected) {
        return {
          ok: false,
          sent,
          committed: false,
          failure: moved == null ? 'no-caret' : 'caret-drift',
          attention: 'dialog-unmapped',
          detail:
            moved == null
              ? 'The selected option stopped being visible halfway through, so nothing further was sent.'
              : `After ${key}, the terminal’s selection sits on option ${moved + 1} instead of ${expected + 1} — something else is typing into this session, so nothing further was sent.`,
        }
      }
      at = moved
    }
  }

  // Commit.
  const commit: KeyName = escape ? 'Escape' : 'Enter'
  const posted = await press(deps, commit)
  if (posted) return { ...posted, sent, committed: false }
  sent.push(commit)

  // Dismissal check.
  let looked = false
  for (let i = 0; i < DISMISS_ATTEMPTS; i++) {
    await wait(DISMISS_DELAY_MS)
    // The anchor matters MOST here. "Gone" is inferred from the sighting key no
    // longer matching, and a strict read of a dialog that SURVIVED the commit
    // with its caret on row 2 reports `unknown` — a different key, i.e. a false
    // success on the one frame where being wrong is worst.
    const lens = await deps.refresh(anchor)
    if (!lens) continue
    looked = true
    // Gone, or replaced by a different question: the key landed. A permission
    // accepted mid-turn routinely raises the NEXT permission within the same
    // second, and calling that a failure would raise the Attention card on the
    // happy path.
    if (!lens.dialog || sightingKey(lens.dialog) !== req.key) {
      return { ok: true, sent, committed: true, effect: gate.effect }
    }
  }
  return {
    ok: false,
    sent,
    committed: true,
    failure: looked ? 'still-open' : 'peek-failed',
    attention: 'dialog-unmapped',
    detail: looked
      ? 'The key was sent and the same prompt is still on the terminal, so it may not have been taken. Check the terminal before answering again.'
      : 'The key was sent and the terminal could not be read afterwards, so whether it landed is unknown. Check the terminal before answering again.',
  }
}

/** What an abort says when the registry recognises nothing on screen — most
 *  often because the option rows are not the ones that were read. */
const ROWS_MOVED =
  'The options on the terminal are not the ones this card was drawn from, so no further keys were sent.'

/** One peek + the full re-verification: family, variant, rows, entry, version.
 *
 *  With no `continuing` this is the STRICT look (step 1). With one it is the
 *  continuity look — same everything except the caret-dependent footer, which
 *  the anchor's owner has already seen once. Note what does NOT relax: the
 *  registry match, the version pin and `shapeHolds` all run again on the
 *  continuity reading, so a row that stopped matching its `rowPattern` still
 *  degrades the entry and still aborts. */
async function look(
  deps: AnswerDeps,
  req: AnswerRequest,
  continuing: DialogContinuity | null = null,
): Promise<
  | { entry: RegistryEntry; sighting: DialogSighting }
  | { failure: AnswerFailure; attention: AttentionCause; detail?: string }
> {
  const lens = await deps.refresh(continuing)
  if (!lens) {
    return {
      failure: 'peek-failed',
      attention: 'dialog-unmapped',
      detail: 'The terminal could not be read just before the keypress, so nothing was sent.',
    }
  }
  if (!lens.dialog) {
    return {
      failure: 'no-dialog',
      attention: 'dialog-unmapped',
      detail: 'The prompt was gone by the time this was answered — something else answered it.',
    }
  }
  const match = entryFor(lens, deps.pin)
  if (!match.entry || match.degraded) {
    return {
      failure: match.entry ? 'not-actionable' : 'changed',
      attention: match.attention ?? 'dialog-unmapped',
      // The registry has ALREADY written the sentence for this refusal — the
      // version it was pinned to, or the row that stopped matching — and
      // `disabled()` stamped it on every option. Dropping it here and falling
      // back to "could not confirm what the terminal is showing" would replace
      // the one fact the user needs (an option list that gained a row is how
      // "No" becomes "Yes, and always allow") with a shrug.
      //
      // NO entry is the one case the registry has no sentence for: it matched
      // nothing, so there was nothing to stamp. That is also the abort that
      // matters most mid-sequence — the rows moved under a key that has already
      // gone — so it says so itself rather than falling through to the generic
      // "could not confirm" line.
      detail: match.entry?.options[0]?.disabledReason ?? ROWS_MOVED,
    }
  }
  if (match.entry.id !== req.entryId || sightingKey(lens.dialog) !== req.key) {
    return {
      failure: 'changed',
      attention: 'dialog-unmapped',
      detail:
        'The terminal is showing a different prompt than the one on this card, so nothing was sent.',
    }
  }
  return { entry: match.entry, sighting: lens.dialog }
}

/** Send one key; `undefined` when it went, an outcome fragment when it did not. */
async function press(
  deps: AnswerDeps,
  key: KeyName,
): Promise<Omit<AnswerOutcome, 'sent' | 'committed'> | undefined> {
  try {
    await deps.sendKey(key)
    return undefined
  } catch (err) {
    return {
      ok: false,
      failure: 'send-failed',
      attention: 'dialog-unmapped',
      detail: err instanceof Error ? err.message : undefined,
    }
  }
}

/* ── the card, as data ───────────────────────────────────────────────────── */

/** The sentence a card wears when this app will not press its keys. The SAME
 *  words the composer's refusal and the retry path use for the same situation
 *  (`use-composer.ts` `dialog-terminal`), because it is the same fact. */
export const DIALOG_TERMINAL_NOTE =
  'Answer in the terminal — chat won’t press a key it can’t verify.'

export interface DialogCardOption {
  /** What the button says. */
  label: string
  /** The digit the TUI binds. A HINT: it is never sent (no digits in the
   *  allowlist) — it is here so the card and the terminal read the same. */
  kbd: string
  actOn: boolean
  /** Why it cannot be pressed — shown on the control itself. */
  reason?: string
  primary?: boolean
}

export interface DialogCardView {
  /** null = something modal is on screen that the registry has no entry for. */
  id: RegistryId | null
  family: DialogSighting['family']
  variant?: DialogSighting['variant']
  /** `sightingKey` — the identity every press is checked against. */
  key: string
  options: readonly DialogCardOption[]
  /** The feedback affordance, when the entry has a verified one. */
  escape?: { label: string; actOn: boolean; reason?: string }
  /** `~/.claude/plans/plan-<slug>.md`, when the plan footer exposed it. */
  planPath?: string
  /**
   * The dialog's own body, verbatim — the command, the file, the diff (QA #11).
   *
   * Straight through from the lens (`DialogSighting.body`) and deliberately
   * untouched on the way: the card is where a user reads what they are about to
   * approve, and the hook's `summary` — the only other source — is a short
   * description by design. Permission family only; a plan's body is a plan, and
   * the card links it instead.
   */
  body?: readonly string[]
  /** The Claude Code versions this fingerprint was CAPTURED against — what the
   *  version-mismatch sentence quotes (`attention.ts` `versionClause`). */
  verifiedVersions?: readonly string[]
  /** Nothing on this card may be pressed. */
  disabled: boolean
  /** Why — the line under the card. */
  note?: string
  /** What the surface should raise, if anything. */
  attention: AttentionCause | null
}

/**
 * The approved board's product voice for the permission family
 * (`live-layer.tsx` `PERMISSION_OPTIONS`, board `board-light.png`).
 *
 * Option 2 is deliberately NOT in this list: what it grants differs per variant
 * — Bash's row names a directory and persists something A0 could not find on
 * disk — so it wears the dialog's OWN sentence (`optionLabel`), which is the
 * only honest label for a grant whose scope varies. Options 1 and 3 mean the
 * same thing on every capture, so they keep the board's words.
 */
const PERMISSION_VOICE: Readonly<Record<number, string>> = { 0: 'Allow once', 2: 'Not now' }

/**
 * What the surface may show — and press — for the dialog the lens is seeing.
 *
 * Pure, so the bench builds its states from the same a0 captures the registry
 * tests read, and so "which buttons are live?" is a question with a unit test.
 * `null` when nothing is on screen: a card is never drawn on a guess.
 */
export function dialogCardView(
  lens: PeekLens,
  pin: string | null,
): DialogCardView | null {
  const sighting = lens.dialog
  if (!sighting) return null
  const key = sightingKey(sighting)
  const match = entryFor(lens, pin)

  // Modal-shaped, unmapped: rendered so the user can see that chat has SEEN it
  // and is refusing, rather than showing nothing while the session sits blocked.
  if (!match.entry) {
    return {
      id: null,
      family: sighting.family,
      variant: sighting.variant,
      key,
      options: sighting.options.map((label, i) => ({
        label,
        kbd: String(i + 1),
        actOn: false,
        reason: DIALOG_TERMINAL_NOTE,
      })),
      body: sighting.body,
      disabled: true,
      note: DIALOG_TERMINAL_NOTE,
      attention: match.attention ?? 'dialog-unmapped',
    }
  }

  const entry = match.entry
  return {
    id: entry.id,
    family: entry.family,
    variant: entry.variant,
    key,
    options: entry.options.map((o) => ({
      label:
        entry.family === 'permission' && PERMISSION_VOICE[o.tuiIndex]
          ? PERMISSION_VOICE[o.tuiIndex]
          : optionLabel(o, sighting),
      kbd: String(o.tuiIndex + 1),
      actOn: o.actOn,
      reason: o.disabledReason,
      primary: o.tuiIndex === 0 && o.actOn,
    })),
    escape: {
      label: entry.escape.label,
      actOn: entry.escape.actOn,
      reason: entry.escape.disabledReason,
    },
    planPath: sighting.planPath,
    body: sighting.body,
    verifiedVersions: entry.verifiedVersions,
    disabled: match.degraded,
    note: match.degraded ? DIALOG_TERMINAL_NOTE : undefined,
    attention: match.attention,
  }
}

/** A sighting this app aborted on: what it was, why, and what the surface must
 *  raise for as long as it is up. */
export interface AbortLatch {
  key: string
  detail: string
  attention: AttentionCause
}

/**
 * The card as it should be drawn given the latch — the whole visible half of a
 * failed sequence, in one pure function.
 *
 * Two things happen at once, and they are both required: the controls go inert
 * (nothing more may be pressed into a screen this app has already misread), and
 * the ABORT'S cause replaces the registry's, because a card that was answerable
 * right up until the caret drifted has nothing to say for itself otherwise. A
 * refusal the user has to infer from a greyed-out button is not a refusal.
 */
export function applyLatch(
  base: DialogCardView | null,
  latch: AbortLatch | null,
): { card: DialogCardView | null; attention: AttentionCause | null } {
  if (!base) return { card: null, attention: null }
  const mine = latch && latch.key === base.key ? latch : null
  return {
    card: mine ? hardDisable(base, mine.detail) : base,
    attention: mine ? mine.attention : base.attention,
  }
}

/** The same view with every control inert, plus the reason. Used after a failed
 *  sequence: once this app has misread the screen ONCE, it stops offering to
 *  press keys into it until the dialog itself changes.
 *
 *  The reason becomes the card's VISIBLE note, not just the controls' tooltips.
 *  A `title` attribute is not a sentence a phone can read, and "something else
 *  is typing into this session" is the whole content of the refusal — replacing
 *  it with the generic terminal line would leave the user with a greyed-out card
 *  and no idea that a key had already gone. */
export function hardDisable(view: DialogCardView, reason: string): DialogCardView {
  return {
    ...view,
    options: view.options.map((o) => ({ ...o, actOn: false, reason })),
    escape: view.escape ? { ...view.escape, actOn: false, reason } : undefined,
    disabled: true,
    note: reason || DIALOG_TERMINAL_NOTE,
  }
}

/**
 * May this control be pressed right now?
 *
 * The card disables its inert controls in the DOM; this is the same refusal in
 * the LOGIC, so "Bash option 2 can never be pressed" survives a restyle that
 * drops an attribute. It is also the double-fire guard: a sequence in flight
 * owns the card until it finishes, because a slow pty must not be able to take
 * two answers to one question.
 */
export function chooseable(
  card: DialogCardView | null,
  busy: number | 'escape' | null,
  target: number | 'escape',
): boolean {
  if (!card || !card.id || card.disabled || busy !== null) return false
  const control = target === 'escape' ? card.escape : card.options[target]
  return control?.actOn === true
}

/**
 * How long the outcome line stays after the dialog is gone.
 *
 * Not a timer — it is re-read on whatever render comes next (the peek poll ticks
 * at 1-4 s), so the line simply stops being drawn. Long enough for someone who
 * looked away, short enough that it cannot be mistaken for a live card.
 */
export const RESOLUTION_MS = 12_000

export interface DialogResolution {
  /** The sighting it answered — so it disappears the moment a NEW question
   *  arrives rather than sitting under it claiming the last one's outcome. */
  key: string
  line: string
  atMs: number
}

/** The outcome line, while it is still worth showing. */
export function visibleResolution(
  resolved: DialogResolution | null,
  card: DialogCardView | null,
  nowMs: number,
): string | null {
  if (!resolved) return null
  if (card && card.key === resolved.key) return null
  return nowMs - resolved.atMs < RESOLUTION_MS ? resolved.line : null
}

/**
 * The line the card crossfades into once an answer has landed.
 *
 * Dialog outcomes write NOTHING to the JSONL (a0 §3), so this is the only
 * record the conversation gets that a decision was made here — and it names the
 * decision rather than the keystroke, because "Enter" is not what the user did.
 */
export function resolutionLine(
  effect: OptionEffect,
  view: Pick<DialogCardView, 'family' | 'variant'>,
): string {
  const what = view.family === 'plan' ? 'plan' : (view.variant ?? 'request')
  switch (effect) {
    case 'accept':
      return `Allowed · ${what}`
    case 'accept-session':
      return `Allowed for this session · ${what}`
    case 'deny':
      return `Denied · ${what}`
    case 'feedback':
      return 'Answered in chat — say what should happen instead'
  }
}

/**
 * The sentence a REFUSED answer leaves behind — and why it is a resolution
 * rather than only a latch.
 *
 * The latch dies with its sighting, by design: the next identical question must
 * not arrive pre-disabled. But the most common abort is exactly the one where
 * the sighting vanishes — somebody answered it in the terminal while the tap was
 * in flight, or a concurrent client moved the caret and then resolved the dialog
 * — and a latch dropped on that frame takes the whole explanation with it. The
 * card disappears, nothing is said, and a tap that sent NOTHING looks precisely
 * like a tap that worked. On this surface that is the worst available failure:
 * the user believes they allowed something they did not.
 *
 * So the outcome line carries both halves. It outlives the sighting (12 s,
 * `visibleResolution`) and it never dresses up a committed key as a no-op.
 */
export function answerNotice(out: AnswerOutcome): string {
  if (out.detail) return out.detail
  return out.committed
    ? 'The key was sent and this app could not confirm what it did. Check the terminal.'
    : 'This app could not confirm what the terminal is showing, so nothing was sent.'
}
