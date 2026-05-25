// ClaudeToolsSheet — the Claude tools manager (skills-mcp-manager plan §C.2).
//
// One <ResponsiveSheet> (Vaul bottom-sheet on touch / right-side dialog on
// desktop) listing MCP servers · skills · slash commands, grouped by SCOPE, each
// row carrying a provenance badge (incl. read-only cloud / plugin / managed
// sources). Affordances per the plan:
//   • MCP — remove (its file), disable/enable (project .mcp.json trust), add
//     (guided form + raw JSON), and an OPT-IN per-row health "Check" (the probe
//     spawns servers, so it never auto-runs on list open). Rows expand to show
//     transport + command/url + env/header KEY names with MASKED values
//     ('••• set') — raw secrets never leave the server.
//   • Skills — read-only listing: name · scope · provenance · path.
//   • Commands — tap-to-RUN (DOCK): a row is now a button that runs the command
//     in the focused session's terminal (POST /api/sessions/:name/send with
//     `/<cmd>\r`), then closes the sheet. This replaces the old dock slash menu.
//     With no focused session a calm toast explains there's nothing to run in.
//     supermux-managed commands + plugin/cloud entries are still flagged.
//
// Scope picking on add defaults to local/user and NEVER project implicitly;
// writing the git-tracked .mcp.json takes an explicit choice + a loud warning
// (the form sends confirm_project_write). After a mutating MCP change we surface
// a calm "restart the session" note (no auto-restart in v1).
//
// `cwd` (the focused session's working dir) scopes the project reads. It is
// resolved from the sheet store's `sessionName` against the live sessions list.
//
// VISUAL: iOS-native finish — ≥44pt targets, continuous corners, springy
// micro-interactions, reduced-motion safe, calm empty/loading/error states,
// sentence-case copy, design tokens throughout.

import * as React from 'react'
import { AnimatePresence, motion, useReducedMotion } from 'framer-motion'
import {
  Activity,
  AlertTriangle,
  ChevronDown,
  CircleSlash,
  Loader2,
  Lock,
  Play,
  Plus,
  Puzzle,
  RefreshCw,
  ServerCog,
  SlashSquare,
  Sparkles,
  Trash2,
} from 'lucide-react'

import { cn } from '@/lib/utils'
import { springs } from '@/lib/springs'
import { settingsRequest } from '@/lib/api/client'
import { ResponsiveSheet } from '@/components/ui/responsive-sheet'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { useToast } from '@/components/ui/use-toast'
import {
  useClaudeRegistry,
  useRemoveMcp,
  useToggleMcp,
  useCheckMcp,
} from '@/hooks/use-claude-tools'
import type {
  CommandEntry,
  McpEntry,
  McpHealth,
  SkillEntry,
} from '@/lib/api/claude'
import { AddMcpForm } from './add-mcp-form'

export interface ClaudeToolsSheetProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** Focused session working dir — scopes the project reads / writes. */
  cwd?: string
  /** Focused session name (for the subtitle). */
  sessionName?: string | null
}

type TabKey = 'mcp' | 'skills' | 'commands'

export function ClaudeToolsSheet({
  open,
  onOpenChange,
  cwd,
  sessionName,
}: ClaudeToolsSheetProps) {
  const description = sessionName ? `Scoped to ${sessionName}` : 'Global scope'
  // The body only mounts while the sheet is open, so its transient view-state
  // (active tab + add-form) initializes fresh each open — no reset effect (which
  // the lint rule rightly flags as a cascading-render risk). Mirrors the
  // NewSessionSheet inner-form pattern.
  return (
    <ResponsiveSheet
      open={open}
      onOpenChange={onOpenChange}
      title="Claude tools"
      description={description}
      className="sm:max-w-lg"
    >
      {open && (
        <ClaudeToolsBody
          cwd={cwd}
          sessionName={sessionName}
          onClose={() => onOpenChange(false)}
        />
      )}
    </ResponsiveSheet>
  )
}

