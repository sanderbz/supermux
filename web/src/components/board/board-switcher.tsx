// board-switcher.tsx — the multi-board switcher (AT-C, plan §5.5).
//
// The single Board became MULTIPLE boards (Main + one per Claude Code team + an
// optional "All" overview). This is the dropdown that toggles between them —
// REUSING the focus/terminal-view session-switcher pattern (mode-menu.tsx's chic
// pill trigger on desktop; session-picker-sheet.tsx's Vaul half-sheet on mobile).
//
//   • Desktop (fine pointer): the trigger is a pill sitting NEXT TO the board
//     title; it opens a Radix <DropdownMenu> of radio rows (keyboard-accessible:
//     ↑/↓, Enter, Esc), exactly the affordance the focus header's ModeMenu uses.
//   • Mobile (coarse pointer): the SAME pill opens a Vaul bottom half-sheet whose
//     rows are pixel-for-pixel the session-picker-sheet rows (h-12, glass, drag
//     indicator, accent-on-current, check) — the native pattern the user asked us
//     to reuse, placed compactly in the board header.
//
// Options = Main · each team board · an optional "All" aggregate. Selecting a
// board scopes the board view to that board_id (the route owns the data fetch).

import * as React from 'react'
import { Drawer } from 'vaul'
import { motion } from 'framer-motion'
import {
  Check,
  ChevronDown,
  LayoutGrid,
  Layers,
  TerminalSquare,
  Users,
} from 'lucide-react'

import { cn } from '@/lib/utils'
import { springs } from '@/lib/springs'
import { useMediaQuery } from '@/hooks/use-media-query'
import { ALL_BOARD_ID, MAIN_BOARD_ID, type Board } from '@/lib/api'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'

/** A switcher option: a real board (main/team), a synthetic per-session filter
 *  (FEAT-BOARD-SESSION), or the synthetic "All" aggregate. */
export interface BoardOption {
  id: string
  name: string
  kind: 'main' | 'team' | 'session' | 'all'
}

export interface BoardSwitcherProps {
  boards: Board[]
  /** The currently-selected board id (or {@link ALL_BOARD_ID}). */
  selected: string
  onSelect: (id: string) => void
  /** Show the "All" cross-board overview option (plan §5.5 — optional). */
  showAll?: boolean
  className?: string
}

/** Build the ordered option list: Main → team boards → per-session boards
 *  (FEAT-BOARD-SESSION) → "All". `useBoards` already returns the synthetic
 *  per-session entries (kind:'session') inline with the real boards in the
 *  desired order, so a single pass over `boards` preserves that ordering.
 *  The "All" overview is only relevant when ≥1 OTHER REAL board exists (i.e.
 *  Main + ≥1 team board); per-session entries are filtered views of Main, so
 *  showing "All" just for them would duplicate Main itself. */
function buildOptions(boards: Board[], showAll: boolean): BoardOption[] {
  const opts: BoardOption[] = boards.map((b) => ({
    id: b.id,
    name: b.name,
    kind: b.kind,
  }))
  const realBoardCount = boards.filter((b) => b.kind !== 'session').length
  if (showAll && realBoardCount > 1) {
    opts.push({ id: ALL_BOARD_ID, name: 'All boards', kind: 'all' })
  }
  return opts
}

/** Render the icon for a board kind as JSX (not a component factory — keeps
 *  ESLint's no-component-during-render rule happy). */
function boardIcon(kind: BoardOption['kind'], className?: string) {
  if (kind === 'all') return <Layers className={className} aria-hidden />
  if (kind === 'team') return <Users className={className} aria-hidden />
  if (kind === 'session')
    return <TerminalSquare className={className} aria-hidden />
  return <LayoutGrid className={className} aria-hidden />
}

