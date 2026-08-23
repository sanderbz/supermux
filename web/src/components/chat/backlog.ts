/**
 * Back-pagination arithmetic (daily-driver QA #3) and the jump-to-bottom
 * threshold (QA #17).
 * ─────────────────────────────────────────────────────────────────────────────
 * Pure, dependency-free, and deliberately separate from the hook that fetches:
 * every number here is the kind a refactor breaks without a test noticing,
 * because a wrong one shows up as "the page jumped" or "the history has a hole
 * in it" rather than as an exception.
 *
 * WHICH ENDPOINT. `/api/sessions/{name}/chat/history` — the A2 backlog route,
 * which pages the same transcript the socket seeds from and speaks the same
 * `WireEntry`. This is the change QA #3 wrote itself against: it paged
 * `/recall?chat=true` because that was the tail's own route and `WireEntry` had
 * no adapter yet, and said in as many words that when the A2 socket landed its
 * callers would change their fetch and keep every rule below. The socket has
 * landed (`use-chat-ws.ts`), `wire-entries.ts` is the adapter, and every rule
 * below is kept — only the cursor's SPELLING moved, because the two routes
 * address an entry differently:
 *
 *   · `/recall`       `<session_id>:<uuid>`      (`encode_cursor`, recall.rs)
 *   · `/chat/history` `<conversation_id>:<offset>` (`HistoryCursor`, ws.rs)
 *
 * Paging in ONE wire format is the point either way: the merged list is
 * `WireEntry` end to end and `toChatEntries` adapts it once, so the seam and
 * the window can never disagree about what a message is.
 *
 * WHY THE CURSOR IS RECOMPUTED, never remembered. Unchanged, and for the same
 * reason: `nextBefore` describes the page boundary as it was when the frame was
 * sent, and paging from the oldest entry currently ON SCREEN is what makes a
 * hole between the two windows unrepresentable. It costs nothing here — a byte
 * offset is a stable address, so the recomputed cursor is exact rather than a
 * best effort.
 *
 * WHY THE OFFSET MUST COME FROM A MAIN-TRANSCRIPT ENTRY. `history_page` resolves
 * the cursor against the main JSONL and nothing else, while a subagent entry's
 * `offset` is a position in its OWN file. `seed_page` (ws.rs) skips subagent
 * entries when it picks `next_before` for exactly this reason; `oldestCursor`
 * mirrors that rule, because handing out a subagent offset pages from an
 * unrelated byte of the main transcript.
 */

/** The half of `WireEntry` the cursor arithmetic reads. */
export interface CursorRef {
  offset: number
  /** Present = this entry came from a subagent file, so its offset is not a
   *  position in the main transcript. */
  agent_id?: string
}

/**
 * What the merge and the seam need of an entry, and all they need: an identity.
 *
 * Generic on purpose. These rules are about the SHAPE of a paged conversation —
 * two lists, one order, no duplicates, no hole — and none of them cares whether
 * it is holding wire entries or display entries. The hook works in `WireEntry`
 * (that is what `/chat/history` returns, and adapting once at the end is what
 * keeps the window and the block from ever disagreeing); the tests reach the
 * same functions with `ChatEntry`. Neither is privileged.
 */
export interface Identified {
  uuid: string
}

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

/**
 * The `before=` cursor for a position in a conversation: `HistoryCursor::format`
 * in `server/src/sessions/chat/ws.rs`, mirrored.
 *
 * The conversation id is half of it on purpose, and the server enforces that:
 * a cursor whose id is not the session's current `cc_conversation_id` is a 409,
 * never bytes from a different conversation at the same offset. That is what
 * makes a `/clear`, a `--resume` or a restart under a paged-back reader a
 * re-seed instead of a silent splice.
 */
export function chatCursor(conversationId: string, offset: number): string {
  return `${conversationId}:${offset}`
}

/** The conversation id the server stamped into a cursor it handed us, so the
 *  client never has to guess at it. `null` for anything malformed — the same
 *  answer `HistoryCursor::parse` gives. */
export function cursorConversation(cursor: string | null): string | null {
  if (!cursor) return null
  const at = cursor.lastIndexOf(':')
  if (at <= 0 || at === cursor.length - 1) return null
  return cursor.slice(0, at)
}

