// The `@`-picker (chat composer mention/delegation) COMPANY scoping — the pure
// half (Bot Mode P1). Kept OUT of `lib/companies.ts` on purpose: that module is
// entry-resident (the overview + switcher import it), and these two helpers are
// only ever reached from the lazy `chat-panel` chunk. Splitting them here keeps
// the eagerly-mounted hero path under its 160 KB gate. No `window` / fetch, so
// the predicate unit-tests in bun without a DOM.

/** Whether a session in the current session's OWN company scope may `@`-name a
 *  `peer`:
 *
 *    · a main/HQ session (`self` `company_id` null/undefined) can reach ANY
 *      session — main/PA bots orchestrate the whole fleet, so `@` offers all.
 *    · a company session sees ONLY same-company peers (`peer.company_id ===
 *      self.company_id`); a main bot or another company's session is hidden.
 *
 *  Keyed off the SESSION's own `company_id`, NOT the global `activeCompany` —
 *  the picker follows who you are typing as, not which space the switcher is
 *  parked in. Mirrors + reinforces the server delegation gate (defense-in-depth;
 *  the real jail is server-side, this is UX + correctness). */
export function canMentionPeer(
  selfCompanyId: number | null | undefined,
  peerCompanyId: number | null | undefined,
): boolean {
  if (selfCompanyId == null) return true
  return peerCompanyId === selfCompanyId
}

/** Filter a session list to the peers `self` may `@`-mention, per
 *  `canMentionPeer`. Generic over anything carrying a nullable `company_id`
 *  (the shared `useSessions()` rows AND the bench's fixture cast). Self is left
 *  in — `atRows` already drops the session typing in itself by `name`. */
export function scopeMentionPeers<T extends { company_id?: number | null }>(
  sessions: readonly T[],
  selfCompanyId: number | null | undefined,
): T[] {
  if (selfCompanyId == null) return [...sessions]
  return sessions.filter((s) => canMentionPeer(selfCompanyId, s.company_id))
}
