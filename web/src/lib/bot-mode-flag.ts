// BOT MODE — the ONE unified flag (WS1 foundation, merges the former
// `chatRenderer` + `grokMode` experiments into a single `botMode`).
//
// When on, Bot mode does two things at once: it restyles the whole app into
// Grok's visual language (the `data-grok` skin) AND turns eligible local Claude
// sessions into chat threads at the focus seam. One toggle, one mental model:
// "your agents become bots".
//
// Kill-switches (the PR-#27 escape-hatch discipline, preserved through the
// merge so the debug split survives):
//   • MASTER — `localStorage['supermux:bot-mode'] = '0'` force-disables BOTH
//     halves regardless of the toggle.
//   • LEGACY SCOPED — kept honoured so a debugger can isolate one half:
//       `localStorage['supermux:grok-mode']   = '0'` kills ONLY the skin
//       `localStorage['supermux:chat-renderer'] = '0'` kills ONLY the renderer
//     (the chat kill is applied in components/chat/flag.ts, next to the
//     eligibility guard).
//
// Pure decision function; the React binding for the skin lives in
// `components/layout.tsx` (read ONCE at mount — a skin flip is a reload-level
// change, not a live re-render), and for the renderer in
// `components/chat/use-chat-renderer.ts` (reactive).

export const BOT_KILL_SWITCH_KEY = 'supermux:bot-mode'

/** The SKIN decision: the `botMode` setting AND the master kill AND the legacy
 *  grok-scoped kill. `killMaster` / `killGrok` are the raw localStorage values;
 *  exactly `'0'` forces OFF. Mirrors the old `grokModeOn`, plus the master
 *  kill. */
export function botModeOn(
  setting: boolean,
  killMaster: string | null,
  killGrok: string | null,
): boolean {
  if (!setting) return false // default OFF until the toggle is flipped
  if (killMaster === '0') return false // master escape hatch
  if (killGrok === '0') return false // legacy skin-only kill (renderer stays)
  return true
}
