import * as React from 'react'
import { Loader2, Users } from 'lucide-react'

import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { ResponsiveSheet } from '@/components/ui/responsive-sheet'
import { teamsStartApi, SessionError } from '@/lib/api'
import {
  WherePicker,
  defaultWhereSelection,
  type WhereSelection,
} from './where-picker'

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
//
// FEAT-WHERE-PICKER. The create-mode directory field is replaced by the
// <WherePicker>: a three-section list (Your sessions / Projects / Use another
// folder) the user can scroll without a `+N more` cap. Picking a SESSION row
// morphs the sheet into a take-over flow on the fly: title, description and
// submit copy switch to the convert-team voice, and submit calls
// /api/teams/start-from-existing instead of /start — without leaving the
// sheet. This is the user's "select an existing one (like one of the session)
// or folder" ask, addressed from the same entry point.

/** Bounds mirror the server clamp (teams/start.rs MIN/MAX_TEAMMATES). */
const MIN_TEAMMATES = 1
const MAX_TEAMMATES = 8
const DEFAULT_TEAMMATES = 3

/** Calm cost framing (plan §8): N agents == the multiplier, never alarmist. The
 *  total processes = lead + teammates. The convert/take-over variant prepends
 *  a calm one-liner spelling out the restart (the Agent Teams env+settings only
 *  take effect at process launch, so we MUST restart — the user sees this
 *  up-front, not after the click). */
function costNote(teammates: number, takeoverName?: string): string {
  const total = teammates + 1
  const runsLine = `Runs ${total} agents in parallel (1 lead + ${teammates} teammate${
    teammates === 1 ? '' : 's'
  }) — more agents, more tokens.`
  if (takeoverName) {
    return `Stops ${takeoverName} and restarts it as the lead of a team — the conversation starts fresh in its directory. ${runsLine}`
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
  // FEAT-WHERE-PICKER: in create mode the user can morph this sheet into a
  // take-over flow by picking a session row in the WherePicker. We lift the
  // current selection up to the sheet so the title/description morph live —
  // see <StartTeamForm> for the actual selection logic + endpoint switch.
  const [where, setWhere] = React.useState<WhereSelection>(() =>
    defaultDir ? { kind: 'new', dir: defaultDir } : defaultWhereSelection(),
  )
  // Reset to the default selection each time the sheet opens (parity with
  // the existing remount-on-open pattern below).
  React.useEffect(() => {
    if (open) {
      setWhere(defaultDir ? { kind: 'new', dir: defaultDir } : defaultWhereSelection())
    }
  }, [open, defaultDir])

  const takeoverName =
    mode === 'convert'
      ? sessionName
      : where.kind === 'session'
        ? where.session.name
        : undefined

  const title = takeoverName ? `Take over ${takeoverName} as a team` : 'Start a team'
  const description = takeoverName
    ? 'Restarts the session as the lead of a team — the current conversation is replaced.'
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
          where={where}
          onWhereChange={setWhere}
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
  where: WhereSelection
  onWhereChange: (next: WhereSelection) => void
  onCancel: () => void
  onStarted: (name: string) => void
}

function StartTeamForm({
  mode,
  sessionName,
  sessionDir,
  where,
  onWhereChange,
  onCancel,
  onStarted,
}: StartTeamFormProps) {
  const [task, setTask] = React.useState('')
  const [teammates, setTeammates] = React.useState(DEFAULT_TEAMMATES)
  const [model, setModel] = React.useState('')
  const [submitting, setSubmitting] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)

  const canSubmit = task.trim().length > 0

  // Convert mode is the legacy "Make <name> a team" entry from the session
  // overflow — sticky to the passed-in session. Create mode reads the
  // WherePicker's selection: a `session` pick converts; a `new` pick starts
  // fresh. Both branches use the same SAME endpoints they always did.
  const isLegacyConvert = mode === 'convert'
  const isPickedSession = !isLegacyConvert && where.kind === 'session'
  const isTakeover = isLegacyConvert || isPickedSession
  const takeoverName = isLegacyConvert
    ? sessionName
    : isPickedSession
      ? where.session.name
      : undefined
  const takeoverDir = isLegacyConvert
    ? sessionDir
    : isPickedSession
      ? where.session.dir
      : undefined

  const submit = async (e?: React.FormEvent) => {
    e?.preventDefault()
    if (!canSubmit || submitting) return
    setSubmitting(true)
    setError(null)
    try {
      const result = isTakeover && takeoverName
        ? await teamsStartApi.convert({
            name: takeoverName,
            task: task.trim(),
            teammates,
            model: model.trim() || undefined,
          })
        : await teamsStartApi.start({
            task: task.trim(),
            teammates,
            model: model.trim() || undefined,
            dir: where.kind === 'new' ? where.dir.trim() || undefined : undefined,
          })
      onStarted(result.lead.name)
    } catch (err) {
      if (err instanceof SessionError && err.status === 409) {
        // 409 = "already a team lead" in convert/takeover mode, "name
        // collision" in create mode.
        setError(
          isTakeover
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
            : isTakeover
              ? 'Could not take over this session.'
              : 'Could not start the team.',
        )
      }
    } finally {
      setSubmitting(false)
    }
  }

  // Legacy convert mode: dir is fixed (the existing session's). Surface as a
  // muted footnote so the user SEES where the team will run — without giving
  // them a field they can wander away from.
  const dirFootnote = isLegacyConvert && takeoverDir ? takeoverDir : null

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
          isTakeover
            ? 'What should the team work on? The session restarts and starts fresh.'
            : 'What should the team accomplish?'
        }
      >
        {/* NO autoFocus — same iOS-PWA Vaul keyboard-during-open race as the
            board-card-editor. The keyboard popping mid-slide-in makes Vaul
            cache `initialDrawerHeight` from the still-translated drawer and
            the sheet ends up half-cropped. The proven-working New Session
            sheet has no autoFocus either; users tap to focus. */}
        <textarea
          id="st-task"
          value={task}
          onChange={(e) => setTask(e.target.value)}
          rows={4}
          placeholder="e.g. Migrate the billing service to the new API and add tests."
          className="w-full rounded-md border border-input bg-transparent px-3 py-2 text-base md:text-sm shadow-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        />
      </Field>

      {/* Legacy convert mode: hide the picker entirely — the existing
          session's dir is authoritative (surfaced as the footnote above).
          Create mode (new + take-over picks): show the WherePicker so the
          user can choose either fresh dir, an existing project, or take over
          an existing session — without leaving the sheet.
          showSessions + gitHint are passed EXPLICITLY (matching the defaults)
          so a future reader sees why New Session — which passes the OPPOSITE
          values — diverges: Start-a-team teammates each need their own git
          worktree (warn appropriate; take-over reachable), a normal session
          can run anywhere (warn off; no take-over). */}
      {!isLegacyConvert && (
        <WherePicker
          id="st-where"
          value={where}
          onChange={onWhereChange}
          showSessions={true}
          gitHint="warn"
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
          The take-over path prepends the restart-fact so the user sees it
          before the click, not after. */}
      <p className="flex items-start gap-2 rounded-md border border-border bg-muted/40 px-3 py-2 text-xs text-muted-foreground">
        <Users className="mt-0.5 size-3.5 shrink-0" aria-hidden />
        <span>{costNote(teammates, takeoverName)}</span>
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
            ? isTakeover
              ? 'Taking over…'
              : 'Starting…'
            : isTakeover
              ? 'Take over'
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
