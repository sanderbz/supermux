import * as React from 'react'
import { Loader2, Users } from 'lucide-react'

import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { ResponsiveSheet } from '@/components/ui/responsive-sheet'
import { teamsStartApi, SessionError } from '@/lib/api'

// "Make <name> a team" — convert an EXISTING session into a team lead IN PLACE.
// Reuses the iOS-style ResponsiveSheet (Vaul drag-detent bottom sheet on touch,
// right-side dialog on desktop) — the same pattern <NewSessionSheet> uses — so
// the affordance feels native. Fields: goal/task (textarea), # teammates
// (stepper), optional model.
//
// The directory is FIXED (the existing session's — a conversion reuses the row,
// it never moves), shown as a muted `In: <dir>` footnote so the user sees WHERE
// the team will run without a field they can wander away from. Submit POSTs
// /api/teams/start-from-existing; the confirm copy spells out the restart, since
// the Agent Teams env+settings only take effect at process launch — Claude has
// to be restarted (fresh conversation) for the team flag to apply.
//
// (The from-scratch "Start a team" create flow + WherePicker morph were removed
// with the New Session panel's Team toggle: teams are now formed by converting
// an existing session, which is this sheet's sole entry.)

/** Bounds mirror the server clamp (teams/start.rs MIN/MAX_TEAMMATES). */
const MIN_TEAMMATES = 1
const MAX_TEAMMATES = 8
const DEFAULT_TEAMMATES = 3

/** Calm cost framing: N agents == the multiplier, never alarmist. Prepends the
 *  restart-fact (the Agent Teams env+settings only take effect at process
 *  launch, so we MUST restart) so the user sees it up-front, not after the
 *  click. total processes = lead + teammates. */
function costNote(teammates: number, name: string): string {
  const total = teammates + 1
  const runsLine = `Runs ${total} agents in parallel (1 lead + ${teammates} teammate${
    teammates === 1 ? '' : 's'
  }) — more agents, more tokens.`
  return `Stops ${name} and restarts it as the lead of a team — the conversation starts fresh in its directory. ${runsLine}`
}

export interface StartTeamSheetProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** The existing session's name — read-only, rendered in the title `Take over
   *  <name> as a team`; the conversion reuses this row (the name is unchanged). */
  sessionName: string
  /** The existing session's dir — shown as a muted `In: <dir>` footnote (fixed;
   *  a conversion never moves the session). */
  sessionDir?: string
  /** Called with the lead session's name on success so the route can navigate
   *  to focus (unchanged for a convert). */
  onStarted: (name: string) => void
}

export function StartTeamSheet({
  open,
  onOpenChange,
  sessionName,
  sessionDir,
  onStarted,
}: StartTeamSheetProps) {
  return (
    <ResponsiveSheet
      open={open}
      onOpenChange={onOpenChange}
      title={`Take over ${sessionName} as a team`}
      description="Restarts the session as the lead of a team — the current conversation is replaced."
    >
      {open && (
        <StartTeamForm
          sessionName={sessionName}
          sessionDir={sessionDir}
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
  sessionName: string
  sessionDir?: string
  onCancel: () => void
  onStarted: (name: string) => void
}

/** The convert/take-over form body — turns the passed-in session into a team
 *  lead in place via /api/teams/start-from-existing. */
function StartTeamForm({
  sessionName,
  sessionDir,
  onCancel,
  onStarted,
}: StartTeamFormProps) {
  const [task, setTask] = React.useState('')
  const [teammates, setTeammates] = React.useState(DEFAULT_TEAMMATES)
  const [model, setModel] = React.useState('')
  const [submitting, setSubmitting] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)

  const canSubmit = task.trim().length > 0

  const submit = async (e?: React.FormEvent) => {
    e?.preventDefault()
    if (!canSubmit || submitting) return
    setSubmitting(true)
    setError(null)
    try {
      const result = await teamsStartApi.convert({
        name: sessionName,
        task: task.trim(),
        teammates,
        model: model.trim() || undefined,
      })
      onStarted(result.lead.name)
    } catch (err) {
      if (err instanceof SessionError && err.status === 409) {
        // 409 = "already a team lead", or the session is archived.
        setError(
          'This session can’t be converted — it’s already a team, or archived. Reload to see its current state.',
        )
      } else if (err instanceof SessionError && err.status === 404) {
        setError('This session no longer exists. Reload the overview and try again.')
      } else if (err instanceof SessionError && err.status === 0) {
        setError('Can’t reach supermux-server. Check it’s running, then try again.')
      } else {
        setError(
          err instanceof Error ? err.message : 'Could not take over this session.',
        )
      }
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <form onSubmit={submit} className="flex flex-col gap-4 px-6 pb-6 pt-4">
      {sessionDir && (
        <p
          className="-mt-1 truncate text-xs text-muted-foreground"
          title={sessionDir}
        >
          In: <span className="font-mono">{sessionDir}</span>
        </p>
      )}

      <Field
        label="Goal"
        htmlFor="st-task"
        hint="What should the team work on? The session restarts and starts fresh."
      >
        {/* NO autoFocus — same iOS-PWA Vaul keyboard-during-open race as the
            board-card-editor. The keyboard popping mid-slide-in makes Vaul
            cache `initialDrawerHeight` from the still-translated drawer and the
            sheet ends up half-cropped. Users tap to focus. */}
        <textarea
          id="st-task"
          value={task}
          onChange={(e) => setTask(e.target.value)}
          rows={4}
          placeholder="e.g. Migrate the billing service to the new API and add tests."
          className="w-full rounded-md border border-input bg-transparent px-3 py-2 text-base md:text-sm shadow-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        />
      </Field>

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

      {/* Calm cost note — muted, informational, never a red banner. */}
      <p className="flex items-start gap-2 rounded-md border border-border bg-muted/40 px-3 py-2 text-xs text-muted-foreground">
        <Users className="mt-0.5 size-3.5 shrink-0" aria-hidden />
        <span>{costNote(teammates, sessionName)}</span>
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
          {submitting ? 'Taking over…' : 'Take over'}
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
