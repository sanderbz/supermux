// Composer text arithmetic (fase A4 T3) — PURE, and deliberately the only place
// in the app that knows how a token joins a draft.
//
// Four surfaces insert into the composer (master plan §3): the attachment
// path-injector, the dock's slash row, the snippet panel, and the `@`/`/`
// pickers (T9). Before A4 each of them wrote its own `send(text)` into the pty
// and each of them spaced differently — the terminal forgave it because the
// user was looking at a prompt. A React composer does not: a missing space
// glues a path onto a word, a double space is visible. So the rule lives here,
// once, and is fixture-tested.
//
// No imports on purpose (the `bun test` resolution rule the chat modules
// follow: relative-only, and nothing that reaches `window`).

export interface InsertResult {
  /** The new draft. */
  draft: string
  /** Where the caret lands — AFTER the inserted token, never at the end of the
   *  draft: inserting a path into the middle of a sentence has to leave the
   *  user typing where they were. */
  caret: number
}

/** A caret, or a selection to replace. A bare number is a collapsed caret. */
export type Selection = number | { start: number; end: number }

function range(sel: Selection, len: number): { start: number; end: number } {
  const s = typeof sel === 'number' ? { start: sel, end: sel } : sel
  // Defensive, not decorative: `selectionStart` is null on a detached textarea
  // and a stale caret can outlive a programmatic draft change by one render.
  const start = clamp(Math.min(s.start, s.end), len)
  const end = clamp(Math.max(s.start, s.end), len)
  return { start, end }
}

function clamp(n: number, len: number): number {
  if (!Number.isFinite(n) || n < 0) return len
  return Math.min(n, len)
}

/**
 * Drop `text` into `draft` at `selection`.
 *
 * THE SPACING RULE, in one sentence: exactly one space before the token unless
 * the draft is empty at that point or already ends in whitespace — and one
 * space after it only when the token would otherwise be glued to what follows.
 * The caret lands directly after the token, so the next keystroke continues the
 * sentence the user was writing.
 */
export function insertAtCaret(
  draft: string,
  selection: Selection,
  text: string,
): InsertResult {
  if (text.length === 0) {
    const { start } = range(selection, draft.length)
    return { draft, caret: start }
  }
  const { start, end } = range(selection, draft.length)
  const left = draft.slice(0, start)
  const right = draft.slice(end)

  // Leading pad: only when there is something to the left and neither side of
  // the seam is already whitespace. (`attachmentSentence` ships its own
  // trailing space — see below — so a second insert never doubles it.)
  const pad = left.length > 0 && !/\s$/.test(left) && !/^\s/.test(text) ? ' ' : ''
  // Trailing pad: only when the token would touch the text that follows it.
  const tail = right.length > 0 && !/^\s/.test(right) && !/\s$/.test(text) ? ' ' : ''

  const head = left + pad + text
  return { draft: head + tail + right, caret: head.length }
}

/**
 * The sentence an uploaded attachment becomes.
 *
 * SAME RULE AS THE TERMINAL, on purpose: `buildAttachmentPrompt`
 * (`lib/api/files.ts:224`) is what the dock, drag-drop and clipboard-paste have
 * always injected into the pty — quoted absolute paths, space-separated, one
 * trailing space so the user keeps typing after them. A chat composer that
 * quoted differently would make the same attachment read differently depending
 * on which renderer happened to be mounted.
 *
 * It is re-derived here rather than imported so this module keeps its one
 * property — no imports, nothing that can reach `window` — and stays the piece
 * of A4 that a future renderer can lift wholesale. The duplication is held
 * together by a TEST, not by prose: `chat-composer-insert.test.ts` asserts this
 * function equals `buildAttachmentPrompt` over four inputs, so a change to
 * either side has to be a deliberate change to both.
 */
export function attachmentSentence(paths: readonly string[]): string {
  if (paths.length === 0) return ''
  return `${paths.map((p) => `"${p}"`).join(' ')} `
}
