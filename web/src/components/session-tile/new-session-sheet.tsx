import * as React from 'react'
import { motion, AnimatePresence, useReducedMotion } from 'framer-motion'
import { Check, ChevronDown, ChevronRight, Loader2, Plus } from 'lucide-react'

import { cn } from '@/lib/utils'
import { MISC } from '@/brand/copy'
import { springs, tweens, motionOff } from '@/lib/springs'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { ResponsiveSheet } from '@/components/ui/responsive-sheet'
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
} from '@/components/ui/dropdown-menu'
import { sessionsApi, SessionError } from '@/lib/api'
import { modelOptions } from '@/lib/model-options'
import { useConnectors } from '@/stores/connectors-store'
import { HostPicker } from '@/components/host-picker'
import {
  WherePicker,
  defaultWhereSelection,
  type NewWhereSelection,
} from './where-picker'
import { createProjectFolder } from '@/lib/create-project-folder'
import { SessionMark } from '@/brand/marks'
import { useRosterMarks } from '@/hooks/use-roster-marks'
import { useCompanies } from '@/hooks/use-companies'
import { encodeMarkPin, freeTokens } from '@/lib/roster-marks'
import type { ConnectorCard } from '@/lib/api/connectors'

// The bot-scoped store sheet body is the heaviest child (the whole catalog
// grid). It only mounts on Step 2, so it rides the already-lazy /store chunk
// instead of the create sheet's static graph — same split `granted-connectors`
// uses, so the connector-onboarding step adds no bytes to the hero path.
const StoreView = React.lazy(() =>
  import('@/components/store/store-view').then((m) => ({ default: m.StoreView })),
)

/** Derive the immutable slug from the free-typed display name (migration 0019):
 *  whitespace → `-`, drop anything outside the server's `valid_name` charset
 *  (`[A-Za-z0-9_.-]`), bound to 100. The user types a human label; this is the
 *  URL/tmux/identity key — and the name of the folder we auto-create for it. */
function toSlug(raw: string): string {
  return raw
    .trim()
    .replace(/\s+/g, '-')
    .replace(/[^A-Za-z0-9_.-]/g, '')
    .slice(0, 100)
}

/** First word of a free-typed line, slug-safe — the seed for a drafted name. */
function firstWord(raw: string): string {
  const m = raw.trim().match(/[A-Za-z0-9][A-Za-z0-9_.-]*/)
  return m ? m[0] : ''
}

/** Example goals that fill the hero on tap — the empty state that teaches. Each
 *  is a whole job a bot can be hired for, phrased as the first thing you'd say. */
const GOAL_EXAMPLES = [
  'Review my open PRs and post a summary to Slack.',
  'Watch the prod logs and flag anything unusual.',
  'Draft release notes from the merged PRs this week.',
]

export interface NewSessionSheetProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** Pre-filled working directory. When omitted a folder named after the
   *  session is created under the projects root. */
  defaultDir?: string
  /** Called after a successful create/start so the route can navigate to focus. */
  onCreated: (name: string) => void
  /** Bot-mode voicing: swaps the header to the task-first "Hire a new bot" flow.
   *  Opt-in (the Grok roster passes it) so the base overview's sheet copy stays
   *  byte-identical. */
  botVoiced?: boolean
  /** Companies (Bot Mode): the company a new bot lands in. `null`/undefined = a
   *  main/PA bot (HQ) — the entire existing fleet. The Grok roster passes the
   *  active company scope so a bot hired inside a company is tagged to it. */
  companyId?: number | null
  /** DEV-bench seam (offline screenshots). Undefined in production. */
  bench?: NewSessionBench
}

/** The single boot panel. In bot mode it is a two-step hire — Describe the job,
 *  then (optionally) give it tools — with everything infra tucked behind an
 *  Advanced disclosure. The inner panel only mounts while the sheet is open, so
 *  its state starts fresh each time. */
