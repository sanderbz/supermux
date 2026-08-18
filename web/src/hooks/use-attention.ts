/**
 * Seen-cursors, and the attention tier for every row.
 * ─────────────────────────────────────────────────────────────────────────────
 * The arithmetic lives in `lib/attention-tiers.ts` (pure). This is the part with
 * state: where the cursors are kept, when they are written, and how a surface
 * asks for one row's tier.
 *
 * ── Why localStorage and not the prefs blob ─────────────────────────────────
 * `overview_layout` is a single whole-value PUT. Read-state changes every time
 * you open a session — putting it in the blob would mean a ~50 KB write per
 * session open, and (worse) two devices would clobber each other's read state
 * on every round trip. §12.2 is explicit: seen-cursors are per-device, and the
 * cross-device version is `PATCH /api/sessions/{name}/seen`, which B5 shipped.
 *
 * ── The two layers, since B5/T4 ─────────────────────────────────────────────
 * localStorage was NOT replaced. It is still the write-through layer, and it is
 * what makes `markRead` instant: the network PATCH is fire-and-forget behind
 * it, so a slow or absent connection never delays the dot going away. The
 * server cursor is what makes the read FOLLOW you — mark a session read on the
 * desktop and the phone's roster agrees without a reload.
 *
 * Reads merge the two newest-wins (`mergeCursors`), ties to local. The server
 * is monotonic, so a stale tab replaying an hour-old cursor is a no-op there
 * and cannot un-read anything.
 *
 * ── Pruning ─────────────────────────────────────────────────────────────────
 * Cursors are keyed by session name and sessions are deleted all day. The map is
 * pruned against the live roster on rehydrate (the `ui-store.ts` legacy-carry
 * precedent), so a year of deleted sessions cannot silently grow the key.
 */
import * as React from 'react'
import { useQuery } from '@tanstack/react-query'

import { sessionsApi, type ApiSession } from '@/lib/api/sessions'
import { SESSIONS_KEY } from '@/hooks/use-sessions'

import {
  attentionFor,
  cursorFor,
  mergeCursors,
  rollup,
  serverCursor,
  tierFor,
  unreadCursorFor,
  type Attention,
  type AttentionSession,
  type SeenCursor,
} from '@/lib/attention-tiers'
import { isAttentionEnabled } from '@/lib/attention-flag'

const STORAGE_KEY = 'supermux:seen'

/** `{ [sessionName]: SeenCursor }`, one localStorage key for the whole map.
 *  One key rather than `supermux:seen:<name>` per session: a roster of 40 would
 *  otherwise be 40 reads on every mount, and the map is a few hundred bytes. */
export type SeenMap = Record<string, SeenCursor>

function readSeen(): SeenMap {
  if (typeof localStorage === 'undefined') return {}
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return {}
    const parsed: unknown = JSON.parse(raw)
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {}
    const out: SeenMap = {}
    for (const [name, v] of Object.entries(parsed as Record<string, unknown>)) {
      const c = v as Partial<SeenCursor> | null
      // A malformed entry is dropped rather than trusted: a cursor with a
      // garbage `ts` would silence a session forever, which is the one failure
      // mode this whole model is trying to avoid.
      if (!c || typeof c.ts !== 'number' || !Number.isFinite(c.ts)) continue
      out[name] = {
        ts: c.ts,
        ...(typeof c.count === 'number' ? { count: c.count } : {}),
        ...(typeof c.epoch === 'number' ? { epoch: c.epoch } : {}),
        // The "Mark unread" flag has to survive the round trip through storage,
        // or a reload silently un-marks every row you flagged.
        ...(c.unread === true ? { unread: true as const } : {}),
      }
    }
    return out
  } catch {
    return {}
  }
}

function writeSeen(map: SeenMap): void {
  if (typeof localStorage === 'undefined') return
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(map))
  } catch {
    /* quota / private mode — read state is a nicety, never an error */
  }
}

