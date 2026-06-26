import * as React from 'react'
import { motion } from 'framer-motion'
import {
  AlertTriangle,
  ChevronDown,
  Folder,
  FolderPlus,
  GitBranch,
  Loader2,
  Sparkles,
} from 'lucide-react'

import { cn } from '@/lib/utils'
import { springs } from '@/lib/springs'
import { Input } from '@/components/ui/input'
import {
  displayLabel,
  projectsApi,
  sessionsApi,
  type ApiSession,
  type ProjectRepo,
} from '@/lib/api'
import { useSessions } from '@/hooks/use-sessions'
import { homeDir, projectsDir } from '@/env'
import { createProjectFolder } from '@/lib/create-project-folder'
import { StatusDot, STATUS_LABEL } from './status-dot'

// ── Where picker ─────────────────────────────────────────────────────────────
// The "Where" picker (replaces the old "Directory" field) handles the three
// distinct flows the user explicitly asked for, in a single scrollable list:
//
//   1. YOUR SESSIONS  (top)  — running/stopped sessions whose directory is
//                              outside the projects root, OR whose row would
//                              otherwise dedupe under a Project entry. Tap =
//                              "Take over" (calls /api/teams/start-from-existing
//                              behind the scenes). Most-recent-first.
//   2. PROJECTS       (mid)  — immediate git-repo subdirs of the deploy-
//                              configured projects root. Dotfile dirs hidden.
//                              A row dedupes when an existing session already
//                              points at the same directory (the session row
//                              wins — it carries more context). Non-git folders
//                              get a calm amber warning icon.
//   3. USE ANOTHER…   (bot)  — collapsed by default. Two affordances:
//                                 • free-text input + autocomplete (dotfiles
//                                   filtered; non-git folders show the same
//                                   amber hint as Projects)
//                                 • "Create a new folder" — name input that
//                                   creates a subdir under `projectsDir()` and
//                                   uses it.
//
// The picker is a controlled component that emits a `WhereSelection`:
//   { kind: 'new', dir: string }            — fresh dir / project / new folder
//   { kind: 'session', session: ApiSession } — take over the existing session
// The parent sheet morphs its title, description, submit copy and submit
// endpoint based on the selection's kind.
//
// Reuse / DRY: each row uses the same visual language as the focus-mode
// session-picker-sheet (44pt rows, status dot for sessions, motion press),
// so the whole sheet feels like one family.

// ── public API ───────────────────────────────────────────────────────────────

/** A "fresh dir" pick — a new (or existing) folder to run the agent/lead in. */
export type NewWhereSelection = { kind: 'new'; dir: string }
/** A "take over" pick — convert an existing session into a team lead in place. */
export type SessionWhereSelection = { kind: 'session'; session: ApiSession }

/** Discriminated union of the two pick kinds. The picker can be narrowed at
 *  compile time to ONLY emit `NewWhereSelection` by passing `showSessions={false}`
 *  — see the overloaded signature on [`WherePicker`] below. */
export type WhereSelection = NewWhereSelection | SessionWhereSelection

/** Common props shared by both modes of the picker. */
interface WherePickerBaseProps {
  /** DOM id prefix for inputs (must be unique per sheet). */
  id?: string
  /** Controls the calm-amber "Not a git repo" warning banner under the picker.
   *
   *   - `'warn'` (default) — show the amber GitRepoHint banner when the current
   *     selection is a non-git project folder. Used by Start-a-team: each
   *     teammate gets its own git worktree, so non-git fails without hooks.
   *   - `'info'` / `'none'` — suppress the banner. A normal session (New
   *     Session) can run anywhere; the warning would just be noise. The small
   *     per-row `git`/`no git` chip in the Projects section is kept either way
   *     (useful context at a glance).
   */
  gitHint?: 'warn' | 'info' | 'none'
  /** Disable the sessions section (legacy; not used now that `showSessions`
   *  exists). Kept for back-compat. Defaults to false. */
  sessionsDisabled?: boolean
}

