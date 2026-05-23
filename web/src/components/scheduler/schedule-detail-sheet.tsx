// ScheduleDetailSheet (M21) — the single editor surface for BOTH create and
// edit. One full-height right-side <Sheet> shell (the one that scrolls correctly
// — see schedule-rework.plan.md: the old centered create Dialog couldn't bound
// its ScrollArea on mobile). `create` mode shows preset recipes + a blank
// editor; `edit` mode binds an existing row, adds the fire log, the run-now /
// delete / enable header actions, and the run history. Both render the shared
// <ScheduleEditor>. The `skipped` run status surfaces the M8 missed-window /
// idempotency behaviour (a fire-key collision or a >60s-late window logs a
// skipped run rather than double-firing).

import * as React from 'react'
import { motion, useReducedMotion } from 'framer-motion'
import { Play, Trash2 } from 'lucide-react'

import { cn } from '@/lib/utils'
import { springs } from '@/lib/springs'
import { Button } from '@/components/ui/button'
import { ResponsiveSheet } from '@/components/ui/responsive-sheet'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { useToast } from '@/components/ui/use-toast'
import { CONFIRM } from '@/brand/copy'
import type { ScheduleRow } from '@/lib/api'
import {
  useDeleteSchedule,
  useRunSchedule,
  useScheduleRuns,
} from '@/hooks/use-scheduler'
import { ScheduleEditor } from './schedule-editor'
import { describeSchedule, formatRanAt } from './helpers'
import { EnableToggle } from './enable-toggle'

interface ScheduleDetailSheetProps {
  /** `create` opens a blank editor; `edit` binds the row. `null` keeps it closed. */
  mode: 'create' | 'edit' | null
  schedule: ScheduleRow | null
  onClose: () => void
  sessions: string[]
}

export function ScheduleDetailSheet({
  mode,
  schedule,
  onClose,
  sessions,
}: ScheduleDetailSheetProps) {
  // Both modes render through the shared <ResponsiveSheet> (Vaul drag-detent
  // bottom sheet on mobile, side Sheet on desktop). Keyed remount per mode/row
  // keeps the form state pristine, same as before.
  if (mode === 'create') {
    return (
      <CreateBody key="create" open onClose={onClose} sessions={sessions} />
    )
  }
  if (mode === 'edit' && schedule) {
    return (
      <EditBody
        key={schedule.id}
        open
        schedule={schedule}
        onClose={onClose}
        sessions={sessions}
      />
    )
  }
  return null
}

// ── create mode ─────────────────────────────────────────────────────────────────

function CreateBody({
  open,
  onClose,
  sessions,
}: {
  open: boolean
  onClose: () => void
  sessions: string[]
}) {
  return (
    <ResponsiveSheet
      open={open}
      onOpenChange={(o) => !o && onClose()}
      title="New schedule"
      description="Boot an agent, send a command, or run a shell job on a timer."
    >
      <div className="px-5 py-5">
        <ScheduleEditor mode="create" sessions={sessions} onClose={onClose} />
      </div>
    </ResponsiveSheet>
  )
}

// ── edit mode ────────────────────────────────────────────────────────────────────

