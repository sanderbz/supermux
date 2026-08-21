/**
 * `<BotPanel>` — the per-bot settings PAGE (Grok/Bot mode, ASK 3).
 * ─────────────────────────────────────────────────────────────────────────────
 * The roster's detail pane used to only GLANCE (cost/context/provider/status) —
 * nothing was editable. The real editable surface lived in
 * `focus-mode/session-info-panel.tsx` and was never mounted in Grok mode. This is
 * that surface, re-shaped as a tabbed bot page and reusing the info-panel's own
 * section bodies (name editor, dir, desc/role, tags, settings, Issues, Schedules,
 * Git, Clone, NotifPolicyControl) rather than reimplementing them.
 *
 * "Three fidelities, one component" (master plan §11.4):
 *   • variant="pane"  — the desktop roster's second column (replaces DetailPane).
 *   • variant="sheet" — a bottom sheet (the mobile focus-view title opens THIS,
 *                       not a duplicate surface).
 *
 * Four quiet tabs: Overview (the glance, now with editable tags + a working-dir
 * row) · Instructions (role + model + notes + notifications — the launch-injected
 * identity) · Tools (skills / connectors / MCP placeholders) · Activity
 * (Schedules · Issues · Git).
 *
 * Styling is Tailwind + shadcn tokens (NOT `[data-grok]`-scoped CSS) so the ONE
 * component renders identically in the in-shell pane and in the body-portalled
 * sheet; the pane's outer chrome reuses the roster's existing `.gr-pane` surface.
 */
import * as React from 'react'
import {
  ArrowRight,
  Check,
  ChevronDown,
  Copy,
  Files as FilesIcon,
  FolderOpen,
  Loader2,
  Terminal,
} from 'lucide-react'
import { Link } from 'react-router-dom'

import { cn } from '@/lib/utils'
import { modelOptions } from '@/lib/model-options'
import { SessionFace } from '@/components/roster/session-face'
import { GrantedConnectors, RestartToApply } from '@/components/roster/granted-connectors'
import { LearnedNotes } from '@/components/roster/learned-notes'
import { NotifPolicyControl } from '@/components/focus-mode/notif-policy-control'
import {
  NameEditor,
  DescEditor,
  TagsEditor,
  GitRow,
  SchedulesList,
} from '@/components/focus-mode/session-info-panel'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { ResponsiveSheet } from '@/components/ui/responsive-sheet'
import { SessionActionsMenu } from '@/components/session-tile/session-actions-menu'
import { IssueList } from '@/components/issues/issue-list'
import { IssueSurface } from '@/components/issues/issue-surface'
import { useSession } from '@/hooks/use-sessions'
import { useSessionConfig } from '@/hooks/use-session-config'
import { useCloneSession } from '@/components/focus-mode/use-clone-session'
import { useToast } from '@/components/ui/use-toast'
import { displayLabel, type ApiSession } from '@/lib/api'

/* ── tiny pure helpers (mirrors of grok-roster's; kept local so this module is
      self-contained and does not widen grok-roster's export surface) ────────── */

const CTX_WINDOW = 200_000
function ctxPct(tokens?: number): number | null {
  if (typeof tokens !== 'number' || tokens <= 0) return null
  return Math.min(100, Math.round((tokens / CTX_WINDOW) * 100))
}
function ringColor(pct: number): string {
  return pct < 50
    ? 'var(--status-active-ink, #16a34a)'
    : pct < 80
      ? 'var(--status-waiting-ink, #d97706)'
      : 'var(--status-error-ink, #dc2626)'
}
function fmtTokens(n?: number): string | undefined {
  if (typeof n !== 'number' || n <= 0) return undefined
  if (n < 1000) return `${Math.max(0.1, n / 1000).toFixed(1)}k`
  return `${(n / 1000).toFixed(n < 10000 ? 1 : 0)}k`
}
function modelOf(s: ApiSession | null): string {
  if (!s) return ''
  if (s.model?.trim()) return s.model.trim()
  const m = s.flags?.match(/--model[= ]+(\S+)/)
  return m?.[1] ?? ''
}
function relTime(iso?: string): string {
  if (!iso) return ''
  const then = Date.parse(iso)
  if (Number.isNaN(then)) return ''
  const secs = Math.max(0, Math.round((Date.now() - then) / 1000))
  if (secs < 45) return 'now'
  const mins = Math.round(secs / 60)
  if (mins < 60) return `${mins}m`
  const hrs = Math.round(mins / 60)
  if (hrs < 24) return `${hrs}h`
  const days = Math.round(hrs / 24)
  return days === 1 ? 'Yesterday' : `${days}d`
}

