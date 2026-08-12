// Archive tombstones — the memory that keeps an archived session removed.
//
// Archiving a session also stops it, and the stop path broadcasts its own
// `{name, status:'stopped'}` `sessions` delta from a separate task, so that
// partial row can land AFTER the archive's removal delta. Without a memory of
// the removal the delta merge re-inserts a stub tile that only a reload clears.
// While a name is tombstoned, `applyDelta` (use-sessions.ts) ignores every
// delta for it that does not carry an explicit `archived: false`.
//
// This lives in `lib/` rather than in the hook so the API client can clear
// tombstones on EVERY full list response, whichever observer triggered the
// fetch. Deliberately dependency-free (rows are structurally typed) to keep
// `lib/api` free of a cycle back into the hooks.

/** Name -> the monotonic clock reading when the archive delta arrived. */
const tombstones = new Map<string, number>()

/** How long a tombstone suppresses a name. Long enough to outlive the trailing
 *  stop/status deltas of an archive (they follow within seconds), short enough
 *  that a client which missed the unarchive broadcast is not stuck with a
 *  suppressed session all day. The two immediate clears (an explicit
 *  `archived: false` delta, and any full list response naming the session) are
 *  what normally lifts a tombstone; this TTL is only the backstop. */
const TTL_MS = 5 * 60_000

/** Monotonic and immune to system clock jumps (NTP steps, DST, a laptop
 *  resuming from sleep with a corrected clock), which a wall clock is not. */
function now(): number {
  return performance.now()
}

/** Remember that `name` was archived, so late deltas cannot resurrect it. */
export function tombstoneArchived(name: string): void {
  tombstones.set(name, now())
}

/** True while `name` is suppressed. Expired entries are dropped as they are
 *  read, so there is no timer and no sweep. */
export function isArchiveTombstoned(name: string): boolean {
  const at = tombstones.get(name)
  if (at === undefined) return false
  if (now() - at >= TTL_MS) {
    tombstones.delete(name)
    return false
  }
  return true
}

/** Forget a single name. The unarchive path broadcasts the full row with an
 *  explicit `archived: false`; an optimistic undo in the UI clears it too, so
 *  the row it re-inserts starts taking deltas again right away. */
export function forgetTombstone(name: string): void {
  tombstones.delete(name)
}

/** Forget every name in a full list response. `GET /api/sessions` filters
 *  archived rows out, so anything it returns is live by definition and must not
 *  stay suppressed until the TTL expires. Called from `sessionsApi.list` rather
 *  than from one query registration, because several components register the
 *  same `['sessions']` key and any of them can own the fetch. */
export function forgetTombstonesFor(rows: readonly { name: string }[]): void {
  for (const r of rows) tombstones.delete(r.name)
}
