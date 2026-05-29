// Scheduler route — the schedule list backend. Columns: title /
// human schedule / next-run / last-run / enable-toggle. The `+` button and the
// row click both open the SAME <ScheduleDetailSheet> (a full-height right Sheet)
// — `create` mode (combined prompt field with inline `/` autocomplete +
// recurrence composer + live next-5-runs preview + test-fire) or `edit` mode
// (inline edit + fire log + run history with idempotency-aware status pills).
// Real-time via SSE (useSchedulerStream) — never polled.
//
// Visual language matches /hosts (the sibling registry route): same headline
// scale, same plain action row at the top (no glass + border-bottom chrome),
// same card-list density, same `max-w-` container.

import * as React from 'react'
import { motion, useReducedMotion } from 'framer-motion'
import { CalendarClock, History, Plus, Timer, TriangleAlert } from 'lucide-react'

import { cn } from '@/lib/utils'
import { springs } from '@/lib/springs'
import { Button } from '@/components/ui/button'
import { EmptyStatePlaceholder } from '@/components/empty-state'
import { EMPTY } from '@/brand/copy'
import type { ScheduleRow } from '@/lib/api'
import { listSessionNames } from '@/lib/api'
import { displayLabel } from '@/lib/api/sessions'
import { useSchedules, useSchedulerStream } from '@/hooks/use-scheduler'
import type { SessionPickerOption } from '@/components/session/session-picker'
import { ScheduleDetailSheet } from '@/components/scheduler/schedule-detail-sheet'
import { EnableToggle } from '@/components/scheduler/enable-toggle'
import {
  describeSchedule,
  formatFull,
  formatRunTime,
} from '@/components/scheduler/helpers'

export function Scheduler() {
  // Toasts come from the app-root <ToastProvider> (mounted in App.tsx) — no
  // route-local scope needed.
  return <SchedulerInner />
}

function SchedulerInner() {
  useSchedulerStream() // live cache invalidation on every fire — no polling
  const schedules = useSchedules()
  // A single sheet hosts both flows. `create` opens a blank editor; selecting an
  // ID opens the same sheet in edit mode. The live row is derived from the list
  // during render so the open edit sheet always reflects the latest SSE-driven
  // data without a sync effect.
  const [creating, setCreating] = React.useState(false)
  const [selectedId, setSelectedId] = React.useState<string | null>(null)
  const [sessions, setSessions] = React.useState<SessionPickerOption[]>([])

  // Load known sessions once (for the tmux target picker / boot context). Carries
  // display_name so the picker + list rows show the friendly label, not the slug.
  React.useEffect(() => {
    let alive = true
    listSessionNames().then((rows) => alive && setSessions(rows))
    return () => {
      alive = false
    }
  }, [])

  const list = schedules.data ?? []
  const selected = selectedId
    ? (list.find((s) => s.id === selectedId) ?? null)
    : null

  const mode = creating ? 'create' : selected ? 'edit' : null
  const closeSheet = () => {
    setCreating(false)
    setSelectedId(null)
  }
  const openCreate = () => {
    setSelectedId(null)
    setCreating(true)
  }

  const reduce = useReducedMotion()

  return (
    // Matches /hosts: a single scrollable column inside the safe-area-aware
    // route shell, headline + secondary action row at top, then a card list.
    // No glass + border-bottom chrome — the page reads as one calm surface.
    <div className="mx-auto flex h-full w-full max-w-5xl flex-col px-3 py-4 pt-[calc(env(safe-area-inset-top)+1rem)] sm:px-5 sm:py-6 sm:pt-6">
      <header className="mb-4 flex flex-wrap items-center gap-3">
        <h1 className="mr-1 text-2xl font-semibold tracking-tight">Scheduler</h1>
        <p className="hidden flex-1 text-sm text-muted-foreground sm:block">
          Recurring jobs — prompt a session, boot a fresh one, or run a shell command on a timer.
        </p>
        <motion.button
          type="button"
          onClick={openCreate}
          aria-label="New schedule"
          title="New schedule"
          whileTap={reduce ? undefined : { scale: 0.9 }}
          transition={springs.snappy}
          className="flex size-9 items-center justify-center rounded-lg bg-muted text-muted-foreground transition-colors hover:text-foreground sm:hidden"
        >
          <Plus className="size-4" />
        </motion.button>
        <Button onClick={openCreate} className="hidden sm:inline-flex">
          <Plus />
          New schedule
        </Button>
      </header>

      <div className="min-h-0 flex-1">
        {schedules.isLoading ? (
          <ListSkeleton />
        ) : schedules.isError ? (
          <ErrorState onRetry={() => schedules.refetch()} />
        ) : list.length === 0 ? (
          <div className="flex h-full items-center justify-center">
            <EmptyStatePlaceholder
              icon={<CalendarClock />}
              message={EMPTY.scheduler.body}
              cta={{ label: EMPTY.scheduler.cta, onClick: openCreate }}
            />
          </div>
        ) : (
          <ScheduleList
            list={list}
            sessions={sessions}
            onOpen={(s) => {
              setCreating(false)
              setSelectedId(s.id)
            }}
          />
        )}
      </div>

      <ScheduleDetailSheet
        mode={mode}
        schedule={selected}
        onClose={closeSheet}
        sessions={sessions}
      />
    </div>
  )
}

