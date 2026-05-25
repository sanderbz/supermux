import * as React from 'react'
import { motion } from 'framer-motion'
import { FileText, ShieldCheck, Loader2, Sparkles } from 'lucide-react'

import { cn } from '@/lib/utils'
import { springs } from '@/lib/springs'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { ResponsiveSheet } from '@/components/ui/responsive-sheet'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { sessionsApi, SessionError, type NewSession } from '@/lib/api'
import { homeDir } from '@/env'

// ── Quick-start preset boot configs (M12 acceptance) ────────────────────────
// Each preset prefills the whole form: a name stem, a provider, and the initial
// prompt (`command`) that boots the agent into the right role. The user can
// still edit anything in the Advanced tab before submitting.

interface Preset {
  id: string
  label: string
  hint: string
  icon: React.ComponentType<{ className?: string }>
  provider: NewSession['provider']
  /** Initial prompt sent to the agent after boot. Empty = a blank session. */
  command: string
  nameStem: string
}

const PRESETS: Preset[] = [
  {
    id: 'blank-claude',
    label: 'Blank Claude',
    hint: 'A fresh agent in this directory.',
    icon: Sparkles,
    provider: 'claude',
    command: '',
    nameStem: 'claude',
  },
  {
    id: 'code-reviewer',
    label: 'Code reviewer',
    hint: 'Reviews the working tree and flags issues.',
    icon: ShieldCheck,
    provider: 'claude',
    command:
      'Review the current working tree. Summarise risky changes, missing tests, and anything I should fix before I ship.',
    nameStem: 'reviewer',
  },
  {
    id: 'doc-writer',
    label: 'Doc writer',
    hint: 'Drafts and updates docs for this repo.',
    icon: FileText,
    provider: 'claude',
    command:
      'Read this repository and draft or update its documentation. Start with a short summary of what you find, then propose what to write.',
    nameStem: 'docs',
  },
]

function suggestName(stem: string): string {
  // Short, URL/tmux-safe suffix so two presets don't collide.
  const suffix = Math.random().toString(36).slice(2, 6)
  return `${stem}-${suffix}`
}

interface FormState {
  name: string
  dir: string
  provider: NonNullable<NewSession['provider']>
  desc: string
  command: string
  worktree: boolean
}

const EMPTY_FORM = (defaultDir: string): FormState => ({
  name: '',
  dir: defaultDir,
  provider: 'claude',
  desc: '',
  command: '',
  worktree: false,
})

export interface NewSessionSheetProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** Pre-filled working directory (§4.11: "pre-filled with cwd + provider=
   *  claude"). When omitted it falls back to the server's home directory
   *  (`window._SUPERMUX_HOME_DIR`) so a session can be created in one click. */
  defaultDir?: string
  /** Called after a successful create with the new session's name so the route
   *  can navigate to `/focus/{name}`. */
  onCreated: (name: string) => void
}

/** The boot affordance (§M12). Two tabs: "Quick start" (3 preset boot configs)
 *  and "Advanced" (full fields). On submit it POSTs `/api/sessions` + boots,
 *  then hands the new name to the route to navigate into focus.
 *
 *  The form lives in an inner component remounted (via `key`) each time the
 *  sheet opens, so its state initializes fresh from `defaultDir` — no reset
 *  effect, no synchronous setState-in-effect. */
export function NewSessionSheet({
  open,
  onOpenChange,
  defaultDir,
  onCreated,
}: NewSessionSheetProps) {
  // Fall back to the server's home directory so the working-directory field is
  // always pre-filled — the user can create a session in one click, no typing.
  const initialDir = defaultDir ?? homeDir()
  // The shared iOS bottom-sheet (ResponsiveSheet): Vaul drag-detent sheet on
  // touch — grab-handle + swipe-down/backdrop-tap dismiss, NO ✕ — and the
  // right-side dialog on desktop, matching every other sheet in the app
  // (claude-tools, board card editor, scheduler). The inner form only mounts
  // while the sheet is open, so it starts fresh from `defaultDir` each time —
  // no reset effect needed.
  return (
    <ResponsiveSheet
      open={open}
      onOpenChange={onOpenChange}
      title="New session"
      description="Boot an agent in tmux. It survives restarts."
    >
      {open && (
        <NewSessionForm
          defaultDir={initialDir}
          onCancel={() => onOpenChange(false)}
          onCreated={(name) => {
            onOpenChange(false)
            onCreated(name)
          }}
        />
      )}
    </ResponsiveSheet>
  )
}

