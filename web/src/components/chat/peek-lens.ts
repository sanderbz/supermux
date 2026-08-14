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
import { parseAnsiLine } from '../../lib/ansi'

/** A dialog the lens can SEE. Whether it may be answered is the registry's call
 *  (T6) — the lens reports, it never decides. */
export interface DialogSighting {
  family: 'permission' | 'plan'
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
}

export interface PeekLens {
  /** `╭─── Claude Code v2.1.231 ───╮` → `2.1.231`. Null when the banner has
   *  scrolled off the window — which is why `use-peek-lens.ts` reads it ONCE
   *  with a deep capture and caches it per session. */
  bannerVersion: string | null
  /** Non-empty text sitting at the TUI's `❯` composer, else null. */
  composerDraft: string | null
  dialog: DialogSighting | null
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
 *  discriminator is option-1 TEXT — a0 §3, stated as a caution. */
function readFamily(
  whole: string,
  options: readonly OptionRow[],
): DialogSighting['family'] | null {
  if (options.length < 2) return null
  const first = options[0].text
  const all = options.map((o) => o.text).join(' · ')
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

function readDialog(lines: readonly string[]): DialogSighting | null {
  const rows = readOptions(lines)
  if (rows.length < 2) return null
  const whole = norm(lines.map(norm).join(' '))
  const family = readFamily(whole, rows)
  if (!family) return null

  const from = Math.max(0, rows[0].line - BLOCK_LOOKBACK)
  const to = Math.min(lines.length, rows[rows.length - 1].line + 4)
  const block = norm(lines.slice(from, to).map(norm).join(' '))

  const caret = rows.find((r) => r.caret)
  const sighting: DialogSighting = {
    family,
    options: rows.map((r) => r.text),
    caretIndex: caret ? caret.index : null,
  }
  if (family === 'permission') {
    const variant = readVariant(block)
    if (variant) sighting.variant = variant
  } else {
    // The footer's plan path, when it is on screen. `[^\s]` and not `.` so a
    // footer that shares its line with `ctrl+g to edit in …` cannot swallow it.
    const m = /~\/\.claude\/plans\/[^\s]*\.md/.exec(whole)
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
function readComposerDraft(lines: readonly string[]): string | null {
  let fallback = -1
  let preferred = -1
  let boxed: string | null = null
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    if (line.startsWith(CARET)) {
      fallback = i
      if (line[1] === NBSP) preferred = i
      continue
    }
    const m = BOXED_COMPOSER_RE.exec(line)
    if (m) boxed = m[1]
  }
  const raw =
    preferred >= 0
      ? lines[preferred].slice(CARET.length)
      : (boxed ?? (fallback >= 0 ? lines[fallback].slice(CARET.length) : ''))
  const draft = norm(raw)
  return draft.length > 0 ? draft : null
}

/** The session's boot binary, from the banner it printed at launch — never
 *  the CLI's own `--version` flag, which reports the DISK binary: the CLI
 *  auto-updates and a RUNNING session keeps the binary it booted with (a0:
 *  `spike-a0-perm` ran 2.1.227 while the disk had 2.1.231). Two banner shapes
 *  exist (a fresh boot draws the `╭─── … ───╮` box, a cleared session the
 *  compact `▐▛███▜▌ Claude Code vX.Y.Z` form), so the anchor is the token, not
 *  the frame. */
function readBannerVersion(whole: string): string | null {
  const m = /Claude Code v(\d+\.\d+\.\d+[^\s│╮─]*)/.exec(whole)
  return m ? m[1] : null
}

/** Read one `/peek` capture. Pure, total, cheap: no capture ever throws, and an
 *  empty one reads as "nothing on screen" rather than as a failure. */
export function readLens(capture: string): PeekLens {
  const lines = capture ? capture.split('\n').map(plain) : []
  const whole = norm(lines.map(norm).join(' '))
  const dialog = readDialog(lines)
  return {
    bannerVersion: readBannerVersion(whole),
    composerDraft: dialog ? null : readComposerDraft(lines),
    dialog,
  }
}

/** The empty reading — what consumers get before the first poll lands, and what
 *  a failed peek must NOT be confused with (T3: a peek outage lets the send
 *  through and leaves the watchdog to be honest about it). */
export const EMPTY_LENS: PeekLens = {
  bannerVersion: null,
  composerDraft: null,
  dialog: null,
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