function ClaudeToolsBody({
  cwd,
  sessionName,
  onClose,
}: {
  cwd?: string
  sessionName?: string | null
  onClose: () => void
}) {
  const [tab, setTab] = React.useState<TabKey>('mcp')
  const [adding, setAdding] = React.useState(false)
  const registry = useClaudeRegistry(cwd, true)
  const { toast } = useToast()

  // Run a slash command in the focused session's terminal (DOCK). Robust path:
  // POST the command + carriage return to the session's send endpoint (the SAME
  // route the ⌘K palette uses to run a command), so it works regardless of where
  // this sheet is mounted (shell level) — no terminal handle to prop-drill. Then
  // close the sheet so the user lands back on the running terminal. Fire-and-
  // forget; the shared `settingsRequest` reads the bearer off env.ts.
  const runCommand = React.useCallback(
    (name: string) => {
      if (!sessionName) {
        toast({
          message: 'Open a session first — there’s no terminal to run this in.',
          tone: 'error',
        })
        return
      }
      onClose()
      void settingsRequest(
        `/api/sessions/${encodeURIComponent(sessionName)}/send`,
        {
          method: 'POST',
          body: JSON.stringify({ text: `/${name}\r` }),
        },
      ).catch((e) => {
        console.warn('claude-tools: run command failed', e)
        toast({ message: 'Couldn’t run the command.', tone: 'error' })
      })
    },
    [sessionName, onClose, toast],
  )

  const restartNote = React.useCallback(() => {
    toast({
      message: 'Restart the affected session to apply this change.',
      duration: 4000,
    })
  }, [toast])

  const mcp = registry.data?.mcp ?? []
  const skills = registry.data?.skills ?? []
  const commands = registry.data?.commands ?? []

  return (
    <>
      {adding ? (
        <AddMcpForm
          cwd={cwd}
          onCancel={() => setAdding(false)}
          onAdded={(name) => {
            setAdding(false)
            toast({ message: `Added ${name}.` })
            restartNote()
          }}
        />
      ) : (
        <Tabs value={tab} onValueChange={(v) => setTab(v as TabKey)}>
          <div className="sticky top-0 z-10 border-b border-border bg-background/90 px-4 pb-3 pt-3 backdrop-blur-sm sm:px-5">
            <TabsList className="grid w-full grid-cols-3">
              <TabsTrigger value="mcp">MCP</TabsTrigger>
              <TabsTrigger value="skills">Skills</TabsTrigger>
              <TabsTrigger value="commands">Commands</TabsTrigger>
            </TabsList>
          </div>

          <div className="px-2 py-2 sm:px-3">
            <TabsContent value="mcp" className="mt-0">
              <McpTab
                entries={mcp}
                cwd={cwd}
                loading={registry.isLoading}
                error={registry.isError}
                onRetry={registry.refetch}
                onAdd={() => setAdding(true)}
                restartNote={restartNote}
              />
            </TabsContent>
            <TabsContent value="skills" className="mt-0">
              <SkillsTab
                entries={skills}
                loading={registry.isLoading}
                error={registry.isError}
                onRetry={registry.refetch}
              />
            </TabsContent>
            <TabsContent value="commands" className="mt-0">
              <CommandsTab
                entries={commands}
                loading={registry.isLoading}
                error={registry.isError}
                onRetry={registry.refetch}
                onRun={runCommand}
                runnable={Boolean(sessionName)}
              />
            </TabsContent>
          </div>
        </Tabs>
      )}
    </>
  )
}

// ── shared list states ────────────────────────────────────────────────────────

function LoadingRows() {
  return (
    <div className="flex flex-col gap-1.5 px-1 py-1">
      {Array.from({ length: 4 }).map((_, i) => (
        <div key={i} className="h-14 animate-pulse rounded-xl bg-muted/50" />
      ))}
    </div>
  )
}

function ErrorState({ onRetry }: { onRetry: () => void }) {
  return (
    <div className="flex flex-col items-center gap-3 px-6 py-12 text-center">
      <div className="flex size-12 items-center justify-center rounded-full bg-destructive/10 text-destructive [&_svg]:size-5">
        <AlertTriangle aria-hidden />
      </div>
      <p className="text-sm text-muted-foreground">
        Couldn’t read your Claude config.
      </p>
      <button
        type="button"
        onClick={onRetry}
        className="inline-flex h-9 items-center gap-1.5 rounded-md border border-border px-3 text-[13px] font-medium hover:bg-accent/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        <RefreshCw className="size-4" aria-hidden />
        Try again
      </button>
    </div>
  )
}

