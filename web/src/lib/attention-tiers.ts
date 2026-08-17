/**
 * The three-tier attention model — provider-neutral by construction.
 * ─────────────────────────────────────────────────────────────────────────────
 * NOT `components/chat/attention.ts`. That module (A4) is the renderer's
 * honesty copy — what to SAY when the chat surface cannot show a live dialog.
 * This one answers a different question for every row of the roster: does this
 * session want you, has it said something since you last looked, is it working,
 * or is it quiet.
 *
 * ── The correction this module exists for ───────────────────────────────────
 * The master plan wanted unread built on the `chat_tail` SSE delta. It cannot
 * be. `chat_tail` exists only *while a chat client is attached* (plus the
 * tailer's grace period) — the SSE producer deliberately uses the non-creating
 * `chat_store()` accessor so it "must not spin up a store for a session nobody
 * is watching". A roster is precisely the list of sessions nobody has open, so
 * on a roster `chat_tail` is absent for almost every row.
 *
 * So the ladder is inverted. The PRIMARY stamp is provider-neutral and always
 * present:
 *
 *   chat_tail.last_entry_ts  (only when a store happens to exist — CC's clock)
 *     ↓ else
 *   activity_at              (server-clock ms, stamped on every activity delta)
 *     ↓ else
 *   last_activity            (epoch SECONDS — the older field)
 *     ↓ else
 *   updated_at               (RFC3339)
 *
 * Every row gets a tier, whatever its provider (claude, codex), whatever
 * its host, team-ness or chat eligibility. `tierFor` has no `undefined` return
 * path, and there is no fourth eligibility gate here: `chat/flag.ts::chatEligible`
 * and `chat/ws.rs::chat_eligible` stay the only ones, and an INELIGIBLE session
 * still gets a tier from the neutral ladder.
 *
 * ── No wrong numbers ────────────────────────────────────────────────────────
 * A *count* is rendered only when the delta carried `entry_count` AND the store
 * epoch matches the one the cursor was recorded under. A store is created and
 * dropped many times a day and its seq counter restarts at 0 each time, so a
 * mismatched (or decreasing) count degrades to a dot. A dot that says "something
 * happened" is honest; a badge that says "3" when it means "unknown" is not.
 *
 * Pure: no React, no storage, no clock of its own — `now` is a parameter.
 */
import type { ApiSession } from '@/lib/api/sessions'

/** The tiers, in PRECEDENCE order. `quiet` is the absence of a tier. */
export const TIERS = ['needs', 'unread', 'working', 'quiet'] as const
export type Tier = (typeof TIERS)[number]

/** What the client remembers about the last time you looked at a session. */
export interface SeenCursor {
  /** Server-clock ms at which the session was last opened/marked read. */
  ts: number
  /** `chat_tail.entry_count` at that moment, if a store existed. */
  count?: number
  /** The store epoch `count` was recorded under. A different epoch ⇒ the count
   *  is a different counter and must not be subtracted. */
  epoch?: number
  /** This cursor was written by "Mark unread", not by reading.
   *
   *  It is NOT decoration. Two things depend on it:
   *
   *  * `markUnread` cannot express itself by DELETING the cursor. `tierFor`
   *    treats "no cursor" as *never opened*, which is deliberately quiet (the
   *    #41/#43 false-positive class), so deleting was arithmetically incapable
   *    of marking anything unread. Instead it rewinds `ts` to just BEFORE the
   *    row's own activity stamp, which is the one value that makes the ordinary
   *    `stamp > seen` comparison say `unread` without inventing a second rule.
   *  * Since B5 the server persists its own cursor and `mergeCursors` takes the
   *    newer of the two — and the server's is always newer than a rewind. So a
   *    deliberate local rewind has to be able to win, and this flag is how it
   *    says so. See `mergeCursors`. */
  unread?: true
}

