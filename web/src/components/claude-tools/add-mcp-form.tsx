// AddMcpForm — add an MCP server, two ways (skills-mcp-manager plan §C.3):
//   • Guided form (default): name · transport (stdio/http/sse segmented) · then
//     command + args + env key/value pairs (stdio) OR url + header pairs
//     (http/sse). Env/header VALUES are write-only inputs — never echoed back.
//   • Raw JSON: paste an `add-json`-shaped `{ "<name>": { … } }` or a bare
//     server-config blob; validated client-side before send (server re-validates).
//
// Scope picker defaults to local/user — NEVER project implicitly. Choosing the
// git-tracked project `.mcp.json` reveals a LOUD inline warning and sends
// `confirm_project_write: true`. After a successful add we surface the
// restart-needed nudge via the parent's `onAdded` callback.
//
// VISUAL: house style — ≥44pt targets, sentence-case copy, spring button press,
// design tokens, reduced-motion safe (framer-motion `whileTap` only).

import * as React from 'react'
import { motion } from 'framer-motion'
import { AlertTriangle, Loader2, Plus, Trash2 } from 'lucide-react'

import { cn } from '@/lib/utils'
import { springs } from '@/lib/springs'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { useAddMcp } from '@/hooks/use-claude-tools'
import { ApiError } from '@/lib/api/client'
import type { AddMcpInput, McpScope, McpTransport } from '@/lib/api/claude'

type ScopeChoice = 'local' | 'user' | 'project'

interface KeyVal {
  id: number
  key: string
  value: string
}

let kvSeq = 0
const newKv = (): KeyVal => ({ id: ++kvSeq, key: '', value: '' })

export interface AddMcpFormProps {
  /** Focused session working dir — enables the "This project" scope choices. */
  cwd?: string
  /** Back to the list (after add, or cancel). */
  onCancel: () => void
  /** Called after a successful add with the server name (parent shows restart). */
  onAdded: (name: string) => void
}

export function AddMcpForm({ cwd, onCancel, onAdded }: AddMcpFormProps) {
  const [mode, setMode] = React.useState<'guided' | 'json'>('guided')
  return (
    <div className="px-4 py-3 sm:px-5">
      <Tabs value={mode} onValueChange={(v) => setMode(v as 'guided' | 'json')}>
        <TabsList className="grid w-full grid-cols-2">
          <TabsTrigger value="guided">Guided</TabsTrigger>
          <TabsTrigger value="json">Paste JSON</TabsTrigger>
        </TabsList>
        <TabsContent value="guided" className="mt-4">
          <GuidedForm cwd={cwd} onCancel={onCancel} onAdded={onAdded} />
        </TabsContent>
        <TabsContent value="json" className="mt-4">
          <JsonForm cwd={cwd} onCancel={onCancel} onAdded={onAdded} />
        </TabsContent>
      </Tabs>
    </div>
  )
}

// ── shared bits ───────────────────────────────────────────────────────────────

function ScopePicker({
  cwd,
  value,
  onChange,
}: {
  cwd?: string
  value: ScopeChoice
  onChange: (s: ScopeChoice) => void
}) {
  const options: { value: ScopeChoice; label: string; hint: string; show: boolean }[] = [
    { value: 'local', label: 'This project', hint: 'Private to you', show: !!cwd },
    { value: 'user', label: 'Global', hint: 'All projects', show: true },
    { value: 'project', label: 'Committed', hint: '.mcp.json (shared)', show: !!cwd },
  ]
  return (
    <Field label="Scope" hint="Defaults to private. Committed is shared in git.">
      <div className="flex flex-col gap-2 sm:flex-row">
        {options
          .filter((o) => o.show)
          .map((o) => {
            const active = o.value === value
            return (
              <button
                key={o.value}
                type="button"
                onClick={() => onChange(o.value)}
                aria-pressed={active}
                className={cn(
                  'flex min-h-11 flex-1 flex-col items-start justify-center rounded-lg border px-3 py-1.5 text-left transition-colors',
                  active
                    ? o.value === 'project'
                      ? 'border-destructive bg-destructive/10 text-foreground'
                      : 'border-primary bg-primary/10 text-foreground'
                    : 'border-border text-muted-foreground hover:bg-accent/40',
                )}
              >
                <span className="text-[13px] font-medium leading-tight">
                  {o.label}
                </span>
                <span className="text-[11px] leading-tight text-muted-foreground">
                  {o.hint}
                </span>
              </button>
            )
          })}
      </div>
    </Field>
  )
}

