/**
 * The composer's folded-actions sheet (mobile chat — mobile polish #4).
 * ─────────────────────────────────────────────────────────────────────────────
 * On the phone the chat surface used to carry TWO bars: the composer, and below
 * it the old global mobile dock ([session-pill] ⌘ + 🎤). The owner wants ONE
 * clean input bar — so under chat that dock is gone, and the handful of actions
 * it exposed are folded in here, behind a single expander in the composer's
 * leading cluster.
 *
 * Deliberately a plain list in the shared `MobileActionSheet` (the one Vaul
 * shell every mobile focus panel uses): a backdrop tap-away, drag-to-dismiss, a
 * focus trap and the home-indicator inset come for free, so this file is just
 * rows. Each row is a 44pt target; tapping one runs its action and closes the
 * sheet, so the composer — and whatever the action staged into it — is what the
 * user is looking at a beat later.
 */
import * as React from 'react'
import { ArrowLeftRight, Command, Plus } from 'lucide-react'

import { cn } from '@/lib/utils'

import { MobileActionSheet } from '../focus-mode/mobile-action-sheet'

export interface ChatActionsSheetProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** Open the session switcher (the picker sheet). */
  onSwitchSession: () => void
  /** Open the global command palette (⌘K) — search / jump / new session. */
  onCommandPalette: () => void
  /** Open the snippets drawer; omitted → the row is not drawn. */
  onSnippets?: () => void
}

export function ChatActionsSheet({
  open,
  onOpenChange,
  onSwitchSession,
  onCommandPalette,
  onSnippets,
}: ChatActionsSheetProps) {
  // Run an action and dismiss — the sheet is a launcher, not a home. Dictation
  // is NOT here: it is the composer's own rest-state mic (a single dictation
  // control), so this sheet holds only the actions with no home of their own.
  const run = React.useCallback(
    (fn: () => void) => {
      fn()
      onOpenChange(false)
    },
    [onOpenChange],
  )

  return (
    <MobileActionSheet open={open} onOpenChange={onOpenChange} title="Actions">
      <div className="flex flex-col px-2 pb-2 pt-1">
        <ActionRow
          icon={ArrowLeftRight}
          label="Switch session"
          onTap={() => run(onSwitchSession)}
        />
        <ActionRow icon={Command} label="Command palette" onTap={() => run(onCommandPalette)} />
        {onSnippets && <ActionRow icon={Plus} label="Snippets" onTap={() => run(onSnippets)} />}
      </div>
    </MobileActionSheet>
  )
}

/** One folded action — an icon tile + a label, the full row a 44pt target. */
function ActionRow({
  icon: Icon,
  label,
  onTap,
  active = false,
}: {
  icon: typeof Command
  label: string
  onTap: () => void
  active?: boolean
}) {
  return (
    <button
      type="button"
      onClick={onTap}
      aria-pressed={active || undefined}
      className={cn(
        'flex min-h-11 w-full items-center gap-3 rounded-xl px-3 py-2 text-left',
        'active:bg-muted/60',
        active && 'text-primary',
      )}
    >
      <span
        className={cn(
          'grid size-8 flex-none place-items-center rounded-lg',
          active ? 'bg-primary/15 text-primary' : 'bg-muted/60 text-foreground',
        )}
      >
        <Icon className="size-[18px]" strokeWidth={1.75} aria-hidden />
      </span>
      <span className="text-[15px] font-medium">{label}</span>
    </button>
  )
}

export default ChatActionsSheet
