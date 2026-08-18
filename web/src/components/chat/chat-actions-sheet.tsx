/**
 * The composer's add-menu — the sheet behind the leading `+` (mobile chat).
 * ─────────────────────────────────────────────────────────────────────────────
 * The `+` means "add something", and this is the something. It is OWNED by the
 * composer (`components/chat/composer.tsx` renders it) and opened by the `+`
 * directly above it — so it reads as belonging to the composer, not as a floating
 * generic list dropped in by the route. It carries the composer's own materials:
 * the shared glass `MobileActionSheet` shell (radius, backdrop, drag-to-dismiss,
 * safe-area), one considered icon set, and rows grouped by what they do.
 *
 * TWO GROUPS:
 *   · ADD TO YOUR MESSAGE — the things that stage into the draft the user is
 *     writing: mention a file/session (`@`), a slash command (`/`), a snippet,
 *     and schedule-instead-of-send. These are the reason the `+` exists.
 *   · THIS SESSION — switch session, command palette. Reachable, but a step
 *     removed from composing, so they sit below a hairline.
 *
 * DICTATION IS NOT A ROW HERE. The composer's trailing rest-state mic IS the
 * dictation control (a real `useDictation` toggle that streams into the draft),
 * so a second "Dictate" entry in this menu would only duplicate a control already
 * on the bar.
 *
 * Each row is a 44pt target; tapping one runs its action and closes the sheet,
 * so the composer — and whatever the action staged into it — is what the user is
 * looking at a beat later.
 */
import * as React from 'react'
import {
  ArrowLeftRight,
  AtSign,
  Clock,
  Command,
  Scissors,
  Slash,
  type LucideIcon,
} from 'lucide-react'

import { cn } from '@/lib/utils'

import { MobileActionSheet } from '../focus-mode/mobile-action-sheet'

export interface ChatActionsSheetProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** Insert an `@` and open the file/session picker (composer-local). */
  onMention: () => void
  /** Insert a `/` and open the command picker (composer-local). */
  onSlash: () => void
  /** Schedule the current draft instead of sending it now; omitted → no row. */
  onSchedule?: () => void
  /** Open the snippets drawer; omitted → no row. */
  onSnippets?: () => void
  /** Open the session switcher (the picker sheet). */
  onSwitchSession: () => void
  /** Open the global command palette (⌘K) — search / jump / new session. */
  onCommandPalette: () => void
}

export function ChatActionsSheet({
  open,
  onOpenChange,
  onMention,
  onSlash,
  onSchedule,
  onSnippets,
  onSwitchSession,
  onCommandPalette,
}: ChatActionsSheetProps) {
  // Run an action and dismiss — the sheet is a launcher, not a home.
  // Mention/command stage a trigger and reopen the picker on the composer the
  // close reveals.
  const run = React.useCallback(
    (fn: () => void) => {
      fn()
      onOpenChange(false)
    },
    [onOpenChange],
  )

  return (
    <MobileActionSheet open={open} onOpenChange={onOpenChange} title="Add to your message">
      <div className="flex flex-col px-2 pb-2 pt-1">
        <ActionRow icon={AtSign} label="Mention a file or session" onTap={() => run(onMention)} />
        <ActionRow icon={Slash} label="Slash command" onTap={() => run(onSlash)} />
        {onSnippets && (
          <ActionRow icon={Scissors} label="Insert a snippet" onTap={() => run(onSnippets)} />
        )}
        {onSchedule && (
          <ActionRow icon={Clock} label="Schedule for later" onTap={() => run(onSchedule)} />
        )}

        {/* Reachable, but a step removed from composing — set off by a hairline
            and a quiet section label so the menu reads as considered, not as one
            flat list. */}
        <div className="my-1.5 h-px bg-border/60" />
        <p className="px-3 pb-1 text-[11px] font-medium uppercase tracking-[0.04em] text-muted-foreground">
          This session
        </p>
        <ActionRow
          icon={ArrowLeftRight}
          label="Switch session"
          onTap={() => run(onSwitchSession)}
        />
        <ActionRow icon={Command} label="Command palette" onTap={() => run(onCommandPalette)} />
      </div>
    </MobileActionSheet>
  )
}

/** One folded action — an icon tile + a label, the full row a 44pt target. */
function ActionRow({
  icon: Icon,
  label,
  onTap,
}: {
  icon: LucideIcon
  label: string
  onTap: () => void
}) {
  return (
    <button
      type="button"
      onClick={onTap}
      className={cn(
        'flex min-h-11 w-full items-center gap-3 rounded-xl px-3 py-2 text-left',
        'active:bg-muted/60',
      )}
    >
      <span className="grid size-8 flex-none place-items-center rounded-lg bg-muted/60 text-foreground">
        <Icon className="size-[18px]" strokeWidth={1.75} aria-hidden />
      </span>
      <span className="text-[15px] font-medium">{label}</span>
    </button>
  )
}

export default ChatActionsSheet
