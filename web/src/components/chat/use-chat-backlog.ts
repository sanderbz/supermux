// Back-pagination for the chat window (daily-driver QA #3, on the A2 socket).
// ─────────────────────────────────────────────────────────────────────────────
// The socket's window is a WINDOW: one seed page, then whatever has been pushed
// since. Everything above it was unreachable — the QA scrolled to
// `scrollTop = 0` six times on a large session and `scrollHeight` never moved.
// This hook is the rest of that conversation: an append-only accumulator of
// older pages, merged above the window into one list.
//
// WHAT CHANGED WITH THE SOCKET. QA #3 wrote this against the A1
// `/recall?chat=true` poll and said its callers would move to `/chat/history`
// when A2 landed. They have. The RULES are the same ones, and they still live
// next door in `backlog.ts` where a test can reach them; what moved is:
//
//   · the route — `/api/sessions/{name}/chat/history`, which pages the same
//     transcript the socket seeds from and speaks the same `WireEntry`;
//   · the cursor — `<conversation_id>:<offset>` (`HistoryCursor`) instead of
//     recall's `<session_id>:<uuid>`;
//   · the domain — the accumulator holds WIRE entries and `toChatEntries`
//     adapts the MERGED list once, so the window and the block below it cannot
//     be built by two passes that disagree.
//
// WHY NOT `useInfiniteQuery`. Its page chain is keyed on the cursor it was
// fetched with, and this cursor cannot be remembered — the window it is measured
// from moves under it while a turn runs (see `backlog.ts` for the hole that
// creates). What is cached here is not "page 2 of a stable list", it is "the
// entries below whatever is currently on screen": an accumulator, not a query.

import * as React from 'react'

import { SessionError, sessionRequest } from '@/lib/api/sessions'

import {
  bridges,
  cursorConversation,
  healedBlock,
  mergeOlder,
  oldestCursor,
  seamOpen,
  BRIDGE_MAX_PAGES,
  OLDER_PAGE_LIMIT,
} from './backlog'
import { toChatEntries } from './wire-entries'
import type { ChatEntry } from './entries'
import type { WireEntry } from './wire'
import type { ChatWireView } from './use-chat-ws'

export interface ChatBacklog {
  /** The window plus every older page loaded so far, newest-first, deduped,
   *  adapted to the renderer's display shape. */
  entries: ChatEntry[]
  /** There is a page below what is on screen. */
  hasOlder: boolean
  /** A page is in flight. */
  loadingOlder: boolean
  /** The last attempt failed — the head states it and offers the retry. */
  olderError: boolean
  /** Everything this conversation holds is on screen. */
  atStart: boolean
  /** Fetch the page below the OLDEST entry currently on screen. Idempotent
   *  while one is in flight, so the scroll handler may call it every frame. */
  loadOlder: () => void
  /** Bumped once per landed page — the scroll restorer's edge (it must run in
   *  the commit that prepends, and only in that one). */
  pagesLoaded: number
}

/** `GET /api/sessions/{name}/chat/history` — `sessionRequest` unwraps the
 *  `{ok,data}` envelope and throws a `SessionError` carrying the status (400
 *  for a malformed cursor, 409 for one from a different conversation). */
interface HistoryPage {
  entries?: WireEntry[]
  has_more?: boolean
  next_before?: string | null
}

async function fetchHistory(
  name: string,
  before: string,
  limit: number,
): Promise<HistoryPage> {
  const qs = new URLSearchParams({ before, limit: String(limit) })
  return sessionRequest<HistoryPage>(
    `/api/sessions/${encodeURIComponent(name)}/chat/history?${qs.toString()}`,
  )
}

/**
 * The accumulator, WITH the conversation it belongs to.
 *
 * Carrying the identity inside the state is what makes switching sessions — and
 * re-seeding onto a different conversation — safe without a reset effect: a
 * state that names another conversation is simply not this one's state, read as
 * empty in the same render (an effect would paint one frame of the previous
 * conversation's history under this one's window). It also makes every writer's
 * guard trivial — a functional update whose `prev` names a different
 * conversation drops itself, which is exactly what an in-flight page for the
 * conversation the user just left should do.
 */