function EditBody({
  open,
  schedule,
  onClose,
  sessions,
}: {
  open: boolean
  schedule: ScheduleRow
  onClose: () => void
  sessions: string[]
}) {
  const [confirmDelete, setConfirmDelete] = React.useState(false)
  const runs = useScheduleRuns(schedule.id)
  const runNow = useRunSchedule()
  const del = useDeleteSchedule()
  const { toast } = useToast()

  const fireNow = () => {
    runNow.mutate(schedule.id, {
      onSuccess: () => toast({ message: 'Running now', tone: 'active' }),
      onError: (e) =>
        toast({
          message: `Run failed — ${(e as Error).message}`,
          tone: 'error',
          duration: 4000,
        }),
    })
  }

  const doDelete = () => {
    del.mutate(schedule.id, {
      onSuccess: () => {
        setConfirmDelete(false)
        onClose()
      },
    })
  }

  return (
    <>
      <ResponsiveSheet
        open={open}
        onOpenChange={(o) => !o && onClose()}
        title={schedule.title}
        description={describeSchedule(schedule.schedule_expr)}
        headerActions={
          // Run-now / Delete on the left; the enable toggle pushed to the right
          // edge of the SAME row (ml-auto), vertically centred with the h-11
          // buttons — clear of the sheet's top-right close button.
          <div className="flex items-center gap-2">
            <Button
              variant="outline"
              size="sm"
              className="h-11"
              onClick={fireNow}
              disabled={runNow.isPending}
            >
              <Play className="size-4" />
              Run now
            </Button>
            <Button
              variant="ghost"
              size="sm"
              className="h-11 text-status-error hover:text-status-error"
              onClick={() => setConfirmDelete(true)}
            >
              <Trash2 className="size-4" />
              Delete
            </Button>
            <div className="ml-auto">
              <EnableToggle
                id={schedule.id}
                enabled={schedule.enabled === 1}
                onError={(m) => toast({ message: m, tone: 'error' })}
              />
            </div>
          </div>
        }
      >
        <div className="flex flex-col gap-6 px-5 py-5">
          <ScheduleEditor
            mode="edit"
            schedule={schedule}
            sessions={sessions}
            onClose={onClose}
          />

          <div className="h-px bg-border" />

          {/* Run history */}
          <section>
            <h3 className="mb-2 text-sm font-semibold text-foreground">
              Recent runs
            </h3>
            {runs.isLoading ? (
              <RunsSkeleton />
            ) : runs.isError ? (
              <p className="text-xs text-muted-foreground">
                Couldn’t load run history.
              </p>
            ) : !runs.data?.length ? (
              <p className="text-xs text-muted-foreground">
                No runs yet. It fires on schedule, or hit “Run now”.
              </p>
            ) : (
              <ol className="flex flex-col gap-1.5">
                {runs.data.map((r, i) => (
                  <RunRow key={r.id} index={i}>
                    <StatusPill status={r.status} />
                    <span className="shrink-0 text-xs text-muted-foreground">
                      {formatRanAt(r.ran_at)}
                    </span>
                    {r.note && (
                      <span className="min-w-0 flex-1 truncate font-mono text-xs text-muted-foreground">
                        {r.note}
                      </span>
                    )}
                  </RunRow>
                ))}
              </ol>
            )}
          </section>
        </div>
      </ResponsiveSheet>

      <Dialog
        open={confirmDelete}
        onOpenChange={(o) => !o && setConfirmDelete(false)}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{CONFIRM.deleteSchedule.title}</DialogTitle>
            <DialogDescription>{CONFIRM.deleteSchedule.body}</DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              variant="outline"
              className="h-11"
              onClick={() => setConfirmDelete(false)}
            >
              {CONFIRM.deleteSchedule.cancel}
            </Button>
            <Button
              variant="destructive"
              className="h-11"
              onClick={doDelete}
              disabled={del.isPending}
            >
              {CONFIRM.deleteSchedule.confirm}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  )
}

function RunRow({
  index,
  children,
}: {
  index: number
  children: React.ReactNode
}) {
  const reduce = useReducedMotion()
  return (
    <motion.li
      initial={reduce ? false : { opacity: 0, x: -6 }}
      animate={{ opacity: 1, x: 0 }}
      transition={{ ...springs.smooth, delay: reduce ? 0 : index * 0.02 }}
      className="flex items-center gap-2 rounded-md border border-border bg-card px-2.5 py-2"
    >
      {children}
    </motion.li>
  )
}

const STATUS_STYLE: Record<string, string> = {
  ok: 'bg-status-active/15 text-status-active',
  error: 'bg-status-error/15 text-status-error',
  skipped: 'bg-status-idle/15 text-muted-foreground',
}

/** Status pill. `skipped` is the M8 missed-window / idempotency outcome. */
function StatusPill({ status }: { status: string }) {
  return (
    <span
      className={cn(
        'shrink-0 rounded-full px-2 py-0.5 text-xs font-medium capitalize',
        STATUS_STYLE[status] ?? 'bg-muted text-muted-foreground',
      )}
    >
      {status}
    </span>
  )
}

function RunsSkeleton() {
  return (
    <div className="flex flex-col gap-1.5" aria-hidden>
      {Array.from({ length: 4 }).map((_, i) => (
        <div key={i} className="h-9 animate-pulse rounded-md bg-muted/40" />
      ))}
    </div>
  )
}
