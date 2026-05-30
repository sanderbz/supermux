// ClaudeToolsSheet — the Claude tools manager.
//
// One <ResponsiveSheet> (Vaul bottom-sheet on touch / right-side dialog on
// desktop) listing MCP servers · skills · slash commands, grouped by SCOPE, each
// row carrying a provenance badge (incl. read-only cloud / plugin / managed
// sources). Affordances:
//   • MCP — remove (its file), disable/enable (project .mcp.json trust), add
//     (guided form + raw JSON), an OPT-IN per-row health "Check" (the probe
//     spawns servers, so it never auto-runs on list open), and "Reconnect" which
//     opens Claude's own `/mcp` panel in the focused terminal (the only native
//     reconnect/authenticate path — the CLI can't reconnect a single server, and
//     it can't enumerate a server's tools either, so the panel is where you go to
//     see + (re)connect them). Rows expand to show transport + command/url +
//     env/header KEY names with MASKED values ('••• set') — raw secrets never
//     leave the server.
//   • Skills — tap-to-ACTIVATE (DOCK): a row is a button that runs `/<name>` in
//     the focused session's terminal (skills are slash-invokable), then closes
//     the sheet. Read-only metadata (scope · provenance · path) still shows.
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
  Check,
  ChevronDown,
  CircleSlash,
  Loader2,
  Lock,
  Play,
  Plus,
  Puzzle,
  RefreshCw,
  ServerCog,
  ShieldAlert,
  SlashSquare,
  Sparkles,
  Trash2,
} from 'lucide-react'