/** Role presets that PREFILL the role/desc textarea (the durable job). Picking
 *  one seeds the field; the user edits from there and blur saves. */
const ROLE_PRESETS: { label: string; text: string }[] = [
  {
    label: 'Reviewer',
    text: 'You review changes for correctness and clarity. Read the diff, flag real bugs and risky edits, and keep feedback specific and actionable. Never merge; report findings.',
  },
  {
    label: 'Builder',
    text: 'You implement features end to end. Prefer small, verifiable steps; run the tests before claiming done; keep changes scoped to the task.',
  },
  {
    label: 'Researcher',
    text: 'You investigate and explain. Search broadly, cite the files you read, and return a structured answer — findings first, then the evidence.',
  },
  {
    label: 'Ops',
    text: 'You keep things running. Watch health, act on failures, prefer the least-destructive recovery, and always say what you changed.',
  },
]

/* ── section shell (Tailwind, portal-safe) ─────────────────────────────────── */

/** Exported for `<TeamPanel>`, which copies BotPanel's FRAME (tabs, tablist,
 *  scrolling body) but shares its section primitives rather than re-declaring
 *  them — the panels must look like one family, and a second copy would drift.
 *  BotPanel itself is NOT generalised: no `variant` prop crosses the two. */
export function Field({
  label,
  hint,
  children,
}: {
  label: string
  hint?: string
  children: React.ReactNode
}) {
  return (
    <section className="flex flex-col gap-2">
      <div className="flex flex-col gap-0.5">
        <h3 className="text-[13px] font-semibold tracking-tight text-foreground">{label}</h3>
        {hint && <p className="text-[12px] leading-snug text-muted-foreground">{hint}</p>}
      </div>
      {children}
    </section>
  )
}

/** The "Applies on next start" advisory — shown after a launch-line change
 *  (model / notes / a grant) so the user knows the live agent was NOT relaunched.
 *  Now carries the one-tap restart that closes the loop (was advice with no
 *  button); a mid-turn bot arms first. */
function RestartHint({ name }: { name: string }) {
  return (
    <div className="mt-1 flex flex-wrap items-center gap-2 rounded-md bg-muted/60 px-2 py-1.5">
      <span className="inline-flex items-center gap-1.5 text-[12px] text-muted-foreground">
        <ArrowRight className="size-3 shrink-0" aria-hidden />
        Applies on next start — the running agent keeps its current setup.
      </span>
      <RestartToApply name={name} />
    </div>
  )
}

/* ── model picker ──────────────────────────────────────────────────────────── */

