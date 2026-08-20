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
 * THE GROUPS (the sheet's own title, "Add to your message", governs all of them
 * — so no group repeats that phrase as its header):
 *   · ATTACH — Camera / Photo library / Files, present only when uploads are
 *     wired (`onFiles`). The most common reason to open the `+`, so it leads.
 *   · COMPOSE — the things that stage into the draft the user is writing:
 *     mention a file/session (`@`), a slash command (`/`), a snippet, and
 *     schedule-instead-of-send.
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
import { Camera, FolderOpen, Image as ImageIcon, type LucideIcon } from 'lucide-react'

import { cn } from '@/lib/utils'

import { MobileActionSheet } from '../focus-mode/mobile-action-sheet'
import { composeActionRows, sessionActionRows, type ChatActionHandlers } from './chat-actions'

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
  /** Open the session switcher (the picker sheet); omitted → no row. */
  onSwitchSession?: () => void
  /** Open the global command palette (⌘K) — search / jump / new session. */
  onCommandPalette: () => void
  /**
   * Stage picked files as attachments (composer upgrade). Present ⇒ the sheet
   * grows an ATTACH group at the top — Camera / Photo library / Files — each row
   * owning its own hidden native picker (`capture`/`multiple`). Omitted ⇒ no
   * attach group, so an unwired caller renders exactly as before.
   */
  onFiles?: (files: File[]) => void
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
  onFiles,
}: ChatActionsSheetProps) {
  const cameraRef = React.useRef<HTMLInputElement | null>(null)
  const photosRef = React.useRef<HTMLInputElement | null>(null)
  const filesRef = React.useRef<HTMLInputElement | null>(null)

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

  // A native picker fired: hand the files up to stage them as chips, then close.
  const onPicked = React.useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const picked = Array.from(e.target.files ?? [])
      // Reset so re-picking the SAME file still fires `change`.
      e.target.value = ''
      if (picked.length && onFiles) {
        onFiles(picked)
        onOpenChange(false)
      }
    },
    [onFiles, onOpenChange],
  )

  // The shared row model — the SAME list the desktop popover draws from
  // (`chat-actions.ts`), so the two surfaces can never drift.
  const handlers: ChatActionHandlers = {
    onMention,
    onSlash,
    onSnippets,
    onSchedule,
    onSwitchSession,
    onCommandPalette,
  }

  return (
    <MobileActionSheet open={open} onOpenChange={onOpenChange} title="Add to your message">
      <div className="flex flex-col px-2 pb-2 pt-1">
        {/* ATTACH — the top group, adaptive to the platform's native pickers.
            Folded IN (rather than a second "Attach…" sheet) so the `+` opens one
            menu with everything: one tap, one list. Labelled so the pickers
            don't read as part of the compose group below them; the compose group
            gets its own "Compose" label rather than echoing the sheet title. */}
        {onFiles && (
          <>
            <p className="px-3 pb-1 pt-0.5 text-[11px] font-medium uppercase tracking-[0.04em] text-muted-foreground">
              Attach
            </p>
            <ActionRow
              icon={Camera}
              label="Camera"
              onTap={() => cameraRef.current?.click()}
            />
            <ActionRow
              icon={ImageIcon}
              label="Photo library"
              onTap={() => photosRef.current?.click()}
            />
            <ActionRow
              icon={FolderOpen}
              label="Files"
              onTap={() => filesRef.current?.click()}
            />
            <div className="my-1.5 h-px bg-border/60" />
            <p className="px-3 pb-1 text-[11px] font-medium uppercase tracking-[0.04em] text-muted-foreground">
              Compose
            </p>
          </>
        )}
        {composeActionRows(handlers).map((row) => (
          <ActionRow key={row.key} icon={row.icon} label={row.label} onTap={() => run(row.run)} />
        ))}

        {/* Reachable, but a step removed from composing — set off by a hairline
            and a quiet section label so the menu reads as considered, not as one
            flat list. */}
        <div className="my-1.5 h-px bg-border/60" />
        <p className="px-3 pb-1 text-[11px] font-medium uppercase tracking-[0.04em] text-muted-foreground">
          This session
        </p>
        {sessionActionRows(handlers).map((row) => (
          <ActionRow key={row.key} icon={row.icon} label={row.label} onTap={() => run(row.run)} />
        ))}
      </div>

      {/* Hidden native pickers — one per option (distinct accept/capture), so the
          phone opens the camera, the photo library or the file browser directly.
          Only mounted when attach is wired. */}
      {onFiles && (
        <>
          <input
            ref={cameraRef}
            type="file"
            accept="image/*"
            capture="environment"
            className="hidden"
            onChange={onPicked}
          />
          <input
            ref={photosRef}
            type="file"
            accept="image/*"
            multiple
            className="hidden"
            onChange={onPicked}
          />
          <input
            ref={filesRef}
            type="file"
            accept="*/*"
            multiple
            className="hidden"
            onChange={onPicked}
          />
        </>
      )}
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
        // `tap-transparent`: the row lives in Vaul's transformed, layer-promoted
        // Drawer.Content, where iOS Safari paints its native tap-flash against
        // the row's document box (ignoring the drawer's transform) — landing the
        // grey flash OFFSET from the pressed row. Drop it and let the composited
        // `active:bg` alone give the pressed feedback, exactly on the row.
        'tap-transparent active:bg-muted/60',
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
