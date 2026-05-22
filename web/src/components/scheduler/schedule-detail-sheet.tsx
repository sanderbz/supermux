// ScheduleDetailSheet (M21) — open one schedule for inline edit + run history.
// Right-side sheet: header with title + enable toggle + run-now/delete, the
// shared ScheduleForm bound to the existing values (Save patches), then the last
// 20 runs with status pills. The `skipped` status surfaces the M8 missed-window
// / idempotency behaviour (a fire-key collision or a >60s-late window logs a
// skipped run rather than double-firing) — shown explicitly so the user can see
// WHY a tick didn't run.

import * as React from 'react'
import { motion, useReducedMotion } from 'framer-motion'
import { Loader2, Play, Trash2 } from 'lucide-react'

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
  usePatchSchedule,
  useRunSchedule,
  useScheduleRuns,
} from '@/hooks/use-scheduler'
import {
  isFormValid,
  ScheduleForm,
  toCreateInput,
  type ScheduleFormValue,
} from './schedule-form'
import { formatRanAt } from './helpers'
import { EnableToggle } from './enable-toggle'

interface ScheduleDetailSheetProps {
  schedule: ScheduleRow | null
  onClose: () => void
  sessions: string[]
}

function rowToForm(s: ScheduleRow): ScheduleFormValue {
  return {
    title: s.title,
    kind: s.kind,
    command: s.command,
    schedule_expr: s.schedule_expr ?? '',
    session: s.session,
    boot_dir: s.boot_dir,
    boot_provider: s.boot_provider || 'claude',
    boot_worktree: s.boot_worktree === 1,
    watch: s.watch === 1,
    done_pattern: s.done_pattern ?? '',
    done_action: s.done_action || 'disable',
  }
}

export function ScheduleDetailSheet({
  schedule,
  onClose,
  sessions,
}: ScheduleDetailSheetProps) {
  return (
    <Sheet open={!!schedule} onOpenChange={(o) => !o && onClose()}>
      <SheetContent
        side="right"
        className="flex w-full flex-col gap-0 p-0 sm:max-w-md"
      >
        {schedule && (
          <DetailBody
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

function DetailBody({
  schedule,
  onClose,
  sessions,
}: {
  schedule: ScheduleRow
  onClose: () => void
  sessions: string[]
}) {
  const [form, setForm] = React.useState<ScheduleFormValue>(() =>
    rowToForm(schedule),
  )
  const [confirmDelete, setConfirmDelete] = React.useState(false)
  const runs = useScheduleRuns(schedule.id)
  const patch = usePatchSchedule()
  const runNow = useRunSchedule()
  const del = useDeleteSchedule()
  const { toast } = useToast()

  const valid = isFormValid(form)

  const save = () => {
    const input = toCreateInput(form)
    patch.mutate(
      {
        id: schedule.id,
        patch: {
          title: input.title,
          kind: input.kind,
          command: input.command,
          schedule_expr: input.schedule_expr,
          session: input.session,
          watch: input.watch,
          done_pattern: input.done_pattern,
          done_action: input.done_action,
        },
      },
      {
        onSuccess: () => {
          toast({ message: 'Schedule updated', tone: 'active' })
        },
        onError: (e) =>
          toast({
            message: `Update failed — ${(e as Error).message}`,
            tone: 'error',
            duration: 4000,
          }),
      },
    )
  }

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
            <SheetDescription className="font-mono text-xs">
              {schedule.id}
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
          <ScheduleForm
            value={form}
            onChange={setForm}
            sessions={sessions}
            hideTestFire
          />

          <Button
            className="h-11 self-start"
            onClick={save}
            disabled={!valid || patch.isPending}
          >
            {patch.isPending && <Loader2 className="size-4 animate-spin" />}
            Save changes
          </Button>

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
