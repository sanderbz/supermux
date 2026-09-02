// WorkflowsView — the list, and the surface the whole feature is judged on
// before anything is opened.
//
// One component, two scopes (the pattern `StoreView` already uses with
// `grantTarget`): `variant="page"` is the `/workflows` route and shows
// everything the viewer may see; `scope={sessionName}` is the same list inside
// a bot's panel. Same cards, same rail, same row menu — a second implementation
// of a list is how two lists start disagreeing about what a workflow is.
//
// The card answers, in one glance and in this order: whose it is, what it is
// called, how far along it is, and when it next runs. The step rail is the
// second line because "where is this thing" is the question a cron table could
// never answer.

import * as React from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { AnimatePresence, motion, useReducedMotion } from 'framer-motion'
import { Copy, MoreVertical, Play, Plus, Square, Trash2 } from 'lucide-react'

import { cn } from '@/lib/utils'
import { springs } from '@/lib/springs'
import { isDelaySendShape } from '@/components/chat/delay-send'
import { useToast } from '@/components/ui/use-toast'
import { ArmedButton } from '@/components/ui/armed-button'
import { useArmedConfirm } from '@/hooks/use-armed-confirm'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { SessionFace } from '@/components/roster/session-face'
import { ScopedPageHeader } from '@/components/roster/scoped-page-header'
import { useCompanyScope } from '@/components/roster/use-company-scope'
import type { WorkflowWithSteps } from '@/lib/api/workflows'
import {
  useCancelRun,
  useCreateWorkflow,
  useDeleteWorkflow,
  useRunWorkflow,
  useWorkflowProgress,
  useWorkflows,
  useWorkflowsStream,
  type ProgressMap,
} from '@/hooks/use-workflows'

import { EnableToggle } from './enable-toggle'
import { StepRail, railStatusFor } from './step-rail'
import { workflowHintParts } from './cadence'
import { workflowEditHref, workflowHref, workflowNewHref } from './workflow-href'
import { WORKFLOW_TEMPLATES } from './templates'

type Filter = 'all' | 'active' | 'paused'

const FILTERS: { key: Filter; label: string }[] = [
  { key: 'all', label: 'All' },
  { key: 'active', label: 'Active' },
  { key: 'paused', label: 'Paused' },
]

export interface WorkflowsViewProps {
  /** `page` (the /workflows route) or `panel` (inside a bot's panel). */
  variant?: 'page' | 'panel'
  /** A bot slug: show only that bot's workflows, and pre-select it on create. */
  scope?: string | null
  /** Offline bench: render these rows instead of the live query. */
  mock?: WorkflowWithSteps[]
  /** Offline bench: seed the live-run positions the SSE stream would supply. */
  mockProgress?: ProgressMap
  /** Offline bench: render the loading skeleton / the unreachable state. */
  mockState?: 'loading' | 'error'
}