/** Props when the picker is allowed to emit BOTH "new" and "session" picks. */
export interface WherePickerFullProps extends WherePickerBaseProps {
  value: WhereSelection
  onChange: (selection: WhereSelection) => void
  /** Show the "Your sessions" take-over section. Defaults to `true`. */
  showSessions?: true
}

/** Props when the picker is locked to "new" picks only. The Sessions section
 *  is suppressed entirely (no session rows are rendered, so the user can't
 *  even attempt a take-over from this surface). `value`/`onChange` are typed
 *  so the parent's state can be `NewWhereSelection` — no runtime guard or
 *  assertion needed at the call site. */
export interface WherePickerNewOnlyProps extends WherePickerBaseProps {
  value: NewWhereSelection
  onChange: (selection: NewWhereSelection) => void
  /** Lock the picker to "new" picks only. Defaults to `true` when omitted. */
  showSessions: false
}

export type WherePickerProps = WherePickerFullProps | WherePickerNewOnlyProps

/** Initial selection helper used by callers — picks `projectsDir()` if set,
 *  else `homeDir()`. Always with a trailing slash so the autocomplete on focus
 *  immediately surfaces the project subdirs. The return type is the narrow
 *  `NewWhereSelection` so callers using the new-only picker (New Session)
 *  don't need to cast. */
export function defaultWhereSelection(): NewWhereSelection {
  const p = projectsDir()
  if (p) return { kind: 'new', dir: p.endsWith('/') ? p : `${p}/` }
  return { kind: 'new', dir: homeDir() }
}

// ── component ────────────────────────────────────────────────────────────────