/** The subset of a session this module reads. `ApiSession` satisfies it. */
export type AttentionSession = Pick<
  ApiSession,
  | 'name'
  | 'status'
  | 'error'
  | 'blocked'
  | 'permission_request'
  | 'chat_tail'
  | 'activity_at'
  | 'last_activity'
  | 'updated_at'
  | 'archived'
  // B5/T4 — the server-persisted seen cursor. Present so the merge in
  // `use-attention.ts` can read it off the same row it already has, without a
  // second request.
  | 'seen_ts'
  | 'seen_count'
  | 'seen_epoch'
>

/** The server's persisted cursor for a session, if it has ever been read on any
 *  device (B5/T4). `null`/absent `seen_ts` means never seen.
 *
 *  Split out from the row so the newest-wins merge has something to name. It is
 *  field-for-field the same triple as [`SeenCursor`] — that is the point: the
 *  server persists the shape the client already had, so merging is a comparison
 *  and not a translation. */
export function serverCursor(s: AttentionSession): SeenCursor | undefined {
  const ts = s.seen_ts
  if (typeof ts !== 'number' || !Number.isFinite(ts)) return undefined
  return {
    ts,
    ...(typeof s.seen_count === 'number' ? { count: s.seen_count } : {}),
    ...(typeof s.seen_epoch === 'number' ? { epoch: s.seen_epoch } : {}),
  }
}

/** The cursor "Mark unread" writes.
 *
 *  One millisecond BEFORE the row's own activity stamp, so the ordinary
 *  `stamp > seen` comparison in `tierFor` reports `unread` — no second rule, no
 *  sentinel tier. `count`/`epoch` are deliberately dropped: the row is unread
 *  again, and we no longer know how many of its entries you had read, so it
 *  degrades to a dot rather than to a wrong number.
 *
 *  A row with no stamp at all (`activityStamp === 0` — a session that has never
 *  reported activity) cannot be marked unread: there is no "since" to be after.
 *  It returns a cursor at 0, which `tierFor` reads as no cursor, i.e. quiet. */
export function unreadCursorFor(s: AttentionSession): SeenCursor {
  const stamp = activityStamp(s)
  return { ts: stamp > 0 ? stamp - 1 : 0, unread: true }
}

/** Newest-wins merge of the local and server cursors (B5/T4.4).
 *
 *  localStorage is NOT replaced by the server cursor — it stays as the
 *  offline/optimistic layer, and it is what makes `markRead` feel instant (the
 *  network write is fire-and-forget behind it). So at any moment there can be
 *  two answers, and the rule is simply the later one:
 *
 *  * local only   → local (the write has not landed yet, or we are offline)
 *  * server only  → server (a fresh device, or one that cleared its storage)
 *  * both         → whichever `ts` is greater
 *
 *  Ties go to LOCAL. A tie means the same read, and preferring local keeps the
 *  count/epoch this device actually observed rather than a round-tripped copy.
 *
 *  ONE exception, and it is the whole reason `SeenCursor.unread` exists: a local
 *  cursor written by "Mark unread" always wins. Newest-wins would otherwise undo
 *  it on the very next render — the server cursor is a real read that really did
 *  happen later, so it is always newer than the rewind. "Come back to this" is a
 *  private note to yourself on this device (`markUnread` is local-only by
 *  design); a note that a background sync erases is not a note. */
export function mergeCursors(
  local: SeenCursor | undefined,
  server: SeenCursor | undefined,
): SeenCursor | undefined {
  if (!local) return server
  if (!server) return local
  if (local.unread) return local
  return server.ts > local.ts ? server : local
}

/**
 * The activity stamp, in SERVER-CLOCK milliseconds, down the documented ladder.
 *
 * `chat_tail.last_entry_ts` is deliberately NOT first for the comparison: it is
 * Claude Code's clock and can trail arrival by tens of seconds (measured in A0),
 * so using it as the unread boundary would mark a session read that had spoken
 * after you looked. It is used only when nothing else exists at all — a session
 * whose only evidence of life is its chat ring.
 */
