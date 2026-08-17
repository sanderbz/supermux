// The per-session Schedules sheet (fase B4 T8) — one session's calendar, in the
// place the session already is.
// ─────────────────────────────────────────────────────────────────────────────
// This is the destination for the `⏱` chip in a transcript's `Created schedule`
// / `Ran schedule` line, and for the session-info panel's read-only list, which
// until now linked out to a route B1 has since redirected. "Which jobs does THIS
// session have?" is a per-session question, and answering it by sending someone
// to a global admin table and asking them to find their own rows is the version
// of this that already existed.
//
// WHAT IT DOES NOT DO, on purpose: it does not re-implement the editor, the run
// history, the test-fire or the enable toggle. Every one of those is the
// SHIPPED `components/scheduler/*` component, unmodified — this file is a list,
// a filter and a header. That is also the §0.6 coordination rule with B1: B4
// depends only on `components/scheduler/*` + `lib/api/scheduler.ts` +
// `hooks/use-scheduler.ts`, never on a route, so it behaves identically whether
// B1 landed first, after, or never. The one place a route is unavoidable — the
// "manage all schedules" link — goes through `scheduleAdminHref()`.

import * as React from 'react'
import { Link } from 'react-router-dom'
import { CalendarClock, History, Plus, Timer } from 'lucide-react'
import { motion, useReducedMotion } from 'framer-motion'

import { Button } from '@/components/ui/button'
import { ResponsiveSheet } from '@/components/ui/responsive-sheet'
import { EnableToggle } from '@/components/scheduler/enable-toggle'
import { ScheduleDetailSheet } from '@/components/scheduler/schedule-detail-sheet'
import {
  describeSchedule,
  formatFull,
  formatRunTime,
} from '@/components/scheduler/helpers'
import type { SessionPickerOption } from '@/components/session/session-picker'
import { useSchedules, useSchedulerStream } from '@/hooks/use-scheduler'
import type { ScheduleRow } from '@/lib/api/scheduler'
import { springs } from '@/lib/springs'
import { cn } from '@/lib/utils'
import { Skeleton } from '@/components/ui/skeleton'

import { scheduleAdminHref } from './schedule-href'

export interface SessionSchedulesSheetProps {
  /** The session whose schedules these are. Also the create form's prefill. */
  session: string
  open: boolean
  onClose: () => void
  /**
   * Open straight into one schedule's detail.
   *
   * The `⏱` chip supplies this when the ledger row knows the id. A row written
   * before the id was in `detail` supplies nothing and lands on the list — the
   * honest degradation, rather than guessing which of two same-titled
   * schedules was meant.
   */
  scheduleId?: string | null
  /**
   * Prefill the create form's prompt (fase B4 T9 — the composer affordance
   * hands over the draft). COPIED, never moved: the composer keeps its text.
   */
  draftPrompt?: string
  /** Open directly in create mode (the composer affordance's entry point). */
  createOnOpen?: boolean
  /** Session targets for the editor's picker. The caller already has the
   *  roster; re-fetching it here would double a query the app holds. */
  sessions?: SessionPickerOption[]
}

