// SHELL_SUBSTRATE — client-side kill-switch for fase B1's painted shell
// substrate (docs/superpowers/plans/2026-08-16-fase-b1-shell.md, T3).
//
// Modelled on `term-history-flag.ts`, deliberately: that pattern (default ON,
// only an explicit '0' disables, no Settings UI) already proved itself as a
// production kill-switch for the tmux-authoritative scrollback.
//
// What it gates: the `data-substrate` attribute on the shell root. Every
// substrate rule in globals.css is scoped under `[data-substrate]`, and the
// pre-B1 Tailwind classes (`bg-card`, `border-r`, `border-t`) are still on the
// elements underneath — so removing the attribute restores the pre-B1
// appearance EXACTLY, with no rebuild and no redeploy. That is the whole point:
// the substrate is the riskiest change in B1 (it repaints every column of every
// route), and it must be revertible from a browser console.
//
// DEFAULT ON: the substrate is the standard appearance.

const STORAGE_KEY = 'supermux:shell-substrate'

/** Whether the painted shell substrate is enabled. DEFAULT ON: only an
 *  explicit `'0'` disables it. Read lazily so flipping the switch and
 *  reloading takes effect immediately. */
export function isShellSubstrateEnabled(): boolean {
  if (typeof localStorage === 'undefined') return true
  try {
    return localStorage.getItem(STORAGE_KEY) !== '0'
  } catch {
    // Private-mode / disabled storage — default ON (the standard appearance).
    return true
  }
}

/** Flip the kill-switch from the console:
 *  `localStorage['supermux:shell-substrate'] = '0'` disables, `'1'` (or
 *  removing the key) re-enables. Takes effect on the next reload. */
export function setShellSubstrateEnabled(enabled: boolean): void {
  if (typeof localStorage === 'undefined') return
  try {
    localStorage.setItem(STORAGE_KEY, enabled ? '1' : '0')
  } catch {
    /* storage unavailable — nothing to persist */
  }
}
