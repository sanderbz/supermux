/**
 * Back-pagination arithmetic (daily-driver QA #3) and the jump-to-bottom
 * threshold (QA #17).
 * ─────────────────────────────────────────────────────────────────────────────
 * Pure, dependency-free, and deliberately separate from the hook that fetches:
 * every number here is the kind a refactor breaks without a test noticing,
 * because a wrong one shows up as "the page jumped" or "the history has a hole
 * in it" rather than as an exception.
 *
 * WHICH ENDPOINT. `/recall?chat=true` — the same route the tail already reads,
 * which has carried `hasMore` + `nextBefore` since fase A1 (measured on the live
 * instance: a 60-entry page in 20 ms). The A2 route `/chat/history` pages the
 * same transcript but speaks `WireEntry`, a shape no client module has an
 * adapter for yet; paging in a second wire format would mean two display models
 * for one conversation. When the A2 socket lands, this module's callers change
 * their fetch and keep every rule below.
 *
 * WHY THE CURSOR IS RECOMPUTED, never remembered. The tail window is the newest
 * N entries and it SLIDES: five new entries during a turn move its oldest entry
 * five newer, so a `nextBefore` captured at seed time now points INSIDE the
 * window and the five entries between the two would belong to no page at all.
 * Paging from the oldest entry currently on screen (`oldestCursor`) makes that
 * hole unrepresentable.
 */
import type { ChatEntry } from './entries'

/**
 * How many entries an older page asks for.
 *
 * Bigger than the tail's 30: a page fetched by scrolling is paid for once and
 * read for a while, and the round trip is 20 ms against a multi-MB transcript
 * (measured). Small enough that the prepend is one paint, not a freeze.
 */
export const OLDER_PAGE_LIMIT = 60

/**
 * How close to the top counts as "asking for more".
 *
 * A full viewport's worth of runway (390×844 phone) so the page lands before
 * the user hits the actual top — reaching `scrollTop === 0` and THEN waiting is
 * the version of this feature that still feels like a wall.
 */
export const NEAR_TOP_PX = 320

/**
 * How far from the bottom the jump-to-bottom pill appears.
 *
 * Far past the 48px follow-bottom threshold on purpose: those two numbers are
 * answering different questions ("should new content still pin?" vs. "is the
 * newest message off screen?"), and a pill that appeared the instant the pin let
 * go would blink on every rubber-band and every keyboard open.
 */
export const JUMP_AWAY_PX = 240

/**
 * How many fill pages the seam repair may spend before it gives up and keeps
 * the newer half only. 5 × 60 = 300 entries of drift between two tail polls —
 * far past anything a live turn produces in 1.2 s, and a hard stop so a cursor
 * that can no longer be found (a cleared or compacted transcript) cannot spin.
 */
export const BRIDGE_MAX_PAGES = 5

/** What `oldestCursor` needs of an entry — the server's cursor pair. */
export interface CursorRef {
  uuid: string
  sessionId?: string
}

/**
 * The `before=` cursor for an entry: `encode_cursor` in
 * `server/src/sessions/recall.rs`, mirrored.
 *
 * The PAIR, not the bare uuid: project-scope reads merge several JSONLs whose
 * mtime order can change under concurrent writes, and the uuid alone would let
 * a cursor match the wrong file. A missing `sessionId` still produces the
 * server's own empty-sid form rather than a bare uuid, which its `decode_cursor`
 * rejects outright (it requires the `:`).
 */
export function historyCursor(entry: CursorRef): string {
  return `${entry.sessionId ?? ''}:${entry.uuid}`
}

/**
 * The cursor for the page BELOW everything currently on screen, from a
 * newest-first list. `null` when there is nothing to page from — an empty
 * transcript must never produce a fetch.
 */
export function oldestCursor(entries: readonly CursorRef[]): string | null {
  const oldest = entries[entries.length - 1]
  return oldest ? historyCursor(oldest) : null
}

/**
 * Tail (newest-first) + accumulated older pages (newest-first) → one
 * newest-first list, deduped by uuid.
 *
 * The dedupe is not paranoia: the tail refetches on every SSE tick, so a page
 * fetched a second ago can overlap the window it was fetched from the edge of,
 * and the same message drawn twice is QA #10's defect wearing a different hat.
 *
 * Returns the tail array ITSELF when there are no older pages, so the memo in
 * `use-chat-turn` (which re-runs on the 1s live-layer ticker) keeps its identity
 * and `toDisplayList` is not recomputed once a second for nothing.
 */
