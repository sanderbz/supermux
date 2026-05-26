import * as React from 'react'
import { Loader2, Users } from 'lucide-react'

import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { ResponsiveSheet } from '@/components/ui/responsive-sheet'
import { teamsStartApi, SessionError } from '@/lib/api'
import { homeDir } from '@/env'
import { DirectoryField } from './directory-field'

// "Start a team" (AT-D, plan §10d / §11-D). Reuses the iOS-style ResponsiveSheet
// (Vaul drag-detent bottom sheet on touch, right-side dialog on desktop) — the
// exact pattern <NewSessionSheet> uses — so the affordance feels native to the
// app. Fields: goal/task (textarea), # teammates (stepper), optional model.
//
// On submit it POSTs /api/teams/start, which creates + boots a Claude LEAD with
// Agent Teams enabled for it and a seed prompt that tells it to form the team;
// then we navigate to the lead's focus view. The TEAM CARD (AT-F1) appears via
// detection once the lead spawns its teammate panes.

/** Bounds mirror the server clamp (teams/start.rs MIN/MAX_TEAMMATES). */
const MIN_TEAMMATES = 1
const MAX_TEAMMATES = 8
const DEFAULT_TEAMMATES = 3

/** Calm cost framing (plan §8): N agents == the multiplier, never alarmist. The
 *  total processes = lead + teammates. */
function costNote(teammates: number): string {
  const total = teammates + 1
  return `Runs ${total} agents in parallel (1 lead + ${teammates} teammate${
    teammates === 1 ? '' : 's'
  }) — more agents, more tokens.`
}

export interface StartTeamSheetProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** Working directory for the lead. Falls back to the server home server-side. */
  defaultDir?: string
  /** Called with the new LEAD session's name so the route can navigate to focus. */
  onStarted: (name: string) => void
}

export function StartTeamSheet({
  open,
  onOpenChange,
  defaultDir,
  onStarted,
}: StartTeamSheetProps) {
  return (
    <ResponsiveSheet
      open={open}
      onOpenChange={onOpenChange}
      title="Start a team"
      description="A lead agent spins up teammates to work in parallel."
    >
      {open && (
        <StartTeamForm
          defaultDir={defaultDir}
          onCancel={() => onOpenChange(false)}
          onStarted={(name) => {
            onOpenChange(false)
            onStarted(name)
          }}
        />
      )}
    </ResponsiveSheet>
  )
}

interface StartTeamFormProps {
  defaultDir?: string
  onCancel: () => void
  onStarted: (name: string) => void
}

