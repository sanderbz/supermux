// ArchivedSheet — browse + restore/purge archived sessions (feat-archive-recover).
//
// Archive is a soft delete (the row survives with `archived = 1`), but archived
// sessions are otherwise unbrowsable + unrecoverable from the UI. This is the
// opt-in recovery surface — NO permanent screen estate.
//
// B1 T6: this is <ShellOverlay>'s FIRST CONSUMER. On mobile nothing changes —
// ShellOverlay renders <ResponsiveSheet> verbatim, so the Vaul drag-detent
// bottom sheet is byte-identical. On desktop the right-side dialog becomes the
// shell overlay: a frame centred in the content column, with the nav rail and
// route header still visible beside its scrim. Chosen as the first consumer
// because it is shell-mounted (layout.tsx), low-traffic, and reversible in one
// import.
//
// Each row shows the session name + when it was archived, with two actions:
//   • Restore  → unarchive (the row springs back into the live overview via the
//                existing SSE delta) and drops out of this sheet.
//   • Delete forever → purge (hard delete, irreversible) behind an INLINE
//                confirm so a stray tap can't nuke a session.
//
// VISUAL: ≥44pt row actions (h-11 controls), sentence-case labels (no
// UPPERCASE), spring transitions (springs.*), design tokens throughout.

import * as React from 'react'

import { useArmedConfirm } from '@/hooks/use-armed-confirm'
import { AnimatePresence, motion, useReducedMotion } from 'framer-motion'
import { Archive, RotateCcw, Trash2 } from 'lucide-react'

import { cn } from '@/lib/utils'
import { Skeleton, SkeletonRegion } from '@/components/ui/skeleton'
import { springs } from '@/lib/springs'
import { ShellOverlay } from '@/components/shell/shell-overlay'
import { StatusDot } from '@/components/session-tile/status-dot'
import { useToast } from '@/components/ui/use-toast'
import {
  useArchivedSessions,
  type UseArchivedSessionsResult,
} from '@/hooks/use-archived-sessions'
import { displayLabel, type ApiSession } from '@/lib/api'
import { LIFECYCLE, PURGE_DISPOSITION } from '@/brand/copy'

export interface ArchivedSheetProps {
  open: boolean
  onOpenChange: (open: boolean) => void
}

/** Relative "when archived" label. We have no `archived_at` column, so the
 *  server orders by — and we display — the newest activity timestamp
 *  (`updated_at`), the closest proxy for "when it was last touched / archived". */
function whenArchived(updatedAt?: string): string {
  if (!updatedAt) return 'Archived'
  const t = Date.parse(updatedAt)
  if (Number.isNaN(t)) return 'Archived'
  const s = Math.round((Date.now() - t) / 1000)
  if (s < 60) return 'Archived just now'
  const m = Math.round(s / 60)
  if (m < 60) return `Archived ${m}m ago`
  const h = Math.round(m / 60)
  if (h < 24) return `Archived ${h}h ago`
  const d = Math.round(h / 24)
  if (d < 7) return `Archived ${d}d ago`
  return `Archived ${new Date(t).toLocaleDateString()}`
}

