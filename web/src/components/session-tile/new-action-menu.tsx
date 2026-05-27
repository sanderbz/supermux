// NewActionMenu — the single "+" trigger that consolidates the three primary
// creation actions on the Overview top bar: "New session", "Start a team",
// "New group". Replaces three separate header buttons (which crowded the bar
// on every viewport and forced two duplicate sets on mobile vs. desktop).
//
// Disclosure surface forks on input modality (`pointer: coarse` → touch):
//   • Desktop (fine pointer) → Radix Popover anchored to the trigger
//     (align="end"), iOS-menu treatment: rounded card, hairline border,
//     subtle shadow, scale+fade entrance via the Popover's built-in
//     data-state classes (already configured in ui/popover.tsx).
//   • Mobile (coarse pointer) → Vaul `Drawer.Root` modal bottom sheet —
//     same `glass` material + drag indicator as ResponsiveSheet /
//     board-switcher's BoardPickerSheet, so the language is consistent
//     with every other Overview disclosure on touch.
//
// Each row is a single tap target — ≥44pt min height, icon + label +
// secondary hint, spring-scaled press-down (springs.buttonPress). All motion
// goes through the existing `springs` bank; no `transition: all`. Labels are
// sentence-case (no UPPERCASE). Keyboard: Esc closes, Tab cycles items
// (Radix handles roving focus on the Popover content; the mobile drawer
// handles focus trap itself).

import * as React from 'react'
import { motion, useReducedMotion } from 'framer-motion'
import { Drawer } from 'vaul'
import { FolderPlus, Plus, TerminalSquare, Users } from 'lucide-react'
import type { LucideIcon } from 'lucide-react'

import { cn } from '@/lib/utils'
import { springs } from '@/lib/springs'
import { useMediaQuery } from '@/hooks/use-media-query'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Kbd } from '@/components/ui/kbd'
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/components/ui/popover'

export interface NewActionMenuProps {
  /** Open the New-session sheet. */
  onNewSession: () => void
  /** Open the Start-a-team sheet. */
  onStartTeam: () => void
  /** Begin the in-place "Add group" flow (flips layout to custom internally). */
  onNewGroup: () => void
}

interface ActionItem {
  id: 'session' | 'team' | 'group'
  label: string
  hint: string
  icon: LucideIcon
  onSelect: () => void
  shortcut?: string
  /** Show a small informational chip next to the label (e.g. "Beta" for
   *  Agent Teams — mirrors the Settings → Experimental treatment, but
   *  inline at the choice point so the surprise lands before commit, not
   *  after). */
  badge?: string
}

