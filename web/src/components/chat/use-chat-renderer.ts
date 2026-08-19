// React binding for the chat renderer flag — reads the persisted toggle from
// the UI store and the kill-switch from localStorage at render time (cheap;
// flipping the kill-switch takes effect on the next render/navigation, which
// is fine for an emergency lever).

import { BOT_KILL_SWITCH_KEY } from '@/lib/bot-mode-flag'
import { useUI } from '@/stores/ui-store'

import {
  CHAT_KILL_SWITCH_KEY,
  chatRendererOn,
  type ChatEligibleSession,
} from './flag'

export function useChatRenderer(s: ChatEligibleSession | null): boolean {
  const botOn = useUI((st) => st.botMode)
  let killMaster: string | null = null
  let killChat: string | null = null
  try {
    killMaster = window.localStorage.getItem(BOT_KILL_SWITCH_KEY)
    killChat = window.localStorage.getItem(CHAT_KILL_SWITCH_KEY)
  } catch {
    /* private mode / quota — treat as no kill-switch */
  }
  return chatRendererOn(botOn, killMaster, killChat, s)
}
