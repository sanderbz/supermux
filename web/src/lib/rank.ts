// The app's type-ahead ranker — one matcher for every picker (fase B3 T3.4).
// ─────────────────────────────────────────────────────────────────────────────
// PURE AND IMPORT-FREE, and in `lib/` rather than in `components/chat/` because
// by B3 it had two callers on opposite sides of the app: the chat `@`/`/`
// popover it was written for, and the scheduler's `PromptField`, which filters
// THE SAME corpus of installed slash commands and used to do it with its own
// `includes()`.
//
// WHY IT MOVED OUT OF `slash.ts`. `slash.ts` also carries the built-in command
// table and the trigger tokenizer — chat's data. Importing the ranker from it
// pulled all of that into the scheduler's chunk (measured: +0.58 KB gz for a
// 30-line function). A shared function belongs where both callers can reach it
// without inheriting the other's baggage; that is the whole argument for this
// file, and the app-JS budget is what made the argument concrete.
//
// Deliberately NOT a scoring library: ~30 lines against a list that is already
// in memory, and this fase ships no new dependency.

const BOUNDARY = '/-_. :'

// ── THE RELEVANCE FLOOR ──────────────────────────────────────────────────────
//
// A subsequence match has to be DENSE to count. Without a floor the branch
// below returned at worst `400 - 200 = 200` for a match whose characters were
// scattered over an entire sentence, so a query almost always matched
// something: `dark` found `/supermux-schedule` (d…a…r…k spread across 73
// characters of its description) and Enter on that row fired a slash command
// into a live agent. A palette row that can be picked with one keystroke has
// to be a row the user meant.
//
// The allowance is generous on purpose: it must keep the matches this ranker
// exists for. `ssmod` → `server/src/sessions/mod.rs` has a spread of 18 for a
// 5-character query, and `rt` → `release-train` a spread of 8 for 2 — both are
// real, both stay. 73 does not. Pinned in tests/unit/rank-floor.test.ts.
const SPREAD_BASE = 6
const SPREAD_PER_CHAR = 3

/**
 * How well `text` matches `query`. -1 is "not at all"; higher is better.
 *
 * Substring beats subsequence, earlier beats later, and a match that starts at
 * a SEGMENT BOUNDARY beats one in the middle of a word — which is the rule that
 * makes `main` find `server/src/main.rs` before `web/src/lib/domain.ts`.
 * Deliberately not a scoring library: this is ~20 lines against a list that is
 * already in memory, and A4 ships no new dependency.
 */
export function fuzzyScore(text: string, query: string): number {
  if (query.length === 0) return 0
  const t = text.toLowerCase()
  const q = query.toLowerCase()

  const idx = t.indexOf(q)
  if (idx >= 0) {
    const boundary = idx === 0 || BOUNDARY.includes(t[idx - 1]!)
    return 1_000 - Math.min(idx, 200) + (idx === 0 ? 300 : 0) + (boundary ? 150 : 0)
  }

  // Subsequence: every query character in order, anywhere.
  let ti = 0
  let first = -1
  let last = -1
  for (const ch of q) {
    const at = t.indexOf(ch, ti)
    if (at < 0) return -1
    if (first < 0) first = at
    last = at
    ti = at + 1
  }
  const spread = last - first - (q.length - 1)
  if (spread > SPREAD_BASE + SPREAD_PER_CHAR * q.length) return -1
  return 400 - Math.min(spread, 200) + (first === 0 ? 60 : 0)
}

/**
 * What a row is ranked on.
 *
 * A bare string is "match anywhere in this" — the file picker's shape, where
 * the whole path IS the name.
 *
 * The pair is "match in the LABEL; `extra` is a tiebreaker" — the shape every
 * row with a description needs. Ranking a command on `"/cmd its whole
 * description sentence"` let a subsequence walk the sentence and win the row
 * outright; a description may still find its row (`trash` → "View archived
 * sessions" via its keywords), but only as a SUBSTRING, and never above a row
 * whose own name matched.
 */
export type RankText = string | { label: string; extra?: string }

/** The `extra` band sits entirely below the label band: the weakest label
 *  match a subsequence can produce is 400-200 = 200, so an extra hit can never
 *  outrank a name hit no matter where in the string it lands. */
function textScore(field: RankText, query: string): number {
  if (typeof field === 'string') return fuzzyScore(field, query)
  const primary = fuzzyScore(field.label, query)
  if (primary >= 0) return primary
  // An empty query already scored 0 on the label above, so `extra` is only
  // ever consulted for a real query.
  if (!field.extra) return -1
  const at = field.extra.toLowerCase().indexOf(query.toLowerCase())
  return at < 0 ? -1 : 120 - Math.min(at, 100)
}

/** Rank `items` by their `textOf` against `query`, best first, dropping the
 *  misses. Stable: equal scores keep the source order (the server's own
 *  ordering — git status order for files, list order for commands). */
export function rankEntities<T>(
  items: readonly T[],
  query: string,
  textOf: (item: T) => RankText,
  limit = 20,
): T[] {
  const scored: { item: T; score: number; at: number }[] = []
  for (let i = 0; i < items.length; i += 1) {
    const score = textScore(textOf(items[i]!), query)
    if (score >= 0) scored.push({ item: items[i]!, score, at: i })
  }
  scored.sort((a, b) => b.score - a.score || a.at - b.at)
  return scored.slice(0, limit).map((s) => s.item)
}