export function WorkflowsView({
  variant = 'page',
  scope = null,
  mock,
  mockProgress,
  mockState,
}: WorkflowsViewProps) {
  const navigate = useNavigate()
  const { toast } = useToast()
  const [filter, setFilter] = React.useState<Filter>('all')
  const isPage = variant === 'page'

  // The /workflows page follows the active company; the bot-panel variant is
  // already single-bot scoped, so it never touches company scope. The id is in
  // the query key (switching refetches), and `inScope` is the same client-side
  // fence the roster uses — the one thing that can express HQ-only, which the
  // server param can't.
  const { activeCompany, inScope } = useCompanyScope()
  const companyScope = isPage ? activeCompany : null

  useWorkflowsStream()
  const liveProgress = useWorkflowProgress()
  const progress = mockProgress ?? liveProgress
  const live = useWorkflows(scope, companyScope)
  const rows = mock ?? live.data ?? []
  const loading = mockState === 'loading' || (!mock && live.isLoading)
  const failed = mockState === 'error' || (!mock && !!live.error)

  // Everything that belongs in THIS scope, before the active/paused pill: a
  // "send later" is an ephemeral delay-send, not a routine — it belongs to the
  // composer's own countdown chip, not this list (the owner's report: the list
  // ballooned with them; fired ones are soft-deleted server-side, this hides the
  // still-pending ones). The company fence (page only) sits here too, so the
  // pills, the empty state and the count all read the scoped set — switch to a
  // company with no routines and you get its "nothing scheduled yet" starter,
  // not "nothing active".
  const scoped = React.useMemo(
    () => rows.filter((w) => !isDelaySendShape(w) && (!isPage || inScope(w.company_id))),
    [rows, isPage, inScope],
  )

  const shown = React.useMemo(
    () =>
      scoped.filter((w) =>
        filter === 'all' ? true : filter === 'active' ? w.enabled === 1 : w.enabled === 0,
      ),
    [scoped, filter],
  )

  return (
    <div className={cn('flex min-h-0 flex-1 flex-col', isPage && 'mx-auto w-full max-w-[880px]')}>
      <div
        className={cn(
          'flex flex-col gap-3',
          isPage ? 'sm-page-header sticky top-0 bg-background/80 px-4 pb-3 pt-4 backdrop-blur sm:px-6' : 'pb-2',
        )}
      >
        {isPage ? (
          // Same scope chip the overview roster leads with, so the company
          // switcher is visible + switchable right here (the bot-panel variant is
          // already single-bot scoped, so it keeps its own compact title).
          <ScopedPageHeader
            title="Workflows"
            subtitle={
              scope
                ? `What ${scope} does on its own.`
                : 'Give a bot a job and a time. It does the rest.'
            }
            actions={<NewButton to={workflowNewHref(scope)} />}
          />
        ) : (
          <div className="flex items-end justify-between gap-3">
            <h1 className="min-w-0 text-[15px] font-semibold tracking-tight text-foreground">
              Workflows
            </h1>
            <NewButton compact to={workflowNewHref(scope)} />
          </div>
        )}

        {scoped.length > 0 && (
          <div className="-mx-1 flex gap-1.5 overflow-x-auto px-1 pb-0.5">
            {FILTERS.map((f) => (
              <button
                key={f.key}
                type="button"
                onClick={() => setFilter(f.key)}
                aria-pressed={filter === f.key}
                className={cn(
                  'shrink-0 rounded-full px-3.5 py-1.5 text-[13px] font-medium transition-[transform,color,background-color] duration-100 active:scale-[0.94] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                  filter === f.key
                    ? 'bg-foreground text-background'
                    : 'bg-secondary text-muted-foreground hover:text-foreground',
                )}
              >
                {f.label}
              </button>
            ))}
          </div>
        )}
      </div>

      <div className={cn('sm-page-scroll min-h-0 flex-1 overflow-y-auto pt-3', isPage ? 'px-4 pb-10 sm:px-6' : 'pb-2')}>
        {loading ? (
          <ListSkeleton />
        ) : failed ? (
          <Unreachable onRetry={() => live.refetch()} />
        ) : scoped.length === 0 ? (
          <EmptyState scope={scope} onPick={(key) => navigate(`${workflowNewHref(scope)}${scope ? '&' : '?'}template=${key}`)} />
        ) : shown.length === 0 ? (
          <p className="px-1 py-8 text-center text-[13px] text-muted-foreground">
            Nothing {filter === 'active' ? 'active' : 'paused'} right now.
          </p>
        ) : (
          <ul className="flex flex-col gap-2">
            <AnimatePresence initial={false}>
              {shown.map((w) => (
                <WorkflowCard
                  key={w.id}
                  workflow={w}
                  progress={progress[w.id]}
                  showFace={!scope}
                  onToast={(message, tone) => toast({ message, tone })}
                />
              ))}
            </AnimatePresence>
          </ul>
        )}
      </div>
    </div>
  )
}

function NewButton({ compact, to }: { compact?: boolean; to: string }) {
  return (
    // A Link, not a button: "new workflow" is a place, and a place should
    // survive a middle-click and a long-press → open in new tab.
    <Link
      to={to}
      className={cn(
        'inline-flex shrink-0 items-center gap-1.5 rounded-full bg-primary font-medium text-primary-foreground transition-transform duration-100 active:scale-[0.96] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
        compact ? 'h-9 px-3 text-[13px]' : 'h-11 px-4 text-[14px]',
      )}
    >
      <Plus className="size-4" aria-hidden="true" />
      {compact ? 'New workflow' : 'New'}
    </Link>
  )
}

// ── one card ──────────────────────────────────────────────────────────────────