/** The separator that joins the roster into one memo key.
 *
 *  NUL, because a session name cannot contain one — a space could, and the
 *  roster signature is compared as a whole string.
 *
 *  It is a CONSTANT and not two literals for the reason this whole seam exists:
 *  the signature was joined with `\0` and split with `' '`, so `live` held one
 *  NUL-joined blob that matched no session name, every stored cursor was judged
 *  dead, and the first render after boot rewrote the map to `{}`. One character,
 *  and it silently deleted every seen-cursor and every "Mark unread" on the
 *  device. Join and split must read the same name or they will drift again. */
const ROSTER_SEP = '\u0000'

/** The roster's memo key — the live session names, order-independent. */
export function rosterSignature(names: readonly string[]): string {
  return [...names].sort().join(ROSTER_SEP)
}

/**
 * Drop the cursors whose session is no longer on the roster.
 *
 * Pure, and exported, so the join/split symmetry above is pinned by a test
 * rather than by a comment: the shipped bug was invisible to the 76 green
 * attention tests because every one of them tested the arithmetic module and
 * none of them tested this seam.
 *
 * Returns `null` when nothing was dropped — a steady-state roster must not
 * rewrite storage on every render.
 *
 * `loaded` disambiguates the EMPTY signature, which used to be conflated: an
 * empty roster is either "the query has not resolved yet" (must NOT prune, or
 * boot would wipe every cursor before the first list arrives) or "the last
 * session was deleted" (MUST prune, or a lifetime of dead cursors accumulates
 * and a reused name inherits the old one). Only the caller knows which, so it
 * passes `loaded`: prune against the empty set only once the roster is real.
 */
export function pruneSeen(
  stored: SeenMap,
  signature: string,
  loaded = false,
): SeenMap | null {
  // No roster yet (not loaded) — never prune blind. A genuinely-empty but
  // LOADED roster (last session deleted) falls through and prunes everything.
  if (!signature && !loaded) return null
  const live = signature ? new Set(signature.split(ROSTER_SEP)) : new Set<string>()
  const kept: SeenMap = {}
  let dropped = 0
  for (const [name, cursor] of Object.entries(stored)) {
    if (live.has(name)) kept[name] = cursor
    else dropped++
  }
  return dropped > 0 ? kept : null
}

export interface AttentionApi {
  /** One row's attention state. `quiet` for everything when the kill switch is
   *  off, so a caller never has to check the flag itself. */
  attentionFor: (s: AttentionSession) => Attention
  /** The ordered needs-you list for the header rollup (oldest waiting first). */
  needs: AttentionSession[]
  /** Record "I have seen this" — called when a session is opened. */
  markRead: (s: AttentionSession) => void
  /** Rewind the cursor so the row lights up again (the row kebab's Mark
   *  unread). Takes the ROW, not the name: the rewind is expressed relative to
   *  the session's own activity stamp, which only the row carries. */
  markUnread: (s: AttentionSession) => void
  enabled: boolean
}

const NOOP: Attention = { tier: 'quiet', dot: false, dotKind: null, count: null, stamp: 0 }

/**
 * The attention state for a roster.
 *
 * Takes the sessions rather than fetching them: the overview, the focus strip
 * and the rollup all already have the list, and a hook that fetched would either
 * duplicate the SSE handlers (see `use-roster-marks.ts`) or invent a second
 * source of truth.
 */
