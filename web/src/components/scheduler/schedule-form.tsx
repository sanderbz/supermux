// ScheduleForm — the kind/fields/expression body shared by the create + edit
// surfaces (both host it in the same right-side Sheet). Owns: kind toggle
// (Prompt session / Boot session / Shell job), per-kind fields, the combined
// `PromptField` (one textarea with inline slash autocomplete — the old
// CommandPicker + PromptArea fused into one), a real session picker (select
// over the live sessions list) for tmux, the recurrence composer with a live
// English render + debounced next-5-runs preview (POST /api/schedules/preview),
// a one-shot datetime picker, an opt-in "Send me notification when done"
// checkbox (the M8 watch + done_action='notify' path with a friendlier label
// and dynamic permission hint), and the test-fire button.
//
// Animations come from springs.ts (no `transition: all`). Default kind is the
// most common case — `tmux` (Prompt session) — so the user lands on the
// minimum-typing flow.

import * as React from 'react'
import { AnimatePresence, motion } from 'framer-motion'
import {
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
  SessionPicker,
  type SessionPickerOption,
} from '@/components/session/session-picker'
import {
  schedulerApi,
  type ScheduleCreateInput,
  type ScheduleKind,
} from '@/lib/api'
import { useSchedulerCommands, useTestFire } from '@/hooks/use-scheduler'
import { usePush } from '@/hooks/use-push'
import {
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
import {
  mergeCommandAndPrompt,
  PromptField,
  splitCommandAndPrompt,
} from './prompt-field'

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
  /** "Send me notification when done" → maps to watch=true + done_action=notify. */
  notify: boolean
  /** Optional regex; empty = the server's default done marker. */
  done_pattern: string
  /** tmux + notify only: append a completion-call footer so the agent confirms
   *  it's done itself (most reliable). Idle detection stays the fallback. */
  confirm_finish: boolean
}

export const EMPTY_FORM: ScheduleFormValue = {
  title: '',
  // Default is the simplest, most-common path — Prompt session — so the user
  // hits the minimum number of required fields on first open.
  kind: 'tmux',
  command: '',
  prompt: '',
  schedule_expr: '',
  session: '',
  boot_dir: '',
  boot_provider: 'claude',
  boot_worktree: false,
  notify: false,
  done_pattern: '',
  // Pre-ticked: when the user turns on notify for a Claude/tmux job, the
  // most-reliable agent-confirmed finish is on by default (they still see it and
  // can untick). Only ever sent for tmux + notify (see toCreateInput).
  confirm_finish: true,
}

const KIND_ICON: Record<ScheduleKind, React.ReactNode> = {
  boot: <Rocket className="size-4" />,
  tmux: <Terminal className="size-4" />,
  shell: <Clock3 className="size-4" />,
}

const KINDS: ScheduleKind[] = ['tmux', 'boot', 'shell']

/** Build the API payload from form state (only the fields the kind needs). The
 *  combined PromptField text is split into `command` + `prompt` at the wire
 *  boundary so the M8 schema stays unchanged. Shell jobs run the command text
 *  literally so a prompt has no meaning there. The notify checkbox serializes
 *  to the M8 `watch=true` + `done_action='notify'` path. */