function WorkflowCard({
  workflow: w,
  progress,
  showFace,
  onToast,
}: {
  workflow: WorkflowWithSteps
  progress?: { step: number; steps: number; running: boolean; status: string | null }
  showFace: boolean
  onToast: (message: string, tone?: 'error') => void
}) {
  const reduce = useReducedMotion()
  const run = useRunWorkflow()
  const cancel = useCancelRun()
  const remove = useDeleteWorkflow()
  const create = useCreateWorkflow()

  const hint = workflowHintParts(w)
  const steps = w.steps ?? []
  const running = progress?.running ?? false
  const railStatus = railStatusFor(progress?.status ?? null, running)
  const current = progress?.step ?? 0
  const currentLabel = steps[Math.max(0, current - 1)]?.title || undefined

  const confirmDelete = useArmedConfirm({
    onConfirm: () => {
      remove.mutate(w.id, {
        onSuccess: () => onToast(`“${w.title}” deleted. Past runs stay in the log.`),
        onError: (e) => onToast(`Couldn’t delete — ${(e as Error).message}`, 'error'),
      })
    },
  })

  const duplicate = () => {
    create.mutate(
      {
        title: `${w.title} (copy)`,
        session: w.session,
        trigger_kind: w.trigger_kind,
        schedule_expr: w.schedule_expr ?? undefined,
        enabled: false,
        steps: steps.map((s) => ({
          title: s.title,
          command: s.command,
          prompt: s.prompt,
          timeout_secs: s.timeout_secs,
        })),
      },
      {
        onSuccess: () => onToast(`Copied “${w.title}” — the copy starts paused.`),
        onError: (e) => onToast(`Couldn’t duplicate — ${(e as Error).message}`, 'error'),
      },
    )
  }

  return (
    <motion.li
      layout={!reduce}
      initial={reduce ? false : { opacity: 0, y: 6 }}
      animate={{ opacity: 1, y: 0 }}
      exit={reduce ? undefined : { opacity: 0, height: 0, marginBottom: 0 }}
      transition={springs.cardExpand}
      className="overflow-hidden"
    >
      <div className="rounded-xl border border-border bg-card px-3 py-2.5 transition-colors duration-100 hover:border-border/80 sm:px-4">
        <div className="flex items-center gap-2">
          {showFace && <SessionFace name={w.session} size={22} animate={false} />}
          <Link
            to={workflowHref(w.id)}
            className="min-w-0 flex-1 truncate text-[15px] font-medium text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            {w.title}
          </Link>
          <EnableToggle
            id={w.id}
            enabled={w.enabled === 1}
            title={w.title}
            onError={(m) => onToast(m, 'error')}
          />
          <RowMenu
            workflow={w}
            running={running}
            confirmDelete={confirmDelete}
            onRun={() =>
              run.mutate(w.id, {
                onSuccess: () => onToast(`“${w.title}” started.`),
                onError: (e) => onToast(`Couldn’t start — ${(e as Error).message}`, 'error'),
              })
            }
            onStop={() =>
              cancel.mutate(w.id, {
                onSuccess: () => onToast(`Stopped “${w.title}”.`),
                onError: (e) => onToast(`Couldn’t stop — ${(e as Error).message}`, 'error'),
              })
            }
            onDuplicate={duplicate}
          />
        </div>

        <Link to={workflowHref(w.id)} className="mt-1.5 block focus-visible:outline-none">
          <div className="flex items-center gap-2">
            <StepRail
              steps={steps.length}
              current={current}
              status={railStatus}
              currentLabel={currentLabel}
            />
            <span className="shrink-0 text-[12px] text-muted-foreground">{hint.steps}</span>
            {running && (
              <span className="shrink-0 text-[12px] font-medium text-primary">
                step {current}/{progress?.steps || steps.length}
              </span>
            )}
          </div>
          <p className="mt-1 truncate text-[12.5px] text-muted-foreground">
            <span className="text-foreground/80">{hint.human}</span>
            {' · '}
            {running
              ? 'running now'
              : w.trigger_kind === 'manual'
                ? hint.next
                : `next ${hint.next}`}
            {' · '}
            {`ran ${hint.last}`}
          </p>
        </Link>
      </div>
    </motion.li>
  )
}