function ScheduleList({
  list,
  sessions,
  onOpen,
}: {
  list: ScheduleRow[]
  sessions: SessionPickerOption[]
  onOpen: (s: ScheduleRow) => void
}) {
  const reduce = useReducedMotion()
  return (
    <div className="flex flex-col gap-2">
      {/* Column header (desktop only). */}
      <div className="hidden grid-cols-[1fr_10rem_7rem_7rem_3rem] items-center gap-3 px-3 text-xs font-medium text-muted-foreground md:grid">
        <span>Title</span>
        <span>Schedule</span>
        <span>Next fire</span>
        <span>Last fired</span>
        <span className="text-right">On</span>
      </div>

      {/* The row is a clickable container (not a <button>) so the enable-toggle
          <button> can nest legitimately — no invalid-HTML / hydration error. */}
      {list.map((s, i) => {
        const human = describeSchedule(s.schedule_expr)
        const sessionLabel =
          displayLabel({
            name: s.session,
            display_name: sessions.find((x) => x.name === s.session)
              ?.display_name,
          }) || '—'
        const target =
          s.kind === 'tmux'
            ? `${sessionLabel} · ${s.command}`
            : s.kind === 'boot'
              ? `${s.command} in ${s.boot_dir || '—'}`
              : s.command
        return (
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
              'md:grid-cols-[1fr_10rem_7rem_7rem_3rem]',
              s.enabled === 1 ? '' : 'opacity-60',
            )}
          >
            {/* Title + secondary meta (target/command + mobile fire log). */}
            <div className="min-w-0">
              <p className="truncate text-sm font-medium text-foreground">
                {s.title}
              </p>
              <p className="truncate font-mono text-xs text-muted-foreground">
                {target}
              </p>
              {/* Mobile-only: human schedule + next/last fire (desktop has columns). */}
              <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-0.5 text-xs text-muted-foreground md:hidden">
                <span className="text-foreground">{human}</span>
                <span
                  className="flex items-center gap-1"
                  title={!s.enabled || !s.next_run ? undefined : formatFull(s.next_run)}
                >
                  <Timer className="size-3" />
                  {s.enabled === 1 ? formatRunTime(s.next_run) : 'paused'}
                </span>
                <span
                  className="flex items-center gap-1"
                  title={s.last_run ? formatFull(s.last_run) : undefined}
                >
                  <History className="size-3" />
                  {s.last_run ? formatRunTime(s.last_run) : 'never'}
                </span>
              </div>
            </div>

            {/* Human schedule (desktop column). */}
            <span className="hidden truncate text-xs text-muted-foreground md:block">
              {human}
            </span>

            {/* Next fire. */}
            <span
              className="hidden text-xs text-foreground md:block"
              title={s.enabled === 1 && s.next_run ? formatFull(s.next_run) : undefined}
            >
              {s.enabled === 1 ? formatRunTime(s.next_run) : 'paused'}
            </span>

            {/* Last fired. */}
            <span
              className="hidden text-xs text-muted-foreground md:block"
              title={s.last_run ? formatFull(s.last_run) : undefined}
            >
              {formatRunTime(s.last_run)}
            </span>

            {/* Enable toggle (stops propagation so the row doesn't open). */}
            <div className="flex items-center justify-self-end md:justify-self-end">
              <EnableToggle id={s.id} enabled={s.enabled === 1} />
            </div>
          </motion.div>
        )
      })}
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