import { cn } from '@/lib/utils'
import { springs } from '@/lib/springs'
import { settingsRequest } from '@/lib/api/client'
import { CONFIRM } from '@/brand/copy'
import { ResponsiveSheet } from '@/components/ui/responsive-sheet'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { useToast } from '@/components/ui/use-toast'
import {
  useClaudeRegistry,
  useRemoveMcp,
  useToggleMcp,
  useCheckMcp,
} from '@/hooks/use-claude-tools'
import { useSession } from '@/hooks/use-sessions'
import { sessionsApi, type SessionMode } from '@/lib/api'
import { modeChipLabel } from '@/components/focus-mode/mode-labels'
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

  // Reconnect / authenticate an MCP server — the ONE native path Claude exposes.
  // The `claude` CLI can't reconnect a single server, but Claude's own `/mcp`
  // panel can (reconnect, OAuth-authenticate, inspect tools). So we send `/mcp\r`
  // to the focused terminal and close the sheet, landing the user on the panel
  // with a hint to pick THIS server. Mirrors `runCommand`'s send-and-close flow.
  const reconnectMcp = React.useCallback(
    (name: string) => {
      if (!sessionName) {
        toast({
          message: 'Open a session first — reconnecting happens in Claude’s /mcp panel.',
          tone: 'error',
        })
        return
      }
      onClose()
      void settingsRequest(
        `/api/sessions/${encodeURIComponent(sessionName)}/send`,
        { method: 'POST', body: JSON.stringify({ text: '/mcp\r' }) },
      )
        .then(() =>
          toast({
            message: `Opened Claude’s MCP panel — pick “${name}” to reconnect or authenticate.`,
            duration: 5000,
          }),
        )
        .catch((e) => {
          console.warn('claude-tools: open /mcp failed', e)
          toast({ message: 'Couldn’t open the MCP panel.', tone: 'error' })
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
          {/* Permission mode — moved here from the focus header. Lives BEFORE the
              tabs so it reads as session-level settings, distinct from the
              tool-registry tabs below. Hidden when there's no focused session OR
              the session isn't a Claude pane (modes are a Claude-only concept). */}
          {sessionName && <ModeSection name={sessionName} />}
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
                onReconnect={reconnectMcp}
                runnable={Boolean(sessionName)}
              />
            </TabsContent>
            <TabsContent value="skills" className="mt-0">
              <SkillsTab
                entries={skills}
                loading={registry.isLoading}
                error={registry.isError}
                onRetry={registry.refetch}
                onRun={runCommand}
                runnable={Boolean(sessionName)}
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

// ── Permission mode (session-level settings — moved here from the focus header) ─
//
// One panel that shows the LIVE permission mode of the focused Claude session
// AND switches it. Three cyclable modes (normal / accept_edits / plan) sit in a
// single bordered card with internal dividers; Bypass sits below in a separate
// destructive card with confirm-then-relaunch semantics — the same contract the
// former <ModeMenu> dropdown enforced, just rendered as a tap-target panel that
// fits the sheet's spacing language.

/** Modes that cycle in place via Shift+Tab on the server side. */
const CYCLE_MODES: { value: SessionMode; label: string; hint: string }[] = [
  { value: 'normal', label: 'Normal', hint: 'Asks before every edit' },
  { value: 'accept_edits', label: 'Accept edits', hint: 'Auto-accepts file edits' },
  { value: 'plan', label: 'Plan mode', hint: 'Plans first, no changes' },
]

function ModeSection({ name }: { name: string }) {
  const { session } = useSession(name)
  // Hide for non-Claude panes — permission modes don't exist there. We render
  // nothing until the session row has loaded so the section doesn't flash in
  // and out during the sheet's open animation.
  if (!session) return null
  if (session.provider !== 'claude') return null
  return <ModeSectionInner name={name} mode={session.mode ?? 'normal'} />
}

function ModeSectionInner({
  name,
  mode,
}: {
  name: string
  mode: SessionMode
}) {
  const { toast } = useToast()
  const [busy, setBusy] = React.useState(false)

  const applyMode = React.useCallback(
    async (target: SessionMode) => {
      if (busy || target === mode) return
      if (target === 'bypass') {
        const c = CONFIRM.switchToBypass
        if (!window.confirm(`${c.title}\n\n${c.body}`)) return
      }
      setBusy(true)
      try {
        const res = await sessionsApi.setMode(name, target)
        if (res.relaunched) {
          toast({ message: 'Session restarted in Bypass mode.', tone: 'active' })
        } else if (!res.converged) {
          toast({
            message: `Couldn’t switch to ${modeChipLabel(target)} — still ${modeChipLabel(res.mode)}.`,
            tone: 'waiting',
          })
        }
      } catch (e) {
        toast({
          message: e instanceof Error ? e.message : 'Mode switch failed.',
          tone: 'error',
        })
      } finally {
        setBusy(false)
      }
    },
    [busy, mode, name, toast],
  )

  return (
    <section className="border-b border-border px-4 pb-3 pt-3 sm:px-5">
      <h3 className="pb-2 text-[12px] font-medium uppercase tracking-wide text-muted-foreground">
        Permission mode
      </h3>
      <div className="overflow-hidden rounded-xl border border-border bg-card">
        {CYCLE_MODES.map((m, i) => (
          <ModeRow
            key={m.value}
            label={m.label}
            hint={m.hint}
            selected={mode === m.value}
            disabled={busy}
            divider={i > 0}
            onClick={() => void applyMode(m.value)}
          />
        ))}
      </div>
      {/* Bypass — destructive, launch-only (confirms then relaunches). Pulled
          OUT of the card above so the visual weight matches its consequence:
          its own bordered surface in calm amber, never adjacent to a "normal"
          row that a thumb could mis-tap. */}
      <motion.button
        type="button"
        onClick={() => void applyMode('bypass')}
        disabled={busy}
        whileTap={{ scale: 0.985 }}
        transition={springs.buttonPress}
        aria-pressed={mode === 'bypass'}
        className={cn(
          'mt-2 flex min-h-12 w-full items-center gap-3 rounded-xl border px-3 py-2 text-left transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50',
          mode === 'bypass'
            ? 'border-status-error/40 bg-status-error/15 text-status-error'
            : 'border-status-error/40 bg-status-error/5 text-status-error hover:bg-status-error/10',
        )}
      >
        <ShieldAlert className="size-4 shrink-0" aria-hidden />
        <span className="flex min-w-0 flex-1 flex-col gap-0.5">
          <span className="text-sm font-medium">Bypass permissions</span>
          <span className="text-[11px] opacity-80">
            Skips all prompts · restarts the session
          </span>
        </span>
        {mode === 'bypass' && <Check className="size-4 shrink-0" aria-hidden />}
      </motion.button>
    </section>
  )
}

function ModeRow({
  label,
  hint,
  selected,
  disabled,
  divider,
  onClick,
}: {
  label: string
  hint: string
  selected: boolean
  disabled: boolean
  divider: boolean
  onClick: () => void
}) {
  return (
    <motion.button
      type="button"
      onClick={onClick}
      disabled={disabled}
      whileTap={{ scale: 0.985 }}
      transition={springs.buttonPress}
      aria-pressed={selected}
      className={cn(
        'flex min-h-12 w-full items-center gap-3 px-3 py-2 text-left transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50',
        divider && 'border-t border-border',
        selected
          ? 'bg-accent/40 text-foreground'
          : 'text-foreground hover:bg-accent/30',
      )}
    >
      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="text-sm font-medium">{label}</span>
        <span className="text-[11px] text-muted-foreground">{hint}</span>
      </span>
      {selected && (
        <Check className="size-4 shrink-0 text-primary" aria-hidden />
      )}
    </motion.button>
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
  onReconnect,
  runnable,
}: {
  entries: McpEntry[]
  cwd?: string
  loading: boolean
  error: boolean
  onRetry: () => void
  onAdd: () => void
  restartNote: () => void
  /** Open Claude's `/mcp` panel in the focused terminal to reconnect/authenticate. */
  onReconnect: (name: string) => void
  /** True when there is a focused session to reconnect within. */
  runnable: boolean
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
                <McpRow key={`local-${e.name}`} entry={e} cwd={cwd} restartNote={restartNote} onReconnect={onReconnect} runnable={runnable} />
              ))}
            </ScopeGroup>
          )}
          {removableUser.length > 0 && (
            <ScopeGroup label="Global">
              {removableUser.map((e) => (
                <McpRow key={`user-${e.name}`} entry={e} cwd={cwd} restartNote={restartNote} onReconnect={onReconnect} runnable={runnable} />
              ))}
            </ScopeGroup>
          )}
          {project.length > 0 && (
            <ScopeGroup label="This project · committed (.mcp.json)">
              {project.map((e) => (
                <McpRow key={`project-${e.name}`} entry={e} cwd={cwd} restartNote={restartNote} onReconnect={onReconnect} runnable={runnable} />
              ))}
            </ScopeGroup>
          )}
          {readonly.length > 0 && (
            <ScopeGroup label="Read-only">
              {readonly.map((e) => (
                <McpRow key={`ro-${e.scope}-${e.name}`} entry={e} cwd={cwd} restartNote={restartNote} onReconnect={onReconnect} runnable={runnable} />
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
  onReconnect,
  runnable,
}: {
  entry: McpEntry
  cwd?: string
  restartNote: () => void
  onReconnect: (name: string) => void
  runnable: boolean
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
  // A check that came back not-connected → highlight Reconnect as the next step.
  const needsAttention =
    !!health &&
    (health.status === 'needs_auth' ||
      health.status === 'failed' ||
      health.status === 'timeout')

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

                {/* reconnect / authenticate — opens Claude's own /mcp panel in the
                    focused terminal (the only native reconnect path; the CLI can't
                    do it). Highlighted when a check flagged a problem. Hidden with
                    no focused session (nothing to open the panel in). */}
                {runnable && (
                  <RowAction
                    onClick={() => onReconnect(entry.name)}
                    icon={RefreshCw}
                    tone={needsAttention ? 'accent' : 'default'}
                  >
                    Reconnect
                  </RowAction>
                )}

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
  onRun,
  runnable,
}: {
  entries: SkillEntry[]
  loading: boolean
  error: boolean
  onRetry: () => void
  /** Activate a skill (`/<name>\r`) in the focused session's terminal. */
  onRun: (name: string) => void
  /** True when there is a focused session to activate the skill in. */
  runnable: boolean
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
      {!runnable && (
        <p className="px-3 pb-2 text-[12px] text-muted-foreground">
          Open a session to activate a skill in its terminal.
        </p>
      )}
      {project.length > 0 && (
        <ScopeGroup label="This project">
          {project.map((e) => (
            <SkillRow key={`p-${e.name}`} entry={e} onRun={onRun} />
          ))}
        </ScopeGroup>
      )}
      {global.length > 0 && (
        <ScopeGroup label="Global">
          {global.map((e) => (
            <SkillRow key={`g-${e.name}`} entry={e} onRun={onRun} />
          ))}
        </ScopeGroup>
      )}
      {plugin.length > 0 && (
        <ScopeGroup label="Read-only">
          {plugin.map((e) => (
            <SkillRow key={`pl-${e.name}`} entry={e} onRun={onRun} />
          ))}
        </ScopeGroup>
      )}
    </div>
  )
}

/** One tap-to-activate skill row. Tapping sends `/<name>\r` to the focused
 *  terminal (skills are slash-invokable in Claude) and closes the sheet — the
 *  same DOCK pattern the Commands tab uses, so a skill reads + behaves as a
 *  primary action. */
function SkillRow({
  entry,
  onRun,
}: {
  entry: SkillEntry
  onRun: (name: string) => void
}) {
  return (
    <motion.li layout={false} className="list-none">
      <motion.button
        type="button"
        onClick={() => onRun(entry.name)}
        whileTap={{ scale: 0.98 }}
        transition={springs.buttonPress}
        aria-label={`Activate /${entry.name} in the focused terminal`}
        className="flex w-full items-start gap-2.5 rounded-xl border border-border bg-card px-3 py-2.5 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring hover:bg-accent/40"
      >
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
        <Play className="mt-1 size-4 shrink-0 text-muted-foreground" aria-hidden />
      </motion.button>
    </motion.li>
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
