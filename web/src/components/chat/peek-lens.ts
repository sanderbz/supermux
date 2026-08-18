// The peek lens (fase A4 T2) — ONE pure reader of `GET /peek?ansi=1`.
//
// Four consumers need to know what is on the pty right now: the composer's
// draft guard (T3), the dialog registry (T6/T7), the mode-chip gate (T7) and
// the Attention card's mini-view (T5). Four independent readers would be four
// chances to disagree about whether a dialog is up — and disagreeing about THAT
// is how a keystroke lands in the wrong place. So: one poll (`use-peek-lens.ts`)
// and one pure function here, fixture-tested against the a0 captures
// (`web/tests/fixtures/tui/`, provenance in that dir's README).
//
// The rules below are transcribed from a0-findings §3 / a0-dialogs.md. Each one
// cites its evidence, because every one of them is a screen-scrape that CC can
// invalidate on any release: a fingerprint MISS must degrade to the Attention
// card (visible), never to a wrong action (invisible).
//
// RELATIVE import so `bun test` runs without alias config (same rule as
// `provisional.ts`); `lib/ansi`'s React dependency is type-only.
import { hasAnsi, lastContentLine, parseAnsiLine, plain } from '../../lib/ansi'
import type { KeyName } from '../../lib/session-input/types'

/** A dialog the lens can SEE. Whether it may be answered is the registry's call
 *  (T6) — the lens reports, it never decides. */
export interface DialogSighting {
  /** `unknown` is the REFUSAL-FIRST reading (A4 review): something with numbered
   *  rows and a caret is sitting on the live screen, and this app has no
   *  fingerprint for it. The registry answers nothing for it (`entryForSighting`
   *  finds no entry → `dialog-unmapped`), and the composer refuses to send —
   *  which is the point. The three captured fingerprints decide whether a dialog
   *  may be ANSWERED; they must not be what decides whether one is THERE, because
   *  a fingerprint miss would then degrade to a send (invisible) instead of to
   *  the Attention card (visible). Read/WebFetch/MCP permission prompts have no
   *  `Tab to amend` footer — nothing to amend — so they land here. */
  family: 'permission' | 'plan' | 'question' | 'startup' | 'paused' | 'unknown'
  /** Which shape inside the family. `bash`/`edit`/`write` are the permission
   *  variants; `trust`/`apikey` are the two STARTUP wedges that draw numbered
   *  rows (`peek-lens` reports the other two — the first-run wizard and codex's
   *  hooks review — through `notice`, because neither has a captured row list
   *  this app is willing to press a key into).
   *
   *  `overage-consent`/`refusal-fallback` are the two `paused` shapes — see
   *  `readPausedVariant`. A `Session paused` screen whose body matches NEITHER
   *  keeps `family: 'paused'` with no variant: the session is still reported as
   *  paused (that is the fact the roster was missing), and the registry answers
   *  nothing, which is the correct degrade for a consent dialog nobody has
   *  read. */
  variant?:
    | 'bash'
    | 'edit'
    | 'write'
    | 'trust'
    | 'apikey'
    | 'overage-consent'
    | 'refusal-fallback'
  /** Whitespace-normalised option labels, in TUI order.
   *  Wrapped continuation lines are folded back into their option (options wrap
   *  at 52 cols — a0 §3 "wrap hazard"), which also folds in a sub-hint that sits
   *  under an option (`(shift+tab)`, `shift+tab to approve with this feedback`):
   *  the two are indistinguishable by indentation in the capture, and a0 reads
   *  the sub-hint as part of the option too ("`(shift+tab)` inside option 2"). */
  options: string[]
  /** 0-based caret row among the options, or null when no caret is visible. */
  caretIndex: number | null
  /** `~/.claude/plans/plan-<slug>.md`, when the footer exposes it (plan family
   *  only — a0 §3 "bonus for P5": the card can read the full plan from disk). */
  planPath?: string
  /**
   * The dialog's OWN question, verbatim — `Do you want to make this edit to
   * case3.txt?`, `Would you like to proceed?`.
   *
   * Caret-INVARIANT, and that is what it is for: CC redraws the FOOTER as the
   * caret moves (a4c, below) but never the question, so this is the token a
   * continuity check can lean on. It also names the target, which is what makes
   * it a discriminator and not just a shape: two permission prompts for two
   * different files never share it.
   */
  question?: string
  /**
   * The dialog's BODY, verbatim — the command, the file, the diff (QA #11).
   *
   * The card used to show a truncated *description*: `Run  Download example.com
   * homepage to /tmp pr… ?`, while the thing actually being approved —
   * `curl -sS https://example.com/ -o /tmp/qa-perm-probe.html && echo done` —
   * appeared nowhere in chat, only in the terminal. The hook's `summary` is
   * short and secret-conscious by design (`activity.rs` prefers Claude's own
   * English description for a Bash call), so the wire cannot supply the command;
   * the SCREEN can, and does. Every capture puts it between the variant title
   * and the question line, and an edit puts its diff there.
   *
   * Verbatim means verbatim: no whitespace normalisation and no clamping, only
   * the common indent removed and the blank edges trimmed. This is the one place
   * on the surface that shows a user exactly what they are agreeing to, so a
   * "helpful" rewrite here would be the bug.
   */
  body?: string[]
  /**
   * The AskUserQuestion HEADER CHIP, verbatim — `Fruit choice`.
   *
   * Claude Code draws it on a reverse-video line of its own (` ☐ <header> `,
   * U+2610) directly above the question. It is the model's own two-word name for
   * the decision, it is the ONLY thing the phone push and the card can share, and
   * before this it appeared on no supermux surface at all: the card was headed
   * ``Run `AskUserQuestion` ?`` and the sentence the user was being asked was
   * nowhere (verify matrix, 03-chat-askq.png).
   *
   * `question` family only.
   */
  header?: string
  /**
   * Per-option DESCRIPTION lines, parallel to `options` (`undefined` where an
   * option has none).
   *
   * AskUserQuestion prints a dim description indented under each label, and it is
   * indistinguishable from a 52-column WRAP by indentation alone — so the
   * ordinary fold produced chips reading `Apple A crisp and refreshing fruit`
   * and a `rowPattern` written against them would be half description text
   * (verify matrix, finding 8). The discriminator is the LABEL LINE'S LENGTH: a
   * row that ended well short of the wrap column did not wrap, so what follows is
   * a description. Split out here rather than folded, so the chip says `Apple`
   * and the card can still show what Apple means.
   */
  descriptions?: (string | undefined)[]
  /**
   * The `N. Type something.` row — AskUserQuestion's own free-text hatch.
   *
   * Reported so the composer can say what it is doing: free text typed into chat
   * is not a NEW prompt while this dialog is up, it is an answer to it.
   */
  freeTextIndex?: number
}

/**
 * Something on the live screen that BLOCKS or WARNS but is not a dialog.
 *
 * The dialog reader above answers "what is asking?". This answers the question
 * the verify matrix found nothing in the product asking at all: *can this session
 * do the next turn?* A usage-limit banner is not modal, nothing waits on a key,
 * the turn simply ends — so every existing signal reads the session as healthy
 * (`Idle`, green dot, composer enabled) while it is dead until the reset time
 * (05-chat-limits.png / 06-overview-limits.png). A startup wedge is the mirror
 * image: the session never got to a first turn at all, and there is no transcript
 * for the other plane to read, so the pty is the ONLY witness there is.
 *
 * Verbatim in, verbatim out: the banner already carries the reset time and the
 * remediation, and this app has no better sentence than Claude Code's own.
 */
export interface PtyNotice {
  /** `limit-blocked` — the account's bucket is exhausted; the next turn fails.
   *  `limit-warning` — the dim footer line at ≥70 % utilisation, or the
   *  `Approaching …` form. A chip, never a block.
   *  `startup-wedge` — the session is parked on a startup gate before its first
   *  turn (see `wedge`).
   *  `session-paused` — Claude Code has PAUSED the turn on a consent modal and
   *  is waiting for an answer that costs money or changes the model (catalog
   *  `limit.overage_consent_dialog` / `err.refusal_fallback_dialog`). The one
   *  notice that is simultaneously a dialog: the turn does not end, no hook
   *  fires, and every existing signal read the session as a green Idle while it
   *  sat paused indefinitely.
   *  `turn-refused` — the API answered with `stop_reason: refusal`. The turn is
   *  DEAD (not retrying, not blocked on a clock) and Claude Code's recovery is
   *  `double press esc to edit your last message`, which this app has no
   *  equivalent for — so it says what happened instead of drawing a bubble.
   *  `stream-stalled` — the request went out and no bytes came back; CC has
   *  scheduled a retry and the turn is STILL LIVE. Transient, never a block:
   *  the failure it fixes is the opposite one (the surface drifting to Idle
   *  and the user walking away from a turn that was about to resume). */
  kind:
    | 'limit-blocked'
    | 'limit-warning'
    | 'startup-wedge'
    | 'session-paused'
    | 'turn-refused'
    | 'stream-stalled'
  /** Claude Code's own line, verbatim (whitespace-normalised, nothing else). */
  text: string
  /** The remediation subline CC prints under a hard block (`/upgrade or
   *  /usage-credits …`), when it is on screen. */
  detail?: string
  /** Which startup gate. `trust`/`apikey` also raise a DIALOG (they have rows);
   *  `onboarding` and `hooks-review` do not — they are reported here only, so a
   *  session parked on the theme picker stops reading as a green Idle. */
  wedge?: 'trust' | 'apikey' | 'onboarding' | 'hooks-review'
  /** Which `session-paused` modal, when the body says. Absent = a `Session
   *  paused` screen this app does not recognise, which is still reported. */
  paused?: 'overage-consent' | 'refusal-fallback'
}

