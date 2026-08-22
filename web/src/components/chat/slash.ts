// `@`-files and `/`-commands — the PURE half (fase A4 T9).
//
// §5.6's anti-lookalike rule: the chat surface must not be LESS CAPABLE than
// the terminal at the app's actual job. Two of the things people do in a Claude
// TUI all day are `@`-ing a path into a sentence and running a slash command,
// and a chat box that can only send prose is a demo of a chat box.
//
// This module owns three pieces of arithmetic, all of them pure so they can be
// asserted in `bun test` without a DOM and without a network:
//
//   1. `readTrigger`  — is the caret sitting in an `@…` / `/…` token?
//   2. `classifySlash`— may this command be SENT, or does it open a widget on a
//                       pty nobody is looking at?
//   3. `fuzzyScore` / `rankEntities` — the client-side filter the popover uses.
//
// One TYPE-ONLY import and nothing else (the chat modules' resolution rule:
// relative-only, and nothing that reaches `window`). `EntityRow` moved to
// `lib/entity.ts` in fase B3 so four surfaces could agree on it; the import is
// fully erased, so this file still has no runtime dependency at all.
import type { EntityRow } from '../../lib/entity'

// ── 1. The trigger ──────────────────────────────────────────────────────────

export interface ComposerTrigger {
  kind: '@' | '/'
  /** What has been typed after the trigger character, up to the caret. */
  query: string
  /** Index of the trigger character in the draft. */
  start: number
  /** The caret — the end of the token being replaced on accept. */
  end: number
}

/** A query longer than this is prose, not a filter — the user typed an address
 *  or a URL and the popover should get out of the way. */
const MAX_QUERY = 64

function isSpace(ch: string): boolean {
  return ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r'
}

/**
 * Read the token the caret is in, or null.
 *
 * THE TWO ASYMMETRIES, both deliberate:
 *
 *   · `@` triggers anywhere a WORD could start (start of draft, or after
 *     whitespace) — `fix @src/main.rs` is the whole point. It must NOT trigger
 *     inside a word, or every e-mail address in a pasted sentence opens a file
 *     picker.
 *   · `/` triggers only as the draft's FIRST token. That is the TUI's own rule
 *     — Claude reads a leading `/` as a command and a mid-sentence one as text
 *     — and without it every path a user types (`server/src`) would open the
 *     command menu on the second character.
 */
export function readTrigger(draft: string, caret: number): ComposerTrigger | null {
  const pos = Math.max(0, Math.min(caret, draft.length))
  const head = draft.slice(0, pos)

  let i = head.length
  let start = -1
  while (i > 0) {
    const ch = head[i - 1]!
    if (ch === '@' || ch === '/') {
      start = i - 1
      break
    }
    // A space between the caret and the trigger ends the token: the user has
    // moved on, and re-opening the popover behind them would steal Enter.
    if (isSpace(ch)) return null
    i -= 1
  }
  if (start < 0) return null

  const kind = head[start] as '@' | '/'
  const before = head.slice(0, start)
  if (kind === '/') {
    // Leading whitespace is tolerated (a draft that starts with a newline is
    // still a draft whose first token is the command); anything else is text.
    if (before.trim().length > 0) return null
  } else if (before.length > 0 && !isSpace(before[before.length - 1]!)) {
    return null
  }

  const query = head.slice(start + 1)
  if (query.length > MAX_QUERY) return null
  return { kind, query, start, end: pos }
}

// ── 2. The slash surface ────────────────────────────────────────────────────

/**
 * Text-safe: the TUI consumes these as text and runs them, so chat may pass them
 * straight through `POST /send` — none of them leaves an interactive widget
 * behind.
 *
 * RE-VERIFIED LIVE ON 2.1.233, one command at a time, in a throwaway pty
 * (captures in `tests/fixtures/tui/cc233-modal/`). Four commands LEFT this list
 * on that evidence, and every one of them was a live wedge:
 *
 *   · `/status` → a full-screen Status panel with an `Esc to cancel` footer and
 *     no composer on screen (`50-status-modal.txt`). This is daily-driver QA #1:
 *     chat sent it, the panel opened on a pty nobody was looking at, chat showed
 *     nothing, and every later send was refused for the wrong reason.
 *   · `/cost`   → the same shape, plus its own keys (`d to day · w to week`,
 *     `51-cost-modal.txt`).
 *   · `/review` → does not exist on 2.1.233. Typing it leaves CC's command menu
 *     open with `/code-review (review)` HIGHLIGHTED, and `send_text` appends the
 *     Enter that accepts it — a different command runs, silently.
 *   · `/pr-comments` → same: it is gone, and the Enter picked `/code-review`,
 *     which started a background agent. Captured while re-verifying this list.
 *
 * The two that stayed were driven to completion on the same pty: `/clear`
 * cleared the transcript and returned to the composer, `/compact` printed
 * `Not enough messages to compact.` into the transcript. Both leave the prompt
 * where they found it.
 *
 * The rule this list is under: a command earns a place here by being WATCHED,
 * and re-watched on the CLI that is shipping. Everything else refuses.
 */