interface Backlog {
  name: string
  /** The socket's re-seed generation. A `resync` means the server is serving a
   *  DIFFERENT conversation, and the cursors this block was paged with are the
   *  ones its 409 exists to reject. */
  epoch: number
  /** Newest-first, like the window it hangs under. */
  older: WireEntry[]
  /**
   * The entry the block hangs under: the window's oldest at the moment the
   * first page was asked for. `seamOpen` in `backlog.ts` reads this to notice
   * when the two halves have come apart, and the repair below refills before
   * the hole can be drawn.
   */
  anchor: string | null
  loading: boolean
  error: boolean
  /** A page has come back with `has_more: false` — the transcript is fully in. */
  exhausted: boolean
  pages: number
}

/** Stable identity so an untouched backlog does not churn the merge memo. */
const NO_OLDER: WireEntry[] = []

const emptyFor = (name: string, epoch: number): Backlog => ({
  name,
  epoch,
  older: NO_OLDER,
  anchor: null,
  loading: false,
  error: false,
  exhausted: false,
  pages: 0,
})

export function useChatBacklog(name: string, tail: ChatWireView): ChatBacklog {
  const epoch = tail.resyncCount
  const [stored, setStored] = React.useState<Backlog>(() => emptyFor(name, epoch))
  const state =
    stored.name === name && stored.epoch === epoch ? stored : emptyFor(name, epoch)

  // The window, newest-first — the order every rule in `backlog.ts` is written
  // in. The socket holds it oldest-first (that is the order the seed arrives in
  // and live frames extend), so this is the one place the two orders meet.
  const windowEntries = React.useMemo(
    () => tail.wire.slice().reverse(),
    [tail.wire],
  )
  const merged = React.useMemo(
    () => mergeOlder(windowEntries, state.older),
    [windowEntries, state.older],
  )
  // One adaptation, over one list. `toChatEntries` reads oldest-first (it folds
  // each `tool_result` into the receipt above it), and answers newest-first.
  const entries = React.useMemo(
    () => toChatEntries(merged.slice().reverse()),
    [merged],
  )

  // The conversation the server stamped into its own cursor. Everything this
  // hook fetches is addressed within it, and a page fetched under a different
  // one is a page from another conversation.
  //
  // The seed's `next_before` is the only source for it, and it is exactly as
  // available as it needs to be: the server sends it whenever `has_more` is
  // true, and when `has_more` is false there is no backlog to address. It
  // survives every live frame (only a seed rewrites it), so it is still there
  // for the fifth page and for the seam repair.
  const conversation = cursorConversation(tail.nextBefore)

  // `has_more` on the seed answers "is there anything below this window"; once a
  // page comes back with `has_more: false` the conversation is fully loaded, and
  // the seed's own (still true) flag must not undo that.
  const hasOlder = tail.hasMore && !state.exhausted

  // Read from the list as it is NOW, every render — never a remembered cursor
  // (`backlog.ts`: paging from the oldest entry on screen is what makes a hole
  // between the two windows unrepresentable).
  const before = oldestCursor(conversation, merged)

  // Not the `loading` flag: two scroll events dispatched before the next render
  // both read the state from before the first `setStored`, and the second would
  // fire a duplicate page. This flips synchronously, inside the callback.
  const inFlight = React.useRef(false)

  // The entry the block hangs under. Read at request time from the WINDOW, not
  // from the merged list: it is the window's own bottom edge that the seam check
  // watches for, and only an empty block sets it (a second page extends the
  // block downward and leaves its top — and so its anchor — where it was).
  const windowAnchor = windowEntries[windowEntries.length - 1]?.uuid ?? null

  const loadOlder = React.useCallback(() => {
    if (inFlight.current || !hasOlder || !before) return
    inFlight.current = true
    setStored((prev) =>
      prev.name === name && prev.epoch === epoch
        ? {
            ...prev,
            loading: true,
            error: false,
            anchor: prev.older.length === 0 ? windowAnchor : prev.anchor,
          }
        : { ...emptyFor(name, epoch), loading: true, anchor: windowAnchor },
    )
    fetchHistory(name, before, OLDER_PAGE_LIMIT)
      .then((page) => {
        // The page arrives oldest-first; the accumulator is newest-first.
        const got = (page.entries ?? []).slice().reverse()
        setStored((prev) => {
          // The conversation changed while this was in flight: its transcript is
          // not this page's, and splicing it in is the one thing a chat data
          // plane may never do.
          if (prev.name !== name || prev.epoch !== epoch) return prev
          return {
            ...prev,
            // Appended raw; `mergeOlder` owns the dedupe, so an overlap with
            // the window cannot double a message.
            older: got.length > 0 ? [...prev.older, ...got] : prev.older,
            // No entries can only mean the cursor sits at the bottom of the
            // file (or points into a conversation that has since been
            // cleared) — either way there is nothing more to fetch, and
            // retrying would loop.
            exhausted: prev.exhausted || page.has_more !== true || got.length === 0,
            loading: false,
            error: false,
            pages: prev.pages + 1,
          }
        })
      })
      .catch((err: unknown) => {
        const stale = err instanceof SessionError && err.status === 409
        // Retryable on purpose: `exhausted` stays false, so the head keeps the
        // control and says what happened. A silently dropped page is the defect.
        //
        // …except a 409, which is the server saying this cursor belongs to a
        // conversation it is no longer serving. Retrying that can only fail
        // again, and the block it was extending is the old conversation's. The
        // socket re-seeds on its own; the block goes with the cursor.
        setStored((prev) => {
          if (prev.name !== name || prev.epoch !== epoch) return prev
          if (stale) return { ...emptyFor(name, epoch), error: true }
          return { ...prev, loading: false, error: true }
        })
      })
      .finally(() => {
        inFlight.current = false
      })
  }, [before, epoch, hasOlder, name, windowAnchor])

  // ── the seam repair ────────────────────────────────────────────────────────
  // The window's oldest edge moves on a RE-SEED. Live `entry` frames only ever
  // append, so within one seed generation the window and the block stay joined
  // — the continuous slide QA #3 measured against the poll (slide 1 → 1 message
  // gone, slide 20 → 20) cannot happen on a pushed source. A reconnect can
  // still land a seed whose oldest entry is newer than the block's top, though,
  // and then everything between them belongs to NEITHER list: the same hole,
  // reached a different way. So: when the anchor is no longer in the window,
  // fetch downward from the window's new bottom until the two halves join, and
  // put the fill on top of the block.
  //
  // It does NOT touch `loading`: that flag is the head's "Loading earlier
  // messages…" state, and this repair is the client keeping its own promise
  // rather than something the reader asked for. It also adds its entries BELOW
  // the window — i.e. above a reader who has scrolled back — so nothing under
  // the eye moves and no scroll restoration is owed.
  const healing = React.useRef(false)
  const windowOldest = windowEntries[windowEntries.length - 1]
  React.useEffect(() => {
    if (healing.current || inFlight.current || !windowOldest || !conversation) return
    const anchor = state.anchor
    if (!seamOpen(windowEntries, { anchor, count: state.older.length })) return
    healing.current = true
    void (async () => {
      const fill: WireEntry[] = []
      let cursor = oldestCursor(conversation, windowEntries)
      let bridged = false
      for (let i = 0; i < BRIDGE_MAX_PAGES && cursor; i++) {
        const page = await fetchHistory(name, cursor, OLDER_PAGE_LIMIT)
        const got = (page.entries ?? []).slice().reverse()
        fill.push(...got)
        if (bridges(got, anchor)) {
          bridged = true
          break
        }
        if (got.length === 0 || page.has_more !== true) break
        cursor = oldestCursor(conversation, got)
      }
      setStored((prev) => {
        if (prev.name !== name || prev.epoch !== epoch || prev.anchor !== anchor) {
          return prev
        }
        const healed = healedBlock(fill, prev.older, bridged)
        // Nothing usable came back: leave the block AND the stale anchor alone,
        // so the next window change tries again instead of deleting history the
        // reader has already paged in.
        if (!healed) return prev
        return { ...prev, older: healed, anchor: windowOldest.uuid }
      })
    })()
      // Left for the next window change on purpose: the repair is not a thing
      // the reader asked for, so it gets no error state of its own, and any
      // frame that changes the transcript re-runs this effect.
      .catch(() => {})
      .finally(() => {
        healing.current = false
      })
  }, [
    conversation,
    epoch,
    name,
    state.anchor,
    state.older,
    windowEntries,
    windowOldest,
  ])

  return {
    entries,
    hasOlder,
    loadingOlder: state.loading,
    olderError: state.error,
    // `!seeded` is "the first page has not arrived yet", which is not the same
    // statement as "this is where the conversation begins".
    atStart: tail.seeded && !hasOlder,
    loadOlder,
    pagesLoaded: state.pages,
  }
}