/**
 * A key the live screen has ARMED — the state IS the pending second keypress
 * (catalog `generic.armed_keys`).
 *
 * `Esc again to clear`, `Press Ctrl-C again to exit`, `Press Ctrl-C again to
 * stop background agents`, `Ctrl+Y to paste deleted text`. On those screens the
 * next key is OVERLOADED: the same Escape this app sends to interrupt a turn
 * throws away what the user was typing, and the same Ctrl-C a recovery might
 * send kills the process outright. Issue #75649 is that failure on the trust
 * gate, where a second Esc exits Claude Code.
 *
 * WHY IT IS ON THE LENS AND NOT IN THE REGISTRY. The registry's job is to say
 * what a key MEANS on a screen it recognises; this is the prior question — *has
 * this screen redefined the key I was about to send?* — and it has to be
 * answerable for screens no fingerprint claims, because those are precisely the
 * ones where guessing is worst. So the lens reports the arming, verbatim, and
 * `registry/armed.ts` decides whether anything may still be sent.
 */
export interface ArmedKey {
  /** The token as the screen spells it — `Esc`, `Ctrl-C`, `Ctrl+Y`. */
  token: string
  /** The key this app would send for that token, or `null` when the allowlist
   *  has no name for it. `null` is not a pass: an unmappable armed token is
   *  still an armed screen, and the refusal is by SCREEN, not by key. */
  key: KeyName | null
  /** What the press does, in Claude Code's own words (`clear`, `exit`, `stop
   *  background agents`, `paste deleted text`). */
  action: string
  /** The screen's own line, whitespace-normalised and otherwise verbatim. */
  text: string
}

/* ── the two-phase fingerprint ────────────────────────────────────────────────
 *
 * SIGHTING is strict and stays strict. CONTINUITY is caret-invariant. The split
 * exists because Claude Code 2.1.232 rewrites the permission footer as the caret
 * walks:
 *
 *   caret on row 1 or 3:  Esc to cancel · Tab to amend · ctrl+e to explain
 *   caret on row 2:       Esc to cancel · ctrl+e to explain
 *
 * (Live, on all three permission variants — bash/write/edit — captured in
 * `tests/fixtures/tui/a4c/`, index + verdicts in that dir's README.)
 *
 * `Tab to amend` is a REQUIRED token of the permission fingerprint, and it must
 * stay required: it is the thing that keeps Read/WebFetch/MCP prompts — which
 * have nothing to amend and so never print it — in `family: unknown`, where this
 * app answers nothing. Dropping it from the sighting would quietly widen the set
 * of prompts chat is willing to press keys into. So the sighting does not move.
 *
 * What moved is the check BETWEEN the keys of an answer already in flight. Once
 * a dialog has been sighted strictly, the question the re-peek has to answer is
 * narrower: *is this still the same dialog, with the caret one row further on?*
 * That question is answerable from the caret-invariant half alone —
 *
 *   · the question line          (names the tool AND its target)
 *   · every option row, in order (exact text, exact count)
 *   · the variant title          (`Bash command` / `Create file` / `Edit file`)
 *   · the section rule above the dialog body
 *
 * — and the footer is EXCLUDED, because the evidence proves the footer is a
 * function of the caret. Every abort the safety wave verified survives: an
 * option list that gained, lost or reworded a row still fails continuity, so a
 * `3. No` that became `2. Yes, and always allow` still stops the sequence with
 * the keys sent so far recorded. What it stops doing is aborting on a footer
 * that CC redrew by itself.
 *
 * Continuity is never a way IN. It is only ever offered a prior sighting that
 * passed the strict test, by the one caller that holds one (`dialog-answer.ts`);
 * every ambient read — the poll, the composer's pre-send gate, the Attention
 * card — calls `readLens` with no anchor and gets the strict reading.
 */

/** The caret-INVARIANT half of a strict sighting: what must still hold while an
 *  answer sequence walks the caret down the dialog. */
export interface DialogContinuity {
  family: Exclude<DialogSighting['family'], 'unknown'>
  variant?: DialogSighting['variant']
  question: string
  options: readonly string[]
}

/**
 * The continuity anchor of a sighting, or `null` when there is nothing strict to
 * anchor to.
 *
 * `unknown` yields null on purpose — an unfixtured modal has not passed the
 * strict test, so it has nothing to extend — and so does a sighting whose
 * question scrolled out of the window: no question, no anchor, no relaxation.
 */
export function continuityOf(s: DialogSighting): DialogContinuity | null {
  if (s.family === 'unknown' || !s.question) return null
  return {
    family: s.family,
    variant: s.variant,
    question: s.question,
    options: s.options,
  }
}

/**
 * A FULL-SCREEN PANEL with no numbered rows — `/status`, `/cost`, `/config`.
 *
 * It is not a `DialogSighting`: there is nothing to answer and nothing for the
 * registry to map. It is still the most important thing on the screen, because
 * it EATS THE NEXT ENTER. Live on 2.1.233 (`tests/fixtures/tui/cc233-modal/`):
 * `/status` sent from chat drew the Status panel, the composer went off screen,
 * and the only `❯` left in the capture was the ECHO of `/status` up in the
 * scrollback — which the draft reader then reported as an unsent draft. The
 * composer refused every later message with "the terminal has an unsent draft
 * `/status`", about a terminal that had no draft at all, and the channel stayed
 * wedged until somebody pressed Esc in the pty (daily-driver QA #1).
 *
 * So the lens reports the panel, the draft read stands down (a scrollback echo
 * is not a draft), and the composer's refusal names the surface that can
 * actually dismiss it.
 */
export interface ModalSighting {
  /** The panel's own dismissal footer, verbatim — `Esc to cancel`. It is the
   *  evidence, and it is what makes this a sighting rather than a guess. */
  hint: string
}

export interface PeekLens {
  /** `╭─── Claude Code v2.1.231 ───╮` → `2.1.231`. Null when the banner has
   *  scrolled off the window — which is why `use-peek-lens.ts` reads it ONCE
   *  with a deep capture and caches it per session. */
  bannerVersion: string | null
  /** Non-empty text sitting at the TUI's `❯` composer, else null. */
  composerDraft: string | null
  /**
   * Could this reading tell a TYPED draft from Claude Code's own prediction?
   *
   * 2.1.232 pre-fills the composer with a model-predicted next prompt drawn in
   * DIM (SGR 2) — live capture `a4c/composer-ghost-ansi.txt`. In plain text the
   * ghost is byte-identical to a half-written sentence, so a plain capture can
   * only report "there is something there" and say it is unsure. With the SGR
   * channel (`?ansi=1`) the dim runs are stripped and what is left is what a
   * human actually typed — `true` then means the draft is real.
   *
   * FEATURE-DETECTED BY RESPONSE SHAPE, not by a version or a flag: a capture
   * that carries no escape at all is a server that answered `?ansi=1` in plain
   * (the deployed one does), and the honest reading of it is `false`. T3 turns
   * an unverified draft into a WARNING instead of a refusal, because refusing
   * every send on a ghost that is always there is not a safety property, it is
   * an outage.
   */
  composerDraftVerified: boolean
  dialog: DialogSighting | null
  /** A full-screen panel is covering the composer (see `ModalSighting`). Never
   *  set at the same time as `dialog`: a dialog is the more specific reading of
   *  the same fact, and one screen may only be one thing. */
  modal: ModalSighting | null
  /**
   * Claude Code is NOT WRITING A TRANSCRIPT for this session.
   *
   * The worst failure mode in the whole state set, and the one nothing
   * detected: with transcript saving off (or an inherited
   * `CLAUDE_CODE_CHILD_SESSION` marker, which is what a supermux daemon
   * launched from inside a Claude session hands every session it spawns), the
   * transcript plane produces ZERO entries. The chat renderer then shows an
   * empty conversation for a session that is actively talking, with a green
   * dot and no explanation — verified live on the rig's own `v-claude`, which
   * had just answered an AskUserQuestion and run `/compact` while
   * `GET /chat/history` returned `{"entries":[]}`.
   *
   * The only signal is a footer warning line above the mode line, so that is
   * what this reads. Not a status and not a dialog: a CONDITION of the
   * session, which is why it sits on the lens beside the banner version.
   */
  transcriptOff: boolean
  /**
   * The session cannot do the next turn, or is close to not being able to (see
   * `PtyNotice`).
   *
   * ORTHOGONAL to `dialog`, unlike `modal`: a screen may be both, and the two
   * say different things. A trust dialog is a question AND a wedge; a limit
   * banner is a wedge and no question at all. Nothing here is ever a reason to
   * press a key — it is a reason to stop drawing the session as healthy.
   */
  notice: PtyNotice | null
  /**
   * Keys this screen has ARMED (see `ArmedKey`). Empty on an ordinary screen.
   *
   * Read on EVERY capture, dialog or not, because the two consumers that send
   * keys — the composer's Stop and the dialog sequencer — can both fire on a
   * screen no fingerprint claims. `registry/armed.ts` turns this into a refusal.
   */
  armed: readonly ArmedKey[]
}

