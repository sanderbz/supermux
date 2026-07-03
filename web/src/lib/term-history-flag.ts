// TERM_TMUX_HISTORY — the client-side feature flag gating the entire
// tmux-authoritative scrollback layer (§5 of SCROLLBACK_SPEC.md).
//
// When OFF (the default) the live terminal behaves EXACTLY as it does today:
//   • xterm keeps its full 50000-line scrollback (xterm owns history),
//   • no `history` request frames are ever sent,
//   • the stacked read-only history term is never mounted.
// This is the instant client-side rollback — flip the flag off and the whole
// history layer is inert with no server redeploy needed (the server's `History`
// handler is additive + read-only, and simply never gets called).
//
// Read from localStorage (mirrors the sound.ts opt-in flag convention). Kept in
// a tiny standalone module so both the hook and any settings surface can import
// the SAME reader/writer — no duplicated key strings.

const STORAGE_KEY = 'supermux:term-tmux-history'

/** Whether the tmux-authoritative scrollback layer is enabled. Default OFF
 *  (opt-in) so the live path stays byte-identical to today until explicitly
 *  turned on for the harness / own instance. Reads localStorage lazily so a
 *  toggle mid-session takes effect on the next terminal (re)mount. */
export function isTermHistoryEnabled(): boolean {
  if (typeof localStorage === 'undefined') return false
  try {
    return localStorage.getItem(STORAGE_KEY) === '1'
  } catch {
    // Private-mode / disabled storage — treat as off (safe default).
    return false
  }
}

/** Persist the toggle. Wire this to a Settings switch or flip it from the
 *  console (`localStorage['supermux:term-tmux-history'] = '1'`) for the staged
 *  rollout. Takes effect on the next terminal mount. */
export function setTermHistoryEnabled(enabled: boolean): void {
  if (typeof localStorage === 'undefined') return
  try {
    localStorage.setItem(STORAGE_KEY, enabled ? '1' : '0')
  } catch {
    /* storage unavailable — nothing to persist */
  }
}