export function WherePicker(props: WherePickerProps) {
  const {
    value,
    onChange,
    id = 'where',
    sessionsDisabled = false,
    gitHint = 'warn',
  } = props as WherePickerFullProps & { sessionsDisabled?: boolean }
  // Discriminated narrowing: when callers pass `showSessions={false}` we
  // suppress the Sessions section entirely AND treat any stray `kind: 'session'`
  // selection as unreachable (the prop overload prevents it at compile time —
  // this is the runtime backstop). Default is `true` so existing callers
  // (Start-a-team) behave identically.
  const showSessions = props.showSessions !== false
  const { sessions } = useSessions()
  const [projects, setProjects] = React.useState<ProjectRepo[]>([])
  const [projectsLoaded, setProjectsLoaded] = React.useState(false)

  // Refetch the projects list — used on mount and after Create-new-folder so
  // the section reflects the freshly-created entry without reopening the sheet.
  const refreshProjects = React.useCallback(async () => {
    const res = await projectsApi.list()
    setProjects(res.entries)
    setProjectsLoaded(true)
  }, [])

  // Load the project repos once on mount. The picker is cheap to render
  // without them (the sessions section + free-text input still work).
  React.useEffect(() => {
    let alive = true
    projectsApi.list().then((res) => {
      if (alive) {
        setProjects(res.entries)
        setProjectsLoaded(true)
      }
    })
    return () => {
      alive = false
    }
  }, [])

  // Sessions section (sorted most-recent first, archived rows are already
  // filtered server-side by /api/sessions). Stable selection is by `name`.
  const sessionRows = React.useMemo(() => {
    return [...sessions]
      .filter((s) => !s.archived)
      .sort((a, b) => (b.last_activity ?? 0) - (a.last_activity ?? 0))
  }, [sessions])

  // Dedupe rule: a project row whose `path` matches an existing session's
  // `dir` collapses under the session row (the session carries more context
  // — name, status, last activity — so it wins). Compares with trailing-slash
  // normalisation so `/opt/projects/foo` and `/opt/projects/foo/` are equal.
  const sessionDirs = React.useMemo(
    () => new Set(sessionRows.map((s) => normaliseDir(s.dir))),
    [sessionRows],
  )
  const projectRows = React.useMemo(
    () => projects.filter((p) => !sessionDirs.has(normaliseDir(p.path))),
    [projects, sessionDirs],
  )

  const selectedSessionName = value.kind === 'session' ? value.session.name : null
  const selectedDir = value.kind === 'new' ? value.dir : null

  return (
    <div className="flex flex-col gap-3">
      <label className="text-sm font-medium" htmlFor={`${id}-summary`}>
        Where
      </label>

      {/* Current selection summary — always visible so the user sees what
          they're about to commit to before scrolling the list. Copy varies
          with the parent context: Start-a-team says "Team will run in:" (the
          team voice); New-Session (showSessions={false}) says "Will run in:"
          (no team noun) so the picker reads correctly in both surfaces. */}
      <SelectionSummary
        id={`${id}-summary`}
        value={value}
        teamVoice={showSessions}
      />

      {/* Scrollable list. max-h is large enough to feel like real content
          (not a tiny dropdown) but capped so the sheet's other fields stay
          reachable without thumb gymnastics. */}
      <div className="flex max-h-[44vh] min-h-[12rem] flex-col gap-3 overflow-y-auto rounded-lg border border-border bg-card/30 p-2">
        {/* ── Section 1: Your sessions ─────────────────────────────────── */}
        {/* Suppressed entirely when `showSessions={false}` — the New-Session
            consumer has no take-over flow, so showing rows that can't be
            picked would be a dead-end. */}
        {showSessions && sessionRows.length > 0 && (
          <Section
            label="Your sessions"
            hint="Take over an existing session as the team lead."
          >
            {sessionRows.map((s) => (
              <SessionRow
                key={s.name}
                session={s}
                selected={selectedSessionName === s.name}
                disabled={sessionsDisabled}
                onPick={() =>
                  (onChange as (sel: WhereSelection) => void)({
                    kind: 'session',
                    session: s,
                  })
                }
              />
            ))}
          </Section>
        )}

        {/* ── Section 2: Projects ──────────────────────────────────────── */}
        {projectsLoaded && projectRows.length > 0 && (
          <Section
            label="Projects"
            hint={
              projects.some((p) => !p.is_git_repo)
                ? 'A non-git folder will be flagged below.'
                : undefined
            }
          >
            {projectRows.map((p) => (
              <ProjectRow
                key={p.path}
                project={p}
                selected={selectedDir === p.path || selectedDir === `${p.path}/`}
                onPick={() => onChange({ kind: 'new', dir: p.path })}
              />
            ))}
          </Section>
        )}

        {/* ── Section 3: Use another folder ────────────────────────────── */}
        <UseAnotherFolder
          id={id}
          value={selectedDir ?? ''}
          onPick={(dir) => onChange({ kind: 'new', dir })}
          projectRows={projectRows}
          sessionDirs={sessionDirs}
          onCreated={refreshProjects}
          // Expanded by default ONLY when the active selection is genuinely
          // outside the picker's known set — i.e. not a project entry AND
          // not the bare projects-root sentinel that's used as the default.
          // Avoids eating vertical space on first open.
          initiallyOpen={(() => {
            if (!selectedDir) return false
            const p = projectsDir()
            const rootBare = p ? (p.endsWith('/') ? p.slice(0, -1) : p) : ''
            const rootSlash = p ? (p.endsWith('/') ? p : `${p}/`) : ''
            if (rootBare && (selectedDir === rootBare || selectedDir === rootSlash)) {
              return false
            }
            return !projects.some(
              (proj) =>
                proj.path === selectedDir || `${proj.path}/` === selectedDir,
            )
          })()}
        />
      </div>

      {/* Calm git-repo warning — surfaces at the bottom of the picker when
          the current selection is a non-git folder. Amber, never red; never
          blocks submit (advanced users may have WorktreeCreate hooks).
          Suppressed when `gitHint !== 'warn'`: a normal New-Session can run
          anywhere, so the amber warning would just be noise. The per-row
          `git`/`no git` chips in Projects are kept either way — useful
          context at a glance. */}
      {gitHint === 'warn' && (
        <GitRepoHint
          value={value}
          projects={projects}
          projectsLoaded={projectsLoaded}
        />
      )}
    </div>
  )
}

