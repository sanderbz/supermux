import * as React from 'react'
import { Loader2, Users } from 'lucide-react'

import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { ResponsiveSheet } from '@/components/ui/responsive-sheet'
import { teamsStartApi, SessionError } from '@/lib/api'
import { homeDir, projectsDir } from '@/env'
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
//
// FEAT-CONVERT-TEAM (mode='convert'). Same sheet, "Make <name> a team" variant —
// converts an EXISTING session into a team lead in place. The directory field
// is hidden (we never move a converted session — it reuses the existing row's
// dir); shown instead as a muted footnote so the user sees WHERE the team will
// run. Submit calls /api/teams/start-from-existing instead of /start. The
// confirm copy spells out the restart, since the Agent Teams env+settings only
// take effect at process launch — Claude has to be restarted (fresh
// conversation) for the team flag to apply.

/** Bounds mirror the server clamp (teams/start.rs MIN/MAX_TEAMMATES). */
const MIN_TEAMMATES = 1
const MAX_TEAMMATES = 8
const DEFAULT_TEAMMATES = 3

/** Calm cost framing (plan §8): N agents == the multiplier, never alarmist. The
 *  total processes = lead + teammates. The convert variant prepends a calm
 *  one-liner spelling out the restart (the Agent Teams env+settings only take
 *  effect at process launch, so we MUST restart — the user sees this
 *  up-front, not after the click). */
function costNote(teammates: number, mode: SheetMode, sessionName?: string): string {
  const total = teammates + 1
  const runsLine = `Runs ${total} agents in parallel (1 lead + ${teammates} teammate${
    teammates === 1 ? '' : 's'
  }) — more agents, more tokens.`
  if (mode === 'convert' && sessionName) {
    return `Stops ${sessionName} and restarts it as the lead of a team — the team starts fresh in this directory. ${runsLine}`
  }
  return runsLine
}

/** create = new session + new team (the original AT-D flow).
 *  convert = take an EXISTING session and turn it into a team lead in place. */
export type SheetMode = 'create' | 'convert'

export interface StartTeamSheetProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** Sheet mode. Defaults to `'create'` for back-compat with every existing
   *  caller (the overview's "Start a team" entry). `'convert'` swaps the title
   *  / dir field / submit copy / submit endpoint. */
  mode?: SheetMode
  /** Convert mode only: the existing session's name + dir. The name is
   *  read-only in the sheet (rendered in the title `Make <name> a team`); the
   *  dir is shown as a muted `In: <dir>` footnote (the user can't change it —
   *  conversion REUSES the existing row). Ignored in create mode. */
  sessionName?: string
  sessionDir?: string
  /** Create mode only: working directory for the lead. Falls back to the
   *  server home server-side. Ignored in convert mode. */
  defaultDir?: string
  /** Called with the LEAD session's name on success so the route can navigate
   *  to focus. Same in both modes (in convert mode the name is unchanged). */
  onStarted: (name: string) => void
}