function StartTeamForm({ defaultDir, onCancel, onStarted }: StartTeamFormProps) {
  const [task, setTask] = React.useState('')
  const [teammates, setTeammates] = React.useState(DEFAULT_TEAMMATES)
  const [model, setModel] = React.useState('')
  // Pre-fill the directory the same way New Session does (defaultDir ?? home),
  // so the lead launches in a sensible cwd and the user can pick a repo without
  // typing. A blank value still works — the server falls back to home.
  const [dir, setDir] = React.useState(() => defaultDir ?? homeDir())
  const [submitting, setSubmitting] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)

  const canSubmit = task.trim().length > 0

  const submit = async (e?: React.FormEvent) => {
    e?.preventDefault()
    if (!canSubmit || submitting) return
    setSubmitting(true)
    setError(null)
    try {
      const result = await teamsStartApi.start({
        task: task.trim(),
        teammates,
        model: model.trim() || undefined,
        dir: dir.trim() || undefined,
      })
      onStarted(result.lead.name)
    } catch (err) {
      if (err instanceof SessionError && err.status === 409) {
        setError('A session with that name already exists — try again.')
      } else if (err instanceof SessionError && err.status === 0) {
        setError('Can’t reach supermux-server. Check it’s running, then try again.')
      } else {
        setError(err instanceof Error ? err.message : 'Could not start the team.')
      }
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <form onSubmit={submit} className="flex flex-col gap-4 px-6 pb-6 pt-4">
      <Field label="Goal" htmlFor="st-task" hint="What should the team accomplish?">
        <textarea
          id="st-task"
          value={task}
          onChange={(e) => setTask(e.target.value)}
          rows={4}
          autoFocus
          placeholder="e.g. Migrate the billing service to the new API and add tests."
          className="w-full rounded-md border border-input bg-transparent px-3 py-2 text-base md:text-sm shadow-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        />
      </Field>

      <DirectoryField
        id="st-dir"
        value={dir}
        onChange={setDir}
        hint="Where the lead runs. Defaults to your home directory."
      />

      <Field label="Teammates" htmlFor="st-count" hint="How many agents work alongside the lead.">
        <div className="flex items-center gap-3">
          <Stepper
            value={teammates}
            min={MIN_TEAMMATES}
            max={MAX_TEAMMATES}
            onChange={setTeammates}
          />
          <span className="text-sm text-muted-foreground">
            {teammates} teammate{teammates === 1 ? '' : 's'}
          </span>
        </div>
      </Field>

      <Field
        label="Model"
        htmlFor="st-model"
        hint="Optional — applied to each teammate. Leave blank for the default."
      >
        <Input
          id="st-model"
          value={model}
          onChange={(e) => setModel(e.target.value)}
          placeholder="opus / sonnet (optional)"
          autoComplete="off"
          spellCheck={false}
        />
      </Field>

      {/* Calm cost note (plan §8) — muted, informational, never a red banner. */}
      <p className="flex items-start gap-2 rounded-md border border-border bg-muted/40 px-3 py-2 text-xs text-muted-foreground">
        <Users className="mt-0.5 size-3.5 shrink-0" aria-hidden />
        <span>{costNote(teammates)}</span>
      </p>

      {error && (
        <p
          role="alert"
          className="rounded-md border border-status-error/40 bg-status-error/10 px-3 py-2 text-sm text-status-error"
        >
          {error}
        </p>
      )}

      <div className="flex gap-2 pt-2">
        <Button type="button" variant="ghost" className="flex-1" onClick={onCancel}>
          Cancel
        </Button>
        <Button type="submit" className="flex-1" disabled={!canSubmit || submitting}>
          {submitting && <Loader2 className="animate-spin" />}
          {submitting ? 'Starting…' : 'Start team'}
        </Button>
      </div>
    </form>
  )
}

/** A compact −/N/+ stepper. Buttons clamp to [min, max]; the value is never typed
 *  directly (keeps it always-valid, no parsing). */
function Stepper({
  value,
  min,
  max,
  onChange,
}: {
  value: number
  min: number
  max: number
  onChange: (n: number) => void
}) {
  const dec = () => onChange(Math.max(min, value - 1))
  const inc = () => onChange(Math.min(max, value + 1))
  return (
    <div className="inline-flex items-center rounded-lg border border-border">
      <StepperBtn label="Fewer teammates" disabled={value <= min} onClick={dec}>
        −
      </StepperBtn>
      <span className="w-8 text-center text-sm font-medium tabular-nums" aria-live="polite">
        {value}
      </span>
      <StepperBtn label="More teammates" disabled={value >= max} onClick={inc}>
        +
      </StepperBtn>
    </div>
  )
}

function StepperBtn({
  children,
  label,
  disabled,
  onClick,
}: {
  children: React.ReactNode
  label: string
  disabled: boolean
  onClick: () => void
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      aria-label={label}
      className={cn(
        'flex size-9 items-center justify-center text-lg leading-none text-muted-foreground transition-colors',
        'hover:text-foreground disabled:opacity-40 disabled:hover:text-muted-foreground',
      )}
    >
      {children}
    </button>
  )
}

function Field({
  label,
  htmlFor,
  hint,
  children,
}: {
  label: string
  htmlFor: string
  hint?: string
  children: React.ReactNode
}) {
  return (
    <div className="flex flex-col gap-1.5">
      <label htmlFor={htmlFor} className="text-sm font-medium">
        {label}
      </label>
      {children}
      {hint && <p className="text-xs text-muted-foreground">{hint}</p>}
    </div>
  )
}
