// QuickKeysSheet — the curated tap-to-send quick-keys panel (R5 quick-keys).
//
// Replaces the old SpecialsSheet's "type the special key" 2×2 pager with a
// curated library rendered as big 44pt tap-to-send chips inside the shared
// `<MobileActionSheet>` Vaul shell (backdrop dismiss, drag-down, focus-trap,
// safe-area — all inherited; none of the slash-popover quirks).
//
//   • TAP-TO-SEND mode (default): the user's SELECTED entries, grouped under
//     small sentence-case section labels (Control / Replies / Commands /
//     Snippets). One tap = send + close. Sending routes through the kind→call
//     switch which calls the EXISTING `onKey` (sendKey) / `onSend` (send) props
//     — no new send path.
//   • EDIT mode (header "Edit" pill): the WHOLE catalog as on/off toggle chips.
//     Tapping a chip toggles membership (no typing). Selection persists to the
//     `quick_keys` server pref via useQuickKeys (optimistic + SSE-synced).
//
// QUALITY: design tokens (glass/bg-card/border-border), springs.buttonPress for
// chip press, 44pt hit targets (h-12), 8px continuous corners, sentence-case,
// whileTap scale + gated navigator.vibrate(8) (Android-only; NO-OP on iOS).

import * as React from 'react'
import { motion } from 'framer-motion'
import { Check, Pencil } from 'lucide-react'

import { cn } from '@/lib/utils'
import { springs } from '@/lib/springs'
import { useSlashCommands, useSnippets } from '@/hooks/use-commands'
import { useQuickKeys } from '@/hooks/use-quick-keys'
import { MobileActionSheet } from './mobile-action-sheet'
import {
  buildCatalog,
  resolveSelection,
  GROUP_LABELS,
  GROUP_ORDER,
  type QuickEntry,
  type QuickGroup,
} from './quick-keys'

export interface QuickKeysSheetProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** Send a named key to the pty (LiveTerminal.sendKey) — the 'key' kind. */
  onKey: (name: string) => void
  /** Send literal text to the pty (LiveTerminal.send) — text/slash/snippet add
   *  their own '\r' (handled here per the send-path table). */
  onSend: (text: string) => void
}

/** Resolve what a tap on an entry should send, using ONLY the existing handles.
 *  'key' → sendKey(payload); the other three → send(payload + '\r'). */
function sendEntry(
  entry: QuickEntry,
  onKey: (name: string) => void,
  onSend: (text: string) => void,
) {
  if (entry.kind === 'key') {
    onKey(entry.payload)
  } else {
    // text / slash / snippet — a reply/command/body + Enter (the SAME path the
    // snippet "run" already uses at routes/focus/mobile.tsx).
    onSend(entry.payload + '\r')
  }
}

export function QuickKeysSheet({
  open,
  onOpenChange,
  onKey,
  onSend,
}: QuickKeysSheetProps) {
  const { selected: selectedIds, setSelected } = useQuickKeys()
  const { data: slashCmds = [] } = useSlashCommands()
  const { data: snippets = [] } = useSnippets()

  const [editing, setEditing] = React.useState(false)
  // Leaving edit mode when the sheet closes keeps the next open in tap-to-send.
  // Done in the open-change handler (not an effect) so there's no setState-in-
  // effect cascade — the close path is the only thing that needs to reset it.
  const handleOpenChange = React.useCallback(
    (next: boolean) => {
      if (!next) setEditing(false)
      onOpenChange(next)
    },
    [onOpenChange],
  )

  const catalog = React.useMemo(
    () => buildCatalog(slashCmds, snippets),
    [slashCmds, snippets],
  )
  const selectedEntries = React.useMemo(
    () => resolveSelection(selectedIds, catalog),
    [selectedIds, catalog],
  )
  const selectedSet = React.useMemo(() => new Set(selectedIds), [selectedIds])

  const onTapSend = React.useCallback(
    (entry: QuickEntry) => {
      sendEntry(entry, onKey, onSend)
      handleOpenChange(false)
    },
    [onKey, onSend, handleOpenChange],
  )

  const onToggle = React.useCallback(
    (id: string) => {
      // Toggle membership; appending keeps a newly-added chip at the end of its
      // section (the id order IS the chip order).
      const next = selectedSet.has(id)
        ? selectedIds.filter((x) => x !== id)
        : [...selectedIds, id]
      setSelected(next)
    },
    [selectedIds, selectedSet, setSelected],
  )

  return (
    <MobileActionSheet
      open={open}
      onOpenChange={handleOpenChange}
      title="Quick keys"
      headerAction={
        <EditPill editing={editing} onClick={() => setEditing((e) => !e)} />
      }
    >
      {/* Scrollable body — data-vaul-no-drag so a vertical scroll wins over the
          sheet drag-to-dismiss (same pattern as the terminal body). */}
      <div
        data-vaul-no-drag
        className="min-h-0 flex-1 overflow-y-auto px-4 pb-4 pt-1"
      >
        {editing ? (
          <CatalogPicker
            catalog={catalog}
            selectedSet={selectedSet}
            onToggle={onToggle}
          />
        ) : (
          <SelectedGrid entries={selectedEntries} onSend={onTapSend} />
        )}
      </div>
    </MobileActionSheet>
  )
}