function ProjectWarning() {
  return (
    <div
      role="alert"
      className="flex gap-2.5 rounded-lg border border-destructive/40 bg-destructive/10 px-3 py-2.5"
    >
      <AlertTriangle className="mt-0.5 size-4 shrink-0 text-destructive" aria-hidden />
      <p className="text-[12px] leading-snug text-foreground">
        <span className="font-medium">.mcp.json is committed to git.</span> Its
        env values would be shared with everyone who clones the repo. Prefer “This
        project” or “Global” for anything with secrets.
      </p>
    </div>
  )
}

function ErrorNote({ message }: { message: string }) {
  return (
    <p
      role="alert"
      className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-[13px] text-destructive"
    >
      {message}
    </p>
  )
}

function FormActions({
  submitting,
  canSubmit,
  onCancel,
}: {
  submitting: boolean
  canSubmit: boolean
  onCancel: () => void
}) {
  return (
    <div className="flex gap-2 pt-1">
      <Button type="button" variant="ghost" className="h-11 flex-1" onClick={onCancel}>
        Cancel
      </Button>
      <Button asChild type="submit" className="h-11 flex-1" disabled={!canSubmit || submitting}>
        <motion.button whileTap={{ scale: 0.97 }} transition={springs.buttonPress}>
          {submitting ? (
            <Loader2 className="animate-spin" />
          ) : (
            <Plus />
          )}
          {submitting ? 'Adding…' : 'Add server'}
        </motion.button>
      </Button>
    </div>
  )
}

function addErrorMessage(err: unknown): string {
  if (err instanceof ApiError) {
    if (err.status === 0) {
      return 'Can’t reach supermux-server. Check it’s running, then try again.'
    }
    return err.message || 'Could not add the server.'
  }
  return err instanceof Error ? err.message : 'Could not add the server.'
}

/** Map the scope CHOICE to the wire scope + confirm flag. `local`/`project`
 *  carry the cwd; `user` is global. */
function scopeWire(choice: ScopeChoice): {
  scope: McpScope
  confirm: boolean
} {
  if (choice === 'user') return { scope: 'user', confirm: false }
  if (choice === 'project') return { scope: 'project', confirm: true }
  return { scope: 'local', confirm: false }
}

// ── guided form ───────────────────────────────────────────────────────────────