/** U+276F — the glyph a0 proved is NEVER a fingerprint on its own: the composer
 *  caret, an echoed user prompt in scrollback, resume-picker rows and the trust
 *  dialog all use it (live-confirmed collisions, a0 §3). */
const CARET = '❯'
/** The composer's own separator is a NON-BREAKING space; an echoed prompt in
 *  scrollback uses an ordinary one. Verified on three captures (this repo's
 *  `composer-draft.txt`, plus live `/peek` of two running sessions). Used as a
 *  preference, never as a requirement — see `readComposerDraft`. */
const NBSP = ' '

/** `   2. Yes, and always allow…` / ` ❯ 1. Yes` — the only line shape that may
 *  be read as a dialog option: space-prefixed, optionally carrying the caret,
 *  then `<digit>.` and a label (a0 §3: the caret is space-prefixed AND sits on a
 *  numbered row; the glyph alone is not enough). */
const OPTION_RE = /^(\s*)(❯\s*)?(\d+)\.\s+(\S.*)$/

/** ANSI (and any other CSI noise) is stripped BEFORE matching: every fingerprint
 *  below is token-based. Colour is a matcher nowhere in v1 — a0 recorded the
 *  periwinkle RGB(177,185,249) permission rule vs the plan dialog's teal
 *  RGB(72,150,140) as the future tie-breaker, and it was never needed once
 *  option-1 text proved sufficient to separate the two families. */

/** Whitespace-normalised, NBSP included (JS `\s` covers U+00A0). */
function norm(s: string): string {
  return s.replace(/\s+/g, ' ').trim()
}

interface OptionRow {
  /** 0-based position among the options, in TUI order. */
  index: number
  line: number
  /** Column the label starts at — where a wrapped continuation lines up. */
  labelCol: number
  caret: boolean
  /** The row as every family before `question` has always read it: the label
   *  with its continuation lines folded in. Unchanged, on purpose — the
   *  permission and plan `rowPattern`s are written against this string. */
  text: string
  /** The label LINE only, nothing folded. */
  label: string
  /** The indented lines under the label, in order. */
  folds: string[]
  /** Did the label line reach the wrap column? (see `WRAP_COL`.) */
  wrapped: boolean
}

/**
 * The column Claude Code wraps an option label at (a0 §3, "wrap hazard").
 *
 * Used as a DISCRIMINATOR and only here: a label line that stopped well short of
 * it did not wrap, so an indented line under it is the option's DESCRIPTION, not
 * the rest of its sentence. That is the whole fix for finding 8 — chips that read
 * `Apple A crisp and refreshing fruit` — and it is deliberately consulted by the
 * `question` family alone, because the permission/plan families' `rowPattern`s
 * were captured against the folded string and folding a `(shift+tab)` sub-hint
 * into option 2 is behaviour those entries already document.
 */
const WRAP_COL = 52

/** Collect the numbered rows, folding wrapped continuations back in. */
function readOptions(lines: readonly string[]): OptionRow[] {
  const rows: OptionRow[] = []
  for (let i = 0; i < lines.length; i++) {
    const m = OPTION_RE.exec(lines[i])
    if (!m) continue
    const n = Number.parseInt(m[3], 10)
    // Options run 1..N in order; anything else (a numbered list in prose, a
    // diff body's line numbers) is not an option block.
    if (n !== rows.length + 1) {
      if (n === 1) rows.length = 0
      else continue
    }
    const label = norm(m[4])
    rows.push({
      index: n - 1,
      line: i,
      labelCol: m[0].length - m[4].length,
      caret: Boolean(m[2]),
      text: label,
      label,
      folds: [],
      wrapped: lines[i].trimEnd().length >= WRAP_COL,
    })
  }
  // Continuations: a non-blank, non-option line indented to (about) the label
  // column, before the next option. The footer sits at indent 1, so it stops
  // the fold on its own.
  for (let r = 0; r < rows.length; r++) {
    const stop = r + 1 < rows.length ? rows[r + 1].line : lines.length
    const minIndent = Math.max(2, rows[r].labelCol - 2)
    for (let i = rows[r].line + 1; i < stop; i++) {
      const raw = lines[i]
      if (!raw.trim()) break
      if (OPTION_RE.test(raw)) break
      if (raw.length - raw.trimStart().length < minIndent) break
      rows[r].folds.push(norm(raw))
      rows[r].text = `${rows[r].text} ${norm(raw)}`
    }
  }
  return rows
}

/** The rule Claude Code draws UNDER an AskUserQuestion's own options, separating
 *  them from the out-of-box affordance (`5. Chat about this`) below it.
 *
 *  That row is numbered in sequence, so the ordinary scan absorbs it as a fifth
 *  option (finding 8) — and it is not one: it takes the conversation somewhere
 *  else instead of answering. Cutting the list at the rule is what keeps the
 *  card's rows and the tool's `options[]` the same list. */
function stopAtRule(rows: readonly OptionRow[], lines: readonly string[]): OptionRow[] {
  const cut = rows.findIndex((r, i) => {
    if (i === 0) return false
    const prev = rows[i - 1]
    for (let j = prev.line + 1; j < r.line; j++) {
      if (SECTION_RULE_RE.test(lines[j])) return true
    }
    return false
  })
  return cut > 0 ? rows.slice(0, cut) : rows.slice()
}

/** Which of the two act-on families this is, if either. Order matters: the two
 *  questions differ by two words (`Would you like` vs `Do you want`), so the
 *  discriminator is option-1 TEXT — a0 §3, stated as a caution.
 *
 *  `block` is the dialog's OWN region, never the whole capture: the capture is
 *  scrollback + viewport (`native/vt.rs`), and matching the fingerprint tokens
 *  across all of it let assistant prose that quotes a footer — or a dialog that
 *  was answered ten minutes ago — classify as a live dialog and lock the
 *  composer (A4 review). */
function readFamily(
  block: string,
  options: readonly OptionRow[],
): 'permission' | 'plan' | null {
  if (options.length < 2) return null
  const first = options[0].text
  const all = options.map((o) => o.text).join(' · ')
  const whole = block
  // Plan approval (ExitPlanMode), pinned v2.1.231. Three real labels — NOT the
  // master plan's "auto-accept / manual / keep planning" phrasing (a0 §3).
  if (
    whole.includes('Would you like to proceed?') &&
    first.startsWith('Yes, and use auto mode') &&
    all.includes('Tell Claude what to change')
  ) {
    return 'plan'
  }
  // Permission: a `Do you want …?` line + option 1 EXACTLY `Yes` + the footer.
  if (
    /Do you want[^?]{0,200}\?/.test(whole) &&
    first === 'Yes' &&
    whole.includes('Esc to cancel') &&
    whole.includes('Tab to amend')
  ) {
    return 'permission'
  }
  return null
}

/* ── the question family (AskUserQuestion) ───────────────────────────────────
 *
 * The state the owner asked about first, and the one with the widest blast
 * radius: the transcript is EMPTY while the dialog is up — Claude Code writes
 * the `tool_use` line only AFTER the answer — so a transcript-only renderer
 * cannot see it at all, and the pty is the entire evidence base. Before this,
 * `readLens()` returned `family:'unknown'` for it, `entryForSighting()` returned
 * null, and the card was headed ``Run `AskUserQuestion` ?`` with five disabled
 * chips whose labels were half description text (verify matrix finding 4 + 8,
 * screenshot 03-chat-askq.png).
 *
 * The fingerprint is the dialog's own furniture, all four tokens required
 * (live capture, CC 2.1.233, `tests/fixtures/tui/askq/ask-user-question.txt`):
 *
 *   ` ☐ Fruit choice `            the reverse-video header chip (U+2610)
 *   `Which fruit do you want?`   the bold question line under it
 *   `❯ 1. Apple` + description   numbered rows with dim descriptions
 *   `Enter to select · ↑/↓ to navigate · Esc to cancel`
 *
 * `Enter to select` alone is NOT enough — Claude Code's own pickers (`/model`,
 * the resume list) print it too, and those are `modal`, not answerable. The
 * header chip is what separates them, because only AskUserQuestion draws one.
 */
