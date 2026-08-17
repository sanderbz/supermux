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
import { hasAnsi, parseAnsiLine } from '../../lib/ansi'

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
  family: 'permission' | 'plan' | 'unknown'
  variant?: 'bash' | 'edit' | 'write'
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
  family: 'permission' | 'plan'
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
function plain(line: string): string {
  return parseAnsiLine(line)
    .map((s) => s.text)
    .join('')
}

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
  text: string
}

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
    rows.push({
      index: n - 1,
      line: i,
      labelCol: m[0].length - m[4].length,
      caret: Boolean(m[2]),
      text: norm(m[4]),
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
      rows[r].text = `${rows[r].text} ${norm(raw)}`
    }
  }
  return rows
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
function readQuestion(block: string, family: 'permission' | 'plan'): string | undefined {
  if (family === 'plan') return block.includes(PLAN_QUESTION) ? PLAN_QUESTION : undefined
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
  prior: DialogContinuity,
): boolean {
  if (rows.length !== prior.options.length) return false
  if (!rows.every((r, i) => r.text === prior.options[i])) return false
  if (!SECTION_RULE_RE.test(block)) return false
  if (!block.includes(prior.question)) return false
  // The title is caret-invariant too, and it is what decides WHICH option 2 the
  // registry believes in — so a frame whose title stopped saying `Create file`
  // is not this dialog, whatever else still matches.
  return readVariant(block) === prior.variant
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
const VARIANT_TITLES = ['Bash command', 'Edit file', 'Create file']
/** A line that is only box-drawing — CC's own framing, at terminal width. */
const RULE_ONLY_RE = /^[\s─━╌┄┈╍-]+$/

function readBody(
  lines: readonly string[],
  from: number,
  optionLine: number,
  family: DialogSighting['family'],
): string[] | undefined {
  if (family !== 'permission') return undefined
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

/** The last row with a printable glyph on it, or −1. */
function lastContentLine(lines: readonly string[]): number {
  for (let i = lines.length - 1; i >= 0; i--) {
    if (lines[i].trim()) return i
  }
  return -1
}

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
  const family: DialogSighting['family'] | null =
    readFamily(block, rows) ??
    (continuing && continues(block, rows, continuing) ? continuing.family : null) ??
    (looksModal(block, rows) ? 'unknown' : null)
  if (!family) return null

  const caret = rows.find((r) => r.caret)
  const sighting: DialogSighting = {
    family,
    options: rows.map((r) => r.text),
    caretIndex: caret ? caret.index : null,
  }
  if (family !== 'unknown') {
    const question = readQuestion(block, family)
    if (question) sighting.question = question
  }
  if (family === 'permission') {
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