export function toCreateInput(v: ScheduleFormValue): ScheduleCreateInput {
  const base: ScheduleCreateInput = {
    title: v.title.trim(),
    kind: v.kind,
    command: v.command.trim(),
    schedule_expr: v.schedule_expr.trim(),
    watch: v.notify,
    done_pattern: v.notify ? v.done_pattern.trim() || undefined : undefined,
    done_action: v.notify ? 'notify' : undefined,
    // Agent-confirmed finish only applies to a Claude/tmux job that wants a
    // notification. The server also clamps it to tmux, but gate here too so the
    // wire payload is honest for shell/boot jobs.
    confirm_finish:
      v.kind === 'tmux' && v.notify ? v.confirm_finish : undefined,
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
  /** Known sessions for the tmux target picker (carries display_name). */
  sessions: SessionPickerOption[]
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

  // The combined "type-anything" field holds `/cmd then prompt` as one string.
  // The form's stored shape stays split (`command` + `prompt`) so the API call
  // doesn't have to know about the merge — but we keep the RAW merged text as
  // a separate piece of state so the user's keystrokes (especially spaces!)
  // never round-trip through the lossy split → merge pair. Earlier versions
  // re-derived the merged value from `command`+`prompt` on every change, which
  // stripped trailing spaces, multi-spaces, and the command/prompt separator
  // — making it physically impossible to type a space in the Prompt field.
  // Seed once from props (initial value), then own the string locally; re-seed
  // when the upstream split values change for a reason OTHER than our own
  // edit (e.g. the editor swaps to a different schedule).
  const lastSplitRef = React.useRef({ command: value.command, prompt: value.prompt })
  const [mergedPrompt, setMergedPromptState] = React.useState(() =>
    mergeCommandAndPrompt(value.command, value.prompt),
  )
  React.useEffect(() => {
    // If `command`/`prompt` changed from outside this component (not from our
    // setMergedPrompt below), re-seed the merged buffer.
    if (
      value.command !== lastSplitRef.current.command ||
      value.prompt !== lastSplitRef.current.prompt
    ) {
      lastSplitRef.current = { command: value.command, prompt: value.prompt }
      setMergedPromptState(mergeCommandAndPrompt(value.command, value.prompt))
    }
  }, [value.command, value.prompt])
  const setMergedPrompt = (next: string) => {
    setMergedPromptState(next)
    const split = splitCommandAndPrompt(next)
    lastSplitRef.current = { command: split.command, prompt: split.prompt }
    onChange({ ...value, command: split.command, prompt: split.prompt })
  }

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

      {/* Kind toggle — Prompt session is the most-common case + default. */}
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

      {/* Kind-specific fields. The combined PromptField replaces the old
          CommandPicker + PromptArea pair: one textarea, type `/` for the
          autocomplete, type anything else for a free-text prompt. */}
      {value.kind === 'tmux' && (
        <>
          <Field label="Target session">
            <SessionPicker
              value={value.session}
              onChange={(v) => set('session', v)}
              sessions={sessions}
              allowEmpty={false}
              ariaLabel="Target session"
              menuLabel="Target session"
              placeholder={
                sessions.length ? 'Choose a session…' : 'No live sessions'
              }
            />
          </Field>
          <Field label="Prompt">
            <PromptField
              value={mergedPrompt}
              onChange={setMergedPrompt}
              commands={commands.data ?? []}
              loading={commands.isLoading}
              placeholder="Type a prompt — or start with /command for one of your installed skills."
            />
          </Field>
        </>
      )}

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
          <Field label="Prompt">
            <PromptField
              value={mergedPrompt}
              onChange={setMergedPrompt}
              commands={commands.data ?? []}
              loading={commands.isLoading}
              placeholder="Type the boot prompt — or start with /command for one of your installed skills."
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

      {/* Notification opt-in (top-level, friendlier than the old "watch mode"
          jargon). Maps to M8 watch + done_action='notify'. The hint surfaces
          the live Notification.permission + push subscription state so the
          user knows whether the ping will actually reach them. */}
      <NotifyField value={value} set={set} />

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

// ── notify checkbox (top-level "send me notification when done") ────────────────

function NotifyField({
  value,
  set,
}: {
  value: ScheduleFormValue
  set: <K extends keyof ScheduleFormValue>(
    key: K,
    v: ScheduleFormValue[K],
  ) => void
}) {
  const push = usePush()
  // Surface the live permission + subscription state so the hint is accurate
  // rather than a generic "remember to enable it" line.
  const hint = React.useMemo(() => {
    switch (push.state) {
      case 'enabled':
        return 'Currently enabled on this device.'
      case 'disabled':
        return 'Enable phone notifications in Settings → Notifications to actually receive these.'
      case 'blocked':
        return 'Notifications are blocked for this site — allow them in your browser settings first.'
      case 'unsupported':
        return 'This device can’t deliver push notifications (iOS needs the PWA installed to the home screen).'
      default:
        return 'Requires notifications enabled in Settings + browser/PWA permission.'
    }
  }, [push.state])

  return (
    <Field label="When it finishes">
      <CheckRow
        checked={value.notify}
        onChange={(c) => set('notify', c)}
        label="Send me notification"
      />
      <p className="mt-1.5 text-xs text-muted-foreground">{hint}</p>
      <AnimatePresence initial={false}>
        {value.notify && (
          <motion.div
            initial={{ opacity: 0, height: 0 }}
            animate={{ opacity: 1, height: 'auto' }}
            exit={{ opacity: 0, height: 0 }}
            transition={springs.cardExpand}
            className="overflow-hidden"
          >
            {/* Agent-confirmed finish — Claude/tmux jobs only. Pre-ticked: the
                agent declares "done" itself (reliable) instead of us guessing
                from idle. We append one delimited instruction to the prompt and
                show it verbatim below so nothing is hidden. */}
            {value.kind === 'tmux' && (
              <div className="mt-3">
                <CheckRow
                  checked={value.confirm_finish}
                  onChange={(c) => set('confirm_finish', c)}
                  label="Ask the agent to confirm when done (most reliable)"
                />
                <p className="mt-1.5 text-xs text-muted-foreground">
                  {value.confirm_finish
                    ? 'The agent signals completion itself when the work is truly done — idle detection is the fallback.'
                    : 'We’ll notify when the agent next goes idle (a good guess, but idle ≠ task complete).'}
                </p>
                <AnimatePresence initial={false}>
                  {value.confirm_finish && (
                    <motion.div
                      initial={{ opacity: 0, height: 0 }}
                      animate={{ opacity: 1, height: 'auto' }}
                      exit={{ opacity: 0, height: 0 }}
                      transition={springs.cardExpand}
                      className="overflow-hidden"
                    >
                      <p className="mt-2.5 text-[11px] font-medium text-muted-foreground/80">
                        Appended to your prompt:
                      </p>
                      <pre className="mt-1 overflow-x-auto rounded-md border border-border bg-muted/40 p-2.5 font-mono text-[11px] leading-relaxed text-muted-foreground">
{`— — —
When this scheduled task is FULLY complete (not before),
signal completion so I'm notified — run exactly:
curl -fsS -H "X-Supermux-Hook-Token: $SUPERMUX_HOOK_TOKEN" \\
  "$SUPERMUX_URL/api/hook/schedule/done" \\
  -d '{"session":"…","schedule_id":"SCHED-…"}'`}
                      </pre>
                    </motion.div>
                  )}
                </AnimatePresence>
              </div>
            )}

            <div className="mt-3">
              <SubField label="Done pattern (optional regex)">
                <Input
                  value={value.done_pattern}
                  onChange={(e) => set('done_pattern', e.target.value)}
                  placeholder="✓ done"
                  className="h-11 font-mono text-base md:text-xs"
                />
              </SubField>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </Field>
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
  const [draft, setDraft] = React.useState<RecurrenceDraft>(() =>
    expr.trim() ? exprToRecurrence(expr) : { ...EMPTY_RECURRENCE },
  )
  const [seededFrom, setSeededFrom] = React.useState(expr)
  if (expr !== seededFrom && expr.trim() && draft.frequency === 'custom') {
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

// ── preview hook (debounced 200ms POST /preview — no polling) ──────────────────

interface PreviewState {
  runs: string[]
  loading: boolean
  error: string | null
}

const IDLE_PREVIEW: PreviewState = { runs: [], loading: false, error: null }

function useExpressionPreview(expr: string): PreviewState {
  const [fetched, setFetched] = React.useState<PreviewState>(IDLE_PREVIEW)
  const trimmed = expr.trim()

  React.useEffect(() => {
    if (!trimmed) return
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
          {state.runs.map((iso) => (
            <li key={iso} className="font-mono text-xs text-foreground">
              {formatFull(iso)}
            </li>
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
