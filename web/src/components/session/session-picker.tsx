// SessionPicker — the shared "pick a session" affordance used by the board
// composer and the scheduler form. Replaces the divergent native <select> in
// scheduler with the same chic pill + DropdownMenu (desktop) / Vaul half-sheet
// (mobile) pattern board-composer was already using — same as board-switcher
// and focus-mode/session-picker-sheet.
//
// DRY: ONE picker for both consumers. The `allowEmpty` prop covers the two
// behaviours that used to live in two different components:
//   • board composer → `allowEmpty: true`  (an explicit "(no session)" row,
//                                            so a card can be detached.)
//   • scheduler form → `allowEmpty: false` (a session is required; the trigger
//                                            shows a placeholder until picked.)
//
// Tolerant of a bound `value` that isn't in the live `sessions` list (e.g. a
// stopped session referenced by an edited row) — that name is rendered verbatim
// so the value is never silently dropped.

import * as React from 'react'
import { useMemo, useState } from 'react'
import { Drawer } from 'vaul'
import { motion } from 'framer-motion'
import { Check, ChevronDown, TerminalSquare } from 'lucide-react'

import { cn } from '@/lib/utils'
import { springs } from '@/lib/springs'
import { useMediaQuery } from '@/hooks/use-media-query'
import { displayLabel } from '@/lib/api/sessions'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'

/** A session as the picker needs it — only a `name` is required. Both
 *  consumers' richer shapes (BoardSession etc.) satisfy this structurally. */
export interface SessionPickerOption {
  name: string
  /** Mutable human label (migration 0019). Rendered as the row/trigger label
   *  via `displayLabel`; `name` stays the value/key. */
  display_name?: string
  status?: string
}

export interface SessionPickerProps {
  /** The currently-picked session name, or '' for "none". */
  value: string
  /** Called with the picked session name (or '' when `allowEmpty`). */
  onChange: (name: string) => void
  /** Live sessions to choose from. */
  sessions: SessionPickerOption[]
  /** Include an explicit "(no session)" row at the top. Default `true`
   *  (matches board composer); pass `false` for required-pick (scheduler). */
  allowEmpty?: boolean
  /** The "(no session)" row label when `allowEmpty`. Default "(no session)". */
  emptyLabel?: string
  /** Pill label when `value` is empty AND `allowEmpty=false` — the
   *  required-pick placeholder. Defaults to `emptyLabel`. */
  placeholder?: string
  /** Accessible label for the trigger. Default "Session". */
  ariaLabel?: string
  /** Override the pill's class (use sparingly — the default style is the
   *  shared chic pill that matches board-switcher). */
  className?: string
  /** Dropdown's section label. Default "Send to session". */
  menuLabel?: string
  /** Sheet's title on mobile. Default = `menuLabel`. */
  sheetTitle?: string
}

/**
 * Render the shared session picker. Desktop = a DropdownMenu; mobile (coarse
 * pointer) = a Vaul half-sheet with 44pt rows + check icons. Matches the
 * board-switcher / focus session-picker-sheet pattern visually so all three
 * read as the SAME affordance.
 */
