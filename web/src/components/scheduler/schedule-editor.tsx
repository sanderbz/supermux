// ScheduleEditor — the editor body shared by the create + edit surfaces.
// Both modes live in the same right-side Sheet shell (see
// schedule-detail-sheet.tsx); this component owns the form state, the validity
// gate, a single submit that branches on `mode` (create vs patch), and a
// compact last/next-fire log for an existing schedule.
//
// The old "Start from one of your commands" recipe grid was removed — the same
// command discovery now happens inline via the PromptField's `/` autocomplete
// (one field, no forced step). Picking a row in the autocomplete inserts the
// `/command` token; everything after it is the prompt body.

import * as React from 'react'
import { FlaskConical, Loader2 } from 'lucide-react'

import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { useToast } from '@/components/ui/use-toast'
import { TOAST } from '@/brand/copy'
import type { ScheduleRow } from '@/lib/api'
import type { SessionPickerOption } from '@/components/session/session-picker'
import {
  useCreateSchedule,
  usePatchSchedule,
  useTestFire,
} from '@/hooks/use-scheduler'
import {
  EMPTY_FORM,
  isFormValid,
  ScheduleForm,
  toCreateInput,
  type ScheduleFormValue,
} from './schedule-form'
import { FireLog } from './fire-log'

/** Map an existing row back into the editable form shape (edit mode seed).
 *  The `notify` flag is reconstructed from the row's watch+done_action pair:
 *  the friendly UI says "Send me notification when done" but the wire shape
 *  is still `watch=true` + `done_action='notify'`. */
export function rowToForm(s: ScheduleRow): ScheduleFormValue {
  const notify = s.watch === 1 && s.done_action === 'notify'
  return {
    title: s.title,
    kind: s.kind,
    command: s.command,
    prompt: s.prompt ?? '',
    schedule_expr: s.schedule_expr ?? '',
    session: s.session,
    boot_dir: s.boot_dir,
    boot_provider: s.boot_provider || 'claude',
    boot_worktree: s.boot_worktree === 1,
    bypass_permissions: s.bypass_permissions === 1,
    notify,
    done_pattern: s.done_pattern ?? '',
    confirm_finish: s.confirm_finish === 1,
  }
}

interface ScheduleEditorProps {
  /** `create` starts from EMPTY_FORM; `edit` seeds from the row. */
  mode: 'create' | 'edit'
  /** The existing row (edit mode only). */
  schedule?: ScheduleRow
  sessions: SessionPickerOption[]
  /** Close the host sheet (e.g. after a successful create). */
  onClose: () => void
  /**
   * Seed values for CREATE mode (fase B4 T8/T9).
   *
   * The per-session Schedules sheet opens this already knowing the session, and
   * the composer affordance opens it already knowing the prompt — asking the
   * user to retype either would be the whole reason those entry points exist.
   * Merged over `EMPTY_FORM` once, at mount: it is a starting point, not a
   * controlled value, so the user can change anything in it.
   *
   * Ignored in edit mode, where the row is the truth.
   */
  prefill?: Partial<ScheduleFormValue>
}

