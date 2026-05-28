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
import { Loader2 } from 'lucide-react'

import { Button } from '@/components/ui/button'
import { useToast } from '@/components/ui/use-toast'
import { TOAST } from '@/brand/copy'
import type { ScheduleRow } from '@/lib/api'
import type { SessionPickerOption } from '@/components/session/session-picker'
import { useCreateSchedule, usePatchSchedule } from '@/hooks/use-scheduler'
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
 *  the friendly UI says "Send me notification when done" but the M8 wire shape
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
    notify,
    done_pattern: s.done_pattern ?? '',
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
}

export function ScheduleEditor({
  mode,
  schedule,
  sessions,
  onClose,
}: ScheduleEditorProps) {
  const [form, setForm] = React.useState<ScheduleFormValue>(() =>
    mode === 'edit' && schedule ? rowToForm(schedule) : { ...EMPTY_FORM },
  )
  const create = useCreateSchedule()
  const patch = usePatchSchedule()
  const { toast } = useToast()

  const valid = isFormValid(form)
  const pending = create.isPending || patch.isPending

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

      <ScheduleForm
        value={form}
        onChange={setForm}
        sessions={sessions}
        hideTestFire={mode === 'edit'}
      />

      <Button
        className="h-11 self-start"
        onClick={submit}
        disabled={!valid || pending}
      >
        {pending && <Loader2 className="size-4 animate-spin" />}
        {mode === 'edit' ? 'Save changes' : 'Save schedule'}
      </Button>
    </div>
  )
}
