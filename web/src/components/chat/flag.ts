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

/** The full decision: settings toggle AND kill-switch AND eligibility.
 *  `killSwitch` is the raw localStorage value; exactly `'0'` forces OFF. */
export function chatRendererOn(
  settingOn: boolean,
  killSwitch: string | null,
  s: ChatEligibleSession | null,
  isTeamLead: boolean,
): boolean {
  if (!settingOn) return false
  if (killSwitch === '0') return false
  if (!s) return false
  return chatEligible(s, isTeamLead)
}