export function ArchivedSheet({ open, onOpenChange }: ArchivedSheetProps) {
  // Only fetch while the sheet is open — opt-in, no always-on request.
  const recovery = useArchivedSessions(open)
  const { archived, isLoading, isError } = recovery

  // B5/T7.2 — the bulk-delete confirm is armed in the header's trailing slot,
  // but the disposition it needs to state is far too big to live on that
  // 28px-high row. Lifting just the armed flag lets the table render in the
  // sheet BODY, where there is room to be honest, while the buttons stay where
  // the user's finger already is.
  // B5/T9.2 keeps the flag lifted (rather than owning a hook here) precisely so
  // the table above can see it; the ARMING itself lives in `DeleteAllAction`.
  const [confirmingPurgeAll, setConfirmingPurgeAll] = React.useState(false)

  const count = archived.length
  const description = isLoading
    ? 'Loading…'
    : count === 0
      ? 'Nothing archived'
      : `${count} archived session${count === 1 ? '' : 's'}`

  return (
    <ShellOverlay
      open={open}
      onOpenChange={onOpenChange}
      title="Archived sessions"
      description={description}
      // Bulk "Delete all" lives INLINE on the description row, right of
      // the count — saves a whole row of vertical space vs sitting above the
      // list, keeps the action discoverable at the same eye line as the count
      // it modifies ("N items · delete them all").
      descriptionTrailing={
        count > 0 ? (
          <DeleteAllAction
            recovery={recovery}
            onArmedChange={setConfirmingPurgeAll}
          />
        ) : null
      }
      className="sm:max-w-md"
    >
      <div className="px-2 py-2 sm:px-3">
        {/* B5/T7.2 — the disposition, shown at the moment it is decided rather
            than buried in docs. Only while the irreversible bulk delete is
            armed: on the resting sheet it would be a wall of rules about an
            action nobody has reached for. */}
        {confirmingPurgeAll ? (
          <div className="px-1 pb-2">
            <DispositionTable />
          </div>
        ) : null}
        {isError ? (
          <p className="px-3 py-10 text-center text-sm text-muted-foreground">
            Couldn’t load archived sessions.
          </p>
        ) : isLoading && count === 0 ? (
          <SkeletonRegion
            label="Loading archived sessions…"
            className="flex flex-col gap-1"
          >
            {Array.from({ length: 3 }).map((_, i) => (
              <Skeleton key={i} className="h-14 rounded-lg bg-muted/50" />
            ))}
          </SkeletonRegion>
        ) : count === 0 ? (
          <EmptyArchived />
        ) : (
          <ul className="flex flex-col gap-1" aria-label="Archived sessions">
            <AnimatePresence initial={false}>
              {archived.map((s) => (
                <ArchivedRow key={s.name} session={s} recovery={recovery} />
              ))}
            </AnimatePresence>
          </ul>
        )}
        {/* B5/T5.3 — the archive/schedule contract, stated where the archived
            rows are. This is the SAME sentence the archive confirm renders
            (`LIFECYCLE.archivePausesSchedules`), imported rather than retyped,
            so the two can never drift. Shown only when there is something
            archived: on an empty sheet it would be a rule about nothing. */}
        {count > 0 && !isError ? (
          <p className="px-3 pb-1 pt-3 text-[12px] leading-snug text-muted-foreground">
            {LIFECYCLE.archiveIsTheUndo} {LIFECYCLE.archivePausesSchedules}
          </p>
        ) : null}
      </div>
    </ShellOverlay>
  )
}

/** "Delete all" row — irreversible, inline-confirm matching the per-row
 *  delete pattern. Disabled while any individual purge is in flight (we'd be
 *  fighting the per-row mutation otherwise). On confirm, fans out every
 *  archived row's purge in parallel; the sheet empties progressively as each
 *  request resolves. */