export function activityStamp(s: AttentionSession): number {
  if (typeof s.activity_at === 'number' && s.activity_at > 0) return s.activity_at
  if (typeof s.last_activity === 'number' && s.last_activity > 0) {
    // Epoch SECONDS on the wire — the older field. Multiplying is the whole of
    // the domain conversion, and getting it wrong makes every session look 1970.
    return s.last_activity * 1000
  }
  if (s.updated_at) {
    const t = Date.parse(s.updated_at)
    if (!Number.isNaN(t)) return t
  }
  const tail = s.chat_tail?.last_entry_ts ?? s.chat_tail?.ts
  if (typeof tail === 'number' && tail > 0) return tail
  return 0
}

/** Does this session have a live, undecided demand on the user? */
function needsYou(s: AttentionSession): boolean {
  // `waiting` is the detector's own "a prompt is on screen" status.
  if (s.status === 'waiting') return true
  // A live permission dialog — already on the wire since A1.
  if (s.permission_request) return true
  // §12.2 promotes `error` alongside: a blocked agent has three affordances in
  // the app and must not vanish just because it is not technically "waiting".
  // NOTE the field, not a status: the Rust `Status` enum has no Error variant —
  // errors ride the separate `error:{type,message}` delta key.
  if (s.error) return true
  // A BLOCKED session — a usage limit reached, or a startup gate nobody has
  // answered. Same promotion as `error`, for a stronger reason: this is the one
  // condition the roster was structurally unable to see. It rides no status
  // (a limit-hit turn ends with a `Stop`, so the detector says `idle`) and no
  // hook (`StopFailure` does not fire for the banner), so before this field the
  // row sat green and quiet while the session was dead for five hours — and a
  // startup wedge sat green and quiet forever (verify matrix finding 1).
  //
  // NEEDS-YOU rather than merely "not quiet", because both halves want a human:
  // a wedge needs an answer, and a limit needs a decision about what to do for
  // the next five hours.
  if (s.blocked) return true
  return false
}

/**
 * The tier for one row. Total: every session gets one.
 *
 * Precedence is `needs` → `unread` → `working` → `quiet`, and it is a
 * precedence, not a union: a session that is both working and waiting is
 * `needs`, because that is the one the user has to act on.
 */
export function tierFor(
  s: AttentionSession,
  cursor?: SeenCursor,
  now: number = Date.now(),
): Tier {
  if (needsYou(s)) return 'needs'

  const stamp = activityStamp(s)
  // A cursor from the future — clock skew between two devices, or a server whose
  // clock moved — must not silence a session forever, so it is clamped. The
  // ceiling is `max(now, stamp)` and NOT `now`, because `cursorFor` deliberately
  // records `max(now, activityStamp)`: a session whose stamp is ahead of this
  // client's clock would otherwise be unread again the instant you closed it.
  const seen = cursor ? Math.min(cursor.ts, Math.max(now, stamp)) : 0
  // No cursor at all ⇒ never opened, and that is deliberately NOT unread. A
  // fresh install (or a new device) would otherwise light up every row in the
  // roster at once — the #41/#43 false-positive class this model exists to
  // avoid. A session you have never opened is quiet until it says something
  // AFTER you started watching.
  if (stamp > 0 && seen > 0 && stamp > seen) return 'unread'

  if (s.status === 'active' || s.status === 'starting') return 'working'
  return 'quiet'
}

/**
 * How many entries arrived since the cursor — or `null`, which means "render a
 * dot, not a number".
 *
 * `null` for every honest reason there is: no store attached, a pre-B2 server,
 * a cursor with no count, a different epoch (the store was dropped and rebuilt,
 * so the counter restarted), or a count that went DOWN.
 */