interface NewSessionFormProps {
  defaultDir: string
  onCancel: () => void
  onCreated: (name: string) => void
}

function NewSessionForm({ defaultDir, onCancel, onCreated }: NewSessionFormProps) {
  const [tab, setTab] = React.useState('quick')
  const [form, setForm] = React.useState<FormState>(() => EMPTY_FORM(defaultDir))
  const [dirSuggestions, setDirSuggestions] = React.useState<string[]>([])
  const [submitting, setSubmitting] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)

  const set = <K extends keyof FormState>(key: K, value: FormState[K]) =>
    setForm((f) => ({ ...f, [key]: value }))

  // Directory typeahead (debounced) against the M7 autocomplete endpoint.
  const dirDebounce = React.useRef<ReturnType<typeof setTimeout> | null>(null)
  const onDirChange = (value: string) => {
    set('dir', value)
    if (dirDebounce.current) clearTimeout(dirDebounce.current)
    dirDebounce.current = setTimeout(async () => {
      if (!value.trim()) return setDirSuggestions([])
      setDirSuggestions(await sessionsApi.autocompleteDir(value))
    }, 200)
  }

  const applyPreset = (preset: Preset) => {
    setForm((f) => ({
      ...f,
      name: f.name || suggestName(preset.nameStem),
      provider: preset.provider ?? 'claude',
      command: preset.command,
      desc: f.desc || preset.label,
    }))
    setTab('advanced')
  }

  // A blank directory must NOT block creation: the server defaults an empty/
  // omitted `dir` to the home directory. Only the name is truly required.
  const canSubmit = form.name.trim().length > 0

  const submit = async (e?: React.FormEvent) => {
    e?.preventDefault()
    if (!canSubmit || submitting) return
    setSubmitting(true)
    setError(null)
    try {
      const created = await sessionsApi.create({
        name: form.name.trim(),
        dir: form.dir.trim(),
        provider: form.provider,
        desc: form.desc.trim() || undefined,
        worktree: form.worktree,
        command: form.command.trim() || undefined,
      })
      const name = created?.name ?? form.name.trim()
      // Boot tmux + send the initial prompt. Non-fatal — the row exists either
      // way; focus can retry the start.
      try {
        await sessionsApi.start(name, form.command.trim() || undefined)
      } catch {
        /* ignore — session created, start retryable from focus */
      }
      onCreated(name)
    } catch (err) {
      if (err instanceof SessionError && err.status === 409) {
        setError(`A session named “${form.name.trim()}” already exists.`)
      } else if (err instanceof SessionError && err.status === 0) {
        setError('Can’t reach supermux-server. Check it’s running, then try again.')
      } else {
        setError(
          err instanceof Error ? err.message : 'Could not create the session.',
        )
      }
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <Tabs value={tab} onValueChange={setTab} className="flex-1">
          <div className="px-6 pt-4">
            <TabsList className="grid w-full grid-cols-2">
              <TabsTrigger value="quick">Quick start</TabsTrigger>
              <TabsTrigger value="advanced">Advanced</TabsTrigger>
            </TabsList>
          </div>

          {/* ── Quick start: 3 preset boot configs ──────────────────────── */}
          <TabsContent value="quick" className="mt-0 px-6 pb-6 pt-4">
            <div className="flex flex-col gap-2">
              {PRESETS.map((preset) => (
                <motion.button
                  key={preset.id}
                  type="button"
                  whileTap={{ scale: 0.98 }}
                  transition={springs.buttonPress}
                  onClick={() => applyPreset(preset)}
                  className="flex min-h-14 items-center gap-3 rounded-xl border border-border bg-card px-4 py-3 text-left outline-none hover:bg-accent/40 focus-visible:ring-2 focus-visible:ring-ring"
                >
                  <span className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-muted text-muted-foreground [&_svg]:size-4">
                    <preset.icon />
                  </span>
                  <span className="flex min-w-0 flex-col">
                    <span className="text-sm font-medium">{preset.label}</span>
                    <span className="truncate text-xs text-muted-foreground">
                      {preset.hint}
                    </span>
                  </span>
                </motion.button>
              ))}
            </div>
            <p className="mt-4 text-xs text-muted-foreground">
              Pick one to prefill the form, then review the directory in
              Advanced.
            </p>
          </TabsContent>

          {/* ── Advanced: full field set ────────────────────────────────── */}
          <TabsContent value="advanced" className="mt-0 px-6 pb-6 pt-4">
            <form onSubmit={submit} className="flex flex-col gap-4">
              <Field label="Name" htmlFor="ns-name">
                <Input
                  id="ns-name"
                  value={form.name}
                  onChange={(e) => set('name', e.target.value)}
                  placeholder="my-agent"
                  autoComplete="off"
                  spellCheck={false}
                />
              </Field>

              <Field
                label="Directory"
                htmlFor="ns-dir"
                hint="Where the agent runs. Defaults to your home directory."
              >
                <Input
                  id="ns-dir"
                  value={form.dir}
                  onChange={(e) => onDirChange(e.target.value)}
                  placeholder="~/projects/app"
                  autoComplete="off"
                  spellCheck={false}
                  list="ns-dir-suggestions"
                />
                {dirSuggestions.length > 0 && (
                  <datalist id="ns-dir-suggestions">
                    {dirSuggestions.map((d) => (
                      <option key={d} value={d} />
                    ))}
                  </datalist>
                )}
              </Field>

              <Field label="Description" htmlFor="ns-desc">
                <Input
                  id="ns-desc"
                  value={form.desc}
                  onChange={(e) => set('desc', e.target.value)}
                  placeholder="What this agent is for (optional)"
                  autoComplete="off"
                />
              </Field>

              <fieldset className="flex flex-col gap-2">
                <legend className="mb-1 text-sm font-medium">Provider</legend>
                <div className="flex gap-2">
                  {(['claude', 'codex', 'shell'] as const).map((p) => (
                    <button
                      key={p}
                      type="button"
                      onClick={() => set('provider', p)}
                      aria-pressed={form.provider === p}
                      className={cn(
                        'min-h-11 flex-1 rounded-lg border px-3 text-sm capitalize transition-colors',
                        form.provider === p
                          ? 'border-primary bg-primary/10 text-foreground'
                          : 'border-border text-muted-foreground hover:bg-accent/40',
                      )}
                    >
                      {p}
                    </button>
                  ))}
                </div>
              </fieldset>

              {form.command && (
                <Field label="Initial prompt" htmlFor="ns-cmd">
                  <textarea
                    id="ns-cmd"
                    value={form.command}
                    onChange={(e) => set('command', e.target.value)}
                    rows={3}
                    className="w-full rounded-md border border-input bg-transparent px-3 py-2 text-base md:text-sm shadow-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  />
                </Field>
              )}

              <label className="flex min-h-11 cursor-pointer items-center gap-3 rounded-lg border border-border px-3">
                <input
                  type="checkbox"
                  checked={form.worktree}
                  onChange={(e) => set('worktree', e.target.checked)}
                  className="size-4 accent-[hsl(var(--primary))]"
                />
                <span className="flex flex-col">
                  <span className="text-sm font-medium">Isolated worktree</span>
                  <span className="text-xs text-muted-foreground">
                    Run in a fresh git worktree so it can&rsquo;t touch your tree.
                  </span>
                </span>
              </label>

              {error && (
                <p
                  role="alert"
                  className="rounded-md border border-status-error/40 bg-status-error/10 px-3 py-2 text-sm text-status-error"
                >
                  {error}
                </p>
              )}

              <div className="flex gap-2 pt-2">
                <Button
                  type="button"
                  variant="ghost"
                  className="flex-1"
                  onClick={onCancel}
                >
                  Cancel
                </Button>
                <Button type="submit" className="flex-1" disabled={!canSubmit || submitting}>
                  {submitting && <Loader2 className="animate-spin" />}
                  {submitting ? 'Booting…' : 'Boot agent'}
                </Button>
              </div>
            </form>
          </TabsContent>
    </Tabs>
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