/**
 * The cursor for the page BELOW everything currently on screen, from a
 * newest-first list. `null` when there is nothing to page from — an empty
 * transcript, an unknown conversation, or a window holding nothing but
 * subagent turns must never produce a fetch.
 */
export function oldestCursor(
  conversationId: string | null,
  entries: readonly CursorRef[],
): string | null {
  if (!conversationId) return null
  // Newest-first, so the LAST main entry is the oldest one on screen.
  for (let i = entries.length - 1; i >= 0; i--) {
    const e = entries[i]
    if (e.agent_id == null) return chatCursor(conversationId, e.offset)
  }
  return null
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
export function mergeOlder<T extends Identified>(
  tail: readonly T[],
  older: readonly T[],
): T[] {
  if (older.length === 0) return tail as T[]
  const seen = new Set<string>()
  const out: T[] = []
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
  tail: readonly Identified[],
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
export function bridges(fill: readonly Identified[], anchor: string | null): boolean {
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
export function healedBlock<T extends Identified>(
  fill: readonly T[],
  block: readonly T[],
  bridged: boolean,
): T[] | null {
  if (fill.length === 0) return null
  return bridged ? mergeOlder(fill, block) : (fill as T[])
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

/**
 * Should the client rescue an EMPTY seed with a direct history fetch, before
 * the surface can render "No conversation yet."?
 *
 * A seed can arrive empty even though a transcript exists on disk: after a
 * server restart the in-memory ring is cold and its re-seed can degenerate (a
 * final physical line larger than the seed budget snaps the tail cursor to
 * EOF), or the whole seed window can be non-renderable (all subagent/meta rows).
 * Such a seed also carries NO cursor, so the ordinary scroll-back never reaches
 * the working `/chat/history` route to self-heal. So when the seed is in, the
 * RENDERED list is empty, and this is NOT a genuinely fresh session
 * (`fresh` = the server's own "no transcript for this conversation"), fetch the
 * newest history page instead of blanking.
 *
 * `alreadyLoaded`/`exhausted` keep it to one attempt: a rescue that returned
 * entries is not empty any more, and one that found nothing marks `exhausted`.
 */
export function shouldRescueEmptySeed(s: {
  seeded: boolean
  fresh: boolean
  renderedCount: number
  alreadyLoaded: boolean
  exhausted: boolean
}): boolean {
  return (
    s.seeded &&
    !s.fresh &&
    s.renderedCount === 0 &&
    !s.alreadyLoaded &&
    !s.exhausted
  )
}

/** Is the newest message far enough off screen to offer a way back to it? */
export function jumpVisible(distanceFromBottom: number): boolean {
  return distanceFromBottom > JUMP_AWAY_PX
}

/**
 * How close to the bottom the reader has to be for new content to keep pinning.
 *
 * Lives here, beside `JUMP_AWAY_PX`, because it now has TWO readers — the
 * panel's scroll handler and the track's footer-growth follow below — and a
 * threshold copied into two files is one that drifts.
 */
export const FOLLOW_THRESHOLD_PX = 48

/**
 * The composer's glass just got taller. Should the track follow it?
 *
 * WHY THIS EXISTS. The track reserves room for the composer by MEASURING it
 * (`conversation.tsx` `trackBottom`), and that measurement is state inside the
 * conversation component — so when the composer grows (a refusal banner
 * appearing, a draft wrapping to a second line) only that subtree re-renders.
 * The panel's follow-bottom effect runs on renders of the PANEL, so it never
 * fired: the reserve grew, the scroll position did not move, and the newly
 * taller glass simply covered another 44px of whatever was at the bottom of the
 * band. Verified as the composer's own dialog refusal landing on top of the
 * dialog card it tells you to answer — it occluded the escape row entirely.
 *
 * `grewBy` has ALREADY been added to `scrollHeight` by the time this is asked,
 * so the distance the reader was at BEFORE the growth is the current one minus
 * it. Shrinking never scrolls: giving room back must not yank the view.
 */
export function followsFooterGrowth(
  m: { scrollHeight: number; scrollTop: number; clientHeight: number },
  grewBy: number,
): boolean {
  if (grewBy <= 0) return false
  return m.scrollHeight - m.scrollTop - m.clientHeight - grewBy < FOLLOW_THRESHOLD_PX
}
