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
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from '@/components/ui/sheet'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { ScrollArea } from '@/components/ui/scroll-area'
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
  const open = mode === 'create' || (mode === 'edit' && !!schedule)
  return (
    <Sheet open={open} onOpenChange={(o) => !o && onClose()}>
      <SheetContent
        side="right"
        className="flex w-full flex-col gap-0 p-0 sm:max-w-md"
      >
        {mode === 'create' && (
          <CreateBody key="create" onClose={onClose} sessions={sessions} />
        )}
        {mode === 'edit' && schedule && (
          <EditBody
            key={schedule.id}
            schedule={schedule}
            onClose={onClose}
            sessions={sessions}
          />
        )}
      </SheetContent>
    </Sheet>
  )
}

// ── create mode ─────────────────────────────────────────────────────────────────

function CreateBody({
  onClose,
  sessions,
}: {
  onClose: () => void
  sessions: string[]
}) {
  return (
    <>
      <SheetHeader className="border-b border-border px-5 py-4 text-left">
        <SheetTitle>New schedule</SheetTitle>
        <SheetDescription>
          Boot an agent, send a command, or run a shell job on a timer.
        </SheetDescription>
      </SheetHeader>

      <ScrollArea className="min-h-0 flex-1">
        <div className="px-5 py-5">
          <ScheduleEditor mode="create" sessions={sessions} onClose={onClose} />
        </div>
      </ScrollArea>
    </>
  )
}

// ── edit mode ────────────────────────────────────────────────────────────────────

function EditBody({
  schedule,
  onClose,
  sessions,
}: {
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
      <SheetHeader className="border-b border-border px-5 py-4 text-left">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <SheetTitle className="truncate">{schedule.title}</SheetTitle>
            <SheetDescription className="truncate">
              {describeSchedule(schedule.schedule_expr)}
            </SheetDescription>
          </div>
          <EnableToggle
            id={schedule.id}
            enabled={schedule.enabled === 1}
            onError={(m) => toast({ message: m, tone: 'error' })}
          />
        </div>
        <div className="mt-2 flex gap-2">
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
        </div>
      </SheetHeader>

      <ScrollArea className="min-h-0 flex-1">
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
      </ScrollArea>

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
