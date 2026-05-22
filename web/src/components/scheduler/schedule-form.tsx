// ScheduleForm (M21) — the kind/fields/expression body shared by the create
// dialog and the edit sheet. Owns: kind radio, matching field set (boot / tmux /
// shell), the free-text expression input with helper chips + a DEBOUNCED
// next-5-runs preview (POST /api/schedules/preview), one-shot datetime picker,
// optional watch-mode, and a test-fire button. Animations use springs.ts only.

import * as React from 'react'
import { AnimatePresence, motion, useReducedMotion } from 'framer-motion'
import { Clock3, FlaskConical, Loader2, Rocket, Terminal } from 'lucide-react'

import { cn } from '@/lib/utils'
import { springs } from '@/lib/springs'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { useToast } from '@/components/ui/use-toast'
import {
  schedulerApi,
  type ScheduleCreateInput,
  type ScheduleKind,
} from '@/lib/api'
import { useTestFire } from '@/hooks/use-scheduler'
import {
  DONE_ACTIONS,
  EXPR_HELPERS,
  formatFull,
  KIND_LABEL,
  PROVIDERS,
} from './helpers'

export interface ScheduleFormValue {
  title: string
  kind: ScheduleKind
  command: string
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

/** Build the API payload from form state (only the fields the kind needs). */
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
  if (v.kind === 'tmux') base.session = v.session.trim()
  if (v.kind === 'boot') {
    base.boot_dir = v.boot_dir.trim()
    base.boot_provider = v.boot_provider
    base.boot_worktree = v.boot_worktree
  }
  return base
}

/** Client-side validity gate (mirrors the M8 server checks) — drives the
 *  Save + Test-fire enabled states. */
export function isFormValid(v: ScheduleFormValue): boolean {
  if (!v.title.trim() || !v.command.trim() || !v.schedule_expr.trim()) {
    return false
  }
  if (v.kind === 'tmux' && !v.session.trim()) return false
  if (v.kind === 'boot' && !v.boot_dir.trim()) return false
  return true
}

interface ScheduleFormProps {
  value: ScheduleFormValue
  onChange: (next: ScheduleFormValue) => void
  /** Known session names for the tmux target combo (free-text fallback). */
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
              className="h-11 font-mono text-xs"
            />
          </Field>
          <div className="grid grid-cols-2 gap-3">
            <Field label="Provider">
              <select
                value={value.boot_provider}
                onChange={(e) => set('boot_provider', e.target.value)}
                className="h-11 w-full rounded-md border border-input bg-transparent px-3 text-sm"
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
            <Input
              value={value.command}
              onChange={(e) => set('command', e.target.value)}
              placeholder="/cso"
              className="h-11 font-mono text-xs"
            />
          </Field>
        </>
      )}

      {value.kind === 'tmux' && (
        <>
          <Field label="Target session">
            <Input
              list="sched-sessions"
              value={value.session}
              onChange={(e) => set('session', e.target.value)}
              placeholder="my-agent"
              className="h-11 font-mono text-xs"
            />
            <datalist id="sched-sessions">
              {sessions.map((s) => (
                <option key={s} value={s} />
              ))}
            </datalist>
          </Field>
          <Field label="Text to send">
            <Input
              value={value.command}
              onChange={(e) => set('command', e.target.value)}
              placeholder="/status"
              className="h-11 font-mono text-xs"
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
            className="h-11 font-mono text-xs"
          />
        </Field>
      )}

      {/* Expression + helpers + preview */}
      <Field label="When">
        <Input
          value={value.schedule_expr}
          onChange={(e) => set('schedule_expr', e.target.value)}
          placeholder="every weekday at 9am"
          className="h-11"
        />
        <div className="mt-2 flex flex-wrap gap-1.5">
          {EXPR_HELPERS.map((h) => (
            <button
              key={h.label}
              type="button"
              onClick={() => set('schedule_expr', h.expr)}
              className="rounded-full border border-border px-2.5 py-1 text-xs text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
            >
              {h.label}
            </button>
          ))}
        </div>
        {/* One-shot datetime → "in <N>m" relative expression. */}
        <OneShotPicker onPick={(expr) => set('schedule_expr', expr)} />
        <NextRunsPreview state={preview} />
      </Field>

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
                    className="h-11 font-mono text-xs"
                  />
                </Field>
                <Field label="On match">
                  <select
                    value={value.done_action}
                    onChange={(e) => set('done_action', e.target.value)}
                    className="h-11 w-full rounded-md border border-input bg-transparent px-3 text-sm"
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
    <details className="mt-2 text-xs text-muted-foreground">
      <summary className="cursor-pointer select-none">
        Or pick a one-shot date + time
      </summary>
      <input
        type="datetime-local"
        onChange={(e) => onChange(e.target.value)}
        className="mt-2 h-11 w-full rounded-md border border-input bg-transparent px-3 text-sm text-foreground"
      />
    </details>
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