export function SessionSchedulesSheet({
  session,
  open,
  onClose,
  scheduleId,
  draftPrompt,
  createOnOpen,
  sessions,
}: SessionSchedulesSheetProps) {
  const reduce = useReducedMotion()
  // Live while it is open, exactly as the Settings section is: a fire that
  // lands while somebody is reading this list should move the "last run" column
  // rather than wait for a reopen.
  useSchedulerStream()
  const schedules = useSchedules()

  const [creating, setCreating] = React.useState(createOnOpen ?? false)
  const [selectedId, setSelectedId] = React.useState<string | null>(scheduleId ?? null)

  // The sheet is opened FROM something (a chip, a row, the composer), and what
  // it was opened from can change between two opens without the component
  // unmounting. Mirroring during render rather than in an effect keeps the
  // first paint correct — an effect would show the list for one frame and then
  // jump into the detail.
  const [lastOpen, setLastOpen] = React.useState(open)
  if (open !== lastOpen) {
    setLastOpen(open)
    if (open) {
      setSelectedId(scheduleId ?? null)
      setCreating(createOnOpen ?? false)
    }
  }

  const mine = React.useMemo<ScheduleRow[]>(
    () => (schedules.data ?? []).filter((s) => s.session === session && !s.deleted),
    [schedules.data, session],
  )

  // Derived during render, so an open detail always reflects the latest SSE
  // data (the same discipline `SchedulesSection` keeps).
  const selected = selectedId ? (mine.find((s) => s.id === selectedId) ?? null) : null
  const detailMode = creating ? 'create' : selected ? 'edit' : null

  const closeDetail = React.useCallback(() => {
    setCreating(false)
    setSelectedId(null)
  }, [])

  const pickerSessions = React.useMemo<SessionPickerOption[]>(
    () => sessions ?? ([{ name: session } as SessionPickerOption]),
    [session, sessions],
  )

  return (
    <>
      <ResponsiveSheet
        open={open && detailMode === null}
        onOpenChange={(o) => !o && onClose()}
        title="Schedules"
        description={`Recurring work for ${session}.`}
        descriptionTrailing={
          <Button
            variant="outline"
            onClick={() => setCreating(true)}
            className="h-8 shrink-0 gap-1.5 px-2.5"
            aria-label="New schedule for this session"
            data-testid="session-schedules-new"
          >
            <Plus className="size-4" />
            <span className="text-[13px] font-medium">New</span>
          </Button>
        }
        className="sm:max-w-md"
      >
        <div className="px-5 py-4">
          {schedules.isLoading && !schedules.data ? (
            <div className="flex flex-col gap-2" aria-hidden>
              {Array.from({ length: 3 }).map((_, i) => (
                <Skeleton key={i} className="h-14 rounded-[12px] bg-muted/40" />
              ))}
            </div>
          ) : mine.length === 0 ? (
            <p className="text-sm text-muted-foreground" data-testid="session-schedules-empty">
              Nothing scheduled for this session yet.
            </p>
          ) : (
            <ul className="flex flex-col gap-1.5">
              {mine.map((s, i) => (
                <motion.li
                  key={s.id}
                  initial={reduce ? false : { opacity: 0, y: 4 }}
                  animate={{ opacity: 1, y: 0 }}
                  transition={reduce ? { duration: 0 } : { ...springs.snappy, delay: i * 0.02 }}
                >
                  <ScheduleRowView schedule={s} onOpen={() => setSelectedId(s.id)} />
                </motion.li>
              ))}
            </ul>
          )}

          {/* The one route in this component tree, behind the one helper that
              is allowed to know it (`schedule-href.ts`). */}
          <div className="mt-4 border-t border-border pt-3">
            <Link
              to={scheduleAdminHref()}
              onClick={onClose}
              data-testid="session-schedules-admin"
              className="text-[13px] font-medium text-primary underline-offset-2 hover:underline"
            >
              Manage all schedules
            </Link>
          </div>
        </div>
      </ResponsiveSheet>

      {/* The SHIPPED detail sheet, unmodified: the editor, the run history, the
          test-fire and delete all come from it. Create mode is prefilled with
          this session (and the composer's draft when there is one) by the
          editor reading its own `sessions` list — see `pickerSessions`. */}
      <ScheduleDetailSheet
        mode={detailMode}
        schedule={selected}
        onClose={closeDetail}
        sessions={pickerSessions}
        prefill={detailMode === 'create' ? { session, prompt: draftPrompt ?? '' } : undefined}
      />
    </>
  )
}

/**
 * One row: what it is, when it runs, when it last ran, and its switch.
 *
 * Deliberately NOT the Settings `Row` primitive — this sheet is opened from the
 * chat surface and from the focus panel, neither of which is a settings list,
 * and the Settings row grammar (label/hint/control at 44pt) reads as a
 * preferences screen inside a transcript.
 */
function ScheduleRowView({
  schedule,
  onOpen,
}: {
  schedule: ScheduleRow
  onOpen: () => void
}) {
  const paused = schedule.enabled !== 1
  return (
    <div
      className={cn(
        'flex min-h-14 items-center gap-2.5 rounded-[12px] border border-border bg-card px-3 py-2',
        'transition-colors hover:bg-accent/40',
        paused && 'opacity-60',
      )}
    >
      <button
        type="button"
        onClick={onOpen}
        data-testid="session-schedule-row"
        data-schedule-id={schedule.id}
        className="flex min-w-0 flex-1 items-center gap-2.5 text-left outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        <CalendarClock className="size-4 shrink-0 text-muted-foreground" aria-hidden />
        <span className="flex min-w-0 flex-1 flex-col">
          <span className="truncate text-[13.5px] font-medium text-foreground">
            {schedule.title}
          </span>
          <span className="flex min-w-0 flex-wrap items-center gap-x-2.5 text-[11.5px] text-muted-foreground">
            <span className="truncate">{describeSchedule(schedule.schedule_expr)}</span>
            <span
              className="flex items-center gap-1"
              title={schedule.next_run ? formatFull(schedule.next_run) : undefined}
            >
              <Timer className="size-3" aria-hidden />
              {paused ? 'paused' : formatRunTime(schedule.next_run)}
            </span>
            <span
              className="flex items-center gap-1"
              title={schedule.last_run ? formatFull(schedule.last_run) : undefined}
            >
              <History className="size-3" aria-hidden />
              {schedule.last_run ? formatRunTime(schedule.last_run) : 'never run'}
            </span>
          </span>
        </span>
      </button>
      <EnableToggle id={schedule.id} enabled={schedule.enabled === 1} />
    </div>
  )
}

export default SessionSchedulesSheet
