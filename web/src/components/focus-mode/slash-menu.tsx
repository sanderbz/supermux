// SlashMenu — M18 (TECH_PLAN §4.4.1, §M18).
//
// When the composer value starts with "/", this popover floats ABOVE the input
// and shows the live `/api/slash-commands` list (M9 built-ins + user skills),
// filtered by the typed prefix. Arrow keys navigate, Enter / tap selects: the
// chosen command is handed back to the composer, which replaces the input value
// and parks the cursor at the end.
//
// This is a NEW, self-contained file (§M18 coordination): the composer wires it
// with three small props and a `<SlashMenu>` mount — dock.tsx itself is touched
// only minimally. The menu owns NO send path; it only reports the picked cmd.
//
// VISUAL (Termius #1/#5/#16/#18/#19):
//   • ≥44pt rows (h-11) — iOS HIG tap-target floor.
//   • Mono command text, sentence-case description — NO uppercase.
//   • Spring `cardExpand` for the open/close morph (the ".smooth"/popover feel);
//     NO `transition: all` anywhere.
//   • `.thinMaterial` look — glass over the terminal buffer so it stays legible.
//   • Selected row springs a subtle highlight; tap-press scales 0.97.

import * as React from 'react'
import { AnimatePresence, motion, useReducedMotion } from 'framer-motion'

import { cn } from '@/lib/utils'
import { springs } from '@/lib/springs'
import { useSlashCommands } from '@/hooks/use-commands'
import type { SlashCommand } from '@/lib/api'

export interface SlashMenuProps {
  /** Current composer value. The menu shows itself only while this starts "/". */
  value: string
  /** True once the composer wants the menu visible (value starts with "/" and
   *  the field is focused). The composer owns this so it can also dismiss. */
  open: boolean
  /** Pick a command — the composer replaces its value with `cmd` + a space. */
  onSelect: (cmd: string) => void
  /** Dismiss without picking (Escape, or value no longer starts with "/"). */
  onDismiss: () => void
}

/** Case-insensitive prefix filter. The user's "/com" must match "/compact";
 *  an empty prefix (bare "/") shows everything. */
function filterCommands(all: SlashCommand[], value: string): SlashCommand[] {
  const q = value.toLowerCase()
  if (q === '/' || q === '') return all
  return all.filter((c) => c.cmd.toLowerCase().startsWith(q))
}

export function SlashMenu({ value, open, onSelect, onDismiss }: SlashMenuProps) {
  const reduceMotion = useReducedMotion()
  const { data: commands = [], isLoading, isError } = useSlashCommands()

  const filtered = React.useMemo(
    () => filterCommands(commands, value),
    [commands, value],
  )

  // Active row for arrow-key navigation. The raw index is stored as-is; a
  // derived `active` clamps it to the current (possibly shorter) filtered list
  // so a narrowing prefix never leaves the highlight out of bounds — pure
  // derivation, no setState cascade.
  const [rawActive, setRawActive] = React.useState(0)
  const active =
    filtered.length === 0
      ? 0
      : Math.min(rawActive, filtered.length - 1)

  // Resetting the highlight to the top on every keystroke is done by keying the
  // arrow-key state off `value`: a fresh value sets rawActive 0 via the handler.
  const valueAtActive = React.useRef(value)

  const listRef = React.useRef<HTMLDivElement | null>(null)

  // Keep the active row in view as arrow keys walk the list.
  React.useEffect(() => {
    const el = listRef.current?.querySelector<HTMLElement>(
      `[data-slash-row="${active}"]`,
    )
    el?.scrollIntoView({ block: 'nearest' })
  }, [active])

  // Reset the highlight to the top whenever the typed value changes (effect —
  // refs are writable here, and the setState is conditional so no cascade).
  React.useEffect(() => {
    if (valueAtActive.current !== value) {
      valueAtActive.current = value
      setRawActive(0)
    }
  }, [value])

  // Arrow / Enter / Escape are handled at the window level while open so the
  // composer textarea keeps focus (the keyboard stays up on mobile). The
  // composer also forwards its own keydown, but capturing here keeps the menu
  // self-contained and works for the desktop dock too.
  React.useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'ArrowDown') {
        e.preventDefault()
        setRawActive((i) =>
          Math.min(i + 1, Math.max(filtered.length - 1, 0)),
        )
      } else if (e.key === 'ArrowUp') {
        e.preventDefault()
        setRawActive((i) => Math.max(i - 1, 0))
      } else if (e.key === 'Enter') {
        if (filtered[active]) {
          e.preventDefault()
          onSelect(filtered[active].cmd)
        }
      } else if (e.key === 'Escape') {
        e.preventDefault()
        onDismiss()
      }
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [open, filtered, active, onSelect, onDismiss])

  return (
    <AnimatePresence>
      {open && (
        <motion.div
          // Floats ABOVE the composer — the parent positions this absolutely.
          initial={reduceMotion ? false : { opacity: 0, y: 8, scale: 0.98 }}
          animate={{ opacity: 1, y: 0, scale: 1 }}
          exit={reduceMotion ? { opacity: 0 } : { opacity: 0, y: 8, scale: 0.98 }}
          transition={reduceMotion ? { duration: 0 } : springs.cardExpand}
          role="listbox"
          aria-label="Slash commands"
          className={cn(
            // .thinMaterial — glass so the terminal buffer stays legible.
            'glass overflow-hidden rounded-2xl border border-border/60 shadow-xl',
          )}
        >
          {isLoading ? (
            <p className="px-4 py-3 text-[13px] text-muted-foreground">
              Loading commands…
            </p>
          ) : isError ? (
            <p className="px-4 py-3 text-[13px] text-muted-foreground">
              Can’t reach supermux-server.
            </p>
          ) : filtered.length === 0 ? (
            <p className="px-4 py-3 text-[13px] text-muted-foreground">
              No command matches “{value}”.
            </p>
          ) : (
            <div
              ref={listRef}
              className="max-h-[min(50vh,320px)] overflow-y-auto py-1"
            >
              {filtered.map((c, i) => (
                <SlashRow
                  key={c.cmd}
                  index={i}
                  command={c}
                  active={i === active}
                  onHover={() => setRawActive(i)}
                  onPick={() => onSelect(c.cmd)}
                />
              ))}
            </div>
          )}
        </motion.div>
      )}
    </AnimatePresence>
  )
}

/** One ≥44pt row — mono command + sentence-case description. */
function SlashRow({
  index,
  command,
  active,
  onHover,
  onPick,
}: {
  index: number
  command: SlashCommand
  active: boolean
  onHover: () => void
  onPick: () => void
}) {
  return (
    <motion.button
      type="button"
      role="option"
      aria-selected={active}
      data-slash-row={index}
      // Pointer-down (not click) so picking lands before the composer blurs.
      onPointerDown={(e) => {
        e.preventDefault()
        onPick()
      }}
      onMouseEnter={onHover}
      whileTap={{ scale: 0.97 }}
      transition={springs.buttonPress}
      className={cn(
        // ≥44pt hit target (h-11), 8px-ish continuous corner inside the popover.
        'flex h-11 w-full items-center gap-3 px-3 text-left',
        active ? 'bg-secondary' : 'hover:bg-secondary/60',
      )}
    >
      <span className="shrink-0 font-mono text-[14px] font-semibold text-foreground">
        {command.cmd}
      </span>
      {command.desc && (
        <span className="min-w-0 flex-1 truncate text-[12px] text-muted-foreground">
          {command.desc}
        </span>
      )}
    </motion.button>
  )
}

export default SlashMenu