export function StartTeamSheet({
  open,
  onOpenChange,
  mode = 'create',
  sessionName,
  sessionDir,
  defaultDir,
  onStarted,
}: StartTeamSheetProps) {
  const title =
    mode === 'convert' && sessionName ? `Make ${sessionName} a team` : 'Start a team'
  const description =
    mode === 'convert'
      ? 'Turns this session into a team lead. It restarts in the same directory and forms a team of teammates.'
      : 'A lead agent spins up teammates to work in parallel.'
  return (
    <ResponsiveSheet
      open={open}
      onOpenChange={onOpenChange}
      title={title}
      description={description}
    >
      {open && (
        <StartTeamForm
          mode={mode}
          sessionName={sessionName}
          sessionDir={sessionDir}
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
  mode: SheetMode
  sessionName?: string
  sessionDir?: string
  defaultDir?: string
  onCancel: () => void
  onStarted: (name: string) => void
}

function StartTeamForm({
  mode,
  sessionName,
  sessionDir,
  defaultDir,
  onCancel,
  onStarted,
}: StartTeamFormProps) {
  const [task, setTask] = React.useState('')
  const [teammates, setTeammates] = React.useState(DEFAULT_TEAMMATES)
  const [model, setModel] = React.useState('')
  // Pre-fill the directory with the deploy-configured projects root (with a
  // trailing slash so the autocomplete on focus IMMEDIATELY lists the project
  // subdirs as candidates — turning "pick a repo" into a one-click choice).
  // Falls back to home when SUPERMUX_PROJECT_DIRS isn't set; an explicit
  // `defaultDir` from the caller still wins. Blank is fine — server defaults
  // to home server-side. (Convert mode: the dir is the existing session's;
  // this state is never read by the dir field because it's hidden.)
  const [dir, setDir] = React.useState(() => {
    if (defaultDir) return defaultDir
    const p = projectsDir()
    if (p) return p.endsWith('/') ? p : `${p}/`
    return homeDir()
  })
  const [submitting, setSubmitting] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)

  const canSubmit = task.trim().length > 0

  const submit = async (e?: React.FormEvent) => {
    e?.preventDefault()
    if (!canSubmit || submitting) return
    setSubmitting(true)
    setError(null)
    try {
      const result =
        mode === 'convert' && sessionName
          ? await teamsStartApi.convert({
              name: sessionName,
              task: task.trim(),
              teammates,
              model: model.trim() || undefined,
            })
          : await teamsStartApi.start({
              task: task.trim(),
              teammates,
              model: model.trim() || undefined,
              dir: dir.trim() || undefined,
            })
      onStarted(result.lead.name)
    } catch (err) {
      if (err instanceof SessionError && err.status === 409) {
        // 409 = "already a team lead" in convert mode, "name collision" in
        // create mode. The convert case is the more useful copy (and the
        // create case still reads correctly).
        setError(
          mode === 'convert'
            ? 'This session can’t be converted — it’s already a team, or archived. Reload to see its current state.'
            : 'A session with that name already exists — try again.',
        )
      } else if (err instanceof SessionError && err.status === 404) {
        setError('This session no longer exists. Reload the overview and try again.')
      } else if (err instanceof SessionError && err.status === 0) {
        setError('Can’t reach supermux-server. Check it’s running, then try again.')
      } else {
        setError(
          err instanceof Error
            ? err.message
            : mode === 'convert'
              ? 'Could not make this a team.'
              : 'Could not start the team.',
        )
      }
    } finally {
      setSubmitting(false)
    }
  }

  const isConvert = mode === 'convert'
  // In convert mode the dir is fixed (the existing session's). Surface it as a
  // muted footnote under the title so the user SEES where the team will run —
  // without giving them a field they can wander away from. The full path stays
  // the accessible label (`title`) for truncation tooltips on narrow widths.
  const dirFootnote = isConvert && sessionDir ? sessionDir : null

  return (
    <form onSubmit={submit} className="flex flex-col gap-4 px-6 pb-6 pt-4">
      {dirFootnote && (
        <p
          className="-mt-1 truncate text-xs text-muted-foreground"
          title={dirFootnote}
        >
          In: <span className="font-mono">{dirFootnote}</span>
        </p>
      )}

      <Field
        label="Goal"
        htmlFor="st-task"
        hint={
          isConvert
            ? 'What should the team work on? The session restarts and starts fresh.'
            : 'What should the team accomplish?'
        }
      >
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

      {/* Convert mode: hide the directory field entirely — the existing
          session's dir is authoritative (surfaced as the footnote above). */}
      {!isConvert && (
        <DirectoryField
          id="st-dir"
          value={dir}
          onChange={setDir}
          hint="Where the lead runs. Defaults to your home directory."
        />
      )}

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

      {/* Calm cost note (plan §8) — muted, informational, never a red banner.
          Convert mode prepends the restart-fact so the user sees it before the
          click, not after. */}
      <p className="flex items-start gap-2 rounded-md border border-border bg-muted/40 px-3 py-2 text-xs text-muted-foreground">
        <Users className="mt-0.5 size-3.5 shrink-0" aria-hidden />
        <span>{costNote(teammates, mode, sessionName)}</span>
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
          {submitting
            ? isConvert
              ? 'Making team…'
              : 'Starting…'
            : isConvert
              ? 'Make it a team'
              : 'Start team'}
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