export function unreadCount(s: AttentionSession, cursor?: SeenCursor): number | null {
  const tail = s.chat_tail
  if (!tail || typeof tail.entry_count !== 'number') return null
  if (!cursor || typeof cursor.count !== 'number') return null
  // The epoch is what makes the seq domain safe. Both sides must have one, and
  // they must agree.
  if (typeof tail.epoch !== 'number' || cursor.epoch !== tail.epoch) return null
  const delta = tail.entry_count - cursor.count
  if (delta <= 0) return null
  return delta
}

/** Which of the two "look at me" tiers a row's dot is drawn for, or `null` for
 *  no dot. Surfaces need the DISTINCTION, not just the boolean: a red needs-you
 *  dot and a calm unread dot are different promises. */
export type DotKind = 'needs' | 'unread'

/** A row's full attention state — what a surface actually renders. */
export interface Attention {
  tier: Tier
  /** `true` for `needs` AND for `unread` — the dot on the mark's shoulder.
   *
   *  It used to be `needs` only, which made the middle tier of a three-tier
   *  model pixel-identical to a quiet row: `unread` was computed, ordered on and
   *  counted, and then drawn nowhere. A tier nothing draws is not a tier. */
  dot: boolean
  /** WHICH dot — `needs` is the red demand, `unread` the calm "it spoke since
   *  you looked". `null` when there is no dot. */
  dotKind: DotKind | null
  /** A number, or `null` for "a dot, no number". */
  count: number | null
  /** The stamp the tier was decided on (server-clock ms). Ordering key. */
  stamp: number
}

export function attentionFor(
  s: AttentionSession,
  cursor?: SeenCursor,
  now: number = Date.now(),
): Attention {
  const tier = tierFor(s, cursor, now)
  const dotKind: DotKind | null = tier === 'needs' ? 'needs' : tier === 'unread' ? 'unread' : null
  return {
    tier,
    dot: dotKind !== null,
    dotKind,
    count: tier === 'unread' ? unreadCount(s, cursor) : null,
    stamp: activityStamp(s),
  }
}

/**
 * The ordered needs-attention list for the overview header's rollup.
 *
 * Oldest-waiting FIRST: the session that has been blocked longest is the one
 * you are keeping waiting. Archived rows are excluded entirely — an archived
 * session cannot want anything.
 */
export function rollup(
  sessions: readonly AttentionSession[],
  cursors: ReadonlyMap<string, SeenCursor> = new Map(),
  now: number = Date.now(),
): AttentionSession[] {
  return sessions
    .filter((s) => !s.archived)
    .filter((s) => tierFor(s, cursors.get(s.name), now) === 'needs')
    .sort((a, b) => {
      const sa = activityStamp(a)
      const sb = activityStamp(b)
      // A session with no stamp at all sorts last rather than first: "unknown"
      // is not "ancient".
      if (sa === 0 && sb === 0) return a.name < b.name ? -1 : 1
      if (sa === 0) return 1
      if (sb === 0) return -1
      return sa - sb
    })
}

/** Rows that are unread, for the same header cluster's secondary count. */
export function unreadSessions(
  sessions: readonly AttentionSession[],
  cursors: ReadonlyMap<string, SeenCursor> = new Map(),
  now: number = Date.now(),
): AttentionSession[] {
  return sessions
    .filter((s) => !s.archived)
    .filter((s) => tierFor(s, cursors.get(s.name), now) === 'unread')
}

/** The cursor to record when a session is opened (or marked read). */
export function cursorFor(s: AttentionSession, now: number = Date.now()): SeenCursor {
  const tail = s.chat_tail
  // The cursor's own stamp is the SERVER clock — the domain every comparison
  // happens in. `Date.now()` is the client's clock, which is the closest thing
  // to it we have without a skew sample; the activity stamp is used when it is
  // AHEAD of us, so a session that spoke "in the future" is not instantly unread.
  const ts = Math.max(now, activityStamp(s))
  if (tail && typeof tail.entry_count === 'number' && typeof tail.epoch === 'number') {
    return { ts, count: tail.entry_count, epoch: tail.epoch }
  }
  return { ts }
}
