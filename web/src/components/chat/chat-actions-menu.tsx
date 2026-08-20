/**
 * The composer add-menu — the POPOVER behind the leading `+` (fine pointer).
 * ─────────────────────────────────────────────────────────────────────────────
 * The desktop / trackpad half of the `+` menu. Its coarse-pointer twin is
 * `chat-actions-sheet.tsx` (a Vaul bottom sheet); both draw the SAME rows from
 * `chat-actions.ts`, so the two surfaces never drift. This one is a Radix
 * `Popover` — which buys the focus trap, `Esc`, outside-click and (with the
 * trigger) return-focus for free — dressed in the COMPOSER's own glass so the
 * menu reads as the same material lifting off the bar, not stock popover chrome.
 *
 * It opens UPWARD from the `+` (`side="top" align="start"`, origin bottom-left)
 * because the composer sits at the page bottom, so it never clips off-screen.
 * Motion is the sanctioned tailwindcss-animate scale/fade already on
 * `PopoverContent` (a close cousin of `springs.cardExpand`), disabled under
 * `prefers-reduced-motion` — no ad-hoc bezier, so `motion-tokens.test.ts` stays
 * green and the app pays no framer bytes here.
 *
 * KEYBOARD (grafted best-practice): roving ↑/↓ (wrap) + Home/End over the rows;
 * Enter / Space run the focused row (native button); Esc closes and Radix
 * returns focus to the `+`. Rows are real `role="menuitem"` buttons, so the whole
 * menu is keyboard- and screen-reader-drivable without an aria-activedescendant
 * shadow model.
 */
import * as React from 'react'
import { Paperclip } from 'lucide-react'

import { cn } from '@/lib/utils'

import { PopoverContent } from '../ui/popover'
import {
  composeActionRows,
  sessionActionRows,
  type ChatActionHandlers,
  type ChatActionRow,
} from './chat-actions'

export interface ChatActionsPopoverProps extends ChatActionHandlers {
  /** Open one OS file dialog (the desktop attach affordance); omitted → no row. */
  onAttach?: () => void
  /** Close the popover — called after a row's action runs. */
  onClose: () => void
}

export function ChatActionsPopover({ onAttach, onClose, ...handlers }: ChatActionsPopoverProps) {
  const compose = composeActionRows(handlers)
  const session = sessionActionRows(handlers)

  // Run a row's action, then close. `onMention`/`onSlash` refocus the field
  // themselves; `onCloseAutoFocus` is prevented below so that refocus (or a
  // navigation that grabs its own focus) wins over Radix's return-to-trigger.
  const run = React.useCallback(
    (fn: () => void) => {
      fn()
      onClose()
    },
    [onClose],
  )

  // Roving focus over the rendered rows. Real DOM focus on real buttons, so
  // Enter/Space activate natively and a screen reader tracks the caret.
  const onKeyDown = React.useCallback((e: React.KeyboardEvent<HTMLDivElement>) => {
    const { key } = e
    if (key !== 'ArrowDown' && key !== 'ArrowUp' && key !== 'Home' && key !== 'End') return
    const items = Array.from(
      e.currentTarget.querySelectorAll<HTMLButtonElement>('[data-menu-row]'),
    )
    if (!items.length) return
    e.preventDefault()
    const at = items.indexOf(document.activeElement as HTMLButtonElement)
    let next: number
    if (key === 'Home') next = 0
    else if (key === 'End') next = items.length - 1
    else if (key === 'ArrowDown') next = at < 0 ? 0 : (at + 1) % items.length
    else next = at < 0 ? items.length - 1 : (at - 1 + items.length) % items.length
    items[next]?.focus()
  }, [])

  return (
    <PopoverContent
      side="top"
      align="start"
      sideOffset={10}
      collisionPadding={12}
      role="menu"
      aria-label="Add to your message"
      onKeyDown={onKeyDown}
      // Let the action decide where focus lands (the field, for mention/slash;
      // the surface a navigation opens) rather than snapping back to the `+`.
      onCloseAutoFocus={(e) => e.preventDefault()}
      className={cn(
        // Composer glass — the pill's own recipe, so the menu is visibly its
        // sibling in both themes. Overrides the stock popover chrome; the
        // tailwindcss-animate enter/exit classes on PopoverContent survive the
        // merge and give the scale/fade. `origin-[0%_100%]` = grow from the `+`.
        'w-[280px] rounded-2xl border-[0.5px] border-hairline bg-surface p-1.5',
        'backdrop-blur-[60px] backdrop-saturate-[180%] shadow-[var(--sm-popover-shadow)]',
        'origin-[0%_100%] text-ink motion-reduce:animate-none',
      )}
    >
      {onAttach && <MenuRow row={{ key: 'attach', icon: Paperclip, label: 'Attach a file', run: onAttach }} onRun={() => run(onAttach)} />}
      {compose.map((row) => (
        <MenuRow key={row.key} row={row} onRun={() => run(row.run)} />
      ))}
      <div className="my-1 h-px bg-border/60" role="separator" />
      {session.map((row) => (
        <MenuRow key={row.key} row={row} onRun={() => run(row.run)} />
      ))}
    </PopoverContent>
  )
}

/** One popover row — an icon tile + label (+ optional key hint), a real
 *  `menuitem` button. `data-menu-row` is the roving-focus hook. */
function MenuRow({ row, onRun }: { row: ChatActionRow; onRun: () => void }) {
  const Icon = row.icon
  return (
    <button
      type="button"
      role="menuitem"
      data-menu-row=""
      onClick={onRun}
      className={cn(
        'flex h-10 w-full items-center gap-2.5 rounded-xl px-2 text-left',
        'text-ink transition-colors hover:bg-fill-soft focus:bg-fill-soft focus:outline-none',
      )}
    >
      <span className="grid size-7 flex-none place-items-center rounded-lg bg-fill-soft text-ink-2">
        <Icon className="size-[17px]" strokeWidth={1.75} aria-hidden />
      </span>
      <span className="min-w-0 flex-1 truncate text-[13.5px] font-medium">{row.label}</span>
      {row.hint && <span className="flex-none font-mono text-[11px] text-ink-2">{row.hint}</span>}
    </button>
  )
}

export default ChatActionsPopover
