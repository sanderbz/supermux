// Chat renderer flag + eligibility (fase A1 walking skeleton).
//
// Three gates, all must pass: (1) the Settings → Experimental toggle
// (`useUI.chatRenderer`, default OFF — the default flip is fase A7);
// (2) the hidden kill-switch `localStorage['supermux:chat-renderer'] = '0'`,
// which force-disables regardless of the toggle (the PR-#27 flag pattern);
// (3) the Track A v1 eligibility guard (master plan Global Constraints):
// local Claude sessions only — `provider === 'claude' && host_id == null
// && !team`. Pure functions here; the React binding is use-chat-renderer.ts.

export const CHAT_KILL_SWITCH_KEY = 'supermux:chat-renderer'

export interface ChatEligibleSession {
  provider: string
  host_id?: number | null
}

/** Track A v1 guard: local Claude sessions only, never a team lead. */
export function chatEligible(
  s: ChatEligibleSession,
  isTeamLead: boolean,
): boolean {
  return s.provider === 'claude' && s.host_id == null && !isTeamLead
}

/** The full decision: the unified `botMode` toggle AND the master kill AND the
 *  legacy renderer-scoped kill AND eligibility. `killMaster` is
 *  `supermux:bot-mode` (kills BOTH halves of Bot mode); `killChat` is the
 *  legacy `supermux:chat-renderer` (kills ONLY the renderer — the skin stays).
 *  Each is the raw localStorage value; exactly `'0'` forces OFF. */
export function chatRendererOn(
  botOn: boolean,
  killMaster: string | null,
  killChat: string | null,
  s: ChatEligibleSession | null,
  isTeamLead: boolean,
): boolean {
  if (!botOn) return false
  if (killMaster === '0') return false // master Bot-mode kill
  if (killChat === '0') return false // legacy renderer-only kill (skin stays)
  if (!s) return false
  return chatEligible(s, isTeamLead)
}
