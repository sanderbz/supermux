// Scheduler route (M21) — the schedule list on the M8 backend. Columns: title /
// kind / target / next-run / last-run / enable-toggle. The `+` button opens
// <NewScheduleDialog> (three preset recipes + expression builder with a live
// next-5-runs preview + test-fire); a row click opens <ScheduleDetailSheet>
// (inline edit + run history with idempotency-aware status pills). Real-time via
// SSE (useSchedulerStream) — never polled.

import * as React from 'react'
import { motion, useReducedMotion } from 'framer-motion'
import { CalendarClock, Plus, TriangleAlert } from 'lucide-react'

import { cn } from '@/lib/utils'
import { springs } from '@/lib/springs'
import { Button } from '@/components/ui/button'
import { EmptyStatePlaceholder } from '@/components/empty-state'
import { EMPTY } from '@/brand/copy'
import type { ScheduleRow } from '@/lib/api'
import { listSessionNames } from '@/lib/api'
import { useSchedules, useSchedulerStream } from '@/hooks/use-scheduler'
import { NewScheduleDialog } from '@/components/scheduler/new-schedule-dialog'
import { ScheduleDetailSheet } from '@/components/scheduler/schedule-detail-sheet'
import { EnableToggle } from '@/components/scheduler/enable-toggle'
import { formatRunTime, KIND_LABEL } from '@/components/scheduler/helpers'

export function Scheduler() {
  // Toasts come from the app-root <ToastProvider> (mounted in App.tsx) — no
  // route-local scope needed.
  return <SchedulerInner />
}

function SchedulerInner() {
  useSchedulerStream() // live cache invalidation on every fire — no polling
  const schedules = useSchedules()
  const [creating, setCreating] = React.useState(false)
  // Track only the selected ID; derive the live row from the list during render
  // so the open detail sheet always reflects the latest SSE-driven data without
  // a sync effect.
  const [selectedId, setSelectedId] = React.useState<string | null>(null)
  const [sessions, setSessions] = React.useState<string[]>([])

  // Load known session names once (for the tmux target combo / boot context).
  React.useEffect(() => {
    let alive = true
    listSessionNames().then((names) => alive && setSessions(names))
    return () => {
      alive = false
    }
  }, [])

  const list = schedules.data ?? []
  const selected = selectedId
    ? (list.find((s) => s.id === selectedId) ?? null)
    : null

  return (
    <div className="mx-auto flex h-full w-full max-w-5xl flex-col">
      <header className="glass flex h-14 shrink-0 items-center justify-between gap-2 border-b border-border px-4 sm:px-6">
        <h1 className="text-xl font-semibold tracking-tight">Scheduler</h1>
        <Button
          size="sm"
          className="h-11"
          onClick={() => setCreating(true)}
          aria-label="New schedule"
        >
          <Plus className="size-4" />
          New schedule
        </Button>
      </header>

      <div className="min-h-0 flex-1 overflow-auto px-4 py-4 sm:px-6">
        {schedules.isLoading ? (
          <ListSkeleton />
        ) : schedules.isError ? (
          <ErrorState onRetry={() => schedules.refetch()} />
        ) : list.length === 0 ? (
          <div className="flex h-full items-center justify-center">
            <EmptyStatePlaceholder
              icon={<CalendarClock />}
              message={EMPTY.scheduler.body}
              cta={{ label: EMPTY.scheduler.cta, onClick: () => setCreating(true) }}
            />
          </div>
        ) : (
          <ScheduleList list={list} onOpen={(s) => setSelectedId(s.id)} />
        )}
      </div>

      <NewScheduleDialog
        open={creating}
        onOpenChange={setCreating}
        sessions={sessions}
      />
      <ScheduleDetailSheet
        schedule={selected}
        onClose={() => setSelectedId(null)}
        sessions={sessions}
      />
    </div>
  )
}

function ScheduleList({
  list,
  onOpen,
}: {
  list: ScheduleRow[]
  onOpen: (s: ScheduleRow) => void
}) {
  const reduce = useReducedMotion()
  return (
    <div className="flex flex-col gap-2">
      {/* Column header (desktop only). */}
      <div className="hidden grid-cols-[1fr_7rem_8rem_8rem_3rem] items-center gap-3 px-3 text-xs font-medium text-muted-foreground md:grid">
        <span>Title</span>
        <span>Kind</span>
        <span>Next run</span>
        <span>Last run</span>
        <span className="text-right">On</span>
      </div>

      {/* The row is a clickable container (not a <button>) so the enable-toggle
          <button> can nest legitimately — no invalid-HTML / hydration error. */}
      {list.map((s, i) => (
        <motion.div
          key={s.id}
          role="button"
          tabIndex={0}
          onClick={() => onOpen(s)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' || e.key === ' ') {
              e.preventDefault()
              onOpen(s)
            }
          }}
          initial={reduce ? false : { opacity: 0, y: 6 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ ...springs.cardExpand, delay: reduce ? 0 : i * 0.03 }}
          whileTap={reduce ? undefined : { scale: 0.995 }}
          className={cn(
            'grid min-h-14 w-full cursor-pointer grid-cols-[1fr_auto] items-center gap-3 rounded-xl border border-border bg-card px-3 py-2.5 text-left transition-colors hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
            'md:grid-cols-[1fr_7rem_8rem_8rem_3rem]',
            s.enabled === 1 ? '' : 'opacity-60',
          )}
        >
          {/* Title + secondary meta (target/command). */}
          <div className="min-w-0">
            <p className="truncate text-sm font-medium text-foreground">
              {s.title}
            </p>
            <p className="truncate font-mono text-xs text-muted-foreground">
              {s.kind === 'tmux'
                ? `${s.session || '—'} · ${s.command}`
                : s.kind === 'boot'
                  ? `${s.command} in ${s.boot_dir || '—'}`
                  : s.command}
            </p>
          </div>

          {/* Kind (desktop column; inline pill on mobile via the meta row). */}
          <span className="hidden text-xs text-muted-foreground md:block">
            {KIND_LABEL[s.kind]}
          </span>

          {/* Next run. */}
          <span className="hidden text-xs text-foreground md:block">
            {s.enabled === 1 ? formatRunTime(s.next_run) : 'paused'}
          </span>

          {/* Last run. */}
          <span className="hidden text-xs text-muted-foreground md:block">
            {formatRunTime(s.last_run)}
          </span>

          {/* Enable toggle (stops propagation so the row doesn't open). */}
          <div className="flex items-center justify-self-end md:justify-self-end">
            <EnableToggle id={s.id} enabled={s.enabled === 1} />
          </div>
        </motion.div>
      ))}
    </div>
  )
}

function ListSkeleton() {
  return (
    <div className="flex flex-col gap-2" aria-hidden>
      {Array.from({ length: 6 }).map((_, i) => (
        <div key={i} className="h-14 animate-pulse rounded-xl bg-muted/40" />
      ))}
    </div>
  )
}

function ErrorState({ onRetry }: { onRetry: () => void }) {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-4 p-8 text-center">
      <div className="flex size-14 items-center justify-center rounded-full bg-status-error/10 text-status-error">
        <TriangleAlert className="size-6" />
      </div>
      <p className="max-w-xs text-sm text-muted-foreground">
        Can’t reach supermux-server. The scheduler list didn’t load.
      </p>
      <Button variant="outline" size="sm" className="h-11" onClick={onRetry}>
        Try again
      </Button>
    </div>
  )
}