const HEADER_CHIP_RE = /^\s*☐\s+(\S.*?)\s*$/
/** The question dialog's key legend, as one token pair. Both halves required. */
const QUESTION_FOOTER = 'Enter to select'
const QUESTION_NAV = 'to navigate'

/** The header chip's own line index, or −1. Searched only ABOVE the first
 *  option and inside the dialog's own block, so a ballot box in assistant prose
 *  cannot invent a question. */
function headerChipLine(lines: readonly string[], from: number, optionLine: number): number {
  for (let i = optionLine - 1; i >= from; i--) {
    if (HEADER_CHIP_RE.test(lines[i])) return i
  }
  return -1
}

/**
 * The question's own sentence — the line the user is actually being asked.
 *
 * Between the header chip and the first option, the last non-blank, non-rule
 * line. `undefined` when the chip has scrolled out of the window, which is a
 * refusal rather than a guess: without the chip there is nothing to prove the
 * line above the options belongs to this dialog rather than to the reply above
 * it.
 */
function readHeadline(
  lines: readonly string[],
  chipLine: number,
  optionLine: number,
): string | undefined {
  let last: string | undefined
  for (let i = chipLine + 1; i < optionLine; i++) {
    const t = norm(lines[i])
    if (!t || SECTION_RULE_RE.test(lines[i]) || RULE_ONLY_RE.test(lines[i])) continue
    last = t
  }
  return last
}

/* ── the startup wedges ──────────────────────────────────────────────────────
 *
 * Everything here happens BEFORE the session's first turn, which has two
 * consequences that make the pty the only witness: no transcript file exists
 * yet, and no boot banner has been printed yet either (the trust dialog renders
 * ABOVE the welcome box — see the capture). The second one is why
 * `registry/claude.ts` gives these entries a pin exemption: requiring a version
 * that structurally cannot be on screen would make the card permanently
 * unanswerable, which is the wedge, not a fix for it.
 */
/** `Accessing workspace:` — the trust gate, on first run in an untrusted
 *  directory and (2.1.232+) on entering a nested repo mid-session. */
const TRUST_TITLE = 'Accessing workspace:'
/** The custom-API-key gate, whose focus DEFAULTS TO `No (recommended)` — a
 *  wrapper that just presses Enter here silently declines the key. */
const APIKEY_TITLE = 'Detected a custom API key in your environment'

/** Which startup gate is on screen, if any. Title + a matching option-1 row:
 *  the title alone can appear in prose about the dialog (this repo does it), and
 *  the row is what proves the dialog itself is drawn. */
function readStartupVariant(
  block: string,
  options: readonly OptionRow[],
): Extract<DialogSighting['variant'], 'trust' | 'apikey'> | null {
  const first = options[0]?.label ?? ''
  if (block.includes(TRUST_TITLE) && /^yes, i trust this folder\b/i.test(first)) return 'trust'
  if (block.includes(APIKEY_TITLE) && /^yes\b/i.test(first)) return 'apikey'
  return null
}

/* ── the paused consent modals ───────────────────────────────────────────────
 *
 * Two dialogs, one title, and the single worst-behaved state in the catalog:
 * Claude Code PAUSES the turn and waits. No `Stop` hook fires (the turn has not
 * ended), no transcript line is written for the dialog itself, and the composer
 * is gone — so the turn machine holds `Active` until `TURN_SAFETY` lapses and
 * then hands the session a green `Idle` dot, forever, over a screen that is
 * asking a billing question (catalog `limit.overage_consent_dialog`,
 * `err.refusal_fallback_dialog`: "the session sits paused while supermux shows
 * Idle").
 *
 * The TITLE is the family and the BODY is the variant. That split matters: CC
 * ships two dialogs under one title today and the result enums differ
 * (`['consent','switch_default','cancelled']` vs
 * `['retry_fallback','edit_prompt','cancelled']`), so a third one shipping
 * tomorrow must still be reported as paused rather than silently mis-read as
 * one of these two. Hence an unrecognised body keeps the family and drops the
 * variant, which the registry answers with nothing.
 */
const PAUSED_TITLE = 'Session paused'
/** The overage dialog's own subject: usage credits, or another model. */
const PAUSED_OVERAGE_RE = /\busage credits?\b/i
/** The refusal dialog's, verbatim from the catalog's copy. */
const PAUSED_REFUSAL_RE = /\bsafeguards flagged this message\b/i

/** Which paused modal this is, if the body says. Requires the title AND a row:
 *  the sentence "Session paused" appears in this repo's own prose, and the rows
 *  are what prove a dialog is drawn. */
function readPausedVariant(
  block: string,
  options: readonly OptionRow[],
): Extract<DialogSighting['variant'], 'overage-consent' | 'refusal-fallback'> | null {
  if (!block.includes(PAUSED_TITLE) || options.length < 2) return null
  // Refusal first: its body names a MODEL switch too, so "usage credits" is not
  // a discriminator against it — "safeguards flagged" is, and only it.
  if (PAUSED_REFUSAL_RE.test(block)) return 'refusal-fallback'
  if (PAUSED_OVERAGE_RE.test(block)) return 'overage-consent'
  return null
}

/** The permission families' question line. Bounded so a `?` far down the
 *  scrollback cannot be dragged into one. */
const PERMISSION_QUESTION_RE = /Do you want[^?]{0,200}\?/g
/** The same token, per LINE — where the body stops (`readBody`). Unflagged: a
 *  `g` regex carries `lastIndex` between calls and would skip every other hit. */
const PERMISSION_QUESTION_LINE_RE = /Do you want[^?]{0,200}\?/
/** The plan dialog's, which is fixed prose rather than a per-target sentence. */
const PLAN_QUESTION = 'Would you like to proceed?'
/** The rule CC draws above a dialog's body. Part of the continuity check: the
 *  dialog is a BOX, and a box that lost its rule is not the same screen. */
const SECTION_RULE_RE = /─{8,}/

/** The dialog's own question, for the sighting to carry. The LAST match wins:
 *  the block reaches back over the prompt that provoked the dialog, and the
 *  question the user is being asked is the one nearest its options. */
function readQuestion(block: string, family: DialogSighting['family']): string | undefined {
  if (family === 'plan') return block.includes(PLAN_QUESTION) ? PLAN_QUESTION : undefined
  // The two startup gates' questions are the titles themselves — fixed prose
  // rather than a per-target sentence, exactly like the plan dialog's.
  if (family === 'startup') {
    if (block.includes(TRUST_TITLE)) return TRUST_TITLE
    if (block.includes(APIKEY_TITLE)) return APIKEY_TITLE
    return undefined
  }
  // The paused modals' question is their title — the dialog's own two words,
  // which is also the sentence the roster and the card lead with.
  if (family === 'paused') return block.includes(PAUSED_TITLE) ? PAUSED_TITLE : undefined
  // `question` carries its own headline (`readHeadline`), set by the caller.
  if (family !== 'permission') return undefined
  let last: string | undefined
  for (const m of block.matchAll(PERMISSION_QUESTION_RE)) last = m[0]
  return last
}

/**
 * Is this the SAME dialog as the one already being answered, footer aside?
 *
 * Every token here is caret-invariant (see the two-phase note at the top), and
 * every one of them is required. Exact row text and exact row COUNT are what
 * keep the verified aborts: a list that gained a row, lost one, or reworded one
 * fails here and the sequence stops with the keys already sent recorded.
 */
function continues(
  block: string,
  rows: readonly OptionRow[],
  lines: readonly string[],
  prior: DialogContinuity,
): boolean {
  // The `question` family cuts its option list at the rule above the out-of-box
  // row, so the anchor must be compared against the SAME list the sighting
  // published — otherwise every continuity read of a question dialog fails on a
  // row count this reader deliberately does not carry.
  const kept = prior.family === 'question' ? stopAtRule(rows, lines) : rows.slice()
  if (kept.length !== prior.options.length) return false
  const shown = prior.family === 'question' ? kept.map((r) => r.label) : kept.map((r) => r.text)
  if (!shown.every((t, i) => t === prior.options[i])) return false
  // A `question` dialog's box has no `─` rule above its options — the one it
  // draws sits BELOW them, between the options and the out-of-box row — so the
  // rule is required for the families whose box has one and only those.
  if (prior.family !== 'question' && prior.family !== 'startup' && !SECTION_RULE_RE.test(block)) {
    return false
  }
  if (!block.includes(prior.question)) return false
  // The title is caret-invariant too, and it is what decides WHICH option 2 the
  // registry believes in — so a frame whose title stopped saying `Create file`
  // is not this dialog, whatever else still matches.
  return variantFor(prior.family, block, kept) === prior.variant
}