export function mergeOlder(
  tail: readonly ChatEntry[],
  older: readonly ChatEntry[],
): ChatEntry[] {
  if (older.length === 0) return tail as ChatEntry[]
  const seen = new Set<string>()
  const out: ChatEntry[] = []
  for (const e of tail) {
    if (seen.has(e.uuid)) continue
    seen.add(e.uuid)
    out.push(e)
  }
  for (const e of older) {
    if (seen.has(e.uuid)) continue
    seen.add(e.uuid)
    out.push(e)
  }
  return out
}

/**
 * THE SEAM — is the accumulated block still joined to the tail?
 * ─────────────────────────────────────────────────────────────────────────────
 * The block hangs under an ANCHOR: the entry that was the tail's oldest when
 * the block's first page was fetched. While that entry is still inside the
 * 30-entry window, the window covers everything above the block and the merged
 * list is one contiguous run.
 *
 * The window SLIDES, though, and the block does not. One new entry pushes the
 * window's bottom one entry up, and the entry it drops is then in neither list
 * — measured against the live server on a 600-entry transcript: one entry
 * landing after the user has paged back loses exactly one message out of the
 * MIDDLE of the conversation, twenty lose twenty, and nothing on the surface
 * says so. That is QA #3's own defect ("everything above the window is
 * unreachable") one window further down, so this is the check that catches it:
 * anchor gone from the tail ⇒ the seam is open and must be refilled before the
 * hole can be drawn.
 */
export function seamOpen(
  tail: readonly CursorRef[],
  block: { anchor: string | null; count: number },
): boolean {
  if (block.count === 0 || block.anchor == null) return false
  return !tail.some((e) => e.uuid === block.anchor)
}

/**
 * Does this fill page reach the anchor — i.e. do the two halves now join?
 *
 * The fill is fetched downward from the window's NEW bottom, so it covers the
 * dropped entries first; once it contains the anchor it also reaches the entry
 * directly above the block, and `mergeOlder` dedupes the overlap away.
 */
export function bridges(fill: readonly CursorRef[], anchor: string | null): boolean {
  if (anchor == null) return false
  return fill.some((e) => e.uuid === anchor)
}

/**
 * The block a repair leaves behind, or `null` for "keep what you had".
 *
 *  · bridged — the fill goes on top and the overlap dedupes away.
 *  · not bridged (a cursor the server can no longer find: a cleared or
 *    compacted transcript) — the fill REPLACES the block. What the reader had
 *    paged in cannot be joined to what is on screen any more, and one shorter
 *    honest conversation they can page back into beats a longer one with a
 *    hole in the middle of it.
 *  · nothing came back at all — change nothing, so a momentarily empty answer
 *    can never delete history the reader has already paged in. The anchor stays
 *    stale, so the next tail tick tries again.
 */
export function healedBlock(
  fill: readonly ChatEntry[],
  block: readonly ChatEntry[],
  bridged: boolean,
): ChatEntry[] | null {
  if (fill.length === 0) return null
  return bridged ? mergeOlder(fill, block) : (fill as ChatEntry[])
}

/** The scroll region as it was the instant the older page was asked for. */
export interface ScrollMark {
  scrollHeight: number
  scrollTop: number
}

/**
 * Where the scroll region must be put after a page is prepended, so that the
 * line the user was reading does not move: the same distance from the top of
 * the OLD content, which is the new height minus the old one, added on.
 *
 * Clamped at zero because a commit can also shrink the track (a superseded
 * provisional block collapsing in the same frame), and a negative `scrollTop`
 * is silently clamped by the browser — i.e. a jump to the very top, which is
 * exactly the disorientation this function exists to prevent.
 */
export function restoredScrollTop(before: ScrollMark, scrollHeight: number): number {
  return Math.max(0, before.scrollTop + (scrollHeight - before.scrollHeight))
}

/** Should the scroll handler ask for the previous page? */
export function shouldLoadOlder(s: {
  scrollTop: number
  hasOlder: boolean
  loading: boolean
}): boolean {
  return s.hasOlder && !s.loading && s.scrollTop < NEAR_TOP_PX
}

/** Is the newest message far enough off screen to offer a way back to it? */
export function jumpVisible(distanceFromBottom: number): boolean {
  return distanceFromBottom > JUMP_AWAY_PX
}
