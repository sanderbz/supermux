// Does this draft mean "hand this to a colleague"? (fase B4 T4)
//
// PURE AND IMPORT-FREE. The `bun test` runner has no jsdom and no `@/` aliases,
// and this is the module the whole hand-off flow turns on — so it takes plain
// data and returns plain data, and the composer does the rest.
//
// THE RULE IS DELIBERATELY NARROW, and it is a safety property rather than a
// convenience one. Every keystroke in the composer is evaluated against it, and
// a match CHANGES WHERE ENTER SENDS — from this session's pty to another
// agent's. So the only shape that counts is the one a person could not produce
// by accident:
//
//   the draft STARTS with a single `@<known-session>` token,
//   that session is not this one,
//   and there is non-empty text after it.
//
// A mention in the middle of a sentence stays a mention: "ask @patch about the
// export" is a message TO THIS SESSION that names a colleague, and dispatching
// it would be the picker silently starting another agent — exactly what the
// deferral comment in `slash.ts` was protecting against.
//
// WHY LEADING-ONLY. It is the one position where the mention cannot be part of
// the sentence's grammar: `@patch rebase the stack` reads as an envelope, and
// `tell @patch to rebase` reads as prose. Anything looser makes the meaning of
// Enter depend on where a word happens to sit in a sentence.

/** A resolved hand-off: who it goes to, and what they receive. */
export interface DelegateIntent {
  /** The recipient's SLUG — the wire's identity, never the display label. */
  to: string
  /** The message, with the `@name` envelope removed. */
  prompt: string
}

/**
 * The token an `@` can open. Mirrors `slash.ts::readTrigger`'s character class
 * so the picker and this module agree on where a mention ends — a name is
 * letters, digits, `-`, `_` and `.`; whitespace ends it, and so does anything
 * else.
 */
const LEADING_MENTION = /^@([A-Za-z0-9_.-]+)(\s|$)/

/**
 * Read a hand-off intent out of a draft, or `null` for "this is a message".
 *
 * @param draft    the composer's raw text, exactly as typed
 * @param mentions lowercased known name → session slug (the panel's index) —
 *                 the SAME index the chips use, so a name that is not a live
 *                 session is never a recipient
 * @param self     the session being typed in; never a recipient of its own
 */
export function readDelegateIntent(
  draft: string,
  mentions: ReadonlyMap<string, string>,
  self: string,
): DelegateIntent | null {
  // Leading spaces/tabs are typing, not meaning. A leading NEWLINE is meaning:
  // a draft whose first line is blank is a multi-line message, and its second
  // line beginning with `@` is prose. Same reason a `@name` inside a fenced
  // block never reaches here — it is not at the start of the draft.
  const head = draft.replace(/^[ \t]+/, '')
  const m = LEADING_MENTION.exec(head)
  if (!m) return null
  const token = m[1]
  // The index is the authority, and it is keyed lowercase (`grouping.ts`).
  const to = mentions.get(token.toLowerCase())
  if (!to) return null
  if (to === self) return null

  const prompt = head.slice(1 + token.length).trim()
  if (prompt.length === 0) return null
  // A SECOND leading mention means the user is addressing a group, and this
  // fase hands work to exactly one colleague. Refusing is honest; picking the
  // first would quietly drop the others.
  if (LEADING_MENTION.test(prompt)) return null

  return { to, prompt }
}

/**
 * What the send control says while an intent holds.
 *
 * The label is the whole safety story of T4: the meaning of Enter has changed,
 * and it changes visibly BEFORE the key is pressed. `label` is what the reader
 * calls that session (the display name when there is one), never the slug —
 * "Hand to ●Patch" names a colleague, "Hand to ●patch" names a database row.
 */
export function handoffLabel(to: string, names?: ReadonlyMap<string, string>): string {
  return names?.get(to)?.trim() || to
}
