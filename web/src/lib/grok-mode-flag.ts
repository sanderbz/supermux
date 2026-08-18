// GROK MODE — the skin flag (WS1 foundation).
//
// Grok mode restyles the WHOLE app into Grok Bot's visual language. It is a
// SKIN, not a fork: one `data-grok` attribute on the shell root that a scoped
// CSS token layer (`styles/grok-mode.css`, every rule under `[data-grok]`) keys
// off. Removing the attribute is a byte-exact revert to today's app with no
// rebuild — the same guarantee `data-substrate` gives (see
// `lib/shell-substrate-flag.ts`).
//
// Two proven flag patterns, mirrored exactly (PR-#27 discipline):
//   1. a USER toggle in the zustand ui-store — `grokMode` (persisted, default
//      FALSE), flipped from Settings → Experimental, just like `chatRenderer`.
//   2. a hidden CONSOLE kill-switch — `localStorage['supermux:grok-mode'] = '0'`
//      force-disables regardless of the toggle. This survives the eventual
//      default-flip forever (like `data-substrate`: even once "on by default",
//      the `'0'` escape hatch reverts).
//
// DEFAULT OFF: the toggle ships false; the default flip is a later, separate PR
// (spec §1.3, WS10) — never here.
//
// Pure decision function; the React binding lives in `components/layout.tsx`,
// which reads it ONCE at mount (a skin flip is a reload-level change, not a live
// re-render — that also avoids a mid-session theme thrash).

export const GROK_KILL_SWITCH_KEY = 'supermux:grok-mode'

/** The full decision: settings toggle AND kill-switch. `killSwitch` is the raw
 *  localStorage value; exactly `'0'` forces OFF. Mirrors `chatRendererOn`. */
export function grokModeOn(
  settingOn: boolean,
  killSwitch: string | null,
): boolean {
  if (!settingOn) return false // default OFF until the toggle is flipped
  if (killSwitch === '0') return false // hidden escape hatch (PR-#27 discipline)
  return true
}