export function NewActionMenu({
  onNewSession,
  onStartTeam,
  onNewGroup,
}: NewActionMenuProps) {
  const [open, setOpen] = React.useState(false)
  // Same modality fork the rest of the Overview's disclosures use
  // (ResponsiveSheet, session-info-panel) — coarse pointer = touch.
  const isMobile = useMediaQuery('(pointer: coarse)')
  const reduce = useReducedMotion()

  const items: ActionItem[] = React.useMemo(
    () => [
      {
        id: 'session',
        label: 'New session',
        hint: 'Boot a fresh agent in a directory',
        icon: TerminalSquare,
        onSelect: onNewSession,
      },
      {
        id: 'team',
        label: 'Start a team',
        hint: 'Several agents on one shared goal',
        icon: Users,
        onSelect: onStartTeam,
        badge: 'Beta',
      },
      {
        id: 'group',
        label: 'New group',
        hint: 'Organise tiles into a labelled section',
        icon: FolderPlus,
        onSelect: onNewGroup,
        shortcut: 'g n',
      },
    ],
    [onNewSession, onStartTeam, onNewGroup],
  )

  const handle = React.useCallback(
    (fn: () => void) => () => {
      setOpen(false)
      // Defer to the next frame so the disclosure surface unmounts cleanly
      // before the destination sheet opens (avoids a Radix focus-restore
      // tug-of-war when one Dialog closes and another opens on the same tick).
      requestAnimationFrame(fn)
    },
    [],
  )

  const Trigger = (
    <Button
      type="button"
      aria-label="New…"
      aria-haspopup="menu"
      aria-expanded={open}
      // The trigger now answers for both the "New session" CTA and the
      // "Start a team" CTA in the onboarding tour — keep the existing
      // `data-tour="start-team"` anchor so tour-overlay.tsx still finds it.
      data-tour="start-team"
      // size-9 + rounded-md matches every other right-side header chip
      // (ViewToggle, SortControl, density control) so the trigger blends
      // into the bar's button rail. `ml-auto` so when the header wraps on
      // narrow phones (<375 + chips together would overflow), the "+" still
      // floats to the visual right edge — the iOS Mail "Compose"
      // top-right pattern — instead of orphaning on the left of a new row.
      className="size-9 rounded-md p-0 ml-auto sm:ml-0"
    >
      {/* Rotate the icon 45° when open → "×". Pure transform, spring-driven. */}
      <motion.span
        animate={{ rotate: open ? 45 : 0 }}
        transition={reduce ? { duration: 0 } : springs.toggleSnap}
        className="flex items-center justify-center"
      >
        <Plus className="size-4" aria-hidden />
      </motion.span>
    </Button>
  )

  if (isMobile) {
    return (
      <Drawer.Root open={open} onOpenChange={setOpen}>
        <Drawer.Trigger asChild>{Trigger}</Drawer.Trigger>
        <Drawer.Portal>
          <Drawer.Overlay className="fixed inset-0 z-[60] bg-black/40" />
          <Drawer.Content
            aria-describedby={undefined}
            className={cn(
              'glass fixed inset-x-0 bottom-0 z-[60] flex flex-col',
              'rounded-t-[10px] border-t border-border/60 pb-safe outline-none',
            )}
          >
            <div className="mx-auto mt-1.5 h-[5px] w-9 shrink-0 rounded-[2.5px] bg-muted-foreground/30" />
            <Drawer.Title className="px-4 pb-1 pt-3 text-[13px] font-semibold text-muted-foreground">
              Create
            </Drawer.Title>
            <div role="menu" className="flex flex-col gap-1 p-2">
              {items.map((item) => (
                <ActionRow
                  key={item.id}
                  item={item}
                  onSelect={handle(item.onSelect)}
                  reduce={!!reduce}
                />
              ))}
            </div>
          </Drawer.Content>
        </Drawer.Portal>
      </Drawer.Root>
    )
  }

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>{Trigger}</PopoverTrigger>
      <PopoverContent
        align="end"
        sideOffset={6}
        // w-64 leaves room for icon + label + 2-line hint without truncation;
        // p-1 because each row carries its own padding for crisp 11pt rhythm.
        className="w-64 rounded-[10px] p-1"
      >
        <div role="menu">
          {items.map((item) => (
            <ActionRow
              key={item.id}
              item={item}
              onSelect={handle(item.onSelect)}
              reduce={!!reduce}
            />
          ))}
        </div>
      </PopoverContent>
    </Popover>
  )
}

// ── Row ───────────────────────────────────────────────────────────────────────

function ActionRow({
  item,
  onSelect,
  reduce,
}: {
  item: ActionItem
  onSelect: () => void
  reduce: boolean
}) {
  const { icon: Icon, label, hint, shortcut, badge } = item
  return (
    <motion.button
      type="button"
      role="menuitem"
      onClick={onSelect}
      // 44pt minimum touch target (`min-h-11`) per iOS HIG.
      whileTap={reduce ? undefined : { scale: 0.98 }}
      transition={springs.buttonPress}
      className={cn(
        'group flex w-full min-h-11 items-center gap-3 rounded-md px-3 py-2 text-left',
        'hover:bg-accent hover:text-accent-foreground',
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
      )}
    >
      <span
        aria-hidden
        className="flex size-8 shrink-0 items-center justify-center rounded-md bg-muted text-muted-foreground group-hover:bg-background"
      >
        <Icon className="size-4" />
      </span>
      <span className="flex min-w-0 flex-1 flex-col leading-tight">
        <span className="flex items-center gap-1.5">
          <span className="text-sm font-medium text-foreground">{label}</span>
          {badge && (
            // Compact secondary chip — informational, NOT promotional. Mirrors
            // the Settings → Experimental tone (calm, opt-in power) so the same
            // capability reads the same way wherever it appears. `py-0` + the
            // smaller text keeps row height unchanged at the 44pt min-target.
            <Badge
              variant="secondary"
              className="h-[15px] shrink-0 px-1.5 py-0 text-[10px] font-medium tracking-normal"
            >
              {badge}
            </Badge>
          )}
        </span>
        <span className="truncate text-xs text-muted-foreground">{hint}</span>
      </span>
      {shortcut && (
        <Kbd
          variant="muted"
          className="hidden shrink-0 sm:inline-flex"
        >
          {shortcut}
        </Kbd>
      )}
    </motion.button>
  )
}