// ── selection summary ────────────────────────────────────────────────────────

function SelectionSummary({
  id,
  value,
  teamVoice,
}: {
  id: string
  value: WhereSelection
  /** When true, copy uses the team voice ("Team will run in:"). When false,
   *  copy is generic ("Will run in:") so the picker reads naturally in the
   *  New-Session context. */
  teamVoice: boolean
}) {
  if (value.kind === 'session') {
    const s = value.session
    return (
      <div
        id={id}
        className="flex items-start gap-2 rounded-md border border-amber-500/30 bg-amber-500/[0.06] px-3 py-2 text-xs"
      >
        <Sparkles className="mt-0.5 size-3.5 shrink-0 text-amber-600 dark:text-amber-400" aria-hidden />
        <span className="min-w-0 flex-1">
          <span className="font-medium text-foreground">
            Take over <span className="font-mono">{s.name}</span>
          </span>
          <span className="block truncate text-muted-foreground" title={s.dir}>
            {s.dir}
          </span>
        </span>
      </div>
    )
  }
  const dir = value.dir.trim()
  return (
    <div
      id={id}
      className="flex items-start gap-2 rounded-md border border-border bg-muted/40 px-3 py-2 text-xs"
    >
      <Folder className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" aria-hidden />
      <span className="min-w-0 flex-1">
        <span className="font-medium text-foreground">
          {teamVoice ? 'Team will run in:' : 'Will run in:'}
        </span>
        <span className="block truncate font-mono text-muted-foreground" title={dir}>
          {dir || '(none picked)'}
        </span>
      </span>
    </div>
  )
}

// ── section wrapper ──────────────────────────────────────────────────────────

function Section({
  label,
  hint,
  children,
}: {
  label: string
  hint?: string
  children: React.ReactNode
}) {
  return (
    <section className="flex flex-col gap-1">
      <header className="flex items-center justify-between px-1.5">
        <h3 className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
          {label}
        </h3>
        {hint && (
          <span className="text-[10px] text-muted-foreground/70">{hint}</span>
        )}
      </header>
      <div className="flex flex-col gap-1">{children}</div>
    </section>
  )
}

// ── rows ─────────────────────────────────────────────────────────────────────

/** A session row (Section 1). Two-line: name (bold) + dir (muted). The take-
 *  over copy is owned by the parent sheet's morph — this row just selects.
 *  Shows a small calm amber dot when the session is currently running so the
 *  user knows it'll be restarted. */
function SessionRow({
  session,
  selected,
  disabled,
  onPick,
}: {
  session: ApiSession
  selected: boolean
  disabled: boolean
  onPick: () => void
}) {
  const running =
    !!session.running ||
    session.status === 'active' ||
    session.status === 'starting' ||
    session.status === 'waiting'
  return (
    <motion.button
      type="button"
      whileTap={disabled ? undefined : { scale: 0.98 }}
      transition={springs.buttonPress}
      onClick={disabled ? undefined : onPick}
      disabled={disabled}
      title={`Take over ${displayLabel(session)} — in ${session.dir}`}
      className={cn(
        'flex min-h-11 w-full items-center gap-3 rounded-lg border px-3 py-2 text-left transition-colors outline-none',
        selected
          ? 'border-primary bg-primary/10'
          : 'border-transparent hover:bg-accent/40',
        'focus-visible:ring-2 focus-visible:ring-ring',
        disabled && 'cursor-not-allowed opacity-50',
      )}
    >
      <StatusDot status={session.status} />
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="flex items-center gap-1.5">
          <span className="truncate text-sm font-medium">{displayLabel(session)}</span>
          {running && (
            <span
              className="rounded-full bg-amber-500/15 px-1.5 py-0.5 text-[9px] font-semibold uppercase leading-none tracking-wide text-amber-700 dark:text-amber-300"
              title="Taking this over restarts the session"
            >
              restart
            </span>
          )}
        </span>
        <span className="truncate text-xs text-muted-foreground" title={session.dir}>
          {session.dir}
        </span>
      </span>
      <span className="shrink-0 text-[11px] text-muted-foreground">
        {STATUS_LABEL[session.status]}
      </span>
    </motion.button>
  )
}

