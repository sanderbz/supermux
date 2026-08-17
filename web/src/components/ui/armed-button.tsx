/**
 * `<ArmedButton>` — the render half of the one armed-confirm idiom (B5/T9).
 *
 * Pairs with `useArmedConfirm`. The resting state shows the action; the armed
 * state shows an explicit `Cancel / <verb>` pair, because a destructive button
 * that arms in place gives the user nowhere to put a mis-click. That pair was
 * variant C's one genuinely better idea, and it is the shape kept here.
 *
 * `aria-live` on the armed region is not decoration: the whole mechanism is a
 * silent state change on a control the user is about to press again, and
 * without an announcement a screen-reader user has no way to know the second
 * press is the destructive one.
 */
import * as React from 'react'

import { cn } from '@/lib/utils'
import type { ArmedConfirm } from '@/hooks/use-armed-confirm'

export interface ArmedButtonProps {
  /** The hook instance driving this button. */
  confirm: ArmedConfirm
  /** Resting label — what the action IS. */
  label: React.ReactNode
  /** Armed label — what pressing again DOES. Short and verb-first. */
  confirmLabel: React.ReactNode
  /** Cancel label. Defaults to "Cancel". */
  cancelLabel?: React.ReactNode
  /** Accessible name for the resting button, when `label` is an icon. */
  ariaLabel?: string
  disabled?: boolean
  /** Classes for the resting button. */
  className?: string
  /** Classes for the armed confirm button. Defaults to the destructive tone. */
  confirmClassName?: string
  /** Rendered before the resting label (an icon, usually). */
  icon?: React.ReactNode
}

export function ArmedButton({
  confirm,
  label,
  confirmLabel,
  cancelLabel = 'Cancel',
  ariaLabel,
  disabled,
  className,
  confirmClassName,
  icon,
}: ArmedButtonProps) {
  if (confirm.armed) {
    return (
      <span
        className="inline-flex items-center gap-1"
        // Announced, because arming is otherwise a silent change to what the
        // next press will do.
        role="status"
        aria-live="polite"
      >
        <button
          type="button"
          onClick={confirm.cancel}
          disabled={disabled}
          className="inline-flex h-7 items-center rounded-md px-2 text-xs font-medium text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50"
        >
          {cancelLabel}
        </button>
        <button
          type="button"
          onClick={confirm.press}
          disabled={disabled}
          className={cn(
            'inline-flex h-7 items-center gap-1 rounded-md bg-destructive px-2 text-xs font-medium text-destructive-foreground hover:bg-destructive/90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50',
            confirmClassName,
          )}
        >
          {confirmLabel}
        </button>
      </span>
    )
  }

  return (
    <button
      type="button"
      onClick={confirm.press}
      disabled={disabled}
      aria-label={ariaLabel}
      className={cn(
        'inline-flex h-7 items-center gap-1 rounded-md px-2 text-xs font-medium text-muted-foreground hover:bg-destructive/10 hover:text-destructive focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50',
        className,
      )}
    >
      {icon}
      {label}
    </button>
  )
}