/** The caret-invariant variant token, per family. */
function variantFor(
  family: DialogSighting['family'],
  block: string,
  rows: readonly OptionRow[],
): DialogSighting['variant'] {
  if (family === 'permission') return readVariant(block)
  if (family === 'startup') return readStartupVariant(block, rows) ?? undefined
  if (family === 'paused') return readPausedVariant(block, rows) ?? undefined
  return undefined
}

/**
 * The dialog's own body, VERBATIM (daily-driver QA #11).
 *
 * Bounded at BOTH ends by things the dialog drew itself, because the capture is
 * scrollback plus viewport and everything above the dialog is somebody else's
 * text:
 *
 *   top     the section rule CC draws above a dialog box, or — on a capture with
 *           no rule (this repo's A1 fixtures) — the variant title. NEITHER of
 *           them present means the body is not identifiable, and then there is
 *           none: showing 24 lines of scrollback under `Run …?` would be worse
 *           than showing nothing.
 *   bottom  the question line, which is drawn by the card already.
 *
 * PERMISSION ONLY. A plan dialog's body is a whole written plan between dashed
 * rules — the card links it instead (`planPath`), and an `unknown` modal has no
 * verified shape at all, so nothing above its rows is known to belong to it.
 *
 * What is dropped is furniture and nothing else: the variant title (the card's
 * `why` line already names the tool), CC's dashed rules, the blank edges, and
 * the common indent. Every remaining glyph is the pty's.
 */
const VARIANT_TITLES = [
  'Bash command',
  'Edit file',
  'Create file',
  // The startup gates' own titles. Same rule, same reason: the card's question
  // line already says them, so repeating them inside the body would print the
  // sentence twice.
  TRUST_TITLE,
  APIKEY_TITLE,
  // Same rule for the paused modals: the card's heading is `Session paused`, so
  // repeating it inside the body would print it twice.
  PAUSED_TITLE,
]
/** A line that is only box-drawing — CC's own framing, at terminal width. */
const RULE_ONLY_RE = /^[\s─━╌┄┈╍-]+$/
/** AskUserQuestion's free-text hatch row (`4. Type something.`). */
const FREE_TEXT_ROW_RE = /^type something\.?$/i

function readBody(
  lines: readonly string[],
  from: number,
  optionLine: number,
  family: DialogSighting['family'],
): string[] | undefined {
  // `paused` joins the two families whose body is prose the user must read
  // before answering: it carries the reason the turn stopped (which model, which
  // credits, which safeguard) and nothing else on any surface says it.
  if (family !== 'permission' && family !== 'startup' && family !== 'paused') return undefined
  let start = -1
  for (let i = optionLine - 1; i >= from; i--) {
    if (SECTION_RULE_RE.test(lines[i])) {
      start = i + 1
      break
    }
  }
  if (start < 0) {
    for (let i = optionLine - 1; i >= from; i--) {
      if (VARIANT_TITLES.includes(lines[i].trim())) {
        start = i
        break
      }
    }
  }
  if (start < 0) return undefined

  let end = optionLine
  for (let i = optionLine - 1; i >= start; i--) {
    if (PERMISSION_QUESTION_LINE_RE.test(lines[i])) {
      end = i
      break
    }
  }

  const kept = lines
    .slice(start, end)
    .filter((l) => !VARIANT_TITLES.includes(l.trim()) && !RULE_ONLY_RE.test(l))
  while (kept.length && !kept[0].trim()) kept.shift()
  while (kept.length && !kept[kept.length - 1].trim()) kept.pop()
  if (!kept.length) return undefined
  // The common indent is the terminal's left margin, not the author's — but the
  // RELATIVE indent is the diff's, so only the shared part goes.
  const indent = Math.min(
    ...kept.filter((l) => l.trim()).map((l) => l.length - l.trimStart().length),
  )
  return kept.map((l) => l.slice(indent).trimEnd())
}

/** Bash vs Edit/Write. Title beats footer: `ctrl+e to explain` is bash-only
 *  (a0 §3), but a title is what the human sees. Scoped to the dialog's own
 *  region so a stray "Edit file" in scrollback cannot rename the sighting. */
function readVariant(block: string): DialogSighting['variant'] {
  if (block.includes('Edit file')) return 'edit'
  if (block.includes('Create file')) return 'write'
  if (block.includes('Bash command') || block.includes('ctrl+e to explain')) return 'bash'
  return undefined
}

/** How far above the first option the dialog's own body reaches (title, command,
 *  description, diff/file body between the dashed rules). 24 lines covers every
 *  a0 capture with room to spare; beyond it we are in scrollback. */
const BLOCK_LOOKBACK = 24

/**
 * How far above the bottom of the capture a dialog's last option may sit.
 *
 * `/peek` returns HISTORY followed by the viewport (`native/vt.rs:307`) — that
 * is what makes the deep banner read work — so an option block up in the
 * scrollback is a dialog that was answered, not one that is waiting. Without
 * this, a session that had answered a permission an hour ago read as blocked
 * forever: every send refused, with no override and no way for the user to say
 * the app was wrong (A4 review). A live dialog's own tail is short — the footer
 * plus a blank line or two on every a0 capture — so 10 rows is slack, not hope.
 */
const DIALOG_TAIL_SLACK = 10

/**
 * Is this numbered block a MODAL — something that will eat the next Enter —
 * even though no fingerprint claims it?
 *
 * The caret is the tell a0 verified: the dialog caret is space-prefixed AND on a
 * numbered row, which ordinary prose lists never are. `Esc to …` is the second
 * reading, for a caret drawn in colour rather than in glyphs.
 */
function looksModal(block: string, rows: readonly OptionRow[]): boolean {
  return rows.some((r) => r.caret) || /\bEsc to (cancel|interrupt|exit|go back)\b/i.test(block)
}

function readDialog(
  lines: readonly string[],
  continuing: DialogContinuity | null,
): DialogSighting | null {
  const rows = readOptions(lines)
  if (rows.length < 2) return null
  // LIVE SCREEN ONLY — see `DIALOG_TAIL_SLACK`.
  const tail = lastContentLine(lines)
  if (tail < 0 || rows[rows.length - 1].line < tail - DIALOG_TAIL_SLACK) return null

  const from = Math.max(0, rows[0].line - BLOCK_LOOKBACK)
  // Down to the bottom of the screen: the guard above has already established
  // that the options are AT the bottom, and everything between them and the last
  // printed row is the dialog's own footer — which is where the fingerprint
  // tokens (`Esc to cancel`, `Tab to amend`) and the plan's path live.
  const to = Math.min(lines.length, Math.max(rows[rows.length - 1].line + 4, tail + 1))
  const block = norm(lines.slice(from, to).map(norm).join(' '))

  // A fingerprint decides whether this may be ANSWERED (the registry's job); it
  // does not decide whether something is THERE. Anything modal-shaped that no
  // fingerprint claims is reported as `unknown` — refused by the composer,
  // unanswerable by the registry, visible in the Attention card.
  //
  // PHASE 2 sits between the two: only when the caller is already answering a
  // strictly-sighted dialog, and only for that dialog. With no anchor this line
  // is not reachable, which is why an ambient read can never be relaxed.
  const chip = headerChipLine(lines, from, rows[0].line)
  const isQuestion =
    chip >= 0 && block.includes(QUESTION_FOOTER) && block.includes(QUESTION_NAV)
  const startup = readStartupVariant(block, rows)
  // The TITLE is the family — a `Session paused` screen with rows is one of
  // these whether or not its body is a shape this app knows (see
  // `readPausedVariant`).
  const paused = block.includes(PAUSED_TITLE)

  const family: DialogSighting['family'] | null =
    readFamily(block, rows) ??
    (isQuestion ? 'question' : null) ??
    (startup ? 'startup' : null) ??
    (paused ? 'paused' : null) ??
    (continuing && continues(block, rows, lines, continuing) ? continuing.family : null) ??
    (looksModal(block, rows) ? 'unknown' : null)
  if (!family) return null

  // The `question` family reads its rows differently — the out-of-box row below
  // the rule is not an option, and an indented line under a short label is a
  // description rather than a wrap. Every other family keeps the reading it was
  // captured with, byte for byte.
  const kept = family === 'question' ? stopAtRule(rows, lines) : rows
  const caret = kept.find((r) => r.caret)
  const sighting: DialogSighting = {
    family,
    options: kept.map((r) => (family === 'question' ? r.label : r.text)),
    caretIndex: caret ? caret.index : null,
  }
  if (family !== 'unknown') {
    const question = readQuestion(block, family)
    if (question) sighting.question = question
  }
  if (family === 'question') {
    const header = HEADER_CHIP_RE.exec(lines[chip])
    if (header) sighting.header = header[1]
    const headline = readHeadline(lines, chip, kept[0].line)
    if (headline) sighting.question = headline
    // A description only where the label line proves it did not wrap.
    sighting.descriptions = kept.map((r) =>
      !r.wrapped && r.folds.length ? r.folds.join(' ') : undefined,
    )
    const free = kept.findIndex((r) => FREE_TEXT_ROW_RE.test(r.label))
    if (free >= 0) sighting.freeTextIndex = free
  } else if (family === 'startup') {
    if (startup) sighting.variant = startup
    // The gate's own copy is what the user is being asked to trust — the path,
    // the rule count, the masked key suffix — so it goes on the card verbatim,
    // the same way a permission dialog's command does.
    const body = readBody(lines, from, kept[0].line, family)
    if (body) sighting.body = body
  } else if (family === 'paused') {
    const variant = readPausedVariant(block, kept)
    if (variant) sighting.variant = variant
    // The reason the turn stopped, verbatim. It is the ONLY place the user is
    // told what they would be consenting to — the title is two words and the
    // rows are two verbs.
    const body = readBody(lines, from, kept[0].line, family)
    if (body) sighting.body = body
  } else if (family === 'permission') {
    const variant = readVariant(block)
    if (variant) sighting.variant = variant
    // What the user is actually agreeing to (QA #11).
    const body = readBody(lines, from, rows[0].line, family)
    if (body) sighting.body = body
  } else if (family === 'plan') {
    // The footer's plan path, when it is on screen. `[^\s]` and not `.` so a
    // footer that shares its line with `ctrl+g to edit in …` cannot swallow it.
    const m = /~\/\.claude\/plans\/[^\s]*\.md/.exec(block)
    if (m) sighting.planPath = m[0]
  }
  return sighting
}

