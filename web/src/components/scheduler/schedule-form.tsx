// ScheduleForm (M21) — the kind/fields/expression body shared by the create +
// edit surfaces (both now host it in the same right-side Sheet). Owns: kind
// radio, matching field set (boot / tmux / shell), a real command picker
// (combobox over GET /api/slash-commands) for boot/tmux prompts, a real session
// picker (select over the live sessions list) for tmux, a friendly recurrence
// composer (quick-pick chips → schedule_expr) with a live English render + a
// Custom escape hatch (raw natural-language / cron) and a DEBOUNCED next-5-runs
// preview (POST /api/schedules/preview), one-shot datetime picker, optional
// watch-mode, and a test-fire button. Animations use springs.ts only.

import * as React from 'react'
import { AnimatePresence, motion, useReducedMotion } from 'framer-motion'
import {
  Check,
  ChevronDown,
  Clock3,
  FlaskConical,
  Loader2,
  Rocket,
  Terminal,
} from 'lucide-react'

import { cn } from '@/lib/utils'
import { springs } from '@/lib/springs'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { useToast } from '@/components/ui/use-toast'
import {
  schedulerApi,
  type RecipeCommand,
  type ScheduleCreateInput,
  type ScheduleKind,
} from '@/lib/api'
import { useSchedulerCommands, useTestFire } from '@/hooks/use-scheduler'
import {
  DONE_ACTIONS,
  describeSchedule,
  EMPTY_RECURRENCE,
  exprToRecurrence,
  formatFull,
  FREQUENCY_CHIPS,
  FREQUENCY_LABEL,
  KIND_LABEL,
  PROVIDERS,
  recurrenceToExpr,
  type Frequency,
  type RecurrenceDraft,
  WEEKDAYS,
} from './helpers'

export interface ScheduleFormValue {
  title: string
  kind: ScheduleKind
  command: string
  /** Free-text prompt sent after the command (boot/tmux only). */
  prompt: string
  schedule_expr: string
  session: string
  boot_dir: string
  boot_provider: string
  boot_worktree: boolean
  watch: boolean
  done_pattern: string
  done_action: string
}

export const EMPTY_FORM: ScheduleFormValue = {
  title: '',
  kind: 'boot',
  command: '',
  prompt: '',
  schedule_expr: '',
  session: '',
  boot_dir: '',
  boot_provider: 'claude',
  boot_worktree: false,
  watch: false,
  done_pattern: '',
  done_action: 'disable',
}

const KIND_ICON: Record<ScheduleKind, React.ReactNode> = {
  boot: <Rocket className="size-4" />,
  tmux: <Terminal className="size-4" />,
  shell: <Clock3 className="size-4" />,
}

const KINDS: ScheduleKind[] = ['boot', 'tmux', 'shell']

/** Build the API payload from form state (only the fields the kind needs). The
 *  free-text `prompt` rides alongside the slash `command` for boot/tmux; shell
 *  jobs run the command literally so a prompt has no meaning there. */
export function toCreateInput(v: ScheduleFormValue): ScheduleCreateInput {
  const base: ScheduleCreateInput = {
    title: v.title.trim(),
    kind: v.kind,
    command: v.command.trim(),
    schedule_expr: v.schedule_expr.trim(),
    watch: v.watch,
    done_pattern: v.watch ? v.done_pattern.trim() || undefined : undefined,
    done_action: v.watch ? v.done_action : undefined,
  }
  if (v.kind === 'tmux') {
    base.session = v.session.trim()
    base.prompt = v.prompt.trim()
  }
  if (v.kind === 'boot') {
    base.boot_dir = v.boot_dir.trim()
    base.boot_provider = v.boot_provider
    base.boot_worktree = v.boot_worktree
    base.prompt = v.prompt.trim()
  }
  return base
}

/** Client-side validity gate (mirrors the M8 server checks) — drives the
 *  Save + Test-fire enabled states. A shell job requires a command; boot/tmux
 *  accept a command and/or a prompt (at least one). */
