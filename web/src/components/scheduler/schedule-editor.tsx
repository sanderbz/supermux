// ScheduleEditor (M21) — the single editor body shared by the create + edit
// surfaces. Both modes now live in the same right-side Sheet shell (see
// schedule-detail-sheet.tsx); this component owns the form state, the validity
// gate, a single submit that branches on `mode` (create vs patch), the
// create-mode preset recipes, and a compact last/next-fire log for an existing
// schedule. Extracting it collapses the two former submit handlers (the old
// NewScheduleDialog + the edit sheet) into one place.

import * as React from 'react'
import { motion, useReducedMotion } from 'framer-motion'
import { Loader2 } from 'lucide-react'

import { springs } from '@/lib/springs'
import { Button } from '@/components/ui/button'
import { useToast } from '@/components/ui/use-toast'
import { TOAST } from '@/brand/copy'
import type { ScheduleRow } from '@/lib/api'
import { useCreateSchedule, usePatchSchedule } from '@/hooks/use-scheduler'
import {
  EMPTY_FORM,
  isFormValid,
  ScheduleForm,
  toCreateInput,
  type ScheduleFormValue,
} from './schedule-form'
import { FireLog } from './fire-log'
import { PRESETS } from './helpers'

/** Map an existing row back into the editable form shape (edit mode seed). */
export function rowToForm(s: ScheduleRow): ScheduleFormValue {
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

interface ScheduleEditorProps {
  /** `create` starts from EMPTY_FORM + preset recipes; `edit` seeds from the row. */
  mode: 'create' | 'edit'
  /** The existing row (edit mode only). */
  schedule?: ScheduleRow
  sessions: string[]
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
  const reduce = useReducedMotion()

  const valid = isFormValid(form)
  const pending = create.isPending || patch.isPending

  const applyPreset = (id: string) => {
    const preset = PRESETS.find((p) => p.id === id)
    if (!preset) return
    setForm({ ...EMPTY_FORM, ...preset.fill })
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
      {mode === 'create' && (
        <div>
          <p className="mb-2 text-xs font-medium text-muted-foreground">
            Start from a recipe
          </p>
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
            {PRESETS.map((p, i) => (
              <motion.button
                key={p.id}
                type="button"
                onClick={() => applyPreset(p.id)}
                initial={reduce ? false : { opacity: 0, y: 6 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ ...springs.cardExpand, delay: reduce ? 0 : i * 0.04 }}
                whileTap={reduce ? undefined : { scale: 0.97 }}
                className="flex min-h-11 flex-col gap-1 rounded-lg border border-border p-3 text-left transition-colors hover:bg-accent"
              >
                <span className="text-sm font-medium text-foreground">
                  {p.label}
                </span>
                <span className="text-xs text-muted-foreground">{p.blurb}</span>
              </motion.button>
            ))}
          </div>
          <div className="mt-4 h-px bg-border" />
        </div>
      )}

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