export function useAttention(
  sessions: readonly AttentionSession[],
  loaded = false,
): AttentionApi {
  // The flag is a kill switch, not a preference: read once, no re-render.
  const [enabled] = React.useState(isAttentionEnabled)
  const [seen, setSeen] = React.useState<SeenMap>(() => readSeen())

  // Prune on roster change: cursors for sessions that no longer exist are dead
  // weight, and the roster is the only thing that can say so. Guarded on an
  // actual removal so a steady state never writes.
  const names = React.useMemo(
    () => rosterSignature(sessions.map((s) => s.name)),
    [sessions],
  )
  React.useEffect(() => {
    // Prune BOTH storage AND the in-memory map. The earlier version wrote only
    // storage on the theory that a stale cursor "cannot affect the UI, there is
    // no row to render it on" — but names are REUSABLE, so a delete+recreate of
    // the same name in one app lifetime would let the recreated session inherit
    // the old in-memory cursor (and its `unread` flag), suppressing or
    // fabricating unread state. Dropping the cursor from memory too is the fix.
    // `loaded` lets a genuinely-empty roster (last session deleted) prune,
    // which the old empty-signature short-circuit could never do. A prune fires
    // only on an actual delete, so the single re-render it costs is rare and
    // correct — not the per-render cascade the old comment feared.
    const kept = pruneSeen(readSeen(), names, loaded)
    if (kept) {
      writeSeen(kept)
      // A delete (rare) MUST evict the cursor from memory too, or a reused name
      // inherits it — see the block comment above. Not a per-render cascade.
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setSeen(kept)
    }
  }, [names, loaded])

  const markRead = React.useCallback((s: AttentionSession) => {
    const cursor = cursorFor(s)
    setSeen((prev) => {
      const next = { ...prev, [s.name]: cursor }
      writeSeen(next)
      return next
    })
    // B5/T4.4 — push the cursor to the server so the read follows the user to
    // their other devices. Fire-and-forget ON PURPOSE: the local write above
    // has already made the dot disappear, and a failed PATCH costs nothing that
    // is not recovered by the next read. Surfacing an error here would be a
    // toast about a background sync the user never asked for.
    void sessionsApi.markSeen(s.name, cursor).catch(() => {})
  }, [])

  const markUnread = React.useCallback((s: AttentionSession) => {
    // WRITE a rewound cursor rather than DELETE the cursor. Deleting looks like
    // the obvious inverse of `markRead`, and it was the bug: `tierFor` reads "no
    // cursor" as *never opened*, which is deliberately QUIET, so the old
    // implementation was arithmetically incapable of marking anything unread.
    // `unreadCursorFor` parks the cursor one millisecond before the row's own
    // activity stamp instead, so the ordinary `stamp > seen` comparison — no
    // special case anywhere in the tier function — reports `unread`.
    const cursor = unreadCursorFor(s)
    setSeen((prev) => {
      const next = { ...prev, [s.name]: cursor }
      writeSeen(next)
      return next
    })
    // Deliberately LOCAL-ONLY. The server cursor is monotonic — it has no
    // "un-read" — and that is the right asymmetry: marking unread is a private
    // note to yourself on this device ("come back to this"), not a claim that
    // nobody has read it. Making it cross-device would also give a stale tab a
    // way to resurrect unread badges on the phone, which is exactly what the
    // monotonic guard exists to prevent. `mergeCursors` honours the local
    // rewind via `SeenCursor.unread` so the newer server cursor cannot undo it.
  }, [])

  // B5/T4.4 — the merge. The server cursor rides the session row we already
  // have, so this costs no request: for each session, whichever of the two
  // cursors is newer wins, ties to local.
  const cursors = React.useMemo(() => {
    const m = new Map(Object.entries(seen))
    for (const s of sessions) {
      const merged = mergeCursors(m.get(s.name), serverCursor(s))
      if (merged) m.set(s.name, merged)
    }
    return m
  }, [seen, sessions])

  const forRow = React.useCallback(
    (s: AttentionSession): Attention =>
      enabled ? attentionFor(s, cursors.get(s.name)) : NOOP,
    [enabled, cursors],
  )

  const needs = React.useMemo(
    () => (enabled ? rollup(sessions, cursors) : []),
    [enabled, sessions, cursors],
  )

  // MEMOISED, because this object is the app-wide provider's value. Rebuilding
  // it on every render of `<Layout>` invalidates the context for every row that
  // draws a tier — the roster, the focus strip, every picker — on renders that
  // changed no cursor at all. The four members already have stable identities
  // (`forRow`/`needs` recompute only when a cursor or the roster moves), so the
  // memo is what carries that stability across the seam.
  return React.useMemo(
    () => ({ attentionFor: forRow, needs, markRead, markUnread, enabled }),
    [forRow, needs, markRead, markUnread, enabled],
  )
}