export function NewSessionSheet({
  open,
  onOpenChange,
  defaultDir,
  onCreated,
  botVoiced,
  companyId,
  bench,
}: NewSessionSheetProps) {
  return (
    <ResponsiveSheet
      open={open}
      onOpenChange={onOpenChange}
      title={botVoiced ? 'Hire a new bot' : 'New session'}
      description={botVoiced ? 'Describe the job — tools and infra are optional.' : MISC.newSessionSubtitle}
    >
      {open && (
        <NewSessionPanel
          defaultDir={defaultDir}
          botVoiced={botVoiced}
          companyId={companyId}
          bench={bench}
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

type Kind = 'claude' | 'codex'
type Step = 'describe' | 'connect'

/** DEV-bench seams (offline screenshots) — start on a given step and feed
 *  StoreView a mock catalog so the connector step renders populated with no
 *  server. Undefined in production (the Grok roster never passes them), so the
 *  live behaviour and bytes are unchanged. Mirrors StoreView's own `mock*`
 *  bench props. */
export interface NewSessionBench {
  initialStep?: Step
  mockConnectors?: ConnectorCard[]
}

export function NewSessionPanel({
  defaultDir,
  botVoiced,
  companyId,
  onCancel,
  onCreated,
  bench,
}: {
  defaultDir: string | undefined
  botVoiced?: boolean
  companyId?: number | null
  onCancel: () => void
  onCreated: (name: string) => void
  bench?: NewSessionBench
}) {
  const [kind, setKind] = React.useState<Kind>('claude')
  return (
    <AgentForm
      key={kind}
      provider={kind}
      kind={kind}
      onKindChange={setKind}
      botVoiced={botVoiced}
      defaultDir={defaultDir}
      companyId={companyId}
      onCancel={onCancel}
      onCreated={onCreated}
      bench={bench}
    />
  )
}

// ── Claude | Codex segmented toggle ──────────────────────────────────────────
// Demoted from the hero to a small right-aligned control near the title — the
// provider is a power choice, not the lead. A muted pill rail with an animated
// `bg-card` thumb (shared layoutId) sliding under the active label.
function KindToggle({
  value,
  onChange,
}: {
  value: Kind
  onChange: (k: Kind) => void
}) {
  const items: { id: Kind; label: string }[] = [
    { id: 'claude', label: 'Claude' },
    { id: 'codex', label: 'Codex' },
  ]
  return (
    <div
      role="group"
      aria-label="Session kind"
      className="grid grid-cols-2 gap-0.5 rounded-lg bg-muted p-0.5"
    >
      {items.map((it) => {
        const active = value === it.id
        return (
          <button
            key={it.id}
            type="button"
            aria-pressed={active}
            onClick={() => onChange(it.id)}
            className={cn(
              'relative flex h-7 items-center justify-center gap-1.5 rounded-md px-2.5 text-[12.5px] font-medium transition-colors',
              active ? 'text-foreground' : 'text-muted-foreground hover:text-foreground',
            )}
          >
            {active && (
              <motion.span
                layoutId="new-session-kind-thumb"
                transition={springs.snappy}
                className="absolute inset-0 rounded-md bg-card shadow-sm"
              />
            )}
            <SessionMark
              seed={`provider:${it.id}`}
              size={15}
              animate={false}
              label={null}
              className="relative"
            />
            <span className="relative">{it.label}</span>
          </button>
        )
      })}
    </div>
  )
}

// ── Agent form — a two-step hire (Describe → Connect) ─────────────────────────
function AgentForm({
  provider,
  kind,
  onKindChange,
  botVoiced,
  defaultDir,
  companyId,
  onCancel,
  onCreated,
  bench,
}: {
  provider: 'claude' | 'codex'
  kind: Kind
  onKindChange: (k: Kind) => void
  botVoiced?: boolean
  defaultDir: string | undefined
  companyId?: number | null
  onCancel: () => void
  onCreated: (name: string) => void
  bench?: NewSessionBench
}) {
  const reduce = useReducedMotion()

  // Active company (Bot Mode): resolve its label so the "runs in" hint can name
  // the company folder honestly. `null` id / HQ → no label, plain-folder copy.
  const { companies } = useCompanies()
  const companyLabel = React.useMemo(() => {
    if (companyId == null) return undefined
    const c = companies.find((co) => co.id === companyId)
    return c ? c.display_name || c.slug : undefined
  }, [companies, companyId])

  // ── Step 1 (Describe) fields ───────────────────────────────────────────────
  const [goal, setGoal] = React.useState('')
  const [role, setRole] = React.useState('')
  // The name is DRAFTED from the role/goal (or a roster-unused token) so hiring
  // is never blocked on naming. Once the user touches the field it locks to
  // their text (`nameTouched`).
  const [nameInput, setNameInput] = React.useState('')
  const [nameTouched, setNameTouched] = React.useState(false)

  // ── Advanced (tucked) fields ────────────────────────────────────────────────
  const [advanced, setAdvanced] = React.useState(false)
  const [model, setModel] = React.useState('') // '' = provider default (omit)
  const [ownFolder, setOwnFolder] = React.useState(false)
  const [where, setWhere] = React.useState<NewWhereSelection>(() =>
    defaultDir ? { kind: 'new', dir: defaultDir } : defaultWhereSelection(),
  )
  const [hostId, setHostId] = React.useState<number | null>(null)
  const [worktree, setWorktree] = React.useState(false)
  const [bypassPermissions, setBypassPermissions] = React.useState(false)
  const [extraInstructions, setExtraInstructions] = React.useState('')
  const [tags, setTags] = React.useState('')

  // ── Face reroll (walks tokens nobody in the roster wears) ───────────────────
  const [reroll, setReroll] = React.useState(0)
  const { pins } = useRosterMarks()
  const pickedPin = React.useMemo(() => {
    if (reroll === 0) return undefined
    const free = freeTokens(pins)
    if (free.length === 0) return undefined
    return free[(reroll - 1) % free.length]
  }, [reroll, pins])

  // The DRAFTED name: role → goal → a roster-unused face-token silhouette,
  // slugified and de-duped against the names already on the roster (so a draft
  // rarely collides). Recomputed as the user types the goal/role and on reroll.
  const takenNames = React.useMemo(() => new Set(pins.keys()), [pins])
  const draftedName = React.useMemo(() => {
    const seeds: string[] = []
    const push = (raw: string) => {
      const s = toSlug(raw)
      if (s) seeds.push(s)
    }
    if (role.trim()) push(role.trim().split(/\s+/).slice(0, 2).join('-'))
    if (goal.trim()) push(firstWord(goal))
    const free = freeTokens(pins)
    // A few rotating token silhouettes so reroll always yields a fresh draft.
    for (let i = 0; i < 4 && free.length > 0; i++) {
      push(free[(reroll + i) % free.length].silhouette)
    }
    push('bot')
    for (const base of seeds) {
      if (!takenNames.has(base)) return base
      for (let i = 2; i < 12; i++) {
        if (!takenNames.has(`${base}-${i}`)) return `${base}-${i}`
      }
    }
    return `bot-${reroll + 1}`
  }, [role, goal, pins, takenNames, reroll])

  const name = nameTouched ? nameInput : draftedName
  const slug = toSlug(name)
  const canSubmit = slug.length > 0

  // ── Step + submit state ─────────────────────────────────────────────────────
  const [step, setStep] = React.useState<Step>(bench?.initialStep ?? 'describe')
  // The DB row is created at the Step 1 → Step 2 transition and remembered here,
  // so Step 2's grants attach to a real session_name BEFORE first boot and a
  // Back → Continue never double-creates.
  const [createdName, setCreatedName] = React.useState<string | null>(null)
  const [busy, setBusy] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)

  // Idempotently create the row (no start yet). Returns the session name or null
  // on failure (with `error` set). Connectors step is Claude-only, so Codex
  // never routes through Step 2.
  const ensureCreated = async (): Promise<string | null> => {
    if (createdName) return createdName
    // Resolve the working directory.
    //  - In a COMPANY (companyId set): the server OWNS the dir — it forces
    //    `<company root>/<name>/` and ignores anything we send. So we omit `dir`
    //    entirely and skip the client-side folder-create dance; hiring a bot in
    //    a company just works, the client never has to get the path right.
    //  - HQ / no company: auto-create a folder named after the slug under the
    //    projects root (default), or the picked WherePicker dir (opt-in).
    const inCompany = companyId != null
    let dir: string | undefined
    if (inCompany) {
      dir = undefined
    } else if (ownFolder) {
      dir = where.dir.trim()
    } else {
      const folder = await createProjectFolder(slug)
      if (!folder) {
        setError('Could not create the folder — pick your own folder in Advanced.')
        setAdvanced(true)
        setOwnFolder(true)
        return null
      }
      dir = folder
    }

    // Launch mapping — the durable ROLE and any extra standing instructions
    // become `desc` (→ `--append-system-prompt`, steers every turn). The GOAL
    // stays out of `desc`; it is typed as the opening user turn at start().
    const desc = [role.trim(), extraInstructions.trim()].filter(Boolean).join('\n\n')

    const created = await sessionsApi.create({
      name: slug,
      display_name: name.trim(),
      // Omitted for a company session (server derives it); a folder path for HQ.
      dir,
      provider,
      worktree,
      desc: desc || undefined,
      // Per-bot model rides the stored row (→ `--model <id>` at launch). '' =
      // provider default, omitted so the launch line stays byte-identical.
      model: model || undefined,
      host_id: hostId ?? undefined,
      // Companies (Bot Mode): tag the new bot to the active company. `null` (HQ)
      // is omitted so the launch/create body stays byte-identical for main bots.
      company_id: companyId ?? undefined,
      bypass_permissions:
        provider === 'claude' && bypassPermissions ? true : undefined,
    })
    const sessionName = created?.name ?? slug

    // Identity extras (tags + a frozen face) are a follow-up PATCH — the create
    // endpoint takes a small typed shape shared with the CLI/scheduler.
    const tagList = tags
      .split(',')
      .map((t) => t.trim())
      .filter(Boolean)
    const markPin = pickedPin ? encodeMarkPin(pickedPin) : null
    if (tagList.length > 0 || markPin) {
      try {
        await sessionsApi.config(sessionName, {
          ...(tagList.length > 0 ? { tags: tagList } : {}),
          ...(markPin ? { mark_pin: markPin } : {}),
        })
      } catch {
        /* the session exists; tags and a face are not worth failing create */
      }
    }
    setCreatedName(sessionName)
    return sessionName
  }

  const withGuard = async (fn: () => Promise<void>) => {
    if (!canSubmit || busy) return
    setBusy(true)
    setError(null)
    try {
      await fn()
    } catch (err) {
      if (err instanceof SessionError && err.status === 409) {
        setError(`The id “${slug}” is taken — tweak the name and try again.`)
      } else if (err instanceof SessionError && err.status === 0) {
        setError('Can’t reach supermux-server. Check it’s running, then try again.')
      } else {
        setError(err instanceof Error ? err.message : 'Could not create the session.')
      }
    } finally {
      setBusy(false)
    }
  }

  // Boot the agent and deliver the GOAL as the opening user turn. Non-fatal: the
  // row exists either way, so focus can retry a failed start.
  const hire = () =>
    withGuard(async () => {
      const sessionName = await ensureCreated()
      if (!sessionName) return
      try {
        await sessionsApi.start(sessionName, goal.trim() || undefined)
      } catch {
        /* ignore — session created, start retryable from focus */
      }
      onCreated(sessionName)
    })

  // Continue → create the row now, advance to the connector step (Claude only).
  const goConnect = () =>
    withGuard(async () => {
      const sessionName = await ensureCreated()
      if (!sessionName) return
      setStep('connect')
    })

  const onGoalSubmit = (e: React.FormEvent) => {
    e.preventDefault()
    if (step === 'describe') {
      if (provider === 'claude') void goConnect()
      else void hire()
    } else {
      void hire()
    }
  }

  const stepTransition = reduce ? motionOff : tweens.swap

  return (
    <form onSubmit={onGoalSubmit} className="flex min-h-0 flex-col">
      {/* Step rail — two dots + a Back affordance on Step 2. Keeps the sheet's
          own header as the chrome; this is the lightweight wizard line. */}
      <div className="flex items-center justify-between gap-3 px-6 pt-3">
        <div className="flex items-center gap-2">
          {step === 'connect' && (
            <button
              type="button"
              onClick={() => setStep('describe')}
              className="-ml-1 mr-1 grid size-7 place-items-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              aria-label="Back to describe"
            >
              <ChevronRight className="size-4 rotate-180" aria-hidden />
            </button>
          )}
          <StepDots step={step} />
        </div>
        {step === 'describe' && <KindToggle value={kind} onChange={onKindChange} />}
      </div>

      <div className="relative overflow-hidden">
        <AnimatePresence mode="wait" initial={false}>
          {step === 'describe' ? (
            <motion.div
              key="describe"
              initial={reduce ? false : { opacity: 0, x: -12 }}
              animate={{ opacity: 1, x: 0 }}
              exit={reduce ? { opacity: 0 } : { opacity: 0, x: -12 }}
              transition={stepTransition}
            >
              <DescribeStep
                provider={provider}
                botVoiced={botVoiced}
                goal={goal}
                setGoal={setGoal}
                role={role}
                setRole={setRole}
                nameValue={name}
                slug={slug}
                companyLabel={companyLabel}
                onNameChange={(v) => {
                  setNameTouched(true)
                  setNameInput(v)
                }}
                pickedPin={pickedPin}
                onReroll={() => setReroll((n) => n + 1)}
                advanced={advanced}
                setAdvanced={setAdvanced}
                model={model}
                setModel={setModel}
                ownFolder={ownFolder}
                setOwnFolder={setOwnFolder}
                where={where}
                setWhere={setWhere}
                hostId={hostId}
                setHostId={setHostId}
                worktree={worktree}
                setWorktree={setWorktree}
                bypassPermissions={bypassPermissions}
                setBypassPermissions={setBypassPermissions}
                extraInstructions={extraInstructions}
                setExtraInstructions={setExtraInstructions}
                tags={tags}
                setTags={setTags}
                busy={busy}
                reduce={!!reduce}
              />
            </motion.div>
          ) : (
            <motion.div
              key="connect"
              initial={reduce ? false : { opacity: 0, x: 12 }}
              animate={{ opacity: 1, x: 0 }}
              exit={reduce ? { opacity: 0 } : { opacity: 0, x: 12 }}
              transition={stepTransition}
            >
              <ConnectStep slug={createdName ?? slug} mock={bench?.mockConnectors} />
            </motion.div>
          )}
        </AnimatePresence>
      </div>

      {error && (
        <p
          role="alert"
          className="mx-6 rounded-md border border-status-error/40 bg-status-error/10 px-3 py-2 text-sm text-status-error-ink"
        >
          {error}
        </p>
      )}

      {/* Footer — pinned to the bottom of the sheet's scroll body so the primary
          action is ALWAYS reachable, never pushed below the viewport-capped
          sheet by a tall body (Advanced open / the connector catalog) or hidden
          behind the soft keyboard. `sticky bottom-0` keeps it in the same single
          scroll body the fields use (DRY with the working sheets) while the body
          scrolls behind it; an opaque bg + top border read it as a footer.
          Labels shift per step (hire a colleague, not launch a job). */}
      <div className="sticky bottom-0 z-10 flex gap-2 border-t border-border bg-background px-6 pb-6 pt-4">
        {step === 'describe' ? (
          <>
            <Button type="button" variant="ghost" className="flex-1" onClick={onCancel}>
              Cancel
            </Button>
            {provider === 'claude' ? (
              <>
                <Button
                  type="button"
                  variant="outline"
                  onClick={() => void hire()}
                  disabled={!canSubmit || busy}
                >
                  Skip &amp; hire
                </Button>
                <Button type="submit" className="flex-1" disabled={!canSubmit || busy}>
                  {busy && <Loader2 className="animate-spin" />}
                  Continue
                </Button>
              </>
            ) : (
              <Button type="submit" className="flex-1" disabled={!canSubmit || busy}>
                {busy && <Loader2 className="animate-spin" />}
                {busy ? 'Hiring…' : 'Hire'}
              </Button>
            )}
          </>
        ) : (
          <>
            <Button
              type="button"
              variant="ghost"
              className="flex-1"
              onClick={() => void hire()}
              disabled={busy}
            >
              Skip for now
            </Button>
            <Button type="submit" className="flex-1" disabled={busy}>
              {busy && <Loader2 className="animate-spin" />}
              {busy ? 'Hiring…' : 'Finish & hire'}
            </Button>
          </>
        )}
      </div>
    </form>
  )
}

// ── Step 1: Describe ──────────────────────────────────────────────────────────
function DescribeStep(props: {
  provider: 'claude' | 'codex'
  botVoiced?: boolean
  goal: string
  setGoal: (v: string) => void
  role: string
  setRole: (v: string) => void
  nameValue: string
  slug: string
  /** When set (a company is active), the "runs in" hint names the company
   *  folder `<company>/<slug>` instead of the plain `<slug>`. */
  companyLabel?: string
  onNameChange: (v: string) => void
  pickedPin: ReturnType<typeof freeTokens>[number] | undefined
  onReroll: () => void
  advanced: boolean
  setAdvanced: (v: boolean) => void
  model: string
  setModel: (v: string) => void
  ownFolder: boolean
  setOwnFolder: (v: boolean) => void
  where: NewWhereSelection
  setWhere: (v: NewWhereSelection) => void
  hostId: number | null
  setHostId: (v: number | null) => void
  worktree: boolean
  setWorktree: (v: boolean) => void
  bypassPermissions: boolean
  setBypassPermissions: (v: boolean) => void
  extraInstructions: string
  setExtraInstructions: (v: string) => void
  tags: string
  setTags: (v: string) => void
  busy: boolean
  reduce: boolean
}) {
  const {
    provider,
    goal,
    setGoal,
    role,
    setRole,
    nameValue,
    slug,
    companyLabel,
    onNameChange,
    pickedPin,
    onReroll,
    advanced,
    setAdvanced,
    busy,
    reduce,
  } = props

  return (
    <div className="flex flex-col gap-5 px-6 pb-2 pt-4">
      {/* GOAL — the hero, task-first front door. */}
      <div className="flex flex-col gap-2">
        <label htmlFor="ns-goal" className="text-[15px] font-semibold text-foreground">
          What should this bot do?
        </label>
        {/* NO autoFocus — the same iOS-PWA Vaul keyboard-during-open race the
            start-team-sheet documents: the keyboard popping mid-slide-in makes
            Vaul cache `initialDrawerHeight` from the still-translated drawer and
            the sheet ends up half-cropped (owner IMG_2478). Users tap to focus. */}
        <textarea
          id="ns-goal"
          value={goal}
          onChange={(e) => setGoal(e.target.value)}
          rows={3}
          placeholder="Review my PRs and post a summary to Slack."
          className="w-full resize-y rounded-xl border border-input bg-transparent px-3 py-2.5 text-[15px] leading-relaxed outline-none placeholder:text-muted-foreground focus-visible:ring-2 focus-visible:ring-ring"
        />
        <p className="text-xs text-muted-foreground">
          Describe the job in a sentence — you can refine everything later.
        </p>
        {!goal.trim() && (
          <div className="flex flex-wrap gap-1.5">
            {GOAL_EXAMPLES.map((ex) => (
              <button
                key={ex}
                type="button"
                onClick={() => setGoal(ex)}
                className="rounded-full border border-border bg-muted/40 px-3 py-1 text-[12px] text-muted-foreground transition-colors hover:bg-accent/50 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                {ex.replace(/\.$/, '')}
              </button>
            ))}
          </div>
        )}
      </div>

      {/* Identity — role seeds the durable job, name is drafted, face inline. */}
      <div className="flex flex-col gap-3">
        <div className="flex items-start gap-3">
          <SessionMark
            seed={slug || 'new-session'}
            pin={pickedPin}
            size={44}
            animate={false}
            label={null}
          />
          <div className="grid min-w-0 flex-1 grid-cols-1 gap-2 sm:grid-cols-2">
            <Field label="Role" htmlFor="ns-role">
              <Input
                id="ns-role"
                value={role}
                onChange={(e) => setRole(e.target.value)}
                placeholder="e.g. PR reviewer"
                autoComplete="off"
                spellCheck={false}
              />
            </Field>
            <Field label="Name" htmlFor="ns-name">
              <Input
                id="ns-name"
                value={nameValue}
                onChange={(e) => onNameChange(e.target.value)}
                placeholder="my-bot"
                autoComplete="off"
                spellCheck={false}
              />
            </Field>
          </div>
        </div>
        <div className="flex items-center justify-between gap-3 pl-[56px]">
          <p className="truncate text-[11px] text-muted-foreground">
            {slug ? (
              companyLabel ? (
                <>
                  Runs in{' '}
                  <code className="font-mono">
                    {companyLabel}/{slug}
                  </code>{' '}
                  — drafted, edit anytime.
                </>
              ) : (
                <>
                  Runs in a folder <code className="font-mono">{slug}</code> — drafted, edit anytime.
                </>
              )
            ) : (
              <>Give it a short name to hire.</>
            )}
          </p>
          <button
            type="button"
            onClick={onReroll}
            disabled={busy}
            className="shrink-0 rounded-md px-2 py-1 text-[12px] font-medium text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50"
          >
            Reroll
          </button>
        </div>
      </div>

      {/* Advanced — everything infra, tucked; animated disclosure w/ aria-expanded. */}
      <div className="rounded-xl border border-border">
        <button
          type="button"
          onClick={() => setAdvanced(!advanced)}
          aria-expanded={advanced}
          aria-controls="ns-advanced"
          className="flex w-full items-center justify-between gap-2 rounded-xl px-3.5 py-2.5 text-left text-[13px] font-medium text-foreground transition-colors hover:bg-muted/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          <span className="flex flex-col">
            <span>Advanced</span>
            <span className="text-[11px] font-normal text-muted-foreground">
              Model, folder, host, worktree, instructions, tags, permissions
            </span>
          </span>
          <ChevronDown
            className={cn('size-4 shrink-0 text-muted-foreground transition-transform', advanced && 'rotate-180')}
            aria-hidden
          />
        </button>
        <AnimatePresence initial={false}>
          {advanced && (
            <motion.div
              id="ns-advanced"
              key="adv"
              initial={reduce ? false : { height: 0, opacity: 0 }}
              animate={{ height: 'auto', opacity: 1 }}
              exit={reduce ? { opacity: 0 } : { height: 0, opacity: 0 }}
              transition={reduce ? motionOff : springs.cardExpand}
              className="overflow-hidden"
            >
              <div className="flex flex-col gap-4 border-t border-border px-3.5 pb-4 pt-4">
                <Field label="Model" htmlFor="ns-model">
                  <CreateModelPicker provider={provider} value={props.model} onChange={props.setModel} />
                </Field>

                <Field
                  label="Extra standing instructions"
                  htmlFor="ns-desc"
                  hint="Durable rules for this bot — not this task. Optional; the Role above already seeds its job."
                >
                  <textarea
                    id="ns-desc"
                    value={props.extraInstructions}
                    onChange={(e) => props.setExtraInstructions(e.target.value)}
                    rows={2}
                    placeholder="Always run the unit suite before you claim green."
                    className="w-full resize-y rounded-md border border-input bg-transparent px-2 py-1.5 text-sm outline-none placeholder:text-muted-foreground focus-visible:ring-2 focus-visible:ring-ring"
                  />
                </Field>

                {!props.ownFolder ? (
                  <div className="flex flex-col gap-1.5">
                    <span className="text-sm font-medium">Folder</span>
                    <p className="text-[11px] text-muted-foreground">
                      Creates a new folder named after the bot.{' '}
                      <button
                        type="button"
                        onClick={() => props.setOwnFolder(true)}
                        className="text-primary hover:underline"
                      >
                        choose your own folder →
                      </button>
                    </p>
                  </div>
                ) : (
                  <Field label="Folder" htmlFor="ns-where">
                    <WherePicker
                      id="ns-where"
                      value={props.where}
                      onChange={props.setWhere}
                      showSessions={false}
                      gitHint="info"
                    />
                  </Field>
                )}

                <Field
                  label="Run on"
                  htmlFor="ns-host"
                  hint="Pick a remote host you registered in Hosts, or stay Local."
                >
                  <HostPicker id="ns-host" value={props.hostId} onChange={props.setHostId} disabled={busy} />
                </Field>

                <CheckCard
                  checked={props.worktree}
                  onChange={props.setWorktree}
                  title="Isolated worktree"
                  desc="Run in a fresh git worktree so it can’t touch your tree."
                />

                <Field label="Tags" htmlFor="ns-tags" hint="Comma-separated. Searchable.">
                  <Input
                    id="ns-tags"
                    value={props.tags}
                    onChange={(e) => props.setTags(e.target.value)}
                    placeholder="frontend, release"
                    autoComplete="off"
                  />
                </Field>

                {provider === 'claude' && (
                  <CheckCard
                    checked={props.bypassPermissions}
                    onChange={props.setBypassPermissions}
                    title="Bypass permissions"
                    desc="Claude runs tools without asking. Use only in directories you trust."
                  />
                )}
              </div>
            </motion.div>
          )}
        </AnimatePresence>
      </div>
    </div>
  )
}

// ── Step 2: Connect (connector onboarding, scoped, skippable) ─────────────────
function ConnectStep({ slug, mock }: { slug: string; mock?: ConnectorCard[] }) {
  const live = useConnectors(mock ? { source: 'local' } : {})
  const cards = mock ?? live.data ?? []
  const emptyVault = !mock && !live.isLoading && cards.length === 0

  return (
    <div className="flex min-h-0 flex-col gap-3 px-6 pb-2 pt-4">
      <div className="flex flex-col gap-1">
        <h3 className="text-[15px] font-semibold text-foreground">Give {slug} its tools</h3>
        <p className="text-[13px] text-muted-foreground">
          Pick what this bot can use. You can add more later — or skip.
        </p>
      </div>

      {/* The store is the tall part — it flows in the sheet's SINGLE scroll body
          (no inner max-h cap) so the outer ResponsiveSheet (maxHeight:var(--vvh))
          governs the height and the catalog scrolls within it. The Skip / Finish
          actions stay on-screen because the footer is `sticky bottom-0`, not
          because the catalog is boxed off. */}
      <div data-grok>
        {emptyVault ? (
          <div className="flex flex-col items-center gap-3 rounded-2xl border border-dashed border-border bg-muted/20 px-6 py-10 text-center">
            <Plus className="size-6 text-muted-foreground" aria-hidden />
            <div className="flex flex-col gap-1">
              <p className="text-sm font-medium text-foreground">No tools connected yet</p>
              <p className="text-[13px] text-muted-foreground">
                Connect your first integration in the store, then grant it to this bot.
              </p>
            </div>
            <a
              href="/store"
              className="inline-flex min-h-9 items-center gap-1.5 rounded-[10px] border border-border bg-card px-3 text-[13px] font-medium text-foreground transition-colors hover:bg-accent/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              Open the store
            </a>
          </div>
        ) : (
          <React.Suspense
            fallback={
              <div className="flex items-center gap-2 rounded-xl border border-border bg-card px-4 py-3 text-[13px] text-muted-foreground">
                <Loader2 className="size-4 animate-spin" aria-hidden />
                Loading connectors…
              </div>
            }
          >
            <StoreView
              grantTarget={slug}
              variant="sheet"
              {...(mock ? { mock, mockGranted: { bot: [], all: [] } } : {})}
            />
          </React.Suspense>
        )}
      </div>
    </div>
  )
}

// ── Create-time model picker ──────────────────────────────────────────────────
// A controlled sibling of the bot-panel's live ModelPicker: it holds the choice
// locally (no session exists yet) and hands it to the create payload. Same
// `modelOptions` allowlist so the two never drift, same DropdownMenu chrome.
function CreateModelPicker({
  provider,
  value,
  onChange,
}: {
  provider: 'claude' | 'codex'
  value: string
  onChange: (v: string) => void
}) {
  const options = modelOptions(provider)
  if (options.length === 0) {
    return <p className="text-[13px] text-muted-foreground">{provider} runs one model — no selection.</p>
  }
  const currentLabel = options.find((o) => o.value === value)?.label ?? 'Default'
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          id="ns-model"
          className={cn(
            'inline-flex min-h-9 items-center gap-1.5 rounded-[10px] border border-input bg-card px-3 text-[13px] font-medium text-foreground',
            'transition-colors hover:bg-accent/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
          )}
        >
          <span className="font-mono">{currentLabel}</span>
          <ChevronDown className="size-3.5 text-muted-foreground" aria-hidden />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="min-w-[180px]">
        {options.map((o) => (
          <DropdownMenuItem
            key={o.value || 'default'}
            onSelect={() => onChange(o.value)}
          >
            <span className="flex-1 font-mono text-[13px]">{o.label}</span>
            {o.value === value && <Check className="size-4 shrink-0" aria-hidden />}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

// ── Two-dot step progress ─────────────────────────────────────────────────────
function StepDots({ step }: { step: Step }) {
  const steps: Step[] = ['describe', 'connect']
  const labels: Record<Step, string> = { describe: 'Describe', connect: 'Tools' }
  return (
    <div className="flex items-center gap-2" aria-label={`Step ${step === 'describe' ? 1 : 2} of 2`}>
      {steps.map((s) => {
        const active = s === step
        return (
          <span key={s} className="flex items-center gap-1.5">
            <span
              className={cn(
                'size-1.5 rounded-full transition-colors',
                active ? 'bg-primary' : 'bg-muted-foreground/30',
              )}
            />
            <span
              className={cn(
                'text-[11px] font-medium transition-colors',
                active ? 'text-foreground' : 'text-muted-foreground/60',
              )}
            >
              {labels[s]}
            </span>
          </span>
        )
      })}
    </div>
  )
}

/** A bordered checkbox row with a title + muted description — the Claude form's
 *  "Isolated worktree" and "Bypass permissions" options share this shape. */
function CheckCard({
  checked,
  onChange,
  title,
  desc,
}: {
  checked: boolean
  onChange: (v: boolean) => void
  title: string
  desc: string
}) {
  return (
    <label className="flex min-h-11 cursor-pointer items-center gap-3 rounded-lg border border-border px-3">
      <input
        type="checkbox"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
        className="size-4 accent-[hsl(var(--primary))]"
      />
      <span className="flex flex-col">
        <span className="text-sm font-medium">{title}</span>
        <span className="text-xs text-muted-foreground">{desc}</span>
      </span>
    </label>
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
