/**
 * The composer add-menu's ROW MODEL — one authored list, two shells.
 * ─────────────────────────────────────────────────────────────────────────────
 * The leading `+` opens a smart menu that is a bottom SHEET on a coarse pointer
 * (`chat-actions-sheet.tsx`, Vaul) and an anchored POPOVER on a fine one
 * (`chat-actions-menu.tsx`, Radix). Both render the SAME rows, so the two
 * surfaces can never drift: the labels, icons, order and gating live here, and
 * each shell only owns its own chrome (glass, motion, keyboard model).
 *
 * ATTACH is deliberately NOT here — it is the one group whose SHAPE differs by
 * platform (the sheet offers Camera / Photo library / Files against the phone's
 * native pickers; the popover offers one "Attach a file" row against a single OS
 * dialog), so each shell authors its own attach affordance and shares only the
 * compose + this-session rows below.
 *
 * DICTATION is not a row on either surface — the composer's trailing rest-state
 * mic IS the dictation control, so a menu row would only duplicate it.
 */
import {
  ArrowLeftRight,
  AtSign,
  Clock,
  Command,
  Scissors,
  Slash,
  type LucideIcon,
} from 'lucide-react'

/** One menu row — a glyph, a label, an optional right-aligned key hint, and the
 *  action it runs. The shell wraps `run` with its own close. */
export interface ChatActionRow {
  /** Stable key — also the roving-focus / `menuitem` id seed in the popover. */
  key: string
  icon: LucideIcon
  label: string
  /** A right-aligned mono hint (e.g. `⌘K`), where one adds clarity. */
  hint?: string
  run: () => void
}

/** The callbacks both shells draw from. Every one that is optional GATES its row
 *  — an unwired action never shows a dead row (the menu is progressive). */
export interface ChatActionHandlers {
  /** Insert an `@` and open the file/session picker (composer-local, always). */
  onMention: () => void
  /** Insert a `/` and open the command picker (composer-local, always). */
  onSlash: () => void
  /** Open the snippets drawer; omitted → no row. */
  onSnippets?: () => void
  /** Schedule the current draft instead of sending it now; omitted → no row. */
  onSchedule?: () => void
  /** Open the session switcher; omitted (desktop's persistent list) → no row. */
  onSwitchSession?: () => void
  /** Open the global command palette (⌘K). */
  onCommandPalette: () => void
}

/** COMPOSE — the things that stage into the draft the user is writing. Mention
 *  and slash are always present; snippet and schedule gate on their handlers. */
export function composeActionRows(h: ChatActionHandlers): ChatActionRow[] {
  const rows: ChatActionRow[] = [
    { key: 'mention', icon: AtSign, label: 'Mention a file or session', run: h.onMention },
    { key: 'slash', icon: Slash, label: 'Slash command', run: h.onSlash },
  ]
  if (h.onSnippets) rows.push({ key: 'snippet', icon: Scissors, label: 'Insert a snippet', run: h.onSnippets })
  if (h.onSchedule) rows.push({ key: 'schedule', icon: Clock, label: 'Schedule for later', run: h.onSchedule })
  return rows
}

/** THIS SESSION — reachable, but a step removed from composing (below a
 *  hairline). Switch-session gates on its handler (omitted on desktop). */
export function sessionActionRows(h: ChatActionHandlers): ChatActionRow[] {
  const rows: ChatActionRow[] = []
  if (h.onSwitchSession)
    rows.push({ key: 'switch', icon: ArrowLeftRight, label: 'Switch session', run: h.onSwitchSession })
  rows.push({ key: 'palette', icon: Command, label: 'Command palette', hint: '⌘K', run: h.onCommandPalette })
  return rows
}
