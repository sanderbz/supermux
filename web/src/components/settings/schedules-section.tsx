// Settings → Schedules (folded in from the standalone /scheduler route, B1 T8).
//
// THIS IS A REDESIGN, NOT A MOVE, AND NOTHING IS DROPPED. The old route was a
// 5-column `max-w-5xl` table; a 42rem settings column cannot hold five columns,
// so the LIST is respeced into the grouped-list grammar — label = title, hint =
// human schedule · next fire · last fired, control = the same `<EnableToggle>`.
// Every other capability is preserved by IMPORTING THE SAME COMPONENT the route
// used, unchanged:
//
//   capability                          | where it lives now
//   ------------------------------------|-------------------------------------
//   list schedules                      | Rows below (was a 5-col grid)
//   create                              | section-header `+` → ScheduleDetailSheet mode="create"
//   edit                                | row tap → the SAME sheet, mode="edit"
//   enable / pause                      | <EnableToggle> in the Row control slot
//   test-fire                           | inside the detail sheet (untouched)
//   fire log + run history + status pills | <FireLog> in the detail sheet (untouched)
//   delete                              | detail sheet, inline CONFIRM (untouched)
//   live updates                        | useSchedulerStream() — mounted here, exactly as it was mounted with the route
//   session targets + display names     | listSessionNames() + displayLabel()
//   empty state                         | EMPTY.scheduler copy, settings-width
//   loading / error+retry               | settings-grammar skeleton + standard error row
//
// The anti-drop guard is `tests/unit/schedules-section.test.tsx` (every column
// of that table must be present in the rendered row) plus
// `tests/e2e/smoke/scheduler-fold.spec.ts` (create → toggle → test-fire → fire
// log → delete, against a real backend).
//
// Modelled on `hosts-section.tsx`, which folded the /hosts route the same way.

import * as React from 'react'
import { motion, useReducedMotion } from 'framer-motion'
import { CalendarClock, History, Plus, RefreshCw, Timer } from 'lucide-react'

import { cn } from '@/lib/utils'
import { springs } from '@/lib/springs'
import { Button } from '@/components/ui/button'
import { EMPTY } from '@/brand/copy'
import type { ScheduleRow } from '@/lib/api'
import { listSessionNames } from '@/lib/api'
import { useSchedules, useSchedulerStream } from '@/hooks/use-scheduler'
import type { SessionPickerOption } from '@/components/session/session-picker'
// Imported UNCHANGED from the deleted route — the whole detail flow (editor,
// recurrence composer, next-5-runs preview, test-fire, fire log, delete
// confirm) is the same component tree it always was.
import { ScheduleDetailSheet } from '@/components/scheduler/schedule-detail-sheet'
import { EnableToggle } from '@/components/scheduler/enable-toggle'
import { formatFull } from '@/components/scheduler/helpers'
import { Row } from '@/components/settings/primitives'
import {
  SCHEDULES_ANCHOR,
  scheduleHintParts,
} from '@/components/settings/schedules-section.helpers'

/** Section shell with a trailing action on the title row + a stable `id`.
 *  Same shape as `hosts-section.tsx`'s `SectionWithAction` — deliberately
 *  duplicated rather than lifted, because lifting it would mean editing a file
 *  a sibling phase is also working in. */
function SectionWithAction({
  id,
  title,
  action,
  footnote,
  children,
}: {
  id?: string
  title: string
  action?: React.ReactNode
  footnote?: React.ReactNode
  children: React.ReactNode
}) {
  return (
    <section id={id} className="flex scroll-mt-16 flex-col">
      <div className="flex items-end justify-between px-4 pb-2">
        <h2 className="text-[13px] font-medium leading-none text-muted-foreground">
          {title}
        </h2>
        {action}
      </div>
      <div className="divide-y divide-border overflow-hidden rounded-2xl border border-border bg-card">
        {children}
      </div>
      {footnote ? (
        <p className="px-4 pt-2 text-[12px] leading-snug text-muted-foreground">
          {footnote}
        </p>
      ) : null}
    </section>
  )
}

/** One schedule, as a settings Row. Tapping the row opens the detail sheet;
 *  the toggle is inside the row but stops propagation itself (EnableToggle
 *  already does), so the two targets never fight. */