export function isFormValid(v: ScheduleFormValue): boolean {
  if (!v.title.trim() || !v.schedule_expr.trim()) return false
  if (v.kind === 'shell') {
    if (!v.command.trim()) return false
  } else if (!v.command.trim() && !v.prompt.trim()) {
    return false
  }
  if (v.kind === 'tmux' && !v.session.trim()) return false
  if (v.kind === 'boot' && !v.boot_dir.trim()) return false
  return true
}

interface ScheduleFormProps {
  value: ScheduleFormValue
  onChange: (next: ScheduleFormValue) => void
  /** Known session names for the tmux target picker. */
  sessions: string[]
  /** Hide the test-fire button (e.g. on the edit sheet for an existing job). */
  hideTestFire?: boolean
}

export function ScheduleForm({
  value,
  onChange,
  sessions,
  hideTestFire,
}: ScheduleFormProps) {
  const set = <K extends keyof ScheduleFormValue>(
    key: K,
    v: ScheduleFormValue[K],
  ) => onChange({ ...value, [key]: v })

  const preview = useExpressionPreview(value.schedule_expr)
  const testFire = useTestFire()
  const { toast } = useToast()
  const commands = useSchedulerCommands()
  const valid = isFormValid(value)

  const runTestFire = () => {
    testFire.mutate(toCreateInput(value), {
      onSuccess: (res) => {
        toast({
          message:
            res.status === 'ok'
              ? `Test fire ok — ${res.note || 'ran'}`
              : `Test fire failed — ${res.note || 'error'}`,
          tone: res.status === 'ok' ? 'active' : 'error',
          duration: 4000,
        })
      },
      onError: (e) => {
        toast({
          message: `Test fire failed — ${(e as Error).message}`,
          tone: 'error',
          duration: 4000,
        })
      },
    })
  }

  return (
    <div className="flex flex-col gap-5">
      {/* Title */}
      <Field label="Title">
        <Input
          value={value.title}
          onChange={(e) => set('title', e.target.value)}
          placeholder="Weekly review"
          className="h-11"
        />
      </Field>

      {/* Kind radio */}
      <Field label="Job kind">
        <div className="grid grid-cols-3 gap-2" role="radiogroup">
          {KINDS.map((k) => {
            const active = value.kind === k
            return (
              <button
                key={k}
                type="button"
                role="radio"
                aria-checked={active}
                onClick={() => set('kind', k)}
                className={cn(
                  'relative flex min-h-11 flex-col items-center justify-center gap-1 rounded-lg border px-2 py-2 text-xs font-medium transition-colors',
                  active
                    ? 'border-primary text-foreground'
                    : 'border-border text-muted-foreground hover:bg-accent',
                )}
              >
                {active && (
                  <motion.span
                    layoutId="sched-kind-active"
                    transition={springs.snappy}
                    className="absolute inset-0 rounded-lg bg-primary/10"
                  />
                )}
                <span className="relative">{KIND_ICON[k]}</span>
                <span className="relative">{KIND_LABEL[k]}</span>
              </button>
            )
          })}
        </div>
      </Field>

      {/* Kind-specific fields */}
      {value.kind === 'boot' && (
        <>
          <Field label="Directory">
            <Input
              value={value.boot_dir}
              onChange={(e) => set('boot_dir', e.target.value)}
              placeholder="/Users/you/project"
              className="h-11 font-mono text-base md:text-xs"
            />
          </Field>
          <div className="grid grid-cols-2 gap-3">
            <Field label="Provider">
              <select
                value={value.boot_provider}
                onChange={(e) => set('boot_provider', e.target.value)}
                className="h-11 w-full rounded-md border border-input bg-transparent px-3 text-base md:text-sm"
              >
                {PROVIDERS.map((p) => (
                  <option key={p} value={p}>
                    {p}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Worktree">
              <CheckRow
                checked={value.boot_worktree}
                onChange={(c) => set('boot_worktree', c)}
                label="Isolated git worktree"
              />
            </Field>
          </div>
          <Field label="Command">
            <CommandPicker
              value={value.command}
              onChange={(v) => set('command', v)}
              commands={commands.data ?? []}
              loading={commands.isLoading}
              placeholder="/cso"
            />
          </Field>
          <Field label="Prompt (optional)">
            <PromptArea
              value={value.prompt}
              onChange={(v) => set('prompt', v)}
              placeholder="Anything to say after the command — or leave the command blank and just send this."
            />
          </Field>
        </>
      )}

      {value.kind === 'tmux' && (
        <>
          <Field label="Target session">
            <SessionPicker
              value={value.session}
              onChange={(v) => set('session', v)}
              sessions={sessions}
            />
          </Field>
          <Field label="Command (optional)">
            <CommandPicker
              value={value.command}
              onChange={(v) => set('command', v)}
              commands={commands.data ?? []}
              loading={commands.isLoading}
              placeholder="/status"
            />
          </Field>
          <Field label="Prompt (optional)">
            <PromptArea
              value={value.prompt}
              onChange={(v) => set('prompt', v)}
              placeholder="Free-text to send after the command — or on its own."
            />
          </Field>
        </>
      )}

      {value.kind === 'shell' && (
        <Field label="Shell command">
          <Input
            value={value.command}
            onChange={(e) => set('command', e.target.value)}
            placeholder="touch /tmp/done"
            className="h-11 font-mono text-base md:text-xs"
          />
        </Field>
      )}

      {/* Recurrence composer + live English render + preview */}
      <RecurrenceComposer
        expr={value.schedule_expr}
        onExpr={(v) => set('schedule_expr', v)}
        preview={preview}
      />

      {/* Watch mode */}
      <Field label="Watch mode">
        <CheckRow
          checked={value.watch}
          onChange={(c) => set('watch', c)}
          label="Watch the session for a done-pattern after it runs"
        />
        <AnimatePresence initial={false}>
          {value.watch && (
            <motion.div
              initial={{ opacity: 0, height: 0 }}
              animate={{ opacity: 1, height: 'auto' }}
              exit={{ opacity: 0, height: 0 }}
              transition={springs.cardExpand}
              className="overflow-hidden"
            >
              <div className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-2">
                <Field label="Done pattern (regex)">
                  <Input
                    value={value.done_pattern}
                    onChange={(e) => set('done_pattern', e.target.value)}
                    placeholder="✓ done"
                    className="h-11 font-mono text-base md:text-xs"
                  />
                </Field>
                <Field label="On match">
                  <select
                    value={value.done_action}
                    onChange={(e) => set('done_action', e.target.value)}
                    className="h-11 w-full rounded-md border border-input bg-transparent px-3 text-base md:text-sm"
                  >
                    {DONE_ACTIONS.map((a) => (
                      <option key={a} value={a}>
                        {a}
                      </option>
                    ))}
                  </select>
                </Field>
              </div>
            </motion.div>
          )}
        </AnimatePresence>
      </Field>

      {/* Test fire */}
      {!hideTestFire && (
        <Button
          type="button"
          variant="outline"
          onClick={runTestFire}
          disabled={!valid || testFire.isPending}
          className="h-11 self-start"
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
  )
}

// ── recurrence composer ────────────────────────────────────────────────────────
//
// Quick-pick chips compose the `schedule_expr` for the common cases; "Custom"
// reveals the raw free-text escape hatch (natural language or cron — the server
// parser already accepts every form). A live English render + the debounced
// next-5-runs preview confirm what was composed.

function RecurrenceComposer({
  expr,
  onExpr,
  preview,
}: {
  expr: string
  onExpr: (v: string) => void
  preview: PreviewState
}) {
  // Seed the composer from the current expression (so edit lands on the right
  // chip). Stored during render via the wasExpr guard — no setState-in-effect.
  const [draft, setDraft] = React.useState<RecurrenceDraft>(() =>
    expr.trim() ? exprToRecurrence(expr) : { ...EMPTY_RECURRENCE },
  )
  const [seededFrom, setSeededFrom] = React.useState(expr)
  if (expr !== seededFrom && expr.trim() && draft.frequency === 'custom') {
    // External expr change while on custom: keep custom (user is editing raw).
    setSeededFrom(expr)
  }

  const applyDraft = (next: RecurrenceDraft) => {
    setDraft(next)
    const composed = recurrenceToExpr(next)
    if (composed !== null) {
      onExpr(composed)
      setSeededFrom(composed)
    }
  }

  const pickFrequency = (f: Frequency) => {
    if (f === 'custom') {
      applyDraft({ ...draft, frequency: f })
      return
    }
    applyDraft({ ...draft, frequency: f })
  }

  const human = describeSchedule(expr)

  return (
    <Field label="When">
      <div className="flex flex-wrap gap-1.5">
        {FREQUENCY_CHIPS.map((f) => {
          const active = draft.frequency === f
          return (
            <button
              key={f}
              type="button"
              aria-pressed={active}
              onClick={() => pickFrequency(f)}
              className={cn(
                'relative min-h-9 rounded-full border px-3 py-1.5 text-xs font-medium transition-colors',
                active
                  ? 'border-primary text-foreground'
                  : 'border-border text-muted-foreground hover:bg-accent hover:text-foreground',
              )}
            >
              {active && (
                <motion.span
                  layoutId="sched-freq-active"
                  transition={springs.snappy}
                  className="absolute inset-0 rounded-full bg-primary/10"
                />
              )}
              <span className="relative">{FREQUENCY_LABEL[f]}</span>
            </button>
          )
        })}
      </div>

      {/* Frequency-specific controls. */}
      <div className="mt-3">
        {draft.frequency === 'once' && (
          <OneShotPicker
            onPick={(e) => {
              onExpr(e)
              setSeededFrom(e)
            }}
          />
        )}

        {(draft.frequency === 'daily' || draft.frequency === 'weekdays') && (
          <TimeRow
            time={draft.time}
            onTime={(t) => applyDraft({ ...draft, time: t })}
          />
        )}

        {draft.frequency === 'weekly' && (
          <div className="flex flex-col gap-3">
            <DayPicker
              day={draft.day}
              onDay={(d) => applyDraft({ ...draft, day: d })}
            />
            <TimeRow
              time={draft.time}
              onTime={(t) => applyDraft({ ...draft, time: t })}
            />
          </div>
        )}

        {draft.frequency === 'monthly' && (
          <div className="flex flex-col gap-3">
            <SubField label="Day of month (1–28)">
              <select
                value={draft.dom}
                onChange={(e) =>
                  applyDraft({ ...draft, dom: Number(e.target.value) })
                }
                className="h-11 w-full rounded-md border border-input bg-transparent px-3 text-base md:text-sm"
              >
                {Array.from({ length: 28 }, (_, i) => i + 1).map((n) => (
                  <option key={n} value={n}>
                    {n}
                  </option>
                ))}
              </select>
            </SubField>
            <TimeRow
              time={draft.time}
              onTime={(t) => applyDraft({ ...draft, time: t })}
            />
          </div>
        )}

        {draft.frequency === 'interval' && (
          <div className="grid grid-cols-2 gap-3">
            <SubField label="Every">
              <Input
                type="number"
                min={1}
                value={draft.intervalN}
                onChange={(e) =>
                  applyDraft({
                    ...draft,
                    intervalN: Math.max(1, Number(e.target.value) || 1),
                  })
                }
                className="h-11"
              />
            </SubField>
            <SubField label="Unit">
              <select
                value={draft.intervalUnit}
                onChange={(e) =>
                  applyDraft({ ...draft, intervalUnit: e.target.value })
                }
                className="h-11 w-full rounded-md border border-input bg-transparent px-3 text-base md:text-sm"
              >
                <option value="m">minutes</option>
                <option value="h">hours</option>
                <option value="d">days</option>
              </select>
            </SubField>
          </div>
        )}

        {draft.frequency === 'custom' && (
          <SubField label="Schedule (natural language or cron)">
            <Input
              value={expr}
              onChange={(e) => {
                onExpr(e.target.value)
                setSeededFrom(e.target.value)
              }}
              placeholder="every monday at 9am"
              className="h-11 font-mono text-base md:text-xs"
            />
          </SubField>
        )}
      </div>

      {/* Live English render. */}
      {expr.trim() && (
        <div className="mt-3 flex items-start gap-2 rounded-lg border border-border bg-muted/40 p-3">
          <Clock3 className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
          <div className="min-w-0">
            <p className="text-sm font-medium text-foreground">{human}</p>
            {preview.runs[0] && !preview.error && (
              <p className="mt-0.5 text-xs text-muted-foreground">
                Next fires {formatFull(preview.runs[0])}
              </p>
            )}
          </div>
        </div>
      )}

      <NextRunsPreview state={preview} />
    </Field>
  )
}

function TimeRow({
  time,
  onTime,
}: {
  time: string
  onTime: (t: string) => void
}) {
  return (
    <SubField label="At">
      <input
        type="time"
        value={time}
        onChange={(e) => onTime(e.target.value)}
        className="h-11 w-full rounded-md border border-input bg-transparent px-3 text-base md:text-sm text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      />
    </SubField>
  )
}

function DayPicker({
  day,
  onDay,
}: {
  day: string
  onDay: (d: string) => void
}) {
  return (
    <SubField label="On">
      <div className="flex flex-wrap gap-1.5">
        {WEEKDAYS.map((d) => {
          const active = day === d.value
          return (
            <button
              key={d.value}
              type="button"
              aria-pressed={active}
              onClick={() => onDay(d.value)}
              className={cn(
                'min-h-11 min-w-11 rounded-lg border px-2.5 py-2 text-xs font-medium transition-colors',
                active
                  ? 'border-primary bg-primary/10 text-foreground'
                  : 'border-border text-muted-foreground hover:bg-accent hover:text-foreground',
              )}
            >
              {d.label}
            </button>
          )
        })}
      </div>
    </SubField>
  )
}

// ── command picker (combobox over the REAL installed commands) ──────────────────
//
// Source is `GET /api/schedules/commands` — the user's actual installed skills +
// user/managed commands + claude.ai MCP connectors, never the built-in Claude
// slash commands. The field still accepts any typed text (a command not in the
// list is sent as-is), so it degrades gracefully.

/** Sentence-case label for each command source (no UPPERCASE literals). */
const SOURCE_LABEL: Record<RecipeCommand['source'], string> = {
  skill: 'Skill',
  command: 'Command',
  mcp: 'MCP connector',
}

function CommandPicker({
  value,
  onChange,
  commands,
  loading,
  placeholder,
}: {
  value: string
  onChange: (v: string) => void
  commands: RecipeCommand[]
  loading: boolean
  placeholder: string
}) {
  const [open, setOpen] = React.useState(false)
  const ref = React.useRef<HTMLDivElement>(null)

  React.useEffect(() => {
    if (!open) return
    const onDoc = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', onDoc)
    return () => document.removeEventListener('mousedown', onDoc)
  }, [open])

  const q = value.trim().toLowerCase()
  const filtered = q
    ? commands.filter(
        (c) =>
          c.cmd.toLowerCase().includes(q) ||
          c.desc.toLowerCase().includes(q),
      )
    : commands

  return (
    <div ref={ref} className="relative">
      <div className="relative">
        <Input
          value={value}
          onChange={(e) => {
            onChange(e.target.value)
            setOpen(true)
          }}
          onFocus={() => setOpen(true)}
          placeholder={placeholder}
          aria-label="Command"
          className="h-11 pr-10 font-mono text-base md:text-xs"
        />
        <button
          type="button"
          aria-label="Browse commands"
          onClick={() => setOpen((o) => !o)}
          className="absolute inset-y-0 right-0 grid w-10 place-items-center text-muted-foreground hover:text-foreground"
        >
          <ChevronDown
            className={cn('size-4 transition-transform', open && 'rotate-180')}
          />
        </button>
      </div>

      <AnimatePresence>
        {open && (
          <motion.div
            initial={{ opacity: 0, y: -4 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -4 }}
            transition={springs.cardExpand}
            className="absolute z-50 mt-1.5 max-h-64 w-full overflow-auto rounded-lg border border-border bg-popover p-1 shadow-lg"
          >
            {loading ? (
              <p className="px-2 py-2 text-xs text-muted-foreground">
                Loading installed commands…
              </p>
            ) : !filtered.length ? (
              <p className="px-2 py-2 text-xs text-muted-foreground">
                {commands.length
                  ? 'No matching command — type any text to send it as-is.'
                  : 'No installed skills or commands — type any text to send it as-is.'}
              </p>
            ) : (
              filtered.map((c) => {
                const selected = c.cmd === value.trim()
                return (
                  <button
                    key={`${c.source}:${c.cmd}`}
                    type="button"
                    onClick={() => {
                      onChange(c.cmd)
                      setOpen(false)
                    }}
                    className={cn(
                      'flex min-h-11 w-full items-start gap-2 rounded-md px-2 py-1.5 text-left transition-colors hover:bg-accent',
                      selected && 'bg-accent',
                    )}
                  >
                    <Check
                      className={cn(
                        'mt-0.5 size-3.5 shrink-0',
                        selected ? 'text-primary' : 'text-transparent',
                      )}
                    />
                    <span className="min-w-0 flex-1">
                      <span className="flex items-center gap-2">
                        <span className="font-mono text-xs text-foreground">
                          {c.cmd}
                        </span>
                        <span className="shrink-0 rounded-full bg-muted px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground">
                          {SOURCE_LABEL[c.source]}
                        </span>
                      </span>
                      {c.desc && (
                        <span className="mt-0.5 block truncate text-xs text-muted-foreground">
                          {c.desc}
                        </span>
                      )}
                    </span>
                  </button>
                )
              })
            )}
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  )
}

// ── prompt textarea (free-text sent after the command) ──────────────────────────

function PromptArea({
  value,
  onChange,
  placeholder,
}: {
  value: string
  onChange: (v: string) => void
  placeholder: string
}) {
  return (
    <textarea
      value={value}
      onChange={(e) => onChange(e.target.value)}
      placeholder={placeholder}
      rows={3}
      aria-label="Prompt"
      className="min-h-11 w-full resize-y rounded-md border border-input bg-transparent px-3 py-2 text-base md:text-sm text-foreground placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
    />
  )
}

// ── session picker (select over the live sessions list) ─────────────────────────

function SessionPicker({
  value,
  onChange,
  sessions,
}: {
  value: string
  onChange: (v: string) => void
  sessions: string[]
}) {
  // When the bound session isn't in the live list (e.g. an edited row pointing
  // at a stopped session), keep it selectable so the value isn't silently lost.
  const options = value && !sessions.includes(value) ? [value, ...sessions] : sessions
  return (
    <div className="relative">
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        aria-label="Target session"
        className="h-11 w-full appearance-none rounded-md border border-input bg-transparent px-3 pr-10 font-mono text-base md:text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        <option value="" disabled>
          {sessions.length ? 'Choose a session…' : 'No live sessions'}
        </option>
        {options.map((s) => (
          <option key={s} value={s}>
            {s}
          </option>
        ))}
      </select>
      <ChevronDown className="pointer-events-none absolute inset-y-0 right-3 my-auto size-4 text-muted-foreground" />
    </div>
  )
}

// ── preview hook (debounced 200ms POST /preview — no polling) ──────────────────

interface PreviewState {
  runs: string[]
  loading: boolean
  error: string | null
}

const IDLE_PREVIEW: PreviewState = { runs: [], loading: false, error: null }

function useExpressionPreview(expr: string): PreviewState {
  // `fetched` holds the last debounced-fetch result. The displayed state is
  // derived during render (empty when the field is blank), so the effect only
  // SUBSCRIBES — it never calls setState synchronously (set-state-in-effect).
  const [fetched, setFetched] = React.useState<PreviewState>(IDLE_PREVIEW)
  const trimmed = expr.trim()

  React.useEffect(() => {
    if (!trimmed) return // empty field renders idle; nothing to fetch
    const ctrl = new AbortController()
    const t = setTimeout(async () => {
      try {
        const res = await schedulerApi.preview(trimmed)
        if (ctrl.signal.aborted) return
        setFetched({ runs: res.next_runs ?? [], loading: false, error: null })
      } catch (e) {
        if (ctrl.signal.aborted) return
        setFetched({ runs: [], loading: false, error: (e as Error).message })
      }
    }, 200)
    return () => {
      ctrl.abort()
      clearTimeout(t)
    }
  }, [trimmed])

  if (!trimmed) return IDLE_PREVIEW
  return fetched
}

function NextRunsPreview({ state }: { state: PreviewState }) {
  const reduce = useReducedMotion()
  if (!state.runs.length && !state.error && !state.loading) return null
  return (
    <div className="mt-3 rounded-lg border border-border bg-muted/40 p-3">
      <p className="mb-1.5 text-xs font-medium text-muted-foreground">
        {state.error ? 'Can’t read that schedule' : 'Next runs'}
      </p>
      {state.error ? (
        <p className="text-xs text-status-error">{state.error}</p>
      ) : state.loading && !state.runs.length ? (
        <p className="text-xs text-muted-foreground">Computing…</p>
      ) : (
        <ol className="flex flex-col gap-1">
          {state.runs.map((iso, i) => (
            <motion.li
              key={iso}
              initial={reduce ? false : { opacity: 0, x: -6 }}
              animate={{ opacity: 1, x: 0 }}
              transition={{ ...springs.smooth, delay: reduce ? 0 : i * 0.03 }}
              className="font-mono text-xs text-foreground"
            >
              {formatFull(iso)}
            </motion.li>
          ))}
        </ol>
      )}
    </div>
  )
}

// One-shot date+time → relative "in <N>m" expression the M8 parser accepts.
function OneShotPicker({ onPick }: { onPick: (expr: string) => void }) {
  const onChange = (v: string) => {
    if (!v) return
    const target = new Date(v)
    if (Number.isNaN(target.getTime())) return
    const mins = Math.max(1, Math.round((target.getTime() - Date.now()) / 60000))
    onPick(`in ${mins}m`)
  }
  return (
    <SubField label="Run at">
      <input
        type="datetime-local"
        onChange={(e) => onChange(e.target.value)}
        className="h-11 w-full rounded-md border border-input bg-transparent px-3 text-base md:text-sm text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      />
    </SubField>
  )
}

// ── small field primitives ────────────────────────────────────────────────────

function Field({
  label,
  children,
}: {
  label: string
  children: React.ReactNode
}) {
  return (
    <label className="flex flex-col gap-1.5">
      <span className="text-xs font-medium text-muted-foreground">{label}</span>
      {children}
    </label>
  )
}

/** A nested label inside a composite control (e.g. inside the composer). */
function SubField({
  label,
  children,
}: {
  label: string
  children: React.ReactNode
}) {
  return (
    <label className="flex flex-col gap-1.5">
      <span className="text-[11px] font-medium text-muted-foreground/80">
        {label}
      </span>
      {children}
    </label>
  )
}

function CheckRow({
  checked,
  onChange,
  label,
}: {
  checked: boolean
  onChange: (c: boolean) => void
  label: string
}) {
  return (
    <button
      type="button"
      role="checkbox"
      aria-checked={checked}
      onClick={() => onChange(!checked)}
      className="flex min-h-11 items-center gap-2.5 text-left text-sm"
    >
      <span
        className={cn(
          'flex size-5 shrink-0 items-center justify-center rounded-md border transition-colors',
          checked
            ? 'border-primary bg-primary text-primary-foreground'
            : 'border-input',
        )}
      >
        {checked && (
          <svg viewBox="0 0 24 24" className="size-3.5" fill="none">
            <path
              d="M5 13l4 4L19 7"
              stroke="currentColor"
              strokeWidth="3"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
        )}
      </span>
      <span className="text-foreground">{label}</span>
    </button>
  )
}