/* ── the notice reader (the blocked/wedged session) ──────────────────────────
 *
 * WHY THIS IS NOT A DIALOG, and why it still had to be read here.
 *
 * A usage-limit banner blocks nothing on the screen: it is drawn as a
 * tool-result continuation row (`⎿ You've hit your weekly limit · resets …`),
 * the turn simply ends, the composer comes back, and Claude Code prints its
 * ordinary `✻ Baked for 0s` completion marker underneath. So every signal this
 * product had said the session was fine — `IDLE_BANK` matched the completion
 * marker, the tile went green, the composer stayed enabled — while the account
 * could not do another turn for five hours (verify matrix finding 1, captures
 * `limit-weekly.txt` / `limit-used-pct.txt`).
 *
 * The wire plane learns this from the transcript's `isApiErrorMessage`. That
 * plane is blind for exactly the sessions that need it most: a session whose
 * transcript is off, and a session that never reached a first turn at all
 * (every startup wedge). The pty is the only witness both cases share, so the
 * reading lives here and both planes publish the same fact.
 *
 * Tail-anchored, like every other live reading in this module: `/peek` returns
 * scrollback + viewport, and a banner from a bucket that has since reset is
 * history, not a condition.
 */

/** How far above the last printed row a notice may sit and still be LIVE. The
 *  banner's own tail on the production capture is 7 rows (subline, completion
 *  marker, the two composer rules, the mode line); 20 is slack. It is also what
 *  keeps this reading equal to the server's, which only ever holds
 *  `status::CAPTURE_LINES` (30) rows at all. */
const NOTICE_TAIL_SLACK = 20

/** HARD BLOCK — the quota wall. `hit` (a bucket ran out) and `reached` (the
 *  model-specific form) are the two verbs the bundle emits; `used`/`Approaching`
 *  are the warning verbs and are deliberately not here.
 *
 *  ANCHORED at the START of the gutter-stripped line and REQUIRING the `limit`
 *  noun the two banner templates always end their phrase on (wave 6 #11). Before
 *  this, `\byou['’]ve (?:hit|reached) your\b.*$` matched any tail — so an
 *  ordinary assistant line ("You've reached your desired deployment state") was
 *  read as a hard block, disabled the composer and raised attention, and an
 *  assistant QUOTING the phrase mid-sentence matched on the `\b` alone. The
 *  start anchor is the gutter tightening (`noticeLine` strips CC's `⎿`/`●`
 *  gutter first, so a banner starts the content and prose does not); the `limit`
 *  requirement is the quota noun (`server/.../agent_error.rs::noun_phrase`
 *  requires the same). */