export function SessionPicker({
  value,
  onChange,
  sessions,
  allowEmpty = true,
  emptyLabel = '(no session)',
  placeholder,
  ariaLabel = 'Session',
  className,
  menuLabel = 'Send to session',
  sheetTitle,
}: SessionPickerProps) {
  const isMobile = useMediaQuery('(pointer: coarse)')
  const [sheetOpen, setSheetOpen] = useState(false)

  // Build the option list:
  //   • the explicit "(no session)" row first when allowed,
  //   • a pinned row for a bound value missing from the live list (e.g. a
  //     stopped session a scheduled job points at — keep it selectable so
  //     the value isn't silently lost),
  //   • the live sessions in order.
  const options = useMemo(() => {
    const seen = new Set<string>()
    const out: { name: string; label: string }[] = []
    if (allowEmpty) out.push({ name: '', label: emptyLabel })
    if (value && !sessions.some((s) => s.name === value)) {
      out.push({ name: value, label: value })
      seen.add(value)
    }
    for (const s of sessions) {
      if (seen.has(s.name)) continue
      out.push({ name: s.name, label: displayLabel(s) })
    }
    return out
  }, [allowEmpty, emptyLabel, sessions, value])

  const fallback = placeholder ?? emptyLabel
  // Render the picked option's LABEL (honours display_name), not the raw slug.
  const triggerLabel = options.find((o) => o.name === value)?.label || fallback
  const triggerAria = `${ariaLabel}: ${triggerLabel} — switch`

  const trigger = (onClick?: () => void) => (
    <motion.button
      type="button"
      onClick={onClick}
      whileTap={{ scale: 0.97 }}
      transition={springs.buttonPress}
      aria-label={triggerAria}
      className={cn(
        'group inline-flex h-8 max-w-[60%] shrink items-center gap-1.5 rounded-full pl-2.5 pr-1.5',
        'bg-secondary text-xs font-medium leading-none text-foreground/90',
        'transition-colors hover:text-foreground active:bg-secondary/70',
        'data-[state=open]:bg-secondary data-[state=open]:text-foreground',
        className,
      )}
    >
      <TerminalSquare
        className="size-3.5 shrink-0 opacity-70"
        aria-hidden
      />
      <span
        className={cn(
          'min-w-0 truncate',
          !value && 'text-muted-foreground',
        )}
      >
        {triggerLabel}
      </span>
      <ChevronDown
        className="size-3.5 shrink-0 opacity-50 transition-transform group-data-[state=open]:rotate-180"
        aria-hidden
      />
    </motion.button>
  )

  if (isMobile) {
    return (
      <>
        {trigger(() => setSheetOpen(true))}
        <SessionPickerSheet
          open={sheetOpen}
          onOpenChange={setSheetOpen}
          options={options}
          selected={value}
          title={sheetTitle ?? menuLabel}
          onPick={(name) => {
            onChange(name)
            setSheetOpen(false)
          }}
        />
      </>
    )
  }

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>{trigger()}</DropdownMenuTrigger>
      <DropdownMenuContent
        align="end"
        className="min-w-56 max-h-[60vh] overflow-y-auto"
      >
        <DropdownMenuLabel className="text-muted-foreground">
          {menuLabel}
        </DropdownMenuLabel>
        <DropdownMenuRadioGroup value={value} onValueChange={onChange}>
          {options.map((o, idx) => (
            <React.Fragment key={`${idx}-${o.name}`}>
              {/* A subtle separator between the "(no session)" row and the
                  live list — only when allowEmpty AND we actually have live
                  options to separate from. */}
              {allowEmpty && idx === 1 && options.length > 1 && (
                <DropdownMenuSeparator />
              )}
              <DropdownMenuRadioItem value={o.name} className="gap-2 py-2">
                {o.name ? (
                  <TerminalSquare
                    className="size-4 shrink-0 text-muted-foreground"
                    aria-hidden
                  />
                ) : (
                  <span className="size-4 shrink-0" aria-hidden />
                )}
                <span
                  className={cn(
                    'truncate text-sm',
                    !o.name && 'text-muted-foreground',
                  )}
                >
                  {o.label}
                </span>
              </DropdownMenuRadioItem>
            </React.Fragment>
          ))}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

// ── Mobile sheet (Vaul half-sheet, 44pt rows, check icons) ─────────────────────

function SessionPickerSheet({
  open,
  onOpenChange,
  options,
  selected,
  title,
  onPick,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  options: { name: string; label: string }[]
  selected: string
  title: string
  onPick: (name: string) => void
}) {
  return (
    <Drawer.Root open={open} onOpenChange={onOpenChange}>
      <Drawer.Portal>
        <Drawer.Overlay className="fixed inset-0 z-[60] bg-black/40" />
        <Drawer.Content
          aria-describedby={undefined}
          className={cn(
            'glass fixed inset-x-0 bottom-0 z-[60] flex max-h-[70vh] flex-col',
            'rounded-t-[10px] border-t border-border/60 pb-safe outline-none',
          )}
        >
          <div className="mx-auto mt-1.5 h-[5px] w-9 shrink-0 rounded-[2.5px] bg-muted-foreground/30" />
          <Drawer.Title className="px-4 pb-1 pt-3 text-[13px] font-semibold text-muted-foreground">
            {title}
          </Drawer.Title>

          <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-2">
            {options.map((o, idx) => {
              const isCurrent = o.name === selected
              return (
                <motion.button
                  key={`${idx}-${o.name}`}
                  type="button"
                  whileTap={{ scale: 0.98 }}
                  transition={springs.buttonPress}
                  onClick={() => onPick(o.name)}
                  className={cn(
                    'flex h-12 w-full items-center gap-3 rounded-lg px-3 text-left',
                    isCurrent ? 'bg-secondary' : 'active:bg-secondary/60',
                  )}
                >
                  {o.name ? (
                    <TerminalSquare
                      className="size-4 shrink-0 text-muted-foreground"
                      aria-hidden
                    />
                  ) : (
                    <span className="size-4 shrink-0" aria-hidden />
                  )}
                  <span
                    className={cn(
                      'min-w-0 flex-1 truncate text-[15px] font-medium',
                      !o.name && 'text-muted-foreground',
                    )}
                  >
                    {o.label}
                  </span>
                  {isCurrent && (
                    <Check
                      className="size-4 shrink-0 text-primary"
                      aria-label="Current"
                    />
                  )}
                </motion.button>
              )
            })}
          </div>
        </Drawer.Content>
      </Drawer.Portal>
    </Drawer.Root>
  )
}
