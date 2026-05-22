// NewScheduleDialog (M21) — create a schedule. Three CEO-amplification preset
// cards at the top (one tap prefills the whole form), then the shared
// ScheduleForm (kind / fields / expression+preview / watch / test-fire), then
// Save. On success the parent's list refreshes via the create mutation.

import * as React from 'react'
import { motion, useReducedMotion } from 'framer-motion'
import { Loader2 } from 'lucide-react'

import { springs } from '@/lib/springs'
import { Button } from '@/components/ui/button'
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
import { TOAST } from '@/brand/copy'
import { useCreateSchedule } from '@/hooks/use-scheduler'
import {
  EMPTY_FORM,
  isFormValid,
  ScheduleForm,
  toCreateInput,
  type ScheduleFormValue,
} from './schedule-form'
import { PRESETS } from './helpers'

interface NewScheduleDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  sessions: string[]
}

export function NewScheduleDialog({
  open,
  onOpenChange,
  sessions,
}: NewScheduleDialogProps) {
  const [form, setForm] = React.useState<ScheduleFormValue>(EMPTY_FORM)
  const create = useCreateSchedule()
  const { toast } = useToast()
  const reduce = useReducedMotion()

  // Reset to a clean form on each open transition (store-during-render — no
  // setState-in-effect). `wasOpen` tracks the previous `open` so the reset fires
  // exactly once when the dialog goes closed → open.
  const [wasOpen, setWasOpen] = React.useState(open)
  if (open !== wasOpen) {
    setWasOpen(open)
    if (open) {
      setForm(EMPTY_FORM)
      create.reset()
    }
  }

  const applyPreset = (id: string) => {
    const preset = PRESETS.find((p) => p.id === id)
    if (!preset) return
    setForm({ ...EMPTY_FORM, ...preset.fill })
  }

  const valid = isFormValid(form)

  const save = () => {
    create.mutate(toCreateInput(form), {
      onSuccess: () => {
        toast({ message: TOAST.jobScheduled, tone: 'active' })
        onOpenChange(false)
      },
      onError: (e) => {
        toast({
          message: `Couldn’t schedule — ${(e as Error).message}`,
          tone: 'error',
          duration: 4000,
        })
      },
    })
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex max-h-[90vh] flex-col gap-0 p-0 sm:max-w-xl">
        <DialogHeader className="border-b border-border px-6 py-4">
          <DialogTitle>New schedule</DialogTitle>
          <DialogDescription>
            Boot an agent, send a command, or run a shell job on a timer.
          </DialogDescription>
        </DialogHeader>

        <ScrollArea className="min-h-0 flex-1">
          <div className="flex flex-col gap-5 px-6 py-5">
            {/* Preset recipes */}
            <div>
              <p className="mb-2 text-xs font-medium text-muted-foreground">
                Start from a recipe
              </p>
              <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
                {PRESETS.map((p, i) => (
                  <motion.button
                    key={p.id}
                    type="button"
                    onClick={() => applyPreset(p.id)}
                    initial={reduce ? false : { opacity: 0, y: 6 }}
                    animate={{ opacity: 1, y: 0 }}
                    transition={{
                      ...springs.cardExpand,
                      delay: reduce ? 0 : i * 0.04,
                    }}
                    whileTap={reduce ? undefined : { scale: 0.97 }}
                    className="flex min-h-11 flex-col gap-1 rounded-lg border border-border p-3 text-left transition-colors hover:bg-accent"
                  >
                    <span className="text-sm font-medium text-foreground">
                      {p.label}
                    </span>
                    <span className="text-xs text-muted-foreground">
                      {p.blurb}
                    </span>
                  </motion.button>
                ))}
              </div>
            </div>

            <div className="h-px bg-border" />

            <ScheduleForm
              value={form}
              onChange={setForm}
              sessions={sessions}
            />
          </div>
        </ScrollArea>

        <DialogFooter className="border-t border-border px-6 py-4">
          <Button
            variant="outline"
            className="h-11"
            onClick={() => onOpenChange(false)}
          >
            Cancel
          </Button>
          <Button
            className="h-11"
            onClick={save}
            disabled={!valid || create.isPending}
          >
            {create.isPending && <Loader2 className="size-4 animate-spin" />}
            Save schedule
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