function ModelPicker({
  name,
  session,
  onRestartAdvised,
}: {
  name: string
  session: ApiSession | null
  onRestartAdvised: () => void
}) {
  const { setModel, pending } = useSessionConfig()
  const options = modelOptions(session?.provider)
  const current = modelOf(session)
  const currentLabel = options.find((o) => o.value === current)?.label ?? current ?? 'Default'

  if (options.length === 0) {
    return (
      <p className="text-[13px] text-muted-foreground">
        {session?.provider ? `${session.provider} runs one model — no selection.` : 'No model selection.'}
      </p>
    )
  }

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          disabled={pending}
          data-vr="bot-model-picker"
          className={cn(
            'inline-flex min-h-9 items-center gap-1.5 rounded-[10px] border border-input bg-card px-3 text-[13px] font-medium text-foreground',
            'transition-colors hover:bg-accent/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50',
          )}
        >
          <span className="font-mono">{currentLabel || 'Default'}</span>
          <ChevronDown className="size-3.5 text-muted-foreground" aria-hidden />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="min-w-[180px]">
        {options.map((o) => (
          <DropdownMenuItem
            key={o.value || 'default'}
            data-vr="bot-model-option"
            onSelect={() => {
              if (o.value === current) return
              void setModel(name, o.value).then((restart) => {
                if (restart) onRestartAdvised()
              })
            }}
          >
            <span className="flex-1 font-mono text-[13px]">{o.label}</span>
            {o.value === current && <Check className="size-4 shrink-0" aria-hidden />}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

/* ── notes (memory) editor — launch-injected, read-only to the bot at runtime ── */

function NotesEditor({
  name,
  memory,
  onRestartAdvised,
}: {
  name: string
  memory: string
  onRestartAdvised: () => void
}) {
  const { setMemory, pending } = useSessionConfig()
  const [draft, setDraft] = React.useState(memory)
  const focused = React.useRef(false)
  React.useEffect(() => {
    if (!focused.current) setDraft(memory)
  }, [memory])

  const commit = () => {
    focused.current = false
    const next = draft.trim()
    if (next === (memory ?? '').trim()) return
    void setMemory(name, next).then((restart) => {
      if (restart) onRestartAdvised()
    })
  }

  return (
    <textarea
      value={draft}
      onChange={(e) => setDraft(e.target.value)}
      onFocus={() => {
        focused.current = true
      }}
      onBlur={commit}
      disabled={pending}
      rows={3}
      placeholder="Facts this bot should always have on hand — conventions, endpoints, who owns what…"
      aria-label="Notes this bot keeps"
      data-vr="bot-notes"
      className="w-full resize-y rounded-md border border-input bg-transparent px-2 py-1.5 text-sm outline-none placeholder:text-muted-foreground focus-visible:ring-2 focus-visible:ring-ring"
    />
  )
}

/* ── working-dir row (mono + copy + Files link) ────────────────────────────── */

export function WorkingDirRow({ name, dir }: { name: string; dir: string }) {
  const [copied, setCopied] = React.useState(false)
  const timer = React.useRef<ReturnType<typeof setTimeout> | null>(null)
  React.useEffect(() => () => { if (timer.current) clearTimeout(timer.current) }, [])
  if (!dir) return <p className="text-sm text-muted-foreground">Not set.</p>
  const copy = () => {
    void navigator.clipboard?.writeText(dir).then(() => {
      setCopied(true)
      if (timer.current) clearTimeout(timer.current)
      timer.current = setTimeout(() => setCopied(false), 1500)
    }).catch(() => {})
  }
  return (
    <div className="flex items-center gap-1.5">
      <code className="min-w-0 flex-1 truncate rounded-md bg-muted/60 px-2 py-1.5 font-mono text-[12px] text-foreground">
        {dir}
      </code>
      <button
        type="button"
        onClick={copy}
        aria-label="Copy working directory"
        title={copied ? 'Copied' : 'Copy'}
        className="grid size-9 shrink-0 place-items-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        {copied ? <Check className="size-4 text-status-active-ink" aria-hidden /> : <Copy className="size-4" aria-hidden />}
      </button>
      <Link
        to={`/files/${encodeURIComponent(name)}`}
        aria-label="Open in file browser"
        title="Files"
        className="grid size-9 shrink-0 place-items-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        <FolderOpen className="size-4" aria-hidden />
      </Link>
    </div>
  )
}

/* ── the four tabs ─────────────────────────────────────────────────────────── */

type TabKey = 'overview' | 'instructions' | 'tools' | 'memory' | 'activity'
const TABS: { key: TabKey; label: string }[] = [
  { key: 'overview', label: 'Overview' },
  { key: 'instructions', label: 'Instructions' },
  { key: 'tools', label: 'Tools' },
  { key: 'memory', label: 'Memory' },
  { key: 'activity', label: 'Activity' },
]

/** The CORE-notes cap — stated plainly (the truth about when edits land). */
const CORE_NOTES_CAP = 2000

function MemoryTab({
  name,
  session,
  onRestartAdvised,
}: {
  name: string
  session: ApiSession | null
  onRestartAdvised: () => void
}) {
  const memory = session?.memory ?? ''
  return (
    <div className="flex flex-col gap-6">
      <Field
        label="Core notes"
        hint="Kept verbatim and injected into the system prompt every run — the bot reads these, but can't rewrite them."
      >
        <NotesEditor name={name} memory={memory} onRestartAdvised={onRestartAdvised} />
        <p className="mt-1 text-[12px] tabular-nums text-muted-foreground">
          ~{memory.length} / {CORE_NOTES_CAP} chars · restart to apply
        </p>
      </Field>

      <LearnedNotes name={name} />
    </div>
  )
}

function OverviewTab({
  name,
  session,
}: {
  name: string
  session: ApiSession | null
}) {
  const pct = ctxPct(session?.tokens)
  const tokens = fmtTokens(session?.tokens)
  const model = modelOf(session)
  const preview =
    session?.chat_tail?.agent?.trim() ||
    session?.chat_tail?.user?.trim() ||
    session?.task_summary?.trim() ||
    ''
  const dir = session?.dir?.trim() || ''

  return (
    <div className="flex flex-col gap-6">
      {/* the glance — Context ring HERO + Tokens + Provider + Status */}
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <div className="flex flex-col rounded-2xl border border-border bg-card p-4">
          <span className="text-[11px] font-bold uppercase tracking-wider text-muted-foreground">Context</span>
          {pct !== null ? (
            <div
              className="relative mt-2 size-11"
              style={{
                borderRadius: '50%',
                background: `conic-gradient(${ringColor(pct)} ${pct}%, var(--muted, #e5e5e5) 0)`,
              }}
            >
              <span className="absolute inset-[6px] grid place-items-center rounded-full bg-card font-mono text-[12px] font-bold text-foreground">
                {pct}%
              </span>
            </div>
          ) : (
            <span className="mt-2 text-base font-semibold text-foreground">—</span>
          )}
          <span className="mt-1.5 text-[11.5px] text-muted-foreground">{tokens ? `${tokens} tokens` : 'no tokens yet'}</span>
        </div>
        <div className="flex flex-col rounded-2xl border border-border bg-card p-4">
          <span className="text-[11px] font-bold uppercase tracking-wider text-muted-foreground">Tokens</span>
          <span className="mt-2 font-mono text-[22px] font-semibold tabular-nums text-foreground">{tokens ?? '0'}</span>
          <span className="mt-0.5 text-[11.5px] text-muted-foreground">cumulative</span>
        </div>
        <div className="flex flex-col rounded-2xl border border-border bg-card p-4">
          <span className="text-[11px] font-bold uppercase tracking-wider text-muted-foreground">Provider</span>
          <span className="mt-2 text-base font-semibold capitalize text-foreground">{session?.provider ?? '—'}</span>
          <span className="mt-0.5 text-[11.5px] text-muted-foreground">{model || (session?.runtime === 'native' ? 'native runtime' : 'runtime')}</span>
        </div>
        <div className="flex flex-col rounded-2xl border border-border bg-card p-4">
          <span className="text-[11px] font-bold uppercase tracking-wider text-muted-foreground">Status</span>
          <span className="mt-2 text-base font-semibold capitalize text-foreground">{session?.status ?? '—'}</span>
          <span className="mt-0.5 text-[11.5px] text-muted-foreground">{relTime(session?.updated_at) || '—'}</span>
        </div>
      </div>

      {preview && (
        <Field label="Latest">
          <div className="max-w-[64ch] rounded-2xl rounded-bl-md border border-border bg-card px-4 py-3 text-sm leading-relaxed text-foreground">
            {preview}
            <div className="mt-2 text-[12px] text-muted-foreground">{relTime(session?.updated_at)}</div>
          </div>
        </Field>
      )}

      <Field label="Tags" hint="Searchable across the roster.">
        <TagsEditor name={name} tags={session?.tags ?? []} />
      </Field>

      <Field label="Working directory">
        <WorkingDirRow name={name} dir={dir} />
      </Field>
    </div>
  )
}

/** The LEAD's instructions, verbatim, when `<TeamPanel>` mounts it — a crew is
 *  steered by steering its lead, so there is exactly ONE instructions surface. */
export function InstructionsTab({
  name,
  session,
  onRestartAdvised,
}: {
  name: string
  session: ApiSession | null
  onRestartAdvised: () => void
}) {
  // Prefill the role/desc field by writing through the SAME hook DescEditor
  // uses; the editor re-seeds from the row on the next render.
  const { setDesc } = useSessionConfig()
  const desc = session?.desc ?? ''

  return (
    <div className="flex flex-col gap-6">
      <Field
        label="What this bot does"
        hint="The durable role, injected into the agent's system prompt at launch — this steers every turn. Tasks still go in the message; this is the standing job."
      >
        <div className="flex flex-wrap gap-1.5">
          {ROLE_PRESETS.map((p) => (
            <button
              key={p.label}
              type="button"
              data-vr="bot-role-preset"
              onClick={() => void setDesc(name, p.text)}
              className="rounded-full border border-border bg-secondary px-3 py-1 text-[12px] font-medium text-foreground transition-colors hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              {p.label}
            </button>
          ))}
        </div>
        <DescEditor name={name} desc={desc} />
      </Field>

      <Field
        label="Model"
        hint="The launch model for this bot."
      >
        <ModelPicker name={name} session={session} onRestartAdvised={onRestartAdvised} />
      </Field>

      <Field
        label="Notes this bot keeps"
        hint="Injected read-only into the system prompt at launch — the bot can read these, but not rewrite them."
      >
        <NotesEditor name={name} memory={session?.memory ?? ''} onRestartAdvised={onRestartAdvised} />
      </Field>

      <Field label="Notifications">
        <NotifPolicyControl name={name} value={session?.notif} />
      </Field>
    </div>
  )
}

/** The lead's tools. `<TeamPanel>` mounts this too, labelled crew-scoped: a
 *  teammate pane inherits the lead's env/config, so the lead's grants ARE the
 *  crew's grants. */
export function ToolsTab({ name, session }: { name: string; session: ApiSession | null }) {
  const mcp = session?.mcp?.trim() || ''
  return (
    <div className="flex flex-col gap-6">
      {/* Connectors are the HERO of this tab — the real, per-bot action surface —
          so they lead. The Skills placeholder + MCP + launch flags fold behind
          Advanced below, where they stop pushing the live content down. */}
      <GrantedConnectors name={name} />

      <details className="group rounded-xl border border-border bg-card px-4 py-3">
        <summary className="cursor-pointer list-none text-[13px] font-medium text-foreground [&::-webkit-details-marker]:hidden">
          Advanced
        </summary>
        <div className="mt-3 flex flex-col gap-4">
          <div className="flex items-baseline justify-between gap-3">
            <dt className="text-muted-foreground text-[13px]">Skills</dt>
            <dd className="text-[13px] text-foreground">Workspace defaults</dd>
          </div>
          <div className="flex flex-col gap-1">
            <dt className="text-muted-foreground text-[13px]">MCP</dt>
            <dd className="min-w-0">
              {mcp ? (
                <code className="block max-w-full truncate rounded-md bg-muted/60 px-2 py-1.5 font-mono text-[12px] text-foreground">
                  {mcp}
                </code>
              ) : (
                <span className="text-[13px] text-muted-foreground">None</span>
              )}
            </dd>
          </div>
        </div>
        <dl className="mt-4 flex flex-col gap-2 border-t border-border pt-3 text-[13px]">
          <div className="flex items-baseline justify-between gap-3">
            <dt className="text-muted-foreground">Flags</dt>
            <dd className="min-w-0 text-right">
              {session?.flags?.trim() ? (
                <code className="max-w-full truncate rounded bg-muted/60 px-1.5 py-0.5 font-mono text-[11px]">{session.flags}</code>
              ) : (
                <span className="text-muted-foreground">None</span>
              )}
            </dd>
          </div>
          <div className="flex items-baseline justify-between gap-3">
            <dt className="text-muted-foreground">Worktree</dt>
            <dd>{session ? (session.worktree ? 'Yes' : 'No') : '—'}</dd>
          </div>
          <div className="flex items-baseline justify-between gap-3">
            <dt className="text-muted-foreground">Runtime</dt>
            <dd className="capitalize">{session?.runtime ?? '—'}</dd>
          </div>
        </dl>
      </details>
    </div>
  )
}

function ActivityTab({
  name,
  onNavigate,
}: {
  name: string
  onNavigate: (name: string) => void
}) {
  const [issuesOpen, setIssuesOpen] = React.useState(false)
  const [openIssueId, setOpenIssueId] = React.useState<string | null>(null)
  const { session } = useSession(name)

  return (
    <div className="flex flex-col gap-6">
      <Field label="Schedules">
        <SchedulesList name={name} />
      </Field>

      <Field label="Issues">
        <div className="flex flex-col gap-2">
          <IssueList
            session={name}
            onOpen={(issue) => {
              setOpenIssueId(issue.id)
              setIssuesOpen(true)
            }}
          />
          <button
            type="button"
            onClick={() => {
              setOpenIssueId(null)
              setIssuesOpen(true)
            }}
            className="self-start rounded-md px-1 py-1 text-xs text-primary hover:underline"
          >
            Open issues →
          </button>
        </div>
      </Field>
      <IssueSurface
        open={issuesOpen}
        onOpenChange={setIssuesOpen}
        initialIssueId={openIssueId}
        session={name}
        title={displayLabel(session ?? { name })}
        onFocusSession={(target) => {
          setIssuesOpen(false)
          onNavigate(target)
        }}
      />

      <Field label="Git">
        <GitRow name={name} />
      </Field>
    </div>
  )
}

/* ── the panel body (shared by both variants) ──────────────────────────────── */

function BotPanelBody({
  name,
  variant,
  onOpenThread,
  onOpenTerminal,
  onNavigate,
  initialTab,
}: {
  name: string
  variant: 'pane' | 'sheet'
  onOpenThread: () => void
  /** When set, this bot cannot be a chat surface (Codex/shell/remote/team-lead),
   *  so the header offers "Open terminal →" (→ /focus) INSTEAD of "Open thread". */
  onOpenTerminal?: () => void
  onNavigate: (name: string) => void
  /** Dev/bench only: seat a specific tab so a still frame can show each one. */
  initialTab?: TabKey
}) {
  const { session } = useSession(name)
  const clone = useCloneSession()
  const { toast } = useToast()
  const [tab, setTab] = React.useState<TabKey>(initialTab ?? 'overview')
  const [restartAdvised, setRestartAdvised] = React.useState(false)
  const onRestartAdvised = React.useCallback(() => setRestartAdvised(true), [])

  const label = displayLabel(session ?? { name })
  const model = modelOf(session)
  const sub = [session?.status, model || session?.provider, session?.branch].filter(Boolean).join(' · ')

  const doClone = async () => {
    if (clone.pending) return
    try {
      const newName = await clone.run(name)
      toast({ message: `Cloned to ${newName}`, tone: 'active' })
      onNavigate(newName)
    } catch (e) {
      toast({ message: `Clone failed — ${(e as Error).message}`, tone: 'error', duration: 4000 })
    }
  }

  return (
    <div className={cn('flex min-h-0 flex-col', variant === 'pane' && 'h-full')}>
      {/* sticky header — face · editable name · sub-line · Open thread · [...] */}
      <header className="flex items-center gap-3 border-b border-border bg-background/80 px-5 py-3 backdrop-blur-sm">
        <SessionFace name={name} status={session?.status} size={40} />
        <div className="flex min-w-0 flex-1 flex-col">
          <div className="min-w-0">
            <NameEditor name={name} displayName={label} />
          </div>
          {sub && <span className="mt-0.5 truncate text-[12.5px] capitalize text-muted-foreground">{sub}</span>}
        </div>
        {onOpenTerminal ? (
          <button
            type="button"
            onClick={onOpenTerminal}
            data-vr="bot-open-terminal"
            className="inline-flex min-h-9 shrink-0 items-center gap-1.5 rounded-[10px] bg-primary px-3 text-[13px] font-medium text-primary-foreground shadow-sm transition-colors hover:bg-primary/90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            <Terminal className="size-3.5" aria-hidden />
            Open terminal
            <ArrowRight className="size-3.5" aria-hidden />
          </button>
        ) : (
          <button
            type="button"
            onClick={onOpenThread}
            data-vr="bot-open-thread"
            className="inline-flex min-h-9 shrink-0 items-center gap-1.5 rounded-[10px] bg-primary px-3 text-[13px] font-medium text-primary-foreground shadow-sm transition-colors hover:bg-primary/90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            Open thread
            <ArrowRight className="size-3.5" aria-hidden />
          </button>
        )}
        {session && (
          <SessionActionsMenu
            session={session}
            variant="row"
            className="!static !size-9 !opacity-100"
          />
        )}
      </header>

      {/* tab bar — a plain `div` carries `role="tablist"` (a `nav` is a landmark
          and may not take an interactive role: jsx-a11y/no-noninteractive-
          element-to-interactive-role). Full WAI-ARIA tab pattern: roving
          `tabindex`, arrow-key movement, and each tab `aria-controls` the one
          panel it drives (`aria-labelledby` points back). */}
      <div
        role="tablist"
        aria-label="Bot settings"
        className="flex shrink-0 items-center gap-1 border-b border-border px-4"
      >
        {TABS.map((t, ti) => (
          <button
            key={t.key}
            type="button"
            role="tab"
            id={`bot-tab-${t.key}`}
            aria-selected={tab === t.key}
            aria-controls="bot-tabpanel"
            tabIndex={tab === t.key ? 0 : -1}
            data-vr="bot-tab"
            data-vr-tab={t.key}
            onClick={() => setTab(t.key)}
            // Roving-tabindex arrow movement lives on the tabs themselves (they
            // are the focusable elements); the tablist container stays a plain,
            // non-focusable grouping so it needs no tabindex.
            onKeyDown={(e) => {
              if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return
              e.preventDefault()
              const next =
                e.key === 'ArrowRight'
                  ? (ti + 1) % TABS.length
                  : (ti - 1 + TABS.length) % TABS.length
              setTab(TABS[next].key)
              e.currentTarget.parentElement
                ?.querySelectorAll<HTMLButtonElement>('[role="tab"]')[next]
                ?.focus()
            }}
            className={cn(
              'relative -mb-px min-h-11 px-3 text-[13px] font-medium transition-colors',
              'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
              tab === t.key
                ? 'text-foreground after:absolute after:inset-x-2 after:bottom-0 after:h-0.5 after:rounded-full after:bg-primary'
                : 'text-muted-foreground hover:text-foreground',
            )}
          >
            {t.label}
          </button>
        ))}
      </div>

      {/* scrolling tab body */}
      <div
        className={cn(
          'min-h-0 flex-1 overflow-y-auto px-5 py-5 [scrollbar-width:thin]',
          variant === 'sheet' && 'max-h-[70vh]',
        )}
        role="tabpanel"
        id="bot-tabpanel"
        aria-labelledby={`bot-tab-${tab}`}
        tabIndex={0}
      >
        {restartAdvised && <div className="mb-4"><RestartHint name={name} /></div>}
        {tab === 'overview' && (
          <OverviewTab name={name} session={session} />
        )}
        {tab === 'instructions' && (
          <InstructionsTab name={name} session={session} onRestartAdvised={onRestartAdvised} />
        )}
        {tab === 'tools' && <ToolsTab name={name} session={session} />}
        {tab === 'memory' && (
          <MemoryTab name={name} session={session} onRestartAdvised={onRestartAdvised} />
        )}
        {tab === 'activity' && <ActivityTab name={name} onNavigate={onNavigate} />}

        {/* Clone — the panel's footer action, on every tab's scroll floor */}
        <div className="mt-8 border-t border-border pt-5">
          <button
            type="button"
            onClick={doClone}
            disabled={clone.pending}
            className="inline-flex min-h-11 w-full items-center justify-center gap-2 rounded-[10px] border border-border bg-card px-4 text-sm font-medium text-foreground transition-colors hover:bg-accent/40 disabled:pointer-events-none disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            {clone.pending ? <Loader2 className="size-4 animate-spin" aria-hidden /> : <FilesIcon className="size-4" aria-hidden />}
            {clone.pending ? 'Cloning…' : 'Clone bot in this directory'}
          </button>
        </div>
      </div>
    </div>
  )
}

/* ── the public component ──────────────────────────────────────────────────── */

export interface BotPanelProps {
  name: string
  variant: 'pane' | 'sheet'
  /** Navigate to the bot's focus thread. */
  onOpenThread: () => void
  /** pane only, ineligible bots: show "Open terminal →" (→ /focus) in the header
   *  instead of "Open thread", since this bot cannot render as a chat surface. */
  onOpenTerminal?: () => void
  /** Navigate to a session's focus route (used by Clone + issue focus). */
  onNavigate: (name: string) => void
  /** sheet only. */
  open?: boolean
  onOpenChange?: (open: boolean) => void
  /** Dev/bench only: seat a specific tab so a still frame can show each one. */
  initialTab?: 'overview' | 'instructions' | 'tools' | 'memory' | 'activity'
}

export function BotPanel({
  name,
  variant,
  onOpenThread,
  onOpenTerminal,
  onNavigate,
  open,
  onOpenChange,
  initialTab,
}: BotPanelProps) {
  if (variant === 'sheet') {
    return (
      <ResponsiveSheet
        open={open ?? false}
        onOpenChange={onOpenChange ?? (() => {})}
        title="Bot"
        description={name}
        className="max-w-2xl"
      >
        {/* `data-grok` so the sheet (portalled to <body>, outside the shell root)
            still resolves the Grok accent tokens, exactly like command-palette. */}
        <div data-grok>
          <BotPanelBody
            name={name}
            variant="sheet"
            initialTab={initialTab}
            onOpenThread={() => {
              onOpenChange?.(false)
              onOpenThread()
            }}
            onNavigate={(n) => {
              onOpenChange?.(false)
              onNavigate(n)
            }}
          />
        </div>
      </ResponsiveSheet>
    )
  }

  return (
    <div className="gr-pane gr-botpane" data-shell-pane>
      <BotPanelBody
        name={name}
        variant="pane"
        onOpenThread={onOpenThread}
        onOpenTerminal={onOpenTerminal}
        onNavigate={onNavigate}
        initialTab={initialTab}
      />
    </div>
  )
}

export default BotPanel
