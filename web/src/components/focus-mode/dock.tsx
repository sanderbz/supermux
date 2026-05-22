// DesktopDock — M14 (TECH_PLAN §4.4.3 — full desktop dock, pixel spec).
//
//   ┌─[⌘K]─[/]─[+]─┃─[Esc][Tab][^C][^U]⚙─┃─[Detach ⌘D]─[Stop ⌘W]─┐
//   │  left cluster   editable 4-chip send-row    right cluster     │
//   └────────────────────────────────────────────────────────────────┘
//
// 56px tall (mirrors the mobile dock for muscle-memory), bg-card + 1px top
// border. The send-row chips call `sendKey(label)`; they are editable via a gear
// icon. The "/" slash button surfaces the M18 slash menu (stubbed to a callback
// here so M18 plugs in WITHOUT editing this file — §29 dep-graph fix). The "+"
// snippet button + ⌘K palette button take callbacks too.
//
// VISUAL: iOS-native — SF Mono chips, 8px continuous corners, ≥44pt hit targets,
// Title-Case tooltips, spring button-press, no `transition: all`.

import * as React from 'react'
import { motion } from 'framer-motion'
import { Command, Slash, Plus, Minimize2, Square, Settings2 } from 'lucide-react'

import { cn } from '@/lib/utils'
import { springs } from '@/lib/springs'
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@/components/ui/tooltip'

/** Default send-row chips — Esc / Tab / Ctrl-C / Ctrl-U (§4.4.3). Each maps to
 *  a `keyToBytes` name understood by `LiveTerminal.sendKey`. */
const DEFAULT_SEND_CHIPS = ['Esc', 'Tab', 'Ctrl-C', 'Ctrl-U'] as const

export interface DesktopDockProps {
  /** Tap a send-row chip → emit that key into the pty (§4.4.3). */
  onSendKey: (label: string) => void
  /** ⌘K palette trigger (v3.0 stub surface). */
  onPalette?: () => void
  /** "/" slash-menu launcher — wired to the M18 slash menu component. */
  onSlash?: () => void
  /** "+" snippet-drawer toggle — opens the M18 snippet side-sheet. */
  onSnippets?: () => void
  /** Detach (⌘D): leave to overview, keep the session alive. */
  onDetach: () => void
  /** Stop (⌘W): confirm + stop the session. */
  onStop: () => void
}

/** Icon-button shell shared by the left/right clusters — 36×36 visible inside a
 *  44pt hit box, spring press, tooltip. */
function IconButton({
  icon: Icon,
  label,
  onClick,
  tone = 'default',
}: {
  icon: typeof Command
  label: string
  onClick?: () => void
  tone?: 'default' | 'destructive'
}) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <motion.button
          type="button"
          onClick={onClick}
          whileTap={{ scale: 0.94 }}
          transition={springs.buttonPress}
          aria-label={label}
          className={cn(
            'flex size-9 items-center justify-center rounded-xl',
            tone === 'destructive'
              ? 'text-destructive hover:bg-destructive/10'
              : 'text-foreground/80 hover:bg-secondary',
          )}
        >
          <Icon className="size-[18px]" />
        </motion.button>
      </TooltipTrigger>
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  )
}

/** A SF-Mono send-row chip — 28px tall, 8px corner, tap = sendKey. Tooltip shows
 *  the underlying tmux key name (§4.4.3). */
function SendChip({
  label,
  onSend,
}: {
  label: string
  onSend: (label: string) => void
}) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <motion.button
          type="button"
          onClick={() => onSend(label)}
          whileTap={{ scale: 0.94 }}
          transition={springs.buttonPress}
          aria-label={`Send ${label}`}
          // 28px visible height inside a ≥44pt hit area via vertical padding.
          className="flex h-7 min-w-9 items-center justify-center rounded-lg border border-border bg-secondary px-2.5 font-mono text-[13px] font-semibold text-secondary-foreground"
        >
          {label}
        </motion.button>
      </TooltipTrigger>
      <TooltipContent>Send {label}</TooltipContent>
    </Tooltip>
  )
}

export function DesktopDock({
  onSendKey,
  onPalette,
  onSlash,
  onSnippets,
  onDetach,
  onStop,
}: DesktopDockProps) {
  // The send-row is "editable via gear icon": clicking the gear cycles to an
  // editable state where each chip is a text input. Persistent storage is the
  // M16 `/api/kbd-groups` table — here we keep an in-memory edit (single source
  // for THIS dock); M16's manage-sheet supersedes it.
  const [chips, setChips] = React.useState<string[]>([...DEFAULT_SEND_CHIPS])
  const [editing, setEditing] = React.useState(false)

  return (
    <div className="flex h-14 shrink-0 items-center gap-2 border-t border-border bg-card px-6">
      {/* Left cluster (24px ≈ px-6 from edge): ⌘K palette, / slash, + snippets. */}
      <div className="flex shrink-0 items-center gap-1">
        <IconButton icon={Command} label="Command palette (⌘K)" onClick={onPalette} />
        <IconButton icon={Slash} label="Slash menu" onClick={onSlash} />
        <IconButton icon={Plus} label="Snippets" onClick={onSnippets} />
      </div>

      <span className="h-6 w-px shrink-0 bg-border" aria-hidden />

      {/* Center: editable 4-chip send-row + gear. */}
      <div className="flex flex-1 items-center justify-center gap-1.5">
        {editing
          ? chips.map((label, i) => (
              <input
                key={i}
                value={label}
                onChange={(e) =>
                  setChips((c) => c.map((v, j) => (j === i ? e.target.value : v)))
                }
                aria-label={`Send-row chip ${i + 1}`}
                className="h-7 w-16 rounded-lg border border-primary/60 bg-background px-2 text-center font-mono text-[13px] font-semibold outline-none focus:ring-2 focus:ring-ring"
              />
            ))
          : chips.map((label) => (
              <SendChip key={label} label={label} onSend={onSendKey} />
            ))}
        <Tooltip>
          <TooltipTrigger asChild>
            <motion.button
              type="button"
              onClick={() => setEditing((e) => !e)}
              whileTap={{ scale: 0.94 }}
              transition={springs.buttonPress}
              aria-label={editing ? 'Done editing send row' : 'Edit send row'}
              aria-pressed={editing}
              className={cn(
                'flex size-8 items-center justify-center rounded-lg',
                editing
                  ? 'bg-primary/15 text-primary'
                  : 'text-muted-foreground hover:bg-secondary',
              )}
            >
              <Settings2 className="size-4" />
            </motion.button>
          </TooltipTrigger>
          <TooltipContent>{editing ? 'Done' : 'Edit send row'}</TooltipContent>
        </Tooltip>
      </div>

      <span className="h-6 w-px shrink-0 bg-border" aria-hidden />

      {/* Right cluster (24px from edge): Detach ⌘D, Stop ⌘W. */}
      <div className="flex shrink-0 items-center gap-1">
        <IconButton icon={Minimize2} label="Detach (⌘D)" onClick={onDetach} />
        <IconButton
          icon={Square}
          label="Stop session (⌘W)"
          onClick={onStop}
          tone="destructive"
        />
      </div>
    </div>
  )
}

export default DesktopDock