export function BoardSwitcher({
  boards,
  selected,
  onSelect,
  showAll = true,
  className,
}: BoardSwitcherProps) {
  const isMobile = useMediaQuery('(pointer: coarse)')
  const [sheetOpen, setSheetOpen] = React.useState(false)
  const options = React.useMemo(
    () => buildOptions(boards, showAll),
    [boards, showAll],
  )
  // Resolve the current label: the selected board, the All aggregate, or a
  // graceful "Main" fallback when a persisted selection has gone away.
  const current =
    options.find((o) => o.id === selected) ??
    options.find((o) => o.id === MAIN_BOARD_ID) ??
    options[0]

  // A lone Main board (no teams, no All) → nothing to switch; render just the
  // board name so the header reads cleanly (no dead dropdown).
  if (options.length <= 1) {
    return (
      <span
        className={cn(
          'inline-flex items-center gap-1.5 text-sm font-medium text-muted-foreground',
          className,
        )}
      >
        {current?.name ?? 'Main'}
      </span>
    )
  }

  // The shared pill trigger — chic, rounded-full, caret; mirrors ModeMenu.
  const renderTrigger = (onClick?: () => void) => (
    <motion.button
      type="button"
      onClick={onClick}
      whileTap={{ scale: 0.97 }}
      transition={springs.buttonPress}
      aria-label={`Board: ${current?.name ?? 'Main'} — switch`}
      className={cn(
        'group inline-flex h-8 shrink-0 items-center gap-1.5 rounded-full pl-2.5 pr-1.5',
        'bg-secondary text-sm font-medium leading-none text-foreground/90',
        'transition-colors hover:text-foreground active:bg-secondary/70',
        'data-[state=open]:bg-secondary data-[state=open]:text-foreground',
        className,
      )}
    >
      {current && boardIcon(current.kind, 'size-3.5 shrink-0 opacity-70')}
      <span className="max-w-[40vw] truncate sm:max-w-[14rem]">
        {current?.name ?? 'Main'}
      </span>
      <ChevronDown
        className="size-3.5 shrink-0 opacity-50 transition-transform group-data-[state=open]:rotate-180"
        aria-hidden
      />
    </motion.button>
  )

  // Mobile: the pill opens a Vaul half-sheet (the session-picker pattern).
  if (isMobile) {
    return (
      <>
        {renderTrigger(() => setSheetOpen(true))}
        <BoardPickerSheet
          open={sheetOpen}
          onOpenChange={setSheetOpen}
          options={options}
          selected={current?.id ?? MAIN_BOARD_ID}
          onPick={onSelect}
        />
      </>
    )
  }

  // Desktop: a Radix dropdown of radio rows (the ModeMenu affordance).
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>{renderTrigger()}</DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="min-w-56">
        <DropdownMenuLabel className="text-muted-foreground">Board</DropdownMenuLabel>
        <DropdownMenuRadioGroup
          value={current?.id ?? MAIN_BOARD_ID}
          onValueChange={onSelect}
        >
          {options.map((o, idx) => {
            // A separator between groups: a `session` row when the previous row
            // wasn't a session (so the per-session group sits visibly apart from
            // Main + team boards), and above the `all` aggregate so it reads as
            // an overview, not just another board.
            const prev = options[idx - 1]
            const sep =
              (o.kind === 'all' && idx > 0) ||
              (o.kind === 'session' && idx > 0 && prev?.kind !== 'session')
            return (
              <React.Fragment key={o.id}>
                {sep && <DropdownMenuSeparator />}
                <DropdownMenuRadioItem value={o.id} className="gap-2 py-2">
                  {boardIcon(o.kind, 'size-4 shrink-0 text-muted-foreground')}
                  <span className="truncate text-sm">{o.name}</span>
                </DropdownMenuRadioItem>
              </React.Fragment>
            )
          })}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

// ── mobile sheet (the session-picker-sheet pattern, board edition) ─────────────

interface BoardPickerSheetProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  options: BoardOption[]
  selected: string
  onPick: (id: string) => void
}

function BoardPickerSheet({
  open,
  onOpenChange,
  options,
  selected,
  onPick,
}: BoardPickerSheetProps) {
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
            Boards
          </Drawer.Title>

          <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-2">
            {options.map((o) => {
              const isCurrent = o.id === selected
              return (
                <motion.button
                  key={o.id}
                  type="button"
                  whileTap={{ scale: 0.98 }}
                  transition={springs.buttonPress}
                  onClick={() => {
                    onPick(o.id)
                    onOpenChange(false)
                  }}
                  className={cn(
                    'flex h-12 w-full items-center gap-3 rounded-lg px-3 text-left',
                    isCurrent ? 'bg-secondary' : 'active:bg-secondary/60',
                  )}
                >
                  {boardIcon(o.kind, 'size-4 shrink-0 text-muted-foreground')}
                  <span className="min-w-0 flex-1 truncate text-[15px] font-medium">
                    {o.name}
                  </span>
                  {o.kind === 'team' && (
                    <span className="shrink-0 text-[12px] text-muted-foreground">
                      Team
                    </span>
                  )}
                  {o.kind === 'session' && (
                    <span className="shrink-0 text-[12px] text-muted-foreground">
                      Session
                    </span>
                  )}
                  {isCurrent && (
                    <Check className="size-4 shrink-0 text-primary" aria-label="Current" />
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

export default BoardSwitcher
