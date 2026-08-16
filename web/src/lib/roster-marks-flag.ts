// ROSTER_MARKS — client-side kill-switch for fase B2's roster faces.
//
// Modelled on `shell-substrate-flag.ts` (B1) and `term-history-flag.ts` (PR
// #27), deliberately: default ON, only an explicit '0' disables, no Settings
// UI, read once at mount.
//
// What it gates: whether the roster surfaces (tile, list row, focus strip,
// pickers) render the session's MARK or fall back to the pre-B2 `StatusDot`.
// The dot component is not deleted — `status-dot.tsx` keeps `STATUS_LABEL` /
// `STATUS_COLOR` for mark-less surfaces — so the fallback is the exact
// pre-B2 appearance, restorable from a browser console with no redeploy.
//
// Why a kill switch at all: this is the change that puts up to 40 animated
// faces on the hero path. The rAF loop is shared and offscreen marks
// unregister, but "shared" is a claim about code and a phone battery is a fact
// about the world — so there is a lever.
//
// DEFAULT ON: marks are the standard appearance.

const STORAGE_KEY = 'supermux:roster-marks'

/** Whether roster surfaces render session marks. DEFAULT ON: only an explicit
 *  `'0'` disables. Read lazily so flipping the switch and reloading takes
 *  effect immediately. */
export function isRosterMarksEnabled(): boolean {
  if (typeof localStorage === 'undefined') return true
  try {
    return localStorage.getItem(STORAGE_KEY) !== '0'
  } catch {
    // Private-mode / disabled storage — default ON (the standard appearance).
    return true
  }
}

/** Flip the kill-switch from the console:
 *  `localStorage['supermux:roster-marks'] = '0'` falls back to the status dot,
 *  `'1'` (or removing the key) restores marks. Takes effect on next reload. */
export function setRosterMarksEnabled(enabled: boolean): void {
  if (typeof localStorage === 'undefined') return
  try {
    localStorage.setItem(STORAGE_KEY, enabled ? '1' : '0')
  } catch {
    /* storage unavailable — nothing to persist */
  }
}