/* ── the app-wide provider ───────────────────────────────────────────────── */

/**
 * The provider's value, read from the shared sessions cache.
 *
 * Passive (`enabled: false`) for the same reason as `useRosterMarksProvider`:
 * `useSessions()` registers SSE handlers and the shell already mounts it once
 * through `<CommandPalette>`. This only re-renders when the cache someone else
 * owns changes — which also makes it correct under `?mock`, where the cache is
 * seeded rather than fetched.
 */
export function useAttentionProvider(): AttentionApi {
  const { data } = useQuery<ApiSession[]>({
    queryKey: SESSIONS_KEY,
    // See `use-roster-marks.ts`: `enabled: false` never fetches, but a query
    // with NO queryFn logs a warning on every render.
    queryFn: sessionsApi.list,
    enabled: false,
  })
  const sessions = React.useMemo<AttentionSession[]>(() => data ?? [], [data])
  // `data !== undefined` is the roster's "loaded" signal: React Query holds
  // `undefined` until the first list resolves and keeps the previous array
  // across a refetch, so an EMPTY `data` means "the last session is gone", not
  // "still loading" — which is exactly what lets `pruneSeen` clear the final
  // cursors instead of leaving them forever.
  return useAttention(sessions, data !== undefined)
}


const NOOP_API: AttentionApi = {
  attentionFor: () => NOOP,
  needs: [],
  markRead: () => {},
  markUnread: () => {},
  enabled: false,
}

const AttentionContext = React.createContext<AttentionApi>(NOOP_API)

export const AttentionProvider = AttentionContext.Provider

/** The whole API — the rollup, `markRead`, `markUnread`. */
export function useAttentionContext(): AttentionApi {
  return React.useContext(AttentionContext)
}

/**
 * ONE row's attention, from the app-wide provider.
 *
 * This is what a row calls. The rows that draw a tier — the tile, the list row,
 * the focus strip — are rendered five layers below the surface that owns the
 * roster (`GroupGrid` → `SortableTileSlot` → `SessionTileWrapper` → …), so the
 * alternative is prop-drilling a tier through components that have no other
 * reason to know about attention. Outside a provider the answer is `quiet`,
 * which is also what the kill switch produces — so a bench, a test or a picker
 * in a portal degrades to today's behaviour rather than crashing.
 */
export function useRowAttention(s: AttentionSession | null | undefined): Attention {
  const api = React.useContext(AttentionContext)
  return s ? api.attentionFor(s) : NOOP
}

/**
 * The tier for ONE session, for surfaces that hold a single row and have no
 * roster to hand (the focus header, a picker row). Reads the same storage; does
 * not prune — pruning is the roster's job, and a single-row surface has no way
 * to know what is alive.
 */
export function useSessionAttention(s: AttentionSession | null | undefined): Attention {
  const [enabled] = React.useState(isAttentionEnabled)
  return React.useMemo(() => {
    if (!s || !enabled) return NOOP
    // Merge the server cursor, exactly like the provider path (`cursors`). A
    // single-row surface that read ONLY localStorage would show a session
    // marked read on another device as still unread — the cross-device cursor
    // rides the row `s` already carries, so this costs no request.
    return attentionFor(s, mergeCursors(readSeen()[s.name], serverCursor(s)))
  }, [s, enabled])
}

/** Non-hook access, for imperative paths (route enter, `markRead` on open). */
export function recordSeen(s: AttentionSession): void {
  const map = readSeen()
  map[s.name] = cursorFor(s)
  writeSeen(map)
}

/** Non-hook read, for the same reason. */
export function tierOf(s: AttentionSession): ReturnType<typeof tierFor> {
  if (!isAttentionEnabled()) return 'quiet'
  // Same server-cursor merge as `useSessionAttention` — a read on another
  // device must not read as unread here.
  return tierFor(s, mergeCursors(readSeen()[s.name], serverCursor(s)))
}