function DeleteAllAction({
  recovery,
  onArmedChange,
}: {
  recovery: UseArchivedSessionsResult
  /** B5/T7.2 — the arming lives HERE (it is this button's state), but the
   *  disposition table it should reveal lives in the sheet body, where there is
   *  room to be honest. So the flag is reported upward rather than owned there:
   *  one source of truth, two places that need to see it. */
  onArmedChange: (armed: boolean) => void
}) {
  const { archived, purgeAll, pending } = recovery
  const { toast } = useToast()
  const reduce = useReducedMotion()
  const [busy, setBusy] = React.useState(false)
  // Lock out the bulk action while ANY individual purge is mid-flight to avoid
  // racing with a per-row delete-confirm the user already kicked off.
  const anyPending = pending.size > 0 || busy
  const count = archived.length

  const onPurgeAll = React.useCallback(async () => {
    setBusy(true)
    try {
      const { ok, failed } = await purgeAll()
      if (failed === 0) {
        toast({ message: `Deleted ${ok} session${ok === 1 ? '' : 's'}` })
      } else if (ok === 0) {
        toast({
          message: 'Couldn’t delete archived sessions',
          tone: 'error',
        })
      } else {
        // Partial — be specific so the user knows what's left.
        toast({
          message: `Deleted ${ok}, ${failed} couldn’t be deleted`,
          tone: 'error',
        })
      }
    } finally {
      setBusy(false)
    }
  }, [purgeAll, toast])

  // Compact inline action sized to fit ON the description row (h-7 / text-xs)
  // so the sheet header gains zero vertical space vs the count alone. The
  // confirm morph keeps the same height so the row never reflows.
  // B5/T9.2 — variant C → the shared idiom. Untimed before: "Delete all" armed
  // and forgotten stayed one click from purging every archived session.
  const confirming = useArmedConfirm({ onConfirm: () => void onPurgeAll() })
  React.useEffect(() => {
    onArmedChange(confirming.armed)
  }, [confirming.armed, onArmedChange])

  if (confirming.armed) {
    return (
      <motion.div
        initial={reduce ? false : { opacity: 0, x: 8 }}
        animate={{ opacity: 1, x: 0 }}
        transition={springs.snappy}
        className="flex items-center gap-1"
      >
        <button
          type="button"
          onClick={confirming.cancel}
          disabled={anyPending}
          className="flex h-7 items-center rounded-md px-2 text-xs font-medium text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50"
        >
          Cancel
        </button>
        <button
          type="button"
          onClick={confirming.press}
          disabled={anyPending}
          className="flex h-7 items-center gap-1 rounded-md bg-destructive px-2 text-xs font-medium text-destructive-foreground hover:bg-destructive/90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50"
        >
          <Trash2 className="size-3.5" aria-hidden />
          Delete {count}
        </button>
      </motion.div>
    )
  }
  return (
    <button
      type="button"
      onClick={confirming.press}
      disabled={anyPending}
      aria-label={`Delete all ${count} archived sessions forever`}
      className="flex h-7 items-center gap-1 rounded-md px-2 text-xs font-medium text-muted-foreground hover:bg-destructive/10 hover:text-destructive focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50"
    >
      <Trash2 className="size-3.5" aria-hidden />
      Delete all
    </button>
  )
}

/** B5/T7.2 — the disposition, rendered. "Delete forever" is the only truly
 *  irreversible verb in supermux, and until now it asked for confirmation
 *  without ever saying what it disposed of. This renders `PURGE_DISPOSITION`
 *  row by row (archive vs purge, side by side) so the comparison the user is
 *  actually making is on screen instead of in their head.
 *
 *  It is driven by the exported table rather than hand-written markup, and
 *  `delete-honesty.test.tsx` asserts every row reaches the DOM — so a row added
 *  to the table cannot be silently left out of the dialog (R3). */
export function DispositionTable() {
  return (
    <div className="rounded-lg border border-border/60 bg-muted/30 p-2">
      <p className="px-1 pb-1.5 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
        What happens
      </p>
      <dl className="flex flex-col gap-1">
        {PURGE_DISPOSITION.map((row) => (
          <div
            key={row.thing}
            className="flex items-baseline justify-between gap-3 px-1"
          >
            <dt className="text-[12px] text-muted-foreground">{row.thing}</dt>
            <dd className="shrink-0 text-[12px] font-medium text-foreground">
              {row.purge}
            </dd>
          </div>
        ))}
      </dl>
      <p className="px-1 pt-2 text-[11px] leading-snug text-muted-foreground">
        {LIFECYCLE.purgeLeavesYourFilesAlone}
      </p>
    </div>
  )
}

function EmptyArchived() {
  const reduce = useReducedMotion()
  return (
    <motion.div
      initial={reduce ? false : { opacity: 0, scale: 0.96 }}
      animate={{ opacity: 1, scale: 1 }}
      transition={springs.cardExpand}
      className="flex flex-col items-center justify-center gap-3 px-6 py-14 text-center"
    >
      <div className="flex size-14 items-center justify-center rounded-full bg-muted text-muted-foreground [&_svg]:size-6">
        <Archive aria-hidden />
      </div>
      <p className="max-w-xs text-sm text-muted-foreground">
        No archived sessions.
      </p>
    </motion.div>
  )
}

