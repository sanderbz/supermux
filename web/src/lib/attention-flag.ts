// ATTENTION — client-side kill-switch for fase B2's attention tiers.
//
// Same pattern as `roster-marks-flag.ts` / `shell-substrate-flag.ts` / PR #27:
// default ON, only an explicit '0' disables, no Settings UI, read once at mount.
//
// What it gates: whether roster surfaces derive a TIER at all. With the switch
// off, `useAttention` reports `quiet` for every session and no unread dot, no
// unread count and no rollup ever renders — i.e. exactly today's behaviour, with
// the needs-input pill and the card glow (which are older, independent
// affordances) untouched.
//
// Why this one has a lever: an attention model that cries wolf is worse than no
// attention model, because it trains the user to ignore the signal. The unit
// suite is written as a false-positive suite for the same reason — but a suite
// covers the cases we thought of, and this covers the ones we did not.
//
// DEFAULT ON: the tiers are the standard behaviour.

const STORAGE_KEY = 'supermux:attention'

/** Whether the attention tiers are derived. DEFAULT ON: only an explicit `'0'`
 *  disables. Read lazily so flipping the switch and reloading takes effect. */
export function isAttentionEnabled(): boolean {
  if (typeof localStorage === 'undefined') return true
  try {
    return localStorage.getItem(STORAGE_KEY) !== '0'
  } catch {
    // Private-mode / disabled storage — default ON (the standard behaviour).
    return true
  }
}

/** Flip the kill-switch from the console:
 *  `localStorage['supermux:attention'] = '0'` collapses every row to `quiet`,
 *  `'1'` (or removing the key) restores the tiers. Takes effect on reload. */
export function setAttentionEnabled(enabled: boolean): void {
  if (typeof localStorage === 'undefined') return
  try {
    localStorage.setItem(STORAGE_KEY, enabled ? '1' : '0')
  } catch {
    /* storage unavailable — nothing to persist */
  }
}
