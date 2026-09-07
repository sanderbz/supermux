// Chat renderer flag + eligibility (fase A1 walking skeleton).
//
// Three gates, all must pass: (1) the Settings → Experimental toggle
// (`useUI.chatRenderer`, default OFF — the default flip is fase A7);
// (2) the hidden kill-switch `localStorage['supermux:chat-renderer'] = '0'`,
// which force-disables regardless of the toggle (the PR-#27 flag pattern);
// (3) the Track A v1 eligibility guard (master plan Global Constraints):
// local Claude or Codex sessions — `host_id == null`, see `chatEligible`.
// Pure functions here; the React binding is use-chat-renderer.ts.
//
// A TEAM LEAD USED TO BE REFUSED HERE (`&& !isTeamLead`). It no longer is
// (TEAMS-in-Bot-mode, Phase 2a). The refusal's stated reason was that a lead's
// window is multiplexed across teammate panes — but a teammate pane is its OWN
// Claude process with its OWN conversation file, so the lead's
// `<project>/<cc_conversation_id>.jsonl` already IS the lead's own conversation
// and the tailer serves it unchanged. What WAS multiplexed is the POINTER, and
// the server now attributes it by pane (`hooks.rs::track_conversation_pointer`,
// Phase 1/S2), so a teammate's hook can never repoint the lead. The server's
// mirror of this gate lost the same clause in `sessions/chat/ws.rs::chat_eligible`.
// ⇒ a lead is a first-class bot: you talk to the crew by talking to the lead.

export const CHAT_KILL_SWITCH_KEY = 'supermux:chat-renderer'

export interface ChatEligibleSession {
  provider: string
  host_id?: number | null
}

/** Local Claude OR Codex sessions. Mirrored server-side by
 *  `sessions/chat/ws.rs::chat_eligible` — the pair is pinned by
 *  `chat_eligibility_matches_the_client_guard`.
 *
 *  CODEX is served in its own transcript dialect (`sessions/chat/codex.rs`): it
 *  writes an append-only rollout JSONL that the same byte cursor tails and the
 *  same wire carries. The rendering is PRAGMATIC by design, not Claude-fidelity
 *  — prompts, replies, reasoning and shell runs map onto the existing kinds, and
 *  anything unmodelled becomes the visible "open the terminal" row
 *  (`wire-entries.ts::UNMAPPED_TEXT`) rather than a gap.
 *
 *  `host_id` is still refused for every provider: a remote session's transcript
 *  lives on the remote box and nothing here can read it. */
export function chatEligible(s: ChatEligibleSession): boolean {
  return (s.provider === 'claude' || s.provider === 'codex') && s.host_id == null
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
): boolean {
  if (!botOn) return false
  if (killMaster === '0') return false // master Bot-mode kill
  if (killChat === '0') return false // legacy renderer-only kill (skin stays)
  if (!s) return false
  return chatEligible(s)
}