function EmptyState({
  icon: Icon,
  text,
}: {
  icon: typeof Sparkles
  text: string
}) {
  const reduce = useReducedMotion()
  return (
    <motion.div
      initial={reduce ? false : { opacity: 0, scale: 0.96 }}
      animate={{ opacity: 1, scale: 1 }}
      transition={springs.cardExpand}
      className="flex flex-col items-center justify-center gap-3 px-6 py-14 text-center"
    >
      <div className="flex size-14 items-center justify-center rounded-full bg-muted text-muted-foreground [&_svg]:size-6">
        <Icon aria-hidden />
      </div>
      <p className="max-w-xs text-sm text-muted-foreground">{text}</p>
    </motion.div>
  )
}

/** A labelled scope subsection (only rendered when it has rows). */
function ScopeGroup({
  label,
  children,
}: {
  label: string
  children: React.ReactNode
}) {
  return (
    <section className="mb-3">
      <h3 className="px-3 pb-1.5 pt-1 text-[12px] font-medium uppercase tracking-wide text-muted-foreground">
        {label}
      </h3>
      <ul className="flex flex-col gap-1">{children}</ul>
    </section>
  )
}

/** Small provenance / scope pill. `tone='warn'` for committed/read-only flags. */
function Badge({
  children,
  tone = 'default',
  icon: Icon,
}: {
  children: React.ReactNode
  tone?: 'default' | 'muted' | 'warn' | 'accent'
  icon?: typeof Lock
}) {
  return (
    <span
      className={cn(
        'inline-flex shrink-0 items-center gap-1 rounded-md px-1.5 py-0.5 text-[10px] font-medium leading-none',
        tone === 'default' && 'bg-secondary text-muted-foreground',
        tone === 'muted' && 'bg-muted text-muted-foreground',
        tone === 'warn' && 'bg-destructive/10 text-destructive',
        tone === 'accent' && 'bg-primary/10 text-primary',
      )}
    >
      {Icon && <Icon className="size-3" aria-hidden />}
      {children}
    </span>
  )
}

// ── MCP tab ───────────────────────────────────────────────────────────────────

function McpTab({
  entries,
  cwd,
  loading,
  error,
  onRetry,
  onAdd,
  restartNote,
}: {
  entries: McpEntry[]
  cwd?: string
  loading: boolean
  error: boolean
  onRetry: () => void
  onAdd: () => void
  restartNote: () => void
}) {
  if (error) return <ErrorState onRetry={onRetry} />
  if (loading && entries.length === 0) return <LoadingRows />

  // Group: this-project (local) · global (user) · committed project · read-only.
  const local = entries.filter((e) => e.scope === 'local')
  const user = entries.filter((e) => e.scope === 'user')
  const project = entries.filter((e) => e.scope === 'project')
  // Read-only = not removable AND not a project-trust row (cloud / plugin / any
  // non-removable user|local entry). This is the COMPLETE read-only set; an
  // earlier `readonlyLocalUser` list was an exact duplicate of it (same predicate
  // over the only non-project scopes), and rendering both spread together drew
  // each read-only row twice once cloud connectors made the group non-empty.
  const readonly = entries.filter((e) => !e.removable && e.scope !== 'project')
  const removableLocal = local.filter((e) => e.removable)
  const removableUser = user.filter((e) => e.removable)

  return (
    <div>
      <AddBar label="Add MCP server" onAdd={onAdd} />
      {entries.length === 0 ? (
        <EmptyState
          icon={ServerCog}
          text={
            cwd
              ? 'No MCP servers in scope. Add one to get started.'
              : 'No global MCP servers yet. Add one to get started.'
          }
        />
      ) : (
        <>
          {cwd && removableLocal.length > 0 && (
            <ScopeGroup label="This project · private">
              {removableLocal.map((e) => (
                <McpRow key={`local-${e.name}`} entry={e} cwd={cwd} restartNote={restartNote} />
              ))}
            </ScopeGroup>
          )}
          {removableUser.length > 0 && (
            <ScopeGroup label="Global">
              {removableUser.map((e) => (
                <McpRow key={`user-${e.name}`} entry={e} cwd={cwd} restartNote={restartNote} />
              ))}
            </ScopeGroup>
          )}
          {project.length > 0 && (
            <ScopeGroup label="This project · committed (.mcp.json)">
              {project.map((e) => (
                <McpRow key={`project-${e.name}`} entry={e} cwd={cwd} restartNote={restartNote} />
              ))}
            </ScopeGroup>
          )}
          {readonly.length > 0 && (
            <ScopeGroup label="Read-only">
              {readonly.map((e) => (
                <McpRow key={`ro-${e.scope}-${e.name}`} entry={e} cwd={cwd} restartNote={restartNote} />
              ))}
            </ScopeGroup>
          )}
        </>
      )}
    </div>
  )
}

