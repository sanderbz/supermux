// TERM_TMUX_HISTORY — client-side kill-switch for the tmux-authoritative
// scrollback layer (SCROLLBACK_SPEC.md).
//
// DEFAULT ON: scroll-up reads history from tmux's authoritative buffer — this is
// now the standard behavior, with no Settings UI. The localStorage key remains
// ONLY as a production kill-switch: set it to '0' to fall back to the legacy
// client-rebuilt scrollback with no redeploy (the server's `History` handler is
// additive + read-only, so it simply stops being called).
//
// Kept in a tiny standalone module so the hook imports a single reader.

const STORAGE_KEY = 'supermux:term-tmux-history'

/** Whether the tmux-authoritative scrollback layer is enabled. DEFAULT ON:
 *  only an explicit `'0'` disables it (the kill-switch). Reads localStorage
 *  lazily so flipping the switch mid-session takes effect on the next terminal
 *  (re)mount. */
export function isTermHistoryEnabled(): boolean {
  if (typeof localStorage === 'undefined') return true
  try {
    return localStorage.getItem(STORAGE_KEY) !== '0'
  } catch {
    // Private-mode / disabled storage — default ON (the standard behavior).
    return true
  }
}

/** Flip the kill-switch from the console:
 *  `localStorage['supermux:term-tmux-history'] = '0'` disables, `'1'` (or
 *  removing the key) re-enables. Takes effect on the next terminal mount. */
export function setTermHistoryEnabled(enabled: boolean): void {
  if (typeof localStorage === 'undefined') return
  try {
    localStorage.setItem(STORAGE_KEY, enabled ? '1' : '0')
  } catch {
    /* storage unavailable — nothing to persist */
  }
}