/** A project row (Section 2). Shows a tiny `git` badge for git repos and an
 *  amber warning icon for non-git folders. */
function ProjectRow({
  project,
  selected,
  onPick,
}: {
  project: ProjectRepo
  selected: boolean
  onPick: () => void
}) {
  return (
    <motion.button
      type="button"
      whileTap={{ scale: 0.98 }}
      transition={springs.buttonPress}
      onClick={onPick}
      title={project.path}
      className={cn(
        'flex min-h-11 w-full items-center gap-3 rounded-lg border px-3 py-2 text-left transition-colors outline-none',
        selected
          ? 'border-primary bg-primary/10'
          : 'border-transparent hover:bg-accent/40',
        'focus-visible:ring-2 focus-visible:ring-ring',
      )}
    >
      <Folder className="size-4 shrink-0 text-muted-foreground" aria-hidden />
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="truncate text-sm font-medium">{project.name}</span>
        <span className="truncate text-xs text-muted-foreground" title={project.path}>
          {project.path}
        </span>
      </span>
      {project.is_git_repo ? (
        <span
          className="inline-flex shrink-0 items-center gap-1 rounded-full bg-muted/70 px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground"
          title="Git repository"
        >
          <GitBranch className="size-2.5" aria-hidden />
          git
        </span>
      ) : (
        <span
          className="inline-flex shrink-0 items-center gap-1 rounded-full bg-amber-500/15 px-1.5 py-0.5 text-[10px] font-medium text-amber-700 dark:text-amber-300"
          title="Not a git repo — teammates need their own worktree"
        >
          <AlertTriangle className="size-2.5" aria-hidden />
          no git
        </span>
      )}
    </motion.button>
  )
}

// ── Section 3: Use another folder ────────────────────────────────────────────

function UseAnotherFolder({
  id,
  value,
  onPick,
  initiallyOpen,
  projectRows,
  sessionDirs,
  onCreated,
}: {
  id: string
  value: string
  onPick: (dir: string) => void
  initiallyOpen: boolean
  projectRows: ProjectRepo[]
  sessionDirs: Set<string>
  onCreated?: () => void | Promise<void>
}) {
  const [open, setOpen] = React.useState(initiallyOpen)
  const [creating, setCreating] = React.useState(false)
  return (
    <section className="flex flex-col gap-1">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="flex min-h-11 w-full items-center justify-between rounded-lg px-3 py-2 text-left text-sm font-medium text-muted-foreground transition-colors hover:bg-accent/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        <span className="flex items-center gap-2">
          <Folder className="size-4" aria-hidden />
          Use another folder
        </span>
        <ChevronDown
          className={cn(
            'size-4 transition-transform',
            open ? 'rotate-180' : 'rotate-0',
          )}
          aria-hidden
        />
      </button>

      {open && (
        <div className="flex flex-col gap-3 px-1 pb-1 pt-1">
          {/* Free-text path + autocomplete. */}
          <FreeTextDirInput
            id={id}
            value={value}
            onPick={onPick}
            projectRows={projectRows}
            sessionDirs={sessionDirs}
          />

          {/* Create-new-folder affordance. */}
          <div className="flex flex-col gap-1.5 rounded-lg border border-dashed border-border bg-muted/20 p-2">
            <div className="flex items-center gap-2 px-1 text-xs text-muted-foreground">
              <FolderPlus className="size-3.5" aria-hidden />
              <span>Create a new folder</span>
            </div>
            <CreateFolderRow
              busy={creating}
              onCreate={async (name) => {
                setCreating(true)
                try {
                  const created = await createProjectFolder(name)
                  if (!created) {
                    // Signal failure so the CreateFolderRow keeps the typed
                    // value (user can retry without re-typing).
                    throw new Error('create failed')
                  }
                  onPick(created)
                  // Refresh the Projects list so the new folder appears in
                  // the canonical section (was missing until sheet reopen).
                  if (onCreated) await onCreated()
                } finally {
                  setCreating(false)
                }
              }}
            />
          </div>
        </div>
      )}
    </section>
  )
}