function ScheduleSettingsRow({
  schedule,
  sessions,
  onOpen,
}: {
  schedule: ScheduleRow
  sessions: SessionPickerOption[]
  onOpen: () => void
}) {
  const { human, target, next, last } = scheduleHintParts(schedule, sessions)
  return (
    <Row
      className={cn(
        'cursor-pointer transition-colors hover:bg-accent/40',
        // A paused schedule reads dimmer — the same signal the old row used.
        schedule.enabled === 1 ? undefined : 'opacity-60',
      )}
      label={
        <div
          role="button"
          tabIndex={0}
          data-testid="schedule-row"
          onClick={onOpen}
          onKeyDown={(e) => {
            if (e.key === 'Enter' || e.key === ' ') {
              e.preventDefault()
              onOpen()
            }
          }}
          className="min-w-0 outline-none"
        >
          <span className="block truncate">{schedule.title}</span>
        </div>
      }
      hint={
        <span className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-0.5">
          <span className="truncate font-mono text-[12px]">{target}</span>
          <span className="text-foreground">{human}</span>
          <span
            className="flex items-center gap-1"
            title={
              schedule.enabled === 1 && schedule.next_run
                ? formatFull(schedule.next_run)
                : undefined
            }
          >
            <Timer className="size-3" aria-hidden />
            {next}
          </span>
          <span
            className="flex items-center gap-1"
            title={schedule.last_run ? formatFull(schedule.last_run) : undefined}
          >
            <History className="size-3" aria-hidden />
            {last}
          </span>
        </span>
      }
      control={<EnableToggle id={schedule.id} enabled={schedule.enabled === 1} />}
    />
  )
}

export function SchedulesSection() {
  const reduce = useReducedMotion()
  // Live updates: SSE cache invalidation on every fire, never polled. Mounted
  // with the SECTION exactly as it was mounted with the route, so the list is
  // as live inside Settings as it was on its own page.
  useSchedulerStream()
  const schedules = useSchedules()

  // One sheet hosts both flows, as before: `create` opens a blank editor,
  // selecting an id opens the same sheet in edit mode. The live row is derived
  // during render, so an open edit sheet always reflects the latest SSE data
  // without a sync effect.
  const [creating, setCreating] = React.useState(false)
  const [selectedId, setSelectedId] = React.useState<string | null>(null)
  const [sessions, setSessions] = React.useState<SessionPickerOption[]>([])

  // Session targets + their display names, loaded once by the section (was:
  // loaded once by the route).
  React.useEffect(() => {
    let alive = true
    listSessionNames().then((rows) => alive && setSessions(rows))
    return () => {
      alive = false
    }
  }, [])

  const list = schedules.data ?? []
  const selected = selectedId ? (list.find((s) => s.id === selectedId) ?? null) : null
  const mode = creating ? 'create' : selected ? 'edit' : null

  const closeSheet = () => {
    setCreating(false)
    setSelectedId(null)
  }
  const openCreate = () => {
    setSelectedId(null)
    setCreating(true)
  }

  const headerAction = (
    <Button
      asChild
      variant="outline"
      onClick={openCreate}
      className="h-9 gap-1.5 px-3"
      aria-label="New schedule"
    >
      <motion.button
        whileTap={reduce ? undefined : { scale: 0.96 }}
        transition={springs.buttonPress}
      >
        <Plus className="size-4" />
        <span className="text-[13px] font-medium">New schedule</span>
      </motion.button>
    </Button>
  )

  return (
    <SectionWithAction
      id={SCHEDULES_ANCHOR}
      title="Schedules"
      action={headerAction}
      footnote="Recurring jobs — prompt a session, boot a fresh one, or run a shell command on a timer. Open a schedule to edit it, test-fire it, or read its run history."
    >
      {schedules.isLoading ? (
        // Settings-grammar skeleton: rows, not the old route's card stack.
        <Row>
          <div className="flex flex-col gap-2 py-1" aria-hidden>
            {Array.from({ length: 3 }).map((_, i) => (
              <div key={i} className="h-8 animate-pulse rounded-lg bg-muted/40" />
            ))}
          </div>
        </Row>
      ) : schedules.isError ? (
        <Row
          label="Couldn’t load schedules"
          hint="Can’t reach supermux-server. Try again in a moment."
          control={
            <Button
              variant="outline"
              onClick={() => schedules.refetch()}
              className="h-11 gap-1.5"
            >
              <RefreshCw className="size-4" />
              Try again
            </Button>
          }
        />
      ) : list.length === 0 ? (
        <Row
          label={EMPTY.scheduler.body}
          control={
            <Button variant="outline" onClick={openCreate} className="h-11 gap-1.5">
              <CalendarClock className="size-4" />
              {EMPTY.scheduler.cta}
            </Button>
          }
        />
      ) : (
        list.map((s) => (
          <ScheduleSettingsRow
            key={s.id}
            schedule={s}
            sessions={sessions}
            onOpen={() => {
              setCreating(false)
              setSelectedId(s.id)
            }}
          />
        ))
      )}

      {/* Imported UNCHANGED: create + edit + test-fire + fire log + delete all
          still live in this one sheet. */}
      <ScheduleDetailSheet
        mode={mode}
        schedule={selected}
        onClose={closeSheet}
        sessions={sessions}
      />
    </SectionWithAction>
  )
}