export const PASS_THROUGH = ['/compact', '/clear'] as const

/** These OPEN A PICKER in the TUI. Sending one from chat would leave an
 *  interactive widget on a pty nobody is looking at — the session then answers
 *  the NEXT message into that widget, which is the silent-misfire class this
 *  whole fase exists to refuse. */
export const PICKER_OPENING = [
  '/model',
  '/resume',
  '/rewind',
  '/config',
  '/agents',
  '/mcp',
  '/login',
] as const

/**
 * Claude Code's OWN command namespace — mirrored from the server's
 * `BUILTIN_SLASH_COMMANDS` (`server/src/agents/skills.rs:33`), which is the list
 * `GET /api/slash-commands` offers the picker. `chat-slash.test.ts` reads that
 * Rust file and asserts the two are identical, so this cannot drift.
 *
 * WHY IT EXISTS (fase A4 T9 review, safety pass). The picker lists every one of
 * these rows, and until this constant landed anything outside the two small
 * lists above classified as `unknown` and was SENT AS TEXT. `/permissions`,
 * `/hooks`, `/memory`, `/theme`, `/ide`, `/plugin` and `/statusline` are full
 * TUI widgets: sending one leaves an editor open on a pty nobody is looking at,
 * and the NEXT chat message — `send_text` appends Enter itself — is typed into
 * it. A message that adds a permission rule is exactly the silent misfire this
 * fase exists to refuse.
 *
 * So the DEFAULT for a built-in is refusal: only `PASS_THROUGH` is verified
 * text-safe, and everything else here needs a surface with a cursor on it. A
 * command that is NOT in this namespace is a project/skill command — a
 * user-authored prompt, not a widget — and still goes, with a note.
 *
 * Stored without the leading slash: it is a set of names, and the entry budget
 * is measured in bytes (T12).
 */
const TUI_BUILTINS: ReadonlySet<string> = new Set(
  ('add-dir agents batch clear color compact config context copy cost debug diff doctor effort' +
    ' export extra-usage fast feedback focus help hooks ide init login logout loop mcp memory' +
    // `pr-comments` is NOT in the server's list (the CLI dropped it), and that is
    // exactly why it is here: typed at the prompt it leaves CC's command menu
    // open on `/code-review (review)`, and the Enter `send_text` appends runs
    // THAT — verified live on 2.1.233 while re-checking `PASS_THROUGH`. A name
    // the CLI no longer has must refuse, not be pasted as text and reinterpreted.
    ' model permissions plan plugin pr-comments recap release-notes remote-control rename resume review' +
    ' rewind sandbox schedule security-review simplify skills stats status statusline tasks' +
    ' terminal-setup theme ultraplan ultrareview usage vim voice').split(' '),
)