/** Free-text path field + suggestion chips (dotfiles filtered). Replaces the
 *  old DirectoryField's chip grid — same visual language but no `+N more`
 *  cap (the chips scroll naturally inside the picker's scroll region). */
function FreeTextDirInput({
  id,
  value,
  onPick,
  projectRows,
  sessionDirs,
}: {
  id: string
  value: string
  onPick: (dir: string) => void
  projectRows: ProjectRepo[]
  sessionDirs: Set<string>
}) {
  const [local, setLocal] = React.useState(value)
  const [suggestions, setSuggestions] = React.useState<string[]>([])
  const debounce = React.useRef<ReturnType<typeof setTimeout> | null>(null)
  const seq = React.useRef(0)

  // Sync inbound `value` -> local input (chip-picks in the picker update the
  // value externally; the input shows the truth).
  React.useEffect(() => {
    setLocal(value)
  }, [value])

  const fetchSuggestions = React.useCallback(async (q: string) => {
    const mine = ++seq.current
    if (!q.trim()) {
      setSuggestions([])
      return
    }
    // hidden=0 → drop `.git` / `.cache` / `.next` noise.
    const next = await sessionsApi.autocompleteDir(q, /* noHidden */ true)
    if (mine !== seq.current) return
    setSuggestions(next)
  }, [])

  React.useEffect(() => {
    if (debounce.current) clearTimeout(debounce.current)
    debounce.current = setTimeout(() => void fetchSuggestions(local), 180)
    return () => {
      if (debounce.current) clearTimeout(debounce.current)
    }
  }, [local, fetchSuggestions])

  // Dedupe suggestions against entries the user already sees in the Sessions
  // and Projects sections above — same Set the picker uses to dedupe projects
  // (trailing-slash normalised).
  const projectPaths = React.useMemo(
    () => new Set(projectRows.map((p) => normaliseDir(p.path))),
    [projectRows],
  )
  const dedupedSuggestions = React.useMemo(
    () =>
      suggestions.filter((s) => {
        const n = normaliseDir(s)
        return !sessionDirs.has(n) && !projectPaths.has(n)
      }),
    [suggestions, sessionDirs, projectPaths],
  )

  return (
    <div className="flex flex-col gap-1.5">
      <label htmlFor={`${id}-path`} className="px-1 text-xs text-muted-foreground">
        Type a path
      </label>
      <Input
        id={`${id}-path`}
        value={local}
        onChange={(e) => {
          setLocal(e.target.value)
          onPick(e.target.value)
        }}
        placeholder="~/projects/app"
        autoComplete="off"
        spellCheck={false}
      />
      {dedupedSuggestions.length > 0 && (
        <div className="grid grid-cols-1 gap-1 sm:grid-cols-2">
          {dedupedSuggestions.map((path) => {
            const trimmed = path.replace(/\/+$/, '')
            const base = trimmed.split('/').pop() || path
            return (
              <motion.button
                key={path}
                type="button"
                whileTap={{ scale: 0.98 }}
                transition={springs.buttonPress}
                onClick={() => {
                  const next = path.endsWith('/') ? path : `${path}/`
                  setLocal(next)
                  onPick(next)
                }}
                title={path}
                className="flex min-h-11 items-center gap-2 rounded-lg border border-border bg-card px-3 py-2 text-left outline-none transition-colors hover:bg-accent/40 focus-visible:ring-2 focus-visible:ring-ring"
              >
                <Folder className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />
                <span className="flex min-w-0 flex-col">
                  <span className="truncate text-sm font-medium">{base}</span>
                  <span className="truncate text-[11px] text-muted-foreground">
                    {path}
                  </span>
                </span>
              </motion.button>
            )
          })}
        </div>
      )}
    </div>
  )
}