export function ScheduleEditor({
  mode,
  schedule,
  sessions,
  onClose,
  prefill,
}: ScheduleEditorProps) {
  const [form, setForm] = React.useState<ScheduleFormValue>(() =>
    mode === 'edit' && schedule
      ? rowToForm(schedule)
      : { ...EMPTY_FORM, ...(prefill ?? {}) },
  )
  const create = useCreateSchedule()
  const patch = usePatchSchedule()
  const testFire = useTestFire()
  const { toast } = useToast()

  const valid = isFormValid(form)
  const pending = create.isPending || patch.isPending

  // Test fire: create, run once, report the outcome, delete. It lives beside
  // Save because it answers the same question ("does this job work?") one step
  // earlier — and because both are actions on the whole form, not on a field.
  const runTestFire = () => {
    testFire.mutate(toCreateInput(form), {
      onSuccess: (res) =>
        toast({
          message:
            res.status === 'ok'
              ? `Test fire ok — ${res.note || 'ran'}`
              : `Test fire failed — ${res.note || 'error'}`,
          tone: res.status === 'ok' ? 'active' : 'error',
          duration: 4000,
        }),
      onError: (e) =>
        toast({
          message: `Test fire failed — ${(e as Error).message}`,
          tone: 'error',
          duration: 4000,
        }),
    })
  }

  const submit = () => {
    const input = toCreateInput(form)
    if (mode === 'edit' && schedule) {
      patch.mutate(
        {
          id: schedule.id,
          patch: {
            title: input.title,
            kind: input.kind,
            command: input.command,
            prompt: input.prompt,
            schedule_expr: input.schedule_expr,
            session: input.session,
            watch: input.watch,
            done_pattern: input.done_pattern,
            done_action: input.done_action,
            confirm_finish: input.confirm_finish,
          },
        },
        {
          onSuccess: () =>
            toast({ message: 'Schedule updated', tone: 'active' }),
          onError: (e) =>
            toast({
              message: `Update failed — ${(e as Error).message}`,
              tone: 'error',
              duration: 4000,
            }),
        },
      )
      return
    }
    create.mutate(input, {
      onSuccess: () => {
        toast({ message: TOAST.jobScheduled, tone: 'active' })
        onClose()
      },
      onError: (e) =>
        toast({
          message: `Couldn’t schedule — ${(e as Error).message}`,
          tone: 'error',
          duration: 4000,
        }),
    })
  }

  return (
    <div className="flex flex-col gap-6">
      {mode === 'edit' && schedule && (
        <FireLog
          lastRun={schedule.last_run}
          nextRun={schedule.next_run}
          runCount={schedule.run_count}
          paused={schedule.enabled !== 1}
        />
      )}

      <ScheduleForm value={form} onChange={setForm} sessions={sessions} />

      {/* THE ACTIONS ARE PINNED. They used to sit at the end of the sheet's own
          scroll region, which put "Save schedule" at y=892 — below the fold at
          every viewport height, with ~7px of the button visible at 900px and
          none below it, and no fade or scrim to say there was more. The sheet
          opens at scrollTop 0, so the primary action of the surface was a thing
          you had to discover by scrolling.
          `sticky bottom-0` inside the sheet's scroller keeps the row on screen
          for as long as the form it belongs to is, and lets it scroll away with
          the section (edit mode continues into the run history below).
          `-mx-5 -mb-5` bleeds it to the sheet's edges through the body padding
          so the border reads as a footer rule rather than a floating card. */}
      <div
        data-testid="schedule-editor-actions"
        className={cn(
          'sticky bottom-0 z-10 -mx-5 flex flex-wrap items-center gap-2',
          'border-t border-border bg-background/95 px-5 py-3 backdrop-blur',
          // Create mode ends with this row, so it also swallows the sheet
          // body's bottom padding and sits flush on the sheet's edge. Edit mode
          // continues into the run history, where the padding is still wanted.
          mode === 'create' && '-mb-5',
        )}
      >
        <Button
          className="h-11"
          onClick={submit}
          disabled={!valid || pending}
        >
          {pending && <Loader2 className="size-4 animate-spin" />}
          {mode === 'edit' ? 'Save changes' : 'Save schedule'}
        </Button>
        {/* Test fire only exists for a schedule that does not exist yet: it
            creates, runs once, reports and deletes. On an existing row the
            header's "Run now" is the same proof against the real schedule. */}
        {mode === 'create' && (
          <Button
            type="button"
            variant="outline"
            className="h-11"
            onClick={runTestFire}
            disabled={!valid || testFire.isPending}
          >
            {testFire.isPending ? (
              <Loader2 className="size-4 animate-spin" />
            ) : (
              <FlaskConical className="size-4" />
            )}
            Test fire now
          </Button>
        )}
      </div>
    </div>
  )
}