function GuidedForm({ cwd, onCancel, onAdded }: AddMcpFormProps) {
  const add = useAddMcp()
  const [name, setName] = React.useState('')
  const [transport, setTransport] = React.useState<McpTransport>('stdio')
  const [scope, setScope] = React.useState<ScopeChoice>(cwd ? 'local' : 'user')
  const [command, setCommand] = React.useState('')
  const [args, setArgs] = React.useState('')
  const [url, setUrl] = React.useState('')
  const [pairs, setPairs] = React.useState<KeyVal[]>([newKv()])
  const [error, setError] = React.useState<string | null>(null)

  const isStdio = transport === 'stdio'
  const trimmedName = name.trim()
  const canSubmit =
    trimmedName.length > 0 && (isStdio ? command.trim().length > 0 : url.trim().length > 0)

  const setPair = (id: number, patch: Partial<KeyVal>) =>
    setPairs((p) => p.map((kv) => (kv.id === id ? { ...kv, ...patch } : kv)))
  const addPair = () => setPairs((p) => [...p, newKv()])
  const removePair = (id: number) =>
    setPairs((p) => (p.length === 1 ? [newKv()] : p.filter((kv) => kv.id !== id)))

  const collectPairs = (): Record<string, string> => {
    const out: Record<string, string> = {}
    for (const kv of pairs) {
      const k = kv.key.trim()
      if (k) out[k] = kv.value
    }
    return out
  }

  const submit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!canSubmit || add.isPending) return
    setError(null)
    const { scope: wireScope, confirm } = scopeWire(scope)
    const input: AddMcpInput = {
      name: trimmedName,
      scope: wireScope,
      cwd: wireScope === 'user' ? undefined : cwd,
      transport,
      confirm_project_write: confirm || undefined,
    }
    if (isStdio) {
      input.command = command.trim()
      const list = args
        .split(/\s+/)
        .map((a) => a.trim())
        .filter(Boolean)
      if (list.length) input.args = list
      const env = collectPairs()
      if (Object.keys(env).length) input.env = env
    } else {
      input.url = url.trim()
      const headers = collectPairs()
      if (Object.keys(headers).length) input.headers = headers
    }
    try {
      await add.mutateAsync(input)
      onAdded(trimmedName)
    } catch (err) {
      setError(addErrorMessage(err))
    }
  }

  return (
    <form onSubmit={submit} className="flex flex-col gap-4">
      <Field label="Name">
        <Input
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="my-server"
          autoComplete="off"
          spellCheck={false}
          className="h-11 font-mono"
        />
      </Field>

      <Field label="Transport">
        <div className="flex gap-2">
          {(['stdio', 'http', 'sse'] as const).map((t) => (
            <button
              key={t}
              type="button"
              onClick={() => setTransport(t)}
              aria-pressed={transport === t}
              className={cn(
                'min-h-11 flex-1 rounded-lg border px-3 text-[13px] font-medium uppercase tracking-wide transition-colors',
                transport === t
                  ? 'border-primary bg-primary/10 text-foreground'
                  : 'border-border text-muted-foreground hover:bg-accent/40',
              )}
            >
              {t}
            </button>
          ))}
        </div>
      </Field>

      {isStdio ? (
        <>
          <Field label="Command">
            <Input
              value={command}
              onChange={(e) => setCommand(e.target.value)}
              placeholder="npx"
              autoComplete="off"
              spellCheck={false}
              className="h-11 font-mono"
            />
          </Field>
          <Field label="Arguments" hint="Space-separated.">
            <Input
              value={args}
              onChange={(e) => setArgs(e.target.value)}
              placeholder="-y some-mcp@latest"
              autoComplete="off"
              spellCheck={false}
              className="h-11 font-mono"
            />
          </Field>
          <PairEditor
            title="Environment"
            hint="Values are write-only — never shown after saving."
            keyPlaceholder="API_KEY"
            valuePlaceholder="secret value"
            pairs={pairs}
            onSet={setPair}
            onAdd={addPair}
            onRemove={removePair}
          />
        </>
      ) : (
        <>
          <Field label="URL">
            <Input
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              placeholder="https://example.com/mcp"
              autoComplete="off"
              spellCheck={false}
              className="h-11 font-mono"
            />
          </Field>
          <PairEditor
            title="Headers"
            hint="Values are write-only — never shown after saving."
            keyPlaceholder="Authorization"
            valuePlaceholder="Bearer …"
            pairs={pairs}
            onSet={setPair}
            onAdd={addPair}
            onRemove={removePair}
          />
        </>
      )}

      <ScopePicker cwd={cwd} value={scope} onChange={setScope} />
      {scope === 'project' && <ProjectWarning />}
      {error && <ErrorNote message={error} />}
      <FormActions submitting={add.isPending} canSubmit={canSubmit} onCancel={onCancel} />
    </form>
  )
}

function PairEditor({
  title,
  hint,
  keyPlaceholder,
  valuePlaceholder,
  pairs,
  onSet,
  onAdd,
  onRemove,
}: {
  title: string
  hint: string
  keyPlaceholder: string
  valuePlaceholder: string
  pairs: KeyVal[]
  onSet: (id: number, patch: Partial<KeyVal>) => void
  onAdd: () => void
  onRemove: (id: number) => void
}) {
  return (
    <div className="flex flex-col gap-1.5">
      <span className="text-[13px] font-medium text-foreground">{title}</span>
      <p className="text-[12px] leading-snug text-muted-foreground">{hint}</p>
      <div className="mt-1 flex flex-col gap-2">
        {pairs.map((kv) => (
          <div key={kv.id} className="flex items-center gap-2">
            <Input
              value={kv.key}
              onChange={(e) => onSet(kv.id, { key: e.target.value })}
              placeholder={keyPlaceholder}
              autoComplete="off"
              spellCheck={false}
              className="h-11 min-w-0 flex-1 font-mono text-[13px]"
            />
            <Input
              type="password"
              value={kv.value}
              onChange={(e) => onSet(kv.id, { value: e.target.value })}
              placeholder={valuePlaceholder}
              autoComplete="off"
              spellCheck={false}
              className="h-11 min-w-0 flex-1 font-mono text-[13px]"
            />
            <button
              type="button"
              onClick={() => onRemove(kv.id)}
              aria-label="Remove pair"
              className="flex size-11 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-destructive/10 hover:text-destructive focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              <Trash2 className="size-4" aria-hidden />
            </button>
          </div>
        ))}
      </div>
      <button
        type="button"
        onClick={onAdd}
        className="mt-1 inline-flex h-9 w-fit items-center gap-1.5 rounded-md px-2 text-[13px] font-medium text-primary hover:bg-primary/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        <Plus className="size-4" aria-hidden />
        Add {title.toLowerCase()} pair
      </button>
    </div>
  )
}