// ── header Edit / Done pill ───────────────────────────────────────────────────

function EditPill({
  editing,
  onClick,
}: {
  editing: boolean
  onClick: () => void
}) {
  return (
    <motion.button
      type="button"
      onClick={onClick}
      whileTap={{ scale: 0.94 }}
      transition={springs.buttonPress}
      aria-pressed={editing}
      aria-label={editing ? 'Done editing quick keys' : 'Edit quick keys'}
      className={cn(
        'flex h-8 items-center gap-1.5 rounded-lg px-3 text-[13px] font-medium',
        editing
          ? 'bg-primary/15 text-primary'
          : 'text-muted-foreground hover:bg-secondary',
      )}
    >
      {editing ? (
        <>
          <Check className="size-4" />
          Done
        </>
      ) : (
        <>
          <Pencil className="size-4" />
          Edit
        </>
      )}
    </motion.button>
  )
}

// ── tap-to-send mode: the selected entries, grouped ───────────────────────────

function SelectedGrid({
  entries,
  onSend,
}: {
  entries: QuickEntry[]
  onSend: (entry: QuickEntry) => void
}) {
  if (entries.length === 0) {
    return (
      <p className="px-1 py-8 text-center text-[13px] text-muted-foreground">
        No quick keys yet. Tap{' '}
        <span className="font-medium text-foreground">Edit</span> to add some.
      </p>
    )
  }
  return (
    <div className="space-y-4">
      {GROUP_ORDER.map((group) => {
        const groupEntries = entries.filter((e) => e.group === group)
        if (groupEntries.length === 0) return null
        return (
          <Section key={group} group={group}>
            {groupEntries.map((entry) => (
              <Chip
                key={entry.id}
                entry={entry}
                onClick={() => onSend(entry)}
              />
            ))}
          </Section>
        )
      })}
    </div>
  )
}

// ── edit mode: the whole catalog as on/off toggles ────────────────────────────

function CatalogPicker({
  catalog,
  selectedSet,
  onToggle,
}: {
  catalog: QuickEntry[]
  selectedSet: Set<string>
  onToggle: (id: string) => void
}) {
  return (
    <div className="space-y-4">
      {GROUP_ORDER.map((group) => {
        const groupEntries = catalog.filter((e) => e.group === group)
        if (groupEntries.length === 0) return null
        return (
          <Section key={group} group={group}>
            {groupEntries.map((entry) => (
              <Chip
                key={entry.id}
                entry={entry}
                selected={selectedSet.has(entry.id)}
                onClick={() => onToggle(entry.id)}
              />
            ))}
          </Section>
        )
      })}
    </div>
  )
}

function Section({
  group,
  children,
}: {
  group: QuickGroup
  children: React.ReactNode
}) {
  return (
    <div>
      <p className="mb-2 text-[11px] font-medium text-muted-foreground">
        {GROUP_LABELS[group]}
      </p>
      <div className="flex flex-wrap gap-2">{children}</div>
    </div>
  )
}

// ── one chip — tap-to-send OR a selection toggle (edit mode) ──────────────────

function Chip({
  entry,
  onClick,
  selected,
}: {
  entry: QuickEntry
  onClick: () => void
  /** When provided, the chip is a toggle (edit mode): filled = selected. */
  selected?: boolean
}) {
  const Icon = entry.icon
  const isToggle = selected !== undefined
  const mono = entry.kind === 'key'
  return (
    <motion.button
      type="button"
      whileTap={{ scale: 0.96 }}
      transition={springs.buttonPress}
      aria-pressed={isToggle ? selected : undefined}
      onClick={() => {
        if ('vibrate' in navigator) navigator.vibrate(8)
        onClick()
      }}
      className={cn(
        // ≥44pt hit target (h-12), 8px continuous corner.
        'flex h-12 items-center justify-center gap-2 rounded-lg border px-4',
        'text-[15px] font-semibold active:bg-secondary',
        mono && 'font-mono',
        isToggle
          ? selected
            ? 'border-primary/40 bg-primary/15 text-primary'
            : 'border-border bg-card text-muted-foreground'
          : 'border-border bg-card text-foreground',
      )}
    >
      {Icon && <Icon className="size-[18px] shrink-0" aria-hidden />}
      <span className="truncate">{entry.label}</span>
      {isToggle && selected && (
        <Check className="size-4 shrink-0 text-primary" aria-hidden />
      )}
    </motion.button>
  )
}

export default QuickKeysSheet