/** A single archived session row: name + when archived, with Restore +
 *  Delete-forever (inline confirm) actions. */
function ArchivedRow({
  session,
  recovery,
}: {
  session: ApiSession
  recovery: UseArchivedSessionsResult
}) {
  const { restore, purge, pending } = recovery
  const { toast } = useToast()
  const reduce = useReducedMotion()
  const busy = pending.has(session.name)
  const label = displayLabel(session)

  const onRestore = React.useCallback(() => {
    restore(session.name)
      .then(() => toast({ message: `Restored ${label}` }))
      .catch(() =>
        toast({ message: 'Couldn’t restore session', tone: 'error' }),
      )
  }, [restore, session.name, label, toast])

  const onPurge = React.useCallback(() => {
    purge(session.name)
      .then(() => toast({ message: `Deleted ${label}` }))
      .catch(() =>
        toast({ message: 'Couldn’t delete session', tone: 'error' }),
      )
  }, [purge, session.name, label, toast])

  // B5/T9.2 — variant C → the shared idiom. Untimed before: a row armed and
  // forgotten was one click from an irreversible delete, indefinitely.
  const confirming = useArmedConfirm({ onConfirm: onPurge })

  return (
    <motion.li
      layout={!reduce}
      initial={reduce ? false : { opacity: 0, height: 0 }}
      animate={{ opacity: 1, height: 'auto' }}
      exit={reduce ? { opacity: 0 } : { opacity: 0, height: 0 }}
      transition={springs.smooth}
      className="overflow-hidden"
    >
      <div
        className={cn(
          'flex items-center gap-3 rounded-lg px-3 py-2',
          'hover:bg-secondary/60',
          busy && 'opacity-60',
        )}
      >
        {/* Archived sessions are stopped; the dot keeps the row visually
            consistent with the overview tiles / palette. */}
        <StatusDot status="stopped" />
        <div className="min-w-0 flex-1">
          <p className="truncate text-[14px] font-medium text-foreground">
            {displayLabel(session)}
          </p>
          <p className="truncate text-[12px] text-muted-foreground">
            {whenArchived(session.updated_at)}
          </p>
        </div>

        {confirming.armed ? (
          // Inline destructive confirm — the row morphs into "Cancel / Delete"
          // so a stray tap can never nuke a session. Matches the tile's
          // archive-confirm pattern.
          <motion.div
            initial={reduce ? false : { opacity: 0, x: 8 }}
            animate={{ opacity: 1, x: 0 }}
            transition={springs.snappy}
            className="flex shrink-0 items-center gap-1"
          >
            <button
              type="button"
              onClick={confirming.cancel}
              disabled={busy}
              className="flex h-11 items-center rounded-md px-3 text-[13px] font-medium text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={onPurge}
              disabled={busy}
              className="flex h-11 items-center gap-1.5 rounded-md bg-destructive px-3 text-[13px] font-medium text-destructive-foreground hover:bg-destructive/90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50"
            >
              <Trash2 className="size-4" aria-hidden />
              Delete forever
            </button>
          </motion.div>
        ) : (
          <div className="flex shrink-0 items-center gap-0.5">
            <button
              type="button"
              onClick={onRestore}
              disabled={busy}
              aria-label={`Restore ${displayLabel(session)}`}
              title="Restore"
              className="flex size-11 items-center justify-center rounded-md text-muted-foreground hover:bg-secondary hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50"
            >
              <RotateCcw className="size-4" aria-hidden />
            </button>
            <button
              type="button"
              onClick={confirming.press}
              disabled={busy}
              aria-label={`Delete ${displayLabel(session)} forever`}
              title="Delete forever"
              className="flex size-11 items-center justify-center rounded-md text-muted-foreground hover:bg-destructive/10 hover:text-destructive focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50"
            >
              <Trash2 className="size-4" aria-hidden />
            </button>
          </div>
        )}
      </div>
    </motion.li>
  )
}

export default ArchivedSheet