const LIMIT_BLOCK_RE = /^you['’]ve (?:hit|reached) your\b[^\n]*\blimit\b/i
/** HARD BLOCK — credit exhaustion. The forms the server ALREADY enumerates
 *  (`agent_error.rs::limit_bucket`) that do NOT use the "hit/reached your …
 *  limit" wording and so slip past `LIMIT_BLOCK_RE` entirely (wave 6 #6). In the
 *  exact no-transcript case this plane exists for, a session out of credits
 *  otherwise stayed composable and read Idle. Mirrored from the server list so
 *  both planes block on the same set; `contains`-style like the server, because
 *  these phrases are distinctive and CC prints each on its own banner line. */
const CREDIT_BLOCK_RE =
  /\b(?:out of usage|monthly spend limit|requires usage credits|usage credits are required|usage allocation has been disabled)\b/i
/** WARNING. Three shapes: the captured `You've used N% of your …` footer
 *  (suppressed by CC below 70 % utilisation), and the two `Approaching …` /
 *  `You're close to …` branches recorded from the bundle's own strings. */
const LIMIT_WARN_RE =
  /\b(?:you['’]ve used \d+% of your\b|approaching (?:session|weekly|opus|usage)\b|you['’]re close to your\b).*$/i
/** The gutter CC draws these lines in, plus the leading indent: the tool-result
 *  continuation (`⎿`), the assistant bullet (`●` — the refusal banner is
 *  printed as an assistant line), and the box rules. */
const CONTINUATION_PREFIX = /^[\s⎿·└│●]+/

/** The startup gates that have NO captured option list — reported as a notice
 *  so the session stops reading as a green Idle, never as something to press a
 *  key into. */
const WEDGE_TOKENS: readonly {
  wedge: NonNullable<PtyNotice['wedge']>
  tokens: readonly string[]
}[] = [
  // Claude Code's first-run wizard. A fresh host (or one whose onboarding flags
  // were lost) parks here before any prompt exists.
  { wedge: 'onboarding', tokens: ["Let's get started.", 'Choose the text style'] },
  // Codex's startup gate — and supermux INSTALLS hooks into sessions, so this
  // product is what triggers it.
  { wedge: 'hooks-review', tokens: ['Hooks need review'] },
]

function noticeLine(line: string): string {
  return norm(line.replace(CONTINUATION_PREFIX, ''))
}

/**
 * What is blocking or warning on the live screen, or null.
 *
 * Precedence is by consequence: a hard block outranks a wedge (a wedged session
 * that also hit its limit is blocked twice, and the limit is the one with a
 * clock on it), and both outrank a warning.
 */
function readNotice(
  lines: readonly string[],
  dialog: DialogSighting | null,
): PtyNotice | null {
  const tail = lastContentLine(lines)
  if (tail < 0) return null
  const from = Math.max(0, tail - NOTICE_TAIL_SLACK + 1)

  // A PAUSED MODAL OUTRANKS EVEN A HARD BLOCK, and it is the one precedence
  // inversion in this function. A limit-hit session and a paused one are the
  // same event seen twice — CC pauses the turn *because* the bucket ran out —
  // but only one of the two readings has a human in it: the block says "come
  // back in five hours", the modal says "answer this and keep going, on
  // credits". Reporting the clock over the question would send someone away
  // from a session that was one keypress from continuing. The banner survives
  // as the notice's `detail` (the dialog's own body carries it).
  if (dialog?.family === 'paused') {
    const notice: PtyNotice = {
      kind: 'session-paused',
      text: dialog.question ?? PAUSED_TITLE,
    }
    if (dialog.variant === 'overage-consent' || dialog.variant === 'refusal-fallback') {
      notice.paused = dialog.variant
    }
    const body = dialog.body?.map(norm).filter(Boolean).join(' ')
    if (body) notice.detail = body
    return notice
  }

  for (let i = tail; i >= from; i--) {
    // Strip CC's gutter FIRST (the `⎿`/`●` continuation), then match on the
    // content: the quota wall is anchored at the start of that content, and an
    // assistant line that merely mentions a limit is not (wave 6 #11). Both the
    // `hit/reached your … limit` templates and the credit-exhaustion forms the
    // server enumerates count as a hard block (wave 6 #6).
    const content = noticeLine(lines[i])
    if (!LIMIT_BLOCK_RE.test(content) && !CREDIT_BLOCK_RE.test(content)) continue
    const text = content
    // The remediation subline CC prints under the banner (`/upgrade or
    // /usage-credits …`), when the next row is still the banner's own.
    const next = i + 1 <= tail ? lines[i + 1] : ''
    const detail =
      next.trim() && !OPTION_RE.test(next) && !RULE_ONLY_RE.test(next)
        ? noticeLine(next)
        : undefined
    return detail ? { kind: 'limit-blocked', text, detail } : { kind: 'limit-blocked', text }
  }

  // A wedge the DIALOG reader already claimed reports the same fact from the
  // same screen — the card can answer it, and this is what makes the roster say
  // so without having to understand the registry.
  if (dialog?.family === 'startup' && (dialog.variant === 'trust' || dialog.variant === 'apikey')) {
    return {
      kind: 'startup-wedge',
      wedge: dialog.variant,
      text: dialog.question ?? dialog.options[0] ?? '',
    }
  }
  const block = lines.slice(from, tail + 1).join('\n')
  for (const { wedge, tokens } of WEDGE_TOKENS) {
    const hit = tokens.find((t) => block.includes(t))
    if (hit) return { kind: 'startup-wedge', wedge, text: hit }
  }

  // THE TURN IS DEAD (catalog `err.safeguards_refusal`). `stop_reason:
  // refusal` is written into the transcript as an `isApiErrorMessage` line —
  // dropped by the parser like every other one — and printed on the pty as a
  // sentence that looks like a transient API error and is not: nothing retries,
  // the turn is over, and the recovery is a keystroke chord this app cannot
  // send. So it is read here as its own kind rather than left to the API-error
  // path, which would say "retrying" about a turn that will never resume.
  for (let i = tail; i >= from; i--) {
    if (!REFUSAL_RE.test(lines[i])) continue
    const text = noticeLine(lines[i])
    const detail = lines
      .slice(i + 1, tail + 1)
      .map(noticeLine)
      .find((l) => REFUSAL_RECOVERY_RE.test(l))
    return detail ? { kind: 'turn-refused', text, detail } : { kind: 'turn-refused', text }
  }

  // STILL LIVE (catalog `err.stream_stalled`). The request went out, no bytes
  // came back, and CC has already scheduled the retry — its own line carries
  // the countdown. Reported so the surface can keep the turn on screen instead
  // of drifting to Idle and letting the user walk away from a turn that resumes
  // by itself.
  for (let i = tail; i >= from; i--) {
    const m = STALLED_RE.exec(lines[i])
    if (m) return { kind: 'stream-stalled', text: noticeLine(m[0]) }
  }

  for (let i = tail; i >= from; i--) {
    const m = LIMIT_WARN_RE.exec(lines[i])
    if (m) return { kind: 'limit-warning', text: noticeLine(m[0]) }
  }
  return null
}

/** The refusal banner's opening, anchored on BOTH halves: `API Error:` (so a
 *  reply that merely discusses safeguards is not one) and the safeguards
 *  sentence (so an ordinary 529 is not). The second captured form —
 *  `API Error: {Model} can't help with this. Start a new session to continue.`
 *  — is the other branch of the same builder. */
const REFUSAL_RE =
  /API Error:.*(?:safeguards flagged this message|can['’]t help with this)/i
/** CC's own recovery line, which is the reason this state needs its own card:
 *  `double press esc` is not a thing chat can do, and it must be said rather
 *  than approximated with a button. */
const REFUSAL_RECOVERY_RE = /double press esc|start a new session/i

/** `Waiting for API response · will retry in 3s · check your network` — the
 *  `stalled` retry kind, whose whole point is that it is NOT a completed error.
 *  Anchored on the first clause and taken to end of line so the countdown and
 *  the remediation ride along verbatim. */
const STALLED_RE = /\bWaiting for API response\b.*$/i

/* ── the armed keys (catalog `generic.armed_keys`) ───────────────────────────
 *
 * Read on every capture, because the screens that arm a key are ordinary ones:
 * a half-written prompt with `Esc again to clear` under it, a running turn with
 * `Press Ctrl-C again to exit`. Nothing here is a dialog, nothing here has a
 * fingerprint, and that is exactly why the reading has to be shape-based and
 * cheap.
 *
 * Tail-anchored on a SHORT window: the hint is drawn directly under the
 * composer and it disappears the moment the arming lapses (CC times it out), so
 * a hint 20 rows up in the scrollback is a key that is no longer armed — and
 * refusing forever on history would be its own outage.
 */
const ARMED_TAIL_SLACK = 6

/** `Esc again to clear` — the composer's own two-step clear. */
const ARMED_ESC_RE = /\b(Esc(?:ape)?) again to ([a-z][a-z ]*[a-z])/gi
/** `Press Ctrl-C again to exit`, `Press {key} again to stop background agents`. */
const ARMED_PRESS_RE = /\bPress (\S+) again to ([a-z][a-z ]*[a-z])/gi
/**
 * `Ctrl+Y to paste deleted text` — the catalog's fourth verbatim, and the one
 * that has to be matched as a LITERAL.
 *
 * It is the undo buffer left behind by a clear, so it is a real arming: that
 * key now restores a specific block of text on this specific screen. But its
 * SHAPE — `<ctrl-key> to <verb>` — is the shape of every ordinary Claude Code
 * footer hint (`ctrl+e to explain` sits under every Bash permission dialog,
 * `ctrl+g to edit in …` under the plan dialog). A general pattern here refused
 * Stop on every permission screen in the suite, which is an outage wearing a
 * safety argument. So: this phrase, and nothing that merely rhymes with it.
 */
const ARMED_CTRL_RE = /\b(Ctrl\+Y) to (paste deleted text)/gi

/** Token → the allowlisted key name this app would send for it. Deliberately
 *  small: a token with no mapping is still reported (an armed SCREEN is the
 *  fact, not an armed key name), it simply cannot be matched against a specific
 *  send. */
const ARMED_KEY_NAMES: Readonly<Record<string, KeyName>> = {
  esc: 'Escape',
  escape: 'Escape',
  'ctrl-c': 'C-c',
  'ctrl+c': 'C-c',
  '^c': 'C-c',
  'ctrl-d': 'C-d',
  'ctrl+d': 'C-d',
}

function armedKeyName(token: string): KeyName | null {
  return ARMED_KEY_NAMES[token.toLowerCase()] ?? null
}

function readArmed(lines: readonly string[]): ArmedKey[] {
  const tail = lastContentLine(lines)
  if (tail < 0) return []
  const from = Math.max(0, tail - ARMED_TAIL_SLACK + 1)
  const out: ArmedKey[] = []
  const seen = new Set<string>()
  for (let i = from; i <= tail; i++) {
    const line = norm(lines[i])
    if (!line) continue
    for (const re of [ARMED_ESC_RE, ARMED_PRESS_RE, ARMED_CTRL_RE]) {
      // `g` regexes carry `lastIndex` between calls; reset before every line.
      re.lastIndex = 0
      for (const m of line.matchAll(re)) {
        const token = m[1]
        const action = m[2].trim()
        const id = `${token.toLowerCase()}/${action.toLowerCase()}`
        if (seen.has(id)) continue
        seen.add(id)
        out.push({ token, key: armedKeyName(token), action, text: line })
      }
    }
  }
  return out
}

/** A composer drawn INSIDE a box — `│ ❯ half a thought          │`. Not seen on
 *  2.1.224/231/232 (every live capture has the composer bare at column 0), but
 *  A1's own fixture carries this shape and the failure mode of missing it is the
 *  bad one: the T3 draft guard goes quietly blind and the send concatenates onto
 *  whatever the human was typing. Cheap insurance, deliberately second in line. */
const BOXED_COMPOSER_RE = /^\s*│\s*❯(.*?)\s*│?\s*$/

/** The text sitting in the TUI's composer, or null when it is empty.
 *
 *  A dialog's caret row is not a draft, which is why the caller gates this on
 *  `dialog == null`. Among the column-0 `❯` lines the composer is the last one
 *  (scrollback echoes are above it); the NBSP separator is preferred because it
 *  tells the composer apart from an echoed prompt even mid-scrollback.
 *
 *  Precedence, strongest fingerprint first:
 *    1. the NBSP-separated column-0 `❯` — the live 2.1.2xx composer;
 *    2. a BOXED `│ ❯ … │` — a whole-line shape, and therefore still far more
 *       specific than "a line that starts with ❯";
 *    3. the last bare column-0 `❯` — the degrade path for a CC that drops the
 *       NBSP.
 *  The bare fallback must NOT outrank the box: in a boxed-composer TUI every
 *  echoed prompt in scrollback is a bare column-0 `❯`, so reading the box last
 *  turned the insurance into its own bug — an empty box behind an echo reported
 *  a phantom draft (T3 then refuses every send), and a full box reported the
 *  ECHO's text instead of the draft.
 *
 *  A multi-line draft reads as its FIRST line. The guard's job is to say "the
 *  terminal has something unsent" and show enough of it to be recognised — T3
 *  truncates to 60 chars anyway — not to reproduce it. */
function composerLineIndex(lines: readonly string[]): number {
  let fallback = -1
  let preferred = -1
  let boxed = -1
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    if (line.startsWith(CARET)) {
      fallback = i
      if (line[1] === NBSP) preferred = i
      continue
    }
    if (BOXED_COMPOSER_RE.test(line)) boxed = i
  }
  if (preferred >= 0) return preferred
  if (boxed >= 0) return boxed
  return fallback
}

/**
 * How far above the bottom of the capture the TUI's composer may sit and still
 * be the LIVE one.
 *
 * `/peek` returns scrollback followed by the viewport, so the composer is always
 * within a couple of rows of the last printed line — 2 on every idle and every
 * mid-turn capture in `cc233-modal/`. 14 is slack for a multi-line draft. What
 * it EXCLUDES is the echoed `❯ /status` 20 rows up in the scrollback, which is
 * what a full-screen panel leaves behind as the only caret on screen.
 */
const COMPOSER_TAIL_SLACK = 14

/**
 * The footer every full-screen Claude Code panel prints — `Esc to cancel`
 * (`/status`, `/cost`), `Esc to close` / `Esc to clear` (`/config`).
 *
 * CAPITAL `Esc`, and that is load-bearing: the status line CC draws WHILE A TURN
 * RUNS says `esc to interrupt` in lower case (`53-running-turn.txt`), and
 * refusing every send during a running turn would be an outage wearing a safety
 * argument. The composer test below is the second half of the discriminator —
 * that line sits UNDER a live composer, a panel replaces it.
 */
const MODAL_FOOTER_RE = /\bEsc to [a-z]+(?: [a-z]+)?/

/**
 * Is a full-screen panel covering the composer?
 *
 * Two facts, both read off the live viewport rather than off the scrollback:
 *   1. the TUI's composer is NOT in the last `COMPOSER_TAIL_SLACK` rows — the
 *      panel has taken the screen (an echoed `❯` up in the history is not a
 *      prompt, which is exactly the misreading this fixes);
 *   2. something down there says how to dismiss itself.
 *
 * Both are required. (1) alone would call a session that has not drawn its
 * composer yet a modal; (2) alone would fire on a permission dialog's own footer
 * — which is `readDialog`'s to report, and it is asked first.
 */
function readModal(lines: readonly string[]): ModalSighting | null {
  const tail = lastContentLine(lines)
  if (tail < 0) return null
  const from = Math.max(0, tail - COMPOSER_TAIL_SLACK + 1)
  const composer = composerLineIndex(lines)
  if (composer >= from) return null
  for (let i = tail; i >= from; i--) {
    const m = MODAL_FOOTER_RE.exec(lines[i])
    if (m) return { hint: m[0] }
  }
  return null
}

/** The draft text on one composer line, by whichever of the two shapes it is. */
function draftOn(line: string): string {
  if (line.startsWith(CARET)) return norm(line.slice(CARET.length))
  const m = BOXED_COMPOSER_RE.exec(line)
  return m ? norm(m[1]) : ''
}

/** The line with its DIM runs dropped — what a human actually typed, on a
 *  capture that carries SGR. Everything CC drew for itself in dim (the 2.1.232
 *  predicted prompt) goes; a typed draft has no SGR 2 on it and survives whole
 *  (`tests/fixtures/tui/composer-draft-ansi.txt`). */
function undimmed(rawLine: string): string {
  return parseAnsiLine(rawLine)
    .filter((s) => !s.dim)
    .map((s) => s.text)
    .join('')
}

interface DraftRead {
  text: string | null
  verified: boolean
}

function readComposerDraft(
  plainLines: readonly string[],
  rawLines: readonly string[],
  ansi: boolean,
): DraftRead {
  const i = composerLineIndex(plainLines)
  // Plain channel: report what is there and say the reading is unverified. The
  // alternative — silently treating every draft as a ghost — would drop the
  // guard entirely on the servers that need it most.
  const draft = i < 0 ? '' : draftOn(ansi ? undimmed(rawLines[i] ?? '') : plainLines[i])
  // NO DRAFT IS ALWAYS VERIFIED. `verified` qualifies the text, and there is
  // nothing uncertain about an empty prompt — a plain capture of a genuinely
  // empty composer would otherwise report "unsure" about a fact it is sure of,
  // and `readLens('')` would stop equalling `EMPTY_LENS`.
  return draft.length > 0 ? { text: draft, verified: ansi } : { text: null, verified: true }
}

/** The session's boot binary, from the banner it printed at launch — never
 *  the CLI's own `--version` flag, which reports the DISK binary: the CLI
 *  auto-updates and a RUNNING session keeps the binary it booted with (a0:
 *  `spike-a0-perm` ran 2.1.227 while the disk had 2.1.231). Two banner shapes
 *  exist (a fresh boot draws the `╭─── … ───╮` box, a cleared session the
 *  compact `▐▛███▜▌ Claude Code vX.Y.Z` form), so the anchor is the token, not
 *  the frame. */
const BANNER_VERSION_RE = /Claude Code v(\d+\.\d+\.\d+[^\s│╮─]*)/
/** The banner's own furniture — the box rule or the block-glyph logo. Required
 *  on the SAME line as the version (A4 review): the deep read is 10 000 lines of
 *  scrollback, and in this repo a session that has *discussed* a Claude Code
 *  version is routine. An unanchored match pinned the registry to a number
 *  somebody typed, and `attention.ts`'s honest "could not read the version"
 *  branch became unreachable. */
const BANNER_FURNITURE = /[╭─│▐▛█▜▌]/

function readBannerVersion(lines: readonly string[]): string | null {
  // First match wins: the boot banner is the first thing a session prints, so in
  // a deep capture it is above every later mention of a version.
  for (const line of lines) {
    if (!BANNER_FURNITURE.test(line)) continue
    const m = BANNER_VERSION_RE.exec(line)
    if (m) return m[1]
  }
  return null
}

/**
 * Read one `/peek` capture. Pure, total, cheap: no capture ever throws, and an
 * empty one reads as "nothing on screen" rather than as a failure.
 *
 * `continuing` is the SECOND phase of the fingerprint and the only way to get a
 * relaxed reading: pass the anchor of a dialog that has ALREADY been sighted
 * strictly and this call will also recognise the same dialog with CC's
 * caret-dependent footer redrawn (see the note beside `DialogContinuity`).
 * Omit it — as every ambient reader does — and the reading is strict.
 */
export function readLens(
  capture: string,
  continuing?: DialogContinuity | null,
): PeekLens {
  const raw = capture ? capture.split('\n') : []
  const lines = raw.map(plain)
  const dialog = readDialog(lines, continuing ?? null)
  // A dialog is the more specific reading of "something is covering the prompt",
  // so it is asked first and a screen is never both.
  const modal = dialog ? null : readModal(lines)
  // A dialog's caret row is not a draft — and neither is the scrollback echo a
  // full-screen panel leaves as the only `❯` on screen. Both gate the read for
  // the same reason: what is at the prompt is unknowable while something else
  // owns the screen, and "unknowable" must not be reported as "the user left
  // half a sentence there" (daily-driver QA #1).
  const draft: DraftRead =
    dialog || modal
      ? { text: null, verified: true }
      : readComposerDraft(lines, raw, hasAnsi(capture))
  return {
    bannerVersion: readBannerVersion(lines),
    composerDraft: draft.text,
    composerDraftVerified: draft.verified,
    dialog,
    modal,
    transcriptOff: readTranscriptOff(lines),
    notice: readNotice(lines, dialog),
    armed: readArmed(lines),
  }
}

/** The footer warning CC prints above the mode line when it is not persisting
 *  the conversation. Anchored on the stable half of the sentence: the tail
 *  names whichever cause applied (an inherited marker, an explicit setting) and
 *  is free to change between releases. */
export function readTranscriptOff(lines: readonly string[]): boolean {
  return lines.some((l) => l.includes('Transcript saving is off'))
}

/** The empty reading — what consumers get before the first poll lands, and what
 *  a failed peek must NOT be confused with (T3: a peek outage lets the send
 *  through and leaves the watchdog to be honest about it). */
export const EMPTY_LENS: PeekLens = {
  bannerVersion: null,
  composerDraft: null,
  // Nothing was read, so nothing is in doubt: `true` here only ever means "the
  // absent draft is not a ghost", and no gate consults it with a null draft.
  composerDraftVerified: true,
  dialog: null,
  modal: null,
  // Nothing was read, so nothing is claimed: an absent capture must never be
  // reported as "this session is blind" — that is the honesty rule the whole
  // attention layer is built on.
  transcriptOff: false,
  notice: null,
  // Nothing was read, so nothing is armed. The refusal this drives is about a
  // key the SCREEN redefined; an absent capture redefines nothing, and the
  // send paths have their own fail-open rule for "could not look".
  armed: [],
}

/** Live turn, or a dialog on screen: the caret can move under us, and the whole
 *  point of the fast cadence is that T7's caret-verify is never stale. */
export const FAST_PEEK_MS = 1_000
/** Nothing is happening — the capture is a background fact, not a heartbeat. */
export const SLOW_PEEK_MS = 4_000

/** The poll's cadence, as a rule rather than a scattering of conditions. Pure so
 *  it is checkable without a DOM (`use-peek-lens.ts` owns only the timer). */
export function peekCadenceMs(ctx: { live: boolean; dialog: boolean }): number {
  return ctx.live || ctx.dialog ? FAST_PEEK_MS : SLOW_PEEK_MS
}