/** Is this one of Claude Code's own commands (rather than a user skill)? */
export function isBuiltin(cmd: string): boolean {
  return TUI_BUILTINS.has(cmd.replace(/^\//, '').toLowerCase())
}

export type SlashClass = 'pass' | 'picker' | 'unverified' | 'unknown'

/** The command a draft starts with (`/compact focus on money` → `/compact`),
 *  or null when the draft is not a command at all. Case-folded: the TUI's own
 *  matcher is case-insensitive. */
export function slashName(text: string): string | null {
  const trimmed = text.trimStart()
  if (!trimmed.startsWith('/')) return null
  const token = trimmed.split(/\s/, 1)[0] ?? ''
  if (token.length < 2) return null
  return token.toLowerCase()
}

/**
 * What may be done with this draft.
 *
 *   'pass'    → send it; the TUI runs it and prints the result into the
 *               transcript, which is exactly what chat wants.
 *   'picker'  → do NOT send. The composer says which command it is and offers
 *               the terminal, where the widget is answerable.
 *   'unverified' → do NOT send either. One of Claude Code's own commands that
 *               A0 never captured (`/permissions`, `/hooks`, `/memory`, …).
 *               Refusing an unverified built-in is the same rung the registry
 *               uses for Bash option 2: a command whose effect on the pty
 *               nobody has watched is not sent on hope.
 *   'unknown' → a project or skill command (`GET /api/slash-commands`) or a
 *               typo. Both are user-authored PROMPTS, not TUI widgets, so this
 *               is pass-through — with a note, because a typo that silently
 *               becomes a message is the same lie in the other direction.
 *
 * Prose classifies as 'pass': there is nothing here to refuse.
 */
export function classifySlash(text: string): SlashClass {
  const cmd = slashName(text)
  if (cmd === null) return 'pass'
  if ((PICKER_OPENING as readonly string[]).includes(cmd)) return 'picker'
  if ((PASS_THROUGH as readonly string[]).includes(cmd)) return 'pass'
  // The order matters: verified first, then the namespace. A built-in that is
  // not on the verified list is refused, NOT sent as text.
  if (isBuiltin(cmd)) return 'unverified'
  return 'unknown'
}

// ── 3. The filter ───────────────────────────────────────────────────────────

/** A match that starts right after one of these reads as a whole segment. */
// The ranker lives in `lib/rank.ts` since fase B3, so the scheduler can share
// it without inheriting this file's command table. NOT re-exported: a barrel
// here would keep this module (and its built-in command table) alive on every
// chunk that only wanted the 30-line matcher.
import { rankEntities } from '../../lib/rank'
import { basename } from '../../lib/path'

// ── 4. The rows ─────────────────────────────────────────────────────────────
//
// What the popover offers, derived from what the two endpoints answered. Pure
// and here rather than in `entity-picker.tsx` for two reasons: the bench feeds
// them fixture lists to screenshot the popover without a server, and the unit
// net can assert the ranking without mounting React.

/** How many rows the popover will show. Long enough to be useful, short enough
 *  that it never covers the transcript it is being written about. */
const LIMIT = 12

/**
 * One offer.
 *
 * THE SHAPE IS NOW THE APP'S, NOT CHAT'S (fase B3 T3.1). `lib/entity.ts` owns
 * the union — nine kinds, and a row that inserts / runs / navigates — because
 * by B3 four surfaces were offering rows and two of them were offering the
 * same slash commands. Chat still builds its own rows here (that is its DATA,
 * and the picker fetches nothing); it just stopped owning the type they are.
 *
 * Everything this file produces is the INSERT arm: the `@`/`/` popover puts
 * text in a draft and does nothing else, which is the rule the A4 header
 * comment states three different ways.
 */
export type { EntityRow }

/**
 * The row a picker `accept` would take, or `null` for "nothing to accept".
 *
 * Extracted from the component (fase B4 T4.6) because it carries a KEYBOARD
 * CONTRACT that a rendered test cannot reach: `accept()` returns `false` when
 * there is nothing to take, and the composer's Enter then falls through to
 * SUBMIT. Get that backwards — return `true` on an empty list — and a query
 * matching nothing silently swallows the user's message; return `false` on a
 * real row and Enter both accepts and sends.
 *
 * The index is clamped rather than trusted: the highlight lives one render out
 * of the list it points into (`entity-picker.tsx` reads both through a ref), so
 * a list that shrank between the keystroke and the read must yield nothing, not
 * a neighbouring row the user never saw.
 */
export function acceptRow(
  rows: readonly EntityRow[],
  activeIndex: number,
): EntityRow | null {
  if (activeIndex < 0 || activeIndex >= rows.length) return null
  return rows[activeIndex] ?? null
}

// `PICKER_PAGE` / `PickerJump` / `jumpTarget` live in `composer-keys.ts` since
// fase B3 — they are the keyboard contract's arithmetic, not the slash
// tokenizer's. Imported from there directly by everything that needs them.

/** The two fields a mention needs — structural on purpose, so this ranks the
 *  shared `useSessions()` rows AND the bench's fixture cast without either of
 *  them having to be the other's type. */
export interface MentionableSession {
  name: string
  display_name?: string
  /** Companies (Bot Mode): the peer's company. Carried so the `@`-picker can
   *  scope who a company session may name (`scopeMentionPeers`), keyed off the
   *  typing session's OWN company_id. Absent = a main/PA bot (reachable by all).
   *  The shared `useSessions()` rows already carry it; the bench fixture may. */
  company_id?: number | null
}

/** One row of `GET /api/slash-commands` (skills.rs::SlashCommand), restated
 *  structurally for the same reason. */
export interface SlashCommandRow {
  cmd: string
  desc: string
}

/**
 * Everything the popover offers, as data.
 *
 * The three lists are FETCHED BY THE PANEL (`chat-panel.tsx`) and travel down
 * as one prop: the A3/A4 contract is that network-touching state arrives from
 * there, and it keeps the lazy picker chunk free of the API client.
 */
export interface EntityPickerData {
  /** `GET /api/sessions/{name}/tracked-files`. */
  files?: readonly string[]
  /** `GET /api/slash-commands` — built-ins merged with the user's skills. */
  commands?: readonly SlashCommandRow[]
  /** The sessions a message could name (the shared sessions query). */
  sessions?: readonly MentionableSession[]
  /** The relevant list is still in flight. */
  loading?: boolean
}

/**
 * What an `@` can name: a file this session is touching, or another session.
 *
 * ONE RANKING over both sources, not two lists stapled together — otherwise a
 * loose subsequence match on a path outranks the colleague whose name the user
 * literally typed. The `kind` (and the meta column) is what tells them apart;
 * the ORDER is just "how well does this answer what you typed".
 */
export function atRows(
  files: readonly string[] | undefined,
  sessions: readonly MentionableSession[],
  self: string,
  query: string,
): EntityRow[] {
  const candidates: { row: EntityRow; text: string }[] = (files ?? []).map((path) => ({
    text: path,
    row: {
      id: `file:${path}`,
      kind: 'file',
      value: `@${path}`,
      label: basename(path),
      meta: dirname(path),
    },
  }))
  // A mention of ANOTHER session — v1 inserts the name and nothing else.
  // Actually dispatching to it (`POST /api/agents/delegate`) is Track B §13; a
  // picker that silently started another agent would be the opposite of
  // everything this fase is for.
  for (const s of sessions) {
    if (s.name === self) continue
    candidates.push({
      text: `${s.display_name ?? ''} ${s.name}`.trim(),
      row: {
        id: `session:${s.name}`,
        kind: 'session',
        value: `@${s.name}`,
        label: s.display_name?.trim() ? s.display_name : s.name,
        // The slug ONLY when it says something the label does not.
        // `display_name` equals `name` for every session nobody has renamed —
        // which is most of them — so an unconditional `meta` printed the same
        // word twice on every row of the picker (reported independently by
        // chat-core and pickers-palette).
        meta: s.display_name?.trim() && s.display_name !== s.name ? s.name : undefined,
      },
    })
  }
  return rankEntities(candidates, query, (c) => c.text, LIMIT).map((c) => c.row)
}

/** The server's list (built-ins merged with the user's skills), plus the local
 *  built-in namespace so the picker is complete even before that request lands
 *  — and so a row chat will not send is always LABELLED as one, on its face,
 *  BEFORE it is picked. */
export function slashRows(
  commands: readonly SlashCommandRow[] | undefined,
  query: string,
): EntityRow[] {
  const seen = new Set<string>()
  const all: SlashCommandRow[] = []
  for (const c of commands ?? []) {
    const cmd = c.cmd.startsWith('/') ? c.cmd : `/${c.cmd}`
    if (seen.has(cmd.toLowerCase())) continue
    seen.add(cmd.toLowerCase())
    all.push({ cmd, desc: c.desc })
  }
  for (const cmd of [...PASS_THROUGH, ...TUI_BUILTINS].map((c) =>
    c.startsWith('/') ? c : `/${c}`,
  )) {
    if (seen.has(cmd)) continue
    seen.add(cmd)
    all.push({ cmd, desc: '' })
  }

  return rankEntities(all, query, (c) => c.cmd, LIMIT).map((c) => ({
    id: `cmd:${c.cmd}`,
    kind: 'command',
    value: c.cmd,
    label: c.cmd,
    meta: c.desc || undefined,
    // Said ON the row rather than in a footnote: a badge nobody can decode is
    // just decoration, and this is the one thing about the row that matters.
    // The row stays pickable — the refusal belongs to the SEND — but nobody
    // reaches the refusal without having read this first.
    warn: WARN[classifySlash(c.cmd)],
  }))
}

/** What a row says about itself, per verdict. `pass`/`unknown` say nothing:
 *  those go. */
const WARN: Record<SlashClass, string | undefined> = {
  pass: undefined,
  unknown: undefined,
  picker: 'opens in terminal',
  unverified: 'terminal only',
}

function dirname(path: string): string {
  const at = path.lastIndexOf('/')
  return at < 0 ? '' : path.slice(0, at)
}

/* ── the picker's ARIA identity ──────────────────────────────────────────── */

/**
 * The ids that tie the composer's textarea to the popover it drives (A4
 * review).
 *
 * They live HERE, in the picker's data module, rather than in the picker
 * component: `composer.tsx` needs them to write `aria-controls` /
 * `aria-activedescendant` on the field, and a static import of the component
 * would pull the whole lazy picker chunk into the surface's first paint.
 *
 * Without the pair, `@sr` announced nothing at all: focus deliberately never
 * leaves the textarea (a popover that stole it would dismiss the soft keyboard
 * on every phone), so a screen reader had no way to know a listbox had opened,
 * how many rows it held, or which one ↑/↓ had moved to — and Enter then
 * replaced the token with a value the user was never told.
 */
export const PICKER_LISTBOX_ID = 'chat-entity-listbox'

/** The active row's id, for `aria-activedescendant`. Index-based so the field
 *  can name a row it does not own. */
export function pickerOptionId(index: number): string {
  return `chat-entity-option-${index}`
}