function AddBar({ label, onAdd }: { label: string; onAdd: () => void }) {
  return (
    <div className="px-1 pb-2">
      <motion.button
        type="button"
        onClick={onAdd}
        whileTap={{ scale: 0.98 }}
        transition={springs.buttonPress}
        className="flex min-h-11 w-full items-center justify-center gap-2 rounded-xl border border-dashed border-border text-[14px] font-medium text-primary hover:bg-primary/5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        <Plus className="size-4" aria-hidden />
        {label}
      </motion.button>
    </div>
  )
}

/** tri-state enable label for project servers (trusted / disabled / pending). */
function mcpStateBadge(entry: McpEntry): React.ReactNode {
  if (entry.scope !== 'project') return null
  if (entry.enabled === true) return <Badge tone="accent">Trusted</Badge>
  if (entry.enabled === false) return <Badge tone="muted">Disabled</Badge>
  return <Badge tone="warn">Pending trust</Badge>
}

function healthTone(status: McpHealth['status']): 'accent' | 'warn' | 'muted' {
  if (status === 'connected' || status === 'ok') return 'accent'
  if (status === 'needs_auth') return 'warn'
  return 'muted'
}

function healthLabel(h: McpHealth): string {
  switch (h.status) {
    case 'connected':
    case 'ok':
      return 'Connected'
    case 'needs_auth':
      return 'Needs auth'
    case 'timeout':
      return 'Timed out'
    default:
      return 'Failed'
  }
}