// ── raw JSON form ─────────────────────────────────────────────────────────────

function JsonForm({ cwd, onCancel, onAdded }: AddMcpFormProps) {
  const add = useAddMcp()
  const [name, setName] = React.useState('')
  const [scope, setScope] = React.useState<ScopeChoice>(cwd ? 'local' : 'user')
  const [raw, setRaw] = React.useState('')
  const [error, setError] = React.useState<string | null>(null)

  const trimmedName = name.trim()
  const canSubmit = trimmedName.length > 0 && raw.trim().length > 0

  const submit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!canSubmit || add.isPending) return
    setError(null)

    let parsed: unknown
    try {
      parsed = JSON.parse(raw)
    } catch {
      setError('That isn’t valid JSON. Paste a server config object.')
      return
    }
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      setError('Expected a JSON object — { "type": "stdio", … } or { "name": { … } }.')
      return
    }
    // Accept either a bare server config OR an `add-json`-shaped wrapper keyed by
    // the server name (use the named entry when present).
    const obj = parsed as Record<string, unknown>
    let config = obj
    const named = obj[trimmedName]
    if (named && typeof named === 'object' && !Array.isArray(named)) {
      config = named as Record<string, unknown>
    }

    const { scope: wireScope, confirm } = scopeWire(scope)
    const input: AddMcpInput = {
      name: trimmedName,
      scope: wireScope,
      cwd: wireScope === 'user' ? undefined : cwd,
      config,
      confirm_project_write: confirm || undefined,
    }
    try {
      await add.mutateAsync(input)
      onAdded(trimmedName)
    } catch (err) {
      setError(addErrorMessage(err))
    }
  }

  return (
    <form onSubmit={submit} className="flex flex-col gap-4">
      <Field label="Name">
        <Input
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="my-server"
          autoComplete="off"
          spellCheck={false}
          className="h-11 font-mono"
        />
      </Field>
      <Field
        label="Config JSON"
        hint="A server config blob. Secrets you paste are sent once and never echoed back."
      >
        <textarea
          value={raw}
          onChange={(e) => setRaw(e.target.value)}
          rows={8}
          spellCheck={false}
          placeholder={'{\n  "type": "stdio",\n  "command": "npx",\n  "args": ["-y", "some-mcp@latest"]\n}'}
          className="w-full resize-y rounded-md border border-input bg-transparent px-3 py-2 font-mono text-[13px] leading-relaxed shadow-sm outline-none transition-colors placeholder:text-muted-foreground focus-visible:ring-2 focus-visible:ring-ring"
        />
      </Field>
      <ScopePicker cwd={cwd} value={scope} onChange={setScope} />
      {scope === 'project' && <ProjectWarning />}
      {error && <ErrorNote message={error} />}
      <FormActions submitting={add.isPending} canSubmit={canSubmit} onCancel={onCancel} />
    </form>
  )
}

// ── field shell ───────────────────────────────────────────────────────────────

function Field({
  label,
  hint,
  children,
}: {
  label: string
  hint?: string
  children: React.ReactNode
}) {
  return (
    <div className="flex flex-col gap-1.5">
      <span className="text-[13px] font-medium text-foreground">{label}</span>
      {children}
      {hint && <p className="text-[12px] leading-snug text-muted-foreground">{hint}</p>}
    </div>
  )
}