function RowMenu({
  workflow: w,
  running,
  confirmDelete,
  onRun,
  onStop,
  onDuplicate,
}: {
  workflow: WorkflowWithSteps
  running: boolean
  confirmDelete: ReturnType<typeof useArmedConfirm>
  onRun: () => void
  onStop: () => void
  onDuplicate: () => void
}) {
  return (
    // `modal={false}` — this row menu lives inside the bot-panel's Vaul sheet on
    // a phone; a modal Vaul/Radix drawer sets pointer-events:none on the body
    // where a modal Radix menu portals, so on touch it read as dead. See the
    // fuller note in session-actions-menu.tsx.
    <DropdownMenu modal={false}>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          aria-label={`More for ${w.title}`}
          className="relative -mr-1 inline-flex size-8 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors duration-100 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring before:absolute before:-inset-1.5 before:content-['']"
        >
          <MoreVertical className="size-4" aria-hidden="true" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-52">
        {running ? (
          <DropdownMenuItem onSelect={onStop}>
            <Square className="mr-2 size-4" aria-hidden="true" />
            Stop this run
          </DropdownMenuItem>
        ) : (
          <DropdownMenuItem onSelect={onRun}>
            <Play className="mr-2 size-4" aria-hidden="true" />
            Run now
          </DropdownMenuItem>
        )}
        <DropdownMenuItem asChild>
          <Link to={workflowEditHref(w.id)}>Edit</Link>
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={onDuplicate}>
          <Copy className="mr-2 size-4" aria-hidden="true" />
          Duplicate
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        {/* Delete is armed, and the copy says what actually survives it: the
            row is soft-deleted, so the ledger is not rewritten by an edit. */}
        <div className="px-2 py-1.5">
          <ArmedButton
            confirm={confirmDelete}
            icon={<Trash2 className="mr-1 size-4" aria-hidden="true" />}
            label="Delete"
            confirmLabel="Delete it"
          />
          <p className="mt-1 px-2 text-[11px] leading-snug text-muted-foreground">
            Past runs stay in the log.
          </p>
        </div>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

// ── empty / loading / unreachable ─────────────────────────────────────────────

function EmptyState({ scope, onPick }: { scope: string | null; onPick: (key: string) => void }) {
  return (
    <div className="flex flex-col gap-3 px-1 pt-4">
      <div className="text-center">
        <p className="text-[15px] font-medium text-foreground">Nothing scheduled yet</p>
        <p className="mx-auto mt-1 max-w-[42ch] text-[13px] text-muted-foreground">
          A workflow is a bot, a few instructions, and a time. Start from one of these — you can
          change every word of it.
        </p>
      </div>
      <ul className="flex flex-col gap-2">
        {WORKFLOW_TEMPLATES.map((t) => (
          <li key={t.key}>
            <button
              type="button"
              onClick={() => onPick(t.key)}
              className="flex w-full items-start gap-3 rounded-xl border border-border bg-card px-3 py-3 text-left transition-transform duration-100 active:scale-[0.99] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring sm:px-4"
            >
              <t.icon className="mt-0.5 size-5 shrink-0 text-muted-foreground" aria-hidden="true" />
              <span className="min-w-0 flex-1">
                <span className="block text-[14px] font-medium text-foreground">{t.title}</span>
                <span className="mt-0.5 block text-[12.5px] leading-snug text-muted-foreground">
                  {t.blurb}
                </span>
              </span>
            </button>
          </li>
        ))}
      </ul>
      <button
        type="button"
        onClick={() => onPick('')}
        className="mx-auto mt-1 h-11 rounded-full px-4 text-[13px] font-medium text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        {scope ? `Start from scratch for ${scope}` : 'Start from scratch'}
      </button>
    </div>
  )
}

function ListSkeleton() {
  return (
    <ul className="flex flex-col gap-2" aria-hidden="true">
      {[0, 1, 2].map((i) => (
        <li key={i} className="rounded-xl border border-border bg-card px-3 py-3 sm:px-4">
          <div className="h-4 w-1/2 rounded bg-muted" />
          <div className="mt-2 h-2 w-24 rounded bg-muted" />
          <div className="mt-2 h-3 w-2/3 rounded bg-muted" />
        </li>
      ))}
    </ul>
  )
}

function Unreachable({ onRetry }: { onRetry: () => void }) {
  return (
    <div className="px-1 py-10 text-center">
      <p className="text-[14px] font-medium text-foreground">Can’t reach supermux-server</p>
      <p className="mx-auto mt-1 max-w-[40ch] text-[13px] text-muted-foreground">
        Your workflows are still there — this page just can’t read them right now.
      </p>
      <button
        type="button"
        onClick={onRetry}
        className="mt-3 h-11 rounded-full bg-secondary px-4 text-[13px] font-medium text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        Try again
      </button>
    </div>
  )
}