function McpRow({
  entry,
  cwd,
  restartNote,
}: {
  entry: McpEntry
  cwd?: string
  restartNote: () => void
}) {
  const reduce = useReducedMotion()
  const { toast } = useToast()
  const [expanded, setExpanded] = React.useState(false)
  const [confirming, setConfirming] = React.useState(false)
  const remove = useRemoveMcp()
  const toggle = useToggleMcp()
  const check = useCheckMcp()
  const [health, setHealth] = React.useState<McpHealth | null>(null)

  const isProject = entry.scope === 'project'
  const busy = remove.isPending || toggle.isPending

  const onRemove = () => {
    setConfirming(false)
    remove
      .mutateAsync({
        name: entry.name,
        scope: entry.scope,
        cwd: entry.scope === 'user' ? undefined : cwd,
      })
      .then(() => {
        toast({ message: `Removed ${entry.name}.` })
        restartNote()
      })
      .catch((e) =>
        toast({
          message: e instanceof Error ? e.message : 'Couldn’t remove the server.',
          tone: 'error',
        }),
      )
  }

  const onToggle = (enable: boolean) => {
    if (!cwd) return
    toggle
      .mutateAsync({ name: entry.name, cwd, enable })
      .then(() => {
        toast({ message: enable ? `Trusted ${entry.name}.` : `Disabled ${entry.name}.` })
        restartNote()
      })
      .catch((e) =>
        toast({
          message: e instanceof Error ? e.message : 'Couldn’t update trust.',
          tone: 'error',
        }),
      )
  }

  const onCheck = () => {
    check
      .mutateAsync({
        name: entry.name,
        scope: entry.scope,
        cwd: entry.scope === 'user' ? undefined : cwd,
      })
      .then((h) => setHealth(h))
      .catch(() =>
        setHealth({ connected: false, status: 'failed', detail: 'Check failed' }),
      )
  }

  // env / header KEY names (values already masked server-side).
  const env = (entry.config?.env ?? {}) as Record<string, unknown>
  const headers = (entry.config?.headers ?? {}) as Record<string, unknown>
  const command = typeof entry.config?.command === 'string' ? entry.config.command : ''
  const args = Array.isArray(entry.config?.args) ? (entry.config.args as unknown[]) : []
  const url = typeof entry.config?.url === 'string' ? entry.config.url : ''
  const secretRows = [
    ...Object.entries(env).map(([k, v]) => ['env', k, v] as const),
    ...Object.entries(headers).map(([k, v]) => ['header', k, v] as const),
  ]

  return (
    <motion.li
      layout={!reduce}
      className={cn('overflow-hidden rounded-xl border border-border bg-card', busy && 'opacity-60')}
    >
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        aria-expanded={expanded}
        className="flex min-h-[3.25rem] w-full items-center gap-2.5 px-3 py-2 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        <span className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-muted text-muted-foreground [&_svg]:size-4">
          <ServerCog aria-hidden />
        </span>
        <span className="flex min-w-0 flex-1 flex-col gap-0.5">
          <span className="truncate font-mono text-[14px] font-medium text-foreground">
            {entry.name}
          </span>
          <span className="flex flex-wrap items-center gap-1">
            <Badge tone="muted">{entry.transport || 'stdio'}</Badge>
            {isProject && entry.committed && (
              <Badge tone="warn" icon={Lock}>
                committed
              </Badge>
            )}
            {mcpStateBadge(entry)}
            {!entry.removable && entry.scope !== 'project' && (
              <Badge tone="muted" icon={Lock}>
                {entry.provenance || 'read-only'}
              </Badge>
            )}
            {health && <Badge tone={healthTone(health.status)}>{healthLabel(health)}</Badge>}
          </span>
        </span>
        <motion.span
          animate={{ rotate: expanded ? 180 : 0 }}
          transition={springs.toggleSnap}
          className="shrink-0 text-muted-foreground"
        >
          <ChevronDown className="size-4" aria-hidden />
        </motion.span>
      </button>

      <AnimatePresence initial={false}>
        {expanded && (
          <motion.div
            initial={reduce ? false : { height: 0, opacity: 0 }}
            animate={{ height: 'auto', opacity: 1 }}
            exit={reduce ? { opacity: 0 } : { height: 0, opacity: 0 }}
            transition={springs.smooth}
            className="overflow-hidden border-t border-border"
          >
            <div className="flex flex-col gap-3 px-3 py-3">
              {/* transport detail */}
              <dl className="flex flex-col gap-1.5 text-[12px]">
                {command && (
                  <DetailRow term="Command" value={[command, ...args.map(String)].join(' ')} />
                )}
                {url && <DetailRow term="URL" value={url} />}
              </dl>

              {/* masked env / header keys */}
              {secretRows.length > 0 && (
                <div className="flex flex-col gap-1">
                  <span className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
                    {Object.keys(env).length ? 'Environment' : 'Headers'}
                  </span>
                  {secretRows.map(([kind, k]) => (
                    <div
                      key={`${kind}-${k}`}
                      className="flex items-center justify-between gap-2 rounded-md bg-secondary px-2.5 py-1.5"
                    >
                      <code className="min-w-0 truncate font-mono text-[12px] text-foreground">
                        {k}
                      </code>
                      <span className="shrink-0 font-mono text-[11px] tracking-widest text-muted-foreground">
                        ••• set
                      </span>
                    </div>
                  ))}
                </div>
              )}

              {/* actions */}
              <div className="flex flex-wrap items-center gap-2">
                {/* opt-in health check */}
                <RowAction
                  onClick={onCheck}
                  disabled={check.isPending}
                  icon={check.isPending ? Loader2 : Activity}
                  spin={check.isPending}
                >
                  {check.isPending ? 'Checking…' : 'Check'}
                </RowAction>

                {/* project trust toggle (tri-state) */}
                {isProject && cwd && (
                  entry.enabled === true ? (
                    <RowAction onClick={() => onToggle(false)} disabled={busy} icon={CircleSlash}>
                      Disable
                    </RowAction>
                  ) : (
                    <RowAction onClick={() => onToggle(true)} disabled={busy} icon={Sparkles} tone="accent">
                      {entry.enabled === false ? 'Re-enable' : 'Trust'}
                    </RowAction>
                  )
                )}

                {/* remove (only when the entry's file is editable) */}
                {entry.removable && (
                  confirming ? (
                    <div className="flex items-center gap-1.5">
                      <RowAction onClick={() => setConfirming(false)} disabled={busy}>
                        Cancel
                      </RowAction>
                      <RowAction onClick={onRemove} disabled={busy} icon={Trash2} tone="destructive">
                        Remove
                      </RowAction>
                    </div>
                  ) : (
                    <RowAction
                      onClick={() => setConfirming(true)}
                      disabled={busy}
                      icon={Trash2}
                      tone="destructive"
                    >
                      Remove
                    </RowAction>
                  )
                )}

                {!entry.removable && (
                  <span className="inline-flex items-center gap-1 text-[12px] text-muted-foreground">
                    <Lock className="size-3.5" aria-hidden />
                    {entry.provenance || 'Read-only'}
                  </span>
                )}
              </div>

              {health?.detail && (
                <p className="text-[12px] text-muted-foreground">{health.detail}</p>
              )}
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </motion.li>
  )
}

function DetailRow({ term, value }: { term: string; value: string }) {
  return (
    <div className="flex gap-2">
      <dt className="w-20 shrink-0 text-muted-foreground">{term}</dt>
      <dd className="min-w-0 flex-1 break-all font-mono text-foreground">{value}</dd>
    </div>
  )
}

function RowAction({
  children,
  onClick,
  disabled,
  icon: Icon,
  tone = 'default',
  spin,
}: {
  children: React.ReactNode
  onClick: () => void
  disabled?: boolean
  icon?: typeof Activity
  tone?: 'default' | 'accent' | 'destructive'
  spin?: boolean
}) {
  return (
    <motion.button
      type="button"
      onClick={onClick}
      disabled={disabled}
      whileTap={{ scale: 0.96 }}
      transition={springs.buttonPress}
      className={cn(
        'inline-flex h-9 items-center gap-1.5 rounded-md border px-2.5 text-[12px] font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50',
        tone === 'default' && 'border-border text-foreground hover:bg-accent/40',
        tone === 'accent' && 'border-primary/40 bg-primary/10 text-primary hover:bg-primary/15',
        tone === 'destructive' &&
          'border-destructive/40 bg-destructive/10 text-destructive hover:bg-destructive/15',
      )}
    >
      {Icon && <Icon className={cn('size-3.5', spin && 'animate-spin')} aria-hidden />}
      {children}
    </motion.button>
  )
}

// ── Skills tab (read-only listing for v1) ─────────────────────────────────────

function SkillsTab({
  entries,
  loading,
  error,
  onRetry,
}: {
  entries: SkillEntry[]
  loading: boolean
  error: boolean
  onRetry: () => void
}) {
  if (error) return <ErrorState onRetry={onRetry} />
  if (loading && entries.length === 0) return <LoadingRows />
  if (entries.length === 0) {
    return <EmptyState icon={Sparkles} text="No skills found in scope." />
  }

  const project = entries.filter((e) => e.scope === 'project')
  const global = entries.filter((e) => e.scope === 'global')
  const plugin = entries.filter((e) => e.scope === 'plugin')

  return (
    <div className="pt-1">
      {project.length > 0 && (
        <ScopeGroup label="This project">
          {project.map((e) => (
            <SkillRow key={`p-${e.name}`} entry={e} />
          ))}
        </ScopeGroup>
      )}
      {global.length > 0 && (
        <ScopeGroup label="Global">
          {global.map((e) => (
            <SkillRow key={`g-${e.name}`} entry={e} />
          ))}
        </ScopeGroup>
      )}
      {plugin.length > 0 && (
        <ScopeGroup label="Read-only">
          {plugin.map((e) => (
            <SkillRow key={`pl-${e.name}`} entry={e} />
          ))}
        </ScopeGroup>
      )}
    </div>
  )
}

function SkillRow({ entry }: { entry: SkillEntry }) {
  return (
    <li className="flex items-start gap-2.5 rounded-xl border border-border bg-card px-3 py-2.5">
      <span className="mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-lg bg-muted text-muted-foreground [&_svg]:size-4">
        <Sparkles aria-hidden />
      </span>
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="flex flex-wrap items-center gap-1">
          <span className="truncate font-mono text-[14px] font-medium text-foreground">
            {entry.name}
          </span>
          {entry.scope === 'plugin' && <Badge tone="muted" icon={Puzzle}>plugin</Badge>}
          {entry.linked && <Badge tone="muted">linked</Badge>}
          {!entry.removable && entry.scope !== 'plugin' && (
            <Badge tone="warn" icon={Lock}>read-only</Badge>
          )}
        </span>
        {entry.description && (
          <span className="line-clamp-2 text-[12px] leading-snug text-muted-foreground">
            {entry.description}
          </span>
        )}
        <span className="truncate font-mono text-[11px] text-muted-foreground/80">
          {entry.linked && entry.link_target ? `${entry.path} → ${entry.link_target}` : entry.path}
        </span>
      </div>
    </li>
  )
}

// ── Commands tab (tap-to-run in the focused terminal — DOCK) ──────────────────

function CommandsTab({
  entries,
  loading,
  error,
  onRetry,
  onRun,
  runnable,
}: {
  entries: CommandEntry[]
  loading: boolean
  error: boolean
  onRetry: () => void
  /** Run a command (`/<name>\r`) in the focused session's terminal. */
  onRun: (name: string) => void
  /** True when there is a focused session to run a command in (else the rows
   *  still render but a hint explains there's no terminal). */
  runnable: boolean
}) {
  if (error) return <ErrorState onRetry={onRetry} />
  if (loading && entries.length === 0) return <LoadingRows />
  if (entries.length === 0) {
    return <EmptyState icon={SlashSquare} text="No slash commands found in scope." />
  }

  const project = entries.filter((e) => e.scope === 'project')
  const global = entries.filter((e) => e.scope === 'global')
  const readonly = entries.filter((e) => e.scope === 'builtin' || e.scope === 'plugin')

  return (
    <div className="pt-1">
      {!runnable && (
        <p className="px-3 pb-2 text-[12px] text-muted-foreground">
          Open a session to run a command in its terminal.
        </p>
      )}
      {project.length > 0 && (
        <ScopeGroup label="This project">
          {project.map((e) => (
            <CommandRowView key={`p-${e.name}`} entry={e} onRun={onRun} />
          ))}
        </ScopeGroup>
      )}
      {global.length > 0 && (
        <ScopeGroup label="Global">
          {global.map((e) => (
            <CommandRowView key={`g-${e.name}`} entry={e} onRun={onRun} />
          ))}
        </ScopeGroup>
      )}
      {readonly.length > 0 && (
        <ScopeGroup label="Read-only">
          {readonly.map((e) => (
            <CommandRowView key={`r-${e.scope}-${e.name}`} entry={e} onRun={onRun} />
          ))}
        </ScopeGroup>
      )}
    </div>
  )
}

/** One tap-to-run command row. Tapping runs `/<name>\r` in the focused terminal
 *  (DOCK) and closes the sheet — the row is a ≥44pt button so it reads + behaves
 *  as the primary action. */
function CommandRowView({
  entry,
  onRun,
}: {
  entry: CommandEntry
  onRun: (name: string) => void
}) {
  return (
    <motion.li layout={false} className="list-none">
      <motion.button
        type="button"
        onClick={() => onRun(entry.name)}
        whileTap={{ scale: 0.98 }}
        transition={springs.buttonPress}
        aria-label={`Run /${entry.name} in the focused terminal`}
        className="flex w-full items-start gap-2.5 rounded-xl border border-border bg-card px-3 py-2.5 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring hover:bg-accent/40"
      >
        <span className="mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-lg bg-muted text-muted-foreground [&_svg]:size-4">
          <SlashSquare aria-hidden />
        </span>
        <div className="flex min-w-0 flex-1 flex-col gap-0.5">
          <span className="flex flex-wrap items-center gap-1">
            <span className="truncate font-mono text-[14px] font-semibold text-foreground">
              /{entry.name}
            </span>
            {entry.managed && <Badge tone="accent">managed by supermux</Badge>}
            {entry.scope === 'builtin' && <Badge tone="muted">built-in</Badge>}
            {entry.scope === 'plugin' && <Badge tone="muted" icon={Puzzle}>plugin</Badge>}
          </span>
          {entry.description && (
            <span className="line-clamp-2 text-[12px] leading-snug text-muted-foreground">
              {entry.description}
            </span>
          )}
          {entry.path && (
            <span className="truncate font-mono text-[11px] text-muted-foreground/80">
              {entry.path}
            </span>
          )}
        </div>
        <Play className="mt-1 size-4 shrink-0 text-muted-foreground" aria-hidden />
      </motion.button>
    </motion.li>
  )
}

export default ClaudeToolsSheet