function CreateFolderRow({
  busy,
  onCreate,
}: {
  busy: boolean
  onCreate: (name: string) => void | Promise<void>
}) {
  const [name, setName] = React.useState('')
  const root = projectsDir() || homeDir()
  const trimmed = name.trim()
  const safe = /^[A-Za-z0-9._-]+$/.test(trimmed)
  const canCreate = safe && !busy
  const handleCreate = async () => {
    if (!canCreate) return
    try {
      await onCreate(trimmed)
      // Clear so a second Create starts blank. Done after the awaited
      // parent call so the input stays populated if creation throws.
      setName('')
    } catch {
      // Parent owns error surface; keep the typed value so the user can retry.
    }
  }
  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-center gap-2">
        <span
          className="shrink-0 truncate text-[11px] font-mono text-muted-foreground"
          title={root}
        >
          {root.endsWith('/') ? root : `${root}/`}
        </span>
        <Input
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="new-project"
          autoComplete="off"
          spellCheck={false}
          className="h-9"
        />
        <button
          type="button"
          onClick={handleCreate}
          disabled={!canCreate}
          className={cn(
            'inline-flex h-9 shrink-0 items-center gap-1 rounded-md border px-2.5 text-xs font-medium transition-colors',
            canCreate
              ? 'border-primary/40 bg-primary/10 text-foreground hover:bg-primary/20'
              : 'border-border text-muted-foreground opacity-60',
          )}
        >
          {busy ? (
            <Loader2 className="size-3.5 animate-spin" />
          ) : (
            <FolderPlus className="size-3.5" />
          )}
          Create
        </button>
      </div>
      {trimmed.length > 0 && !safe && (
        <p className="px-1 text-[10px] text-amber-600 dark:text-amber-400">
          Use letters, digits, dots, dashes or underscores.
        </p>
      )}
    </div>
  )
}

// ── git-repo hint ────────────────────────────────────────────────────────────

function GitRepoHint({
  value,
  projects,
  projectsLoaded,
}: {
  value: WhereSelection
  projects: ProjectRepo[]
  projectsLoaded: boolean
}) {
  // No hint for session take-over (the existing session's dir is already
  // running — git-ness is a no-op observation there).
  if (value.kind === 'session') return null
  if (!projectsLoaded) return null
  const dir = normaliseDir(value.dir.trim())
  if (!dir) return null
  // Match against the loaded project entries (the only authoritative source
  // for is_git_repo without another endpoint round-trip). If the dir isn't
  // a known project, we don't know — stay quiet rather than nag.
  const match = projects.find(
    (p) => normaliseDir(p.path) === dir,
  )
  if (!match || match.is_git_repo) return null
  return (
    <p className="flex items-start gap-2 rounded-md border border-amber-500/30 bg-amber-500/[0.06] px-3 py-2 text-xs text-amber-800 dark:text-amber-300">
      <AlertTriangle className="mt-0.5 size-3.5 shrink-0" aria-hidden />
      <span>
        Not a git repo — teammates each need their own git worktree, so this
        may fail. Pick a repo or initialize git here first.
      </span>
    </p>
  )
}

// ── helpers ──────────────────────────────────────────────────────────────────

function normaliseDir(dir: string): string {
  if (!dir) return ''
  return dir.replace(/\/+$/, '')
}

