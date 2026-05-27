// Settings → Updates panel (UPDATE-MECH-FE).
//
// World-class UI for the self-update flow. Six states, each rendered with the
// same iOS-grouped-list visual language as the other Settings sections — opaque
// card material, sentence-case header, generous 44pt touch targets, spring
// motion sourced from the shared preset bank. The panel lives ONLY inside
// Settings; nothing about it is route- or layout-specific.
//
// State machine (driven by the `useVersion` hook):
//   A. Up to date              ← `!updateAvailable && blockedReasons.length === 0`
//   B. Update available        ← `updateAvailable && blockedReasons.length === 0`
//   C. Available — blocked     ← `updateAvailable && blockedReasons.length > 0`
//   D. Updating                ← `progress !== null && step ∉ {done, failed, rolled_back}`
//   E. Failed / rolled back    ← `progress?.step ∈ {failed, rolled_back}`
//   F. No network              ← `error !== null || (no latest && no_network blocker)`
//
// State D and E are exclusive with B/C — when a build is in flight we hide the
// update-available copy because the user just chose to install it.
//
// MarkdownViewer is lazy-loaded only when the user expands the release notes —
// the chunk is ~120kb gzipped (react-markdown + rehype-highlight) and the
// happy path "up to date" state never pays for it.

import * as React from 'react'
import {
  AnimatePresence,
  motion,
  useReducedMotion,
} from 'framer-motion'
import {
  AlertTriangle,
  ArrowUpCircle,
  Check,
  CheckCircle2,
  ChevronDown,
  CircleAlert,
  ExternalLink,
  Hammer,
  Loader2,
  PackageCheck,
  RefreshCw,
  Search,
  WifiOff,
} from 'lucide-react'

import { cn } from '@/lib/utils'
import { springs } from '@/lib/springs'
import { Button } from '@/components/ui/button'
import { Row } from '@/components/settings/primitives'
import { SectionWithAction } from '@/components/settings/hosts-section'
import { useVersion, type UpdateProgress } from '@/hooks/use-version'
import type {
  BlockedReason,
  UpdateEvent,
  UpdateStep,
  VersionInfo,
  LatestRelease,
} from '@/lib/api'

// Lazy-loaded markdown renderer. The release-notes drawer is the only place
// MarkdownViewer is used outside of /files, and most users will never expand
// it — the chunk is deferred so the happy-path render is free of it.
const MarkdownViewer = React.lazy(() =>
  import('@/components/files/markdown-viewer').then((m) => ({
    default: m.MarkdownViewer,
  })),
)

// ── tiny atoms ────────────────────────────────────────────────────────────────

/** Render an ISO-8601 timestamp as `2026-05-27 22:48 UTC` — the format the
 *  Connection section uses for the build sha. Falls back to the raw string on
 *  parse failure so we never render "Invalid Date". */
function formatBuildAt(iso: string): string {
  const d = new Date(iso)
  if (isNaN(d.getTime())) return iso
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(
    d.getUTCDate(),
  )} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())} UTC`
}

/** "released 2026-05-28" — short calendar date for the release published_at. */
function formatReleasedDate(iso: string): string {
  const d = new Date(iso)
  if (isNaN(d.getTime())) return iso
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`
}

/** Static spring-in wrapper so each sub-state shares one motion preset. */
function StateCard({ children }: { children: React.ReactNode }) {
  const reduce = useReducedMotion()
  return (
    <motion.div
      initial={reduce ? false : { opacity: 0, y: 6 }}
      animate={{ opacity: 1, y: 0 }}
      transition={springs.cardExpand}
      className="flex flex-col gap-3"
    >
      {children}
    </motion.div>
  )
}

// ── sub-views ─────────────────────────────────────────────────────────────────

/** State A — up to date. Single line + a refresh button. Calm, no badges. */
function UpToDateView({
  onRefresh,
  refreshing,
}: {
  onRefresh: () => void
  refreshing: boolean
}) {
  return (
    <StateCard>
      <div className="flex items-center gap-2">
        <span className="inline-flex size-6 items-center justify-center rounded-full bg-status-ready/15 text-status-ready">
          <Check className="size-4" />
        </span>
        <span className="text-[15px] font-medium">Up to date</span>
      </div>
      <p className="text-[13px] text-muted-foreground">
        You’re running the latest release. Updates show up here automatically;
        checking is also fine.
      </p>
      <div>
        <RefreshButton onRefresh={onRefresh} refreshing={refreshing} />
      </div>
    </StateCard>
  )
}

/** State B — update available, installable. Release tag + notes preview +
 *  prominent "Update now" button. */
function UpdateAvailableView({
  latest,
  onUpdate,
  onRefresh,
  refreshing,
  starting,
}: {
  latest: LatestRelease
  onUpdate: () => void
  onRefresh: () => void
  refreshing: boolean
  starting: boolean
}) {
  const reduce = useReducedMotion()
  return (
    <StateCard>
      <div className="flex items-center gap-2">
        <span className="inline-flex size-6 items-center justify-center rounded-full bg-status-ready/15 text-status-ready">
          <ArrowUpCircle className="size-4" />
        </span>
        <span className="text-[15px] font-medium">Update available</span>
      </div>
      <p className="text-[13px] text-muted-foreground">
        <span className="font-mono text-foreground">{latest.tag}</span>{' '}
        <span aria-hidden>·</span> released{' '}
        {formatReleasedDate(latest.published_at)}
      </p>

      <ReleaseNotes notes={latest.body} url={latest.html_url} />

      <div className="flex flex-wrap items-center gap-2 pt-1">
        <Button
          asChild
          variant="default"
          onClick={onUpdate}
          disabled={starting}
          className="h-11 min-w-[10rem] gap-2 px-5 text-[14px] font-medium"
        >
          <motion.button
            whileTap={reduce ? undefined : { scale: 0.97 }}
            transition={springs.buttonPress}
          >
            {starting ? (
              <>
                <Loader2 className="animate-spin" />
                Starting…
              </>
            ) : (
              <>
                <ArrowUpCircle />
                Update now
              </>
            )}
          </motion.button>
        </Button>
        <RefreshButton onRefresh={onRefresh} refreshing={refreshing} />
      </div>
    </StateCard>
  )
}

/** State C — update available but blocked by preflight checks. We list every
 *  blocker as a bullet with human copy + (when present) the exact command to
 *  run, so the user can resolve it in one keystroke. */
function BlockedView({
  latest,
  reasons,
  onRefresh,
  refreshing,
}: {
  latest: LatestRelease | null
  reasons: BlockedReason[]
  onRefresh: () => void
  refreshing: boolean
}) {
  return (
    <StateCard>
      <div className="flex items-center gap-2">
        <span className="inline-flex size-6 items-center justify-center rounded-full bg-status-error/15 text-status-error">
          <CircleAlert className="size-4" />
        </span>
        <span className="text-[15px] font-medium">
          Update available — action needed
        </span>
      </div>
      {latest && (
        <p className="text-[13px] text-muted-foreground">
          <span className="font-mono text-foreground">{latest.tag}</span>{' '}
          <span aria-hidden>·</span> released{' '}
          {formatReleasedDate(latest.published_at)}
        </p>
      )}

      <div className="flex flex-col gap-2">
        <p className="text-[13px] font-medium">To install this update:</p>
        <ul className="flex flex-col gap-1.5">
          {reasons.map((r, i) => (
            <li key={i} className="flex items-start gap-2 text-[13px]">
              <span
                aria-hidden
                className="mt-1.5 size-1.5 shrink-0 rounded-full bg-status-error/70"
              />
              <BlockedReasonLine reason={r} />
            </li>
          ))}
        </ul>
      </div>

      <div>
        <RefreshButton onRefresh={onRefresh} refreshing={refreshing} label="Refresh checks" />
      </div>
    </StateCard>
  )
}

/** Render one blocked reason. Most are plain text; a couple have structured
 *  fields (a command to copy, the current branch) we surface specifically. */
function BlockedReasonLine({ reason }: { reason: BlockedReason }) {
  switch (reason.kind) {
    case 'manual_update_required':
      return (
        <span className="text-[13px] text-foreground">
          {reason.message}
          <code className="ml-1 rounded bg-muted px-1.5 py-0.5 font-mono text-[12px] text-muted-foreground">
            {reason.command}
          </code>
        </span>
      )
    case 'missing_tool':
      return (
        <span className="text-[13px] text-foreground">
          {reason.message}
          <code className="ml-1 rounded bg-muted px-1.5 py-0.5 font-mono text-[12px] text-muted-foreground">
            {reason.tool}
          </code>
        </span>
      )
    case 'not_on_main':
      return (
        <span className="text-[13px] text-foreground">
          {reason.message}
        </span>
      )
    case 'low_disk':
      return (
        <span className="text-[13px] text-foreground">
          {reason.message} ({reason.available_mb} MB free)
        </span>
      )
    case 'ahead_of_remote':
      return (
        <span className="text-[13px] text-foreground">
          {reason.message} ({reason.count} commit{reason.count === 1 ? '' : 's'})
        </span>
      )
    default:
      return <span className="text-[13px] text-foreground">{reason.message}</span>
  }
}

/** State D — update in progress. Per-step checklist + a smooth progress bar +
 *  the current status message. Discourages closing the tab. */
function UpdatingView({
  latest,
  progress,
}: {
  latest: LatestRelease | null
  progress: UpdateProgress
}) {
  // Resolve the per-step status — `done` (the step is in history), `active`
  // (the step IS the current step), or `pending` (still in the future).
  const stepIndex = STEP_ORDER.indexOf(progress.step)
  // Approximate visible elapsed time on the active step from the SSE history.
  const activeStartedAt = React.useMemo(() => {
    const entry = progress.history.find((e: UpdateEvent) => e.step === progress.step)
    return entry ? new Date(entry.ts).getTime() : Date.now()
  }, [progress.history, progress.step])
  const [elapsedSec, setElapsedSec] = React.useState(0)
  React.useEffect(() => {
    setElapsedSec(Math.max(0, Math.floor((Date.now() - activeStartedAt) / 1000)))
    const id = setInterval(() => {
      setElapsedSec(Math.max(0, Math.floor((Date.now() - activeStartedAt) / 1000)))
    }, 1000)
    return () => clearInterval(id)
  }, [activeStartedAt])

  // Progress bar fill — fraction of total steps completed plus a half-step for
  // "in progress" so the bar always moves a hair when the step changes.
  const progressPct = Math.min(100, ((stepIndex + 0.5) / STEP_ORDER.length) * 100)

  return (
    <StateCard>
      <div className="flex items-center gap-2">
        <Loader2 className="size-4 animate-spin text-primary" />
        <span className="text-[15px] font-medium">
          Updating to{' '}
          <span className="font-mono">{latest?.tag ?? 'latest'}</span>…
        </span>
      </div>

      {/* Smooth progress bar — width animated with a soft spring. The "snappy"
          spring keeps it from looking floaty when a step boundary lands. */}
      <div className="h-1.5 w-full overflow-hidden rounded-full bg-muted">
        <motion.div
          className="h-full rounded-full bg-primary"
          initial={{ width: 0 }}
          animate={{ width: `${progressPct}%` }}
          transition={springs.snappy}
        />
      </div>

      <ul className="flex flex-col gap-1.5">
        {STEP_ORDER.map((s, i) => {
          const state: 'done' | 'active' | 'pending' =
            i < stepIndex ? 'done' : i === stepIndex ? 'active' : 'pending'
          return (
            <StepRow
              key={s}
              step={s}
              state={state}
              elapsedSec={state === 'active' ? elapsedSec : undefined}
            />
          )
        })}
      </ul>

      <div className="rounded-lg border border-border bg-muted/30 px-3 py-2">
        <p className="text-[12px] font-medium uppercase tracking-wide text-muted-foreground">
          Status
        </p>
        <p className="mt-0.5 text-[13px] text-foreground">{progress.message}</p>
        <p className="mt-1 text-[12px] text-muted-foreground">
          Please don’t close this tab — supermux will reload automatically when
          the new version is ready.
        </p>
      </div>
    </StateCard>
  )
}

const STEP_ORDER: UpdateStep[] = ['fetching', 'building', 'installing', 'verifying']

const STEP_COPY: Record<UpdateStep, { label: string; estimate?: string }> = {
  fetching: { label: 'Fetching', estimate: '~10s' },
  building: { label: 'Building', estimate: '~1m20s' },
  installing: { label: 'Installing', estimate: '~5s' },
  verifying: { label: 'Verifying', estimate: '~5s' },
  done: { label: 'Done' },
  failed: { label: 'Failed' },
  rolled_back: { label: 'Rolled back' },
}

function StepRow({
  step,
  state,
  elapsedSec,
}: {
  step: UpdateStep
  state: 'done' | 'active' | 'pending'
  elapsedSec?: number
}) {
  const Icon =
    state === 'done'
      ? CheckCircle2
      : state === 'active'
        ? step === 'building'
          ? Hammer
          : Loader2
        : null
  const tone =
    state === 'done'
      ? 'text-status-ready'
      : state === 'active'
        ? 'text-primary'
        : 'text-muted-foreground/60'
  const copy = STEP_COPY[step]
  return (
    <li className="flex items-center gap-2 text-[13px]">
      <span className={cn('inline-flex size-5 items-center justify-center', tone)}>
        {Icon ? (
          <Icon
            className={cn(
              'size-4',
              state === 'active' && step !== 'building' && 'animate-spin',
            )}
          />
        ) : (
          // Pending: empty square outline so the row reserves the same width.
          <span className="size-3.5 rounded-[3px] border border-current" />
        )}
      </span>
      <span className={cn(state === 'pending' && 'text-muted-foreground')}>
        {copy.label}
      </span>
      <span className="text-[12px] text-muted-foreground">
        {state === 'active'
          ? `${copy.estimate ?? ''} — ${formatElapsed(elapsedSec ?? 0)} elapsed`
          : state === 'done'
            ? '✓'
            : copy.estimate
              ? copy.estimate
              : ''}
      </span>
    </li>
  )
}

function formatElapsed(sec: number): string {
  const m = Math.floor(sec / 60)
  const s = sec % 60
  return `${m}:${String(s).padStart(2, '0')}`
}

/** State E — failure: either the server reported a failed step, or it rolled
 *  back the previous binary. Either way the panel keeps the last log line on
 *  screen + offers a retry. */
function FailedView({
  progress,
  current,
  onRetry,
  onRefresh,
  refreshing,
  starting,
}: {
  progress: UpdateProgress
  current: VersionInfo | null
  onRetry: () => void
  onRefresh: () => void
  refreshing: boolean
  starting: boolean
}) {
  const rolled = progress.step === 'rolled_back'
  return (
    <StateCard>
      <div className="flex items-center gap-2">
        <span className="inline-flex size-6 items-center justify-center rounded-full bg-status-error/15 text-status-error">
          <AlertTriangle className="size-4" />
        </span>
        <span className="text-[15px] font-medium">
          {rolled
            ? `Update failed — rolled back to ${current?.tag ?? 'previous build'}`
            : 'Update failed'}
        </span>
      </div>

      <div className="rounded-lg border border-status-error/30 bg-status-error/5 px-3 py-2">
        <p className="text-[12px] font-medium uppercase tracking-wide text-status-error/80">
          Last log line
        </p>
        <p className="mt-0.5 break-words font-mono text-[12px] text-foreground">
          {progress.message}
        </p>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <Button
          asChild
          variant="default"
          onClick={onRetry}
          disabled={starting}
          className="h-11 gap-2 px-5"
        >
          <motion.button
            whileTap={{ scale: 0.97 }}
            transition={springs.buttonPress}
          >
            {starting ? (
              <>
                <Loader2 className="animate-spin" />
                Starting…
              </>
            ) : (
              <>
                <RefreshCw />
                Try again
              </>
            )}
          </motion.button>
        </Button>
        <RefreshButton onRefresh={onRefresh} refreshing={refreshing} />
      </div>
    </StateCard>
  )
}

/** State F — couldn't reach GitHub (or the server). Calm copy, retry button. */
function NoNetworkView({
  error,
  onRefresh,
  refreshing,
}: {
  error: Error | null
  onRefresh: () => void
  refreshing: boolean
}) {
  return (
    <StateCard>
      <div className="flex items-center gap-2">
        <span className="inline-flex size-6 items-center justify-center rounded-full bg-muted text-muted-foreground">
          <WifiOff className="size-4" />
        </span>
        <span className="text-[15px] font-medium">
          Couldn’t check for updates
        </span>
      </div>
      <p className="text-[13px] text-muted-foreground">
        {error?.message ??
          'No network reach to GitHub. supermux will keep trying in the background.'}
      </p>
      <div>
        <RefreshButton onRefresh={onRefresh} refreshing={refreshing} label="Try again" />
      </div>
    </StateCard>
  )
}

// ── shared atoms ──────────────────────────────────────────────────────────────

function RefreshButton({
  onRefresh,
  refreshing,
  label = 'Check now',
}: {
  onRefresh: () => void
  refreshing: boolean
  label?: string
}) {
  const reduce = useReducedMotion()
  return (
    <Button
      asChild
      variant="outline"
      onClick={onRefresh}
      disabled={refreshing}
      className="h-11 gap-2 px-4"
    >
      <motion.button
        whileTap={reduce ? undefined : { scale: 0.97 }}
        transition={springs.buttonPress}
      >
        {refreshing ? (
          <Loader2 className="animate-spin" />
        ) : (
          <Search className="size-4" />
        )}
        {label}
      </motion.button>
    </Button>
  )
}

/** Lazy expand/collapse release notes panel. Closed by default — only the
 *  user who taps the chevron pays for the markdown chunk. */
function ReleaseNotes({ notes, url }: { notes: string; url: string }) {
  const [open, setOpen] = React.useState(false)
  const reduce = useReducedMotion()
  return (
    <div className="rounded-lg border border-border bg-muted/30">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center justify-between gap-2 px-3 py-2 text-left text-[13px] font-medium text-foreground hover:bg-muted/40"
        aria-expanded={open}
      >
        <span className="inline-flex items-center gap-2">
          <PackageCheck className="size-4 text-muted-foreground" />
          Release notes
        </span>
        <motion.span
          animate={{ rotate: open ? 180 : 0 }}
          transition={springs.toggleSnap}
          className="text-muted-foreground"
        >
          <ChevronDown className="size-4" />
        </motion.span>
      </button>
      <AnimatePresence initial={false}>
        {open && (
          <motion.div
            key="notes"
            initial={reduce ? false : { height: 0, opacity: 0 }}
            animate={{ height: 'auto', opacity: 1 }}
            exit={reduce ? { opacity: 0 } : { height: 0, opacity: 0 }}
            transition={springs.cardExpand}
            className="overflow-hidden"
          >
            <div className="border-t border-border px-3 py-3">
              <div className="max-h-64 overflow-y-auto text-[13px]">
                <React.Suspense
                  fallback={
                    <p className="text-muted-foreground">Loading notes…</p>
                  }
                >
                  <MarkdownViewer source={notes} basePath="/release-notes.md" />
                </React.Suspense>
              </div>
              <a
                href={url}
                target="_blank"
                rel="noopener noreferrer"
                className="mt-3 inline-flex h-9 items-center gap-1.5 text-[13px] font-medium text-primary hover:underline"
              >
                View on GitHub
                <ExternalLink className="size-3.5" />
              </a>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  )
}

// ── public component ──────────────────────────────────────────────────────────

/** Settings → Updates section. Top "current version" row stays put across all
 *  states; the rest of the card swaps between A-F via an AnimatePresence morph
 *  so the transitions read as one calm change instead of a re-render flash. */
export function UpdatesPanel() {
  const v = useVersion()
  const [refreshing, setRefreshing] = React.useState(false)

  const onRefresh = React.useCallback(async () => {
    if (refreshing) return
    setRefreshing(true)
    try {
      await v.refresh()
    } finally {
      setRefreshing(false)
    }
  }, [refreshing, v])

  const onUpdate = React.useCallback(async () => {
    try {
      await v.startUpdate()
    } catch {
      // The hook already invalidated the version query on 409; the panel
      // re-renders with the new blocked_reasons. Nothing else to do here.
    }
  }, [v])

  const inFlight =
    v.progress &&
    v.progress.step !== 'done' &&
    v.progress.step !== 'failed' &&
    v.progress.step !== 'rolled_back'
  const terminalFailure =
    v.progress?.step === 'failed' || v.progress?.step === 'rolled_back'

  // Pick which sub-state to render. `inFlight` and `terminalFailure` take
  // priority over the version snapshot — the user explicitly chose this path,
  // so showing the upstream "Up to date" message under it would be confusing.
  const renderState = (() => {
    if (inFlight) return 'D' as const
    if (terminalFailure) return 'E' as const
    if (v.error) return 'F' as const
    if (
      v.blockedReasons.some((r) => r.kind === 'no_network') &&
      !v.updateAvailable
    ) {
      return 'F' as const
    }
    if (v.updateAvailable && v.blockedReasons.length > 0) return 'C' as const
    if (v.updateAvailable && v.latest) return 'B' as const
    return 'A' as const
  })()

  return (
    <SectionWithAction
      id="updates"
      title="Updates"
      footnote="supermux checks for new releases automatically. When one’s ready, install it from here in one tap."
    >
      {/* Current version is always visible — anchors the state below. */}
      <Row
        label={
          <div className="flex flex-col gap-0.5">
            <span className="text-[15px] font-medium">Current version</span>
            <span className="font-mono text-[13px] text-muted-foreground">
              {v.current ? (
                <>
                  {v.current.tag ?? 'dev'} · {v.current.sha} ·{' '}
                  {v.current.built_at ? `built ${formatBuildAt(v.current.built_at)}` : ''}
                </>
              ) : v.loading ? (
                'Loading…'
              ) : (
                'Unknown'
              )}
            </span>
          </div>
        }
      />

      <Row>
        <AnimatePresence mode="wait" initial={false}>
          <motion.div
            key={renderState}
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.18 }}
            className="w-full"
          >
            {renderState === 'A' && (
              <UpToDateView onRefresh={onRefresh} refreshing={refreshing} />
            )}
            {renderState === 'B' && v.latest && (
              <UpdateAvailableView
                latest={v.latest}
                onUpdate={onUpdate}
                onRefresh={onRefresh}
                refreshing={refreshing}
                starting={v.starting}
              />
            )}
            {renderState === 'C' && (
              <BlockedView
                latest={v.latest}
                reasons={v.blockedReasons}
                onRefresh={onRefresh}
                refreshing={refreshing}
              />
            )}
            {renderState === 'D' && v.progress && (
              <UpdatingView latest={v.latest} progress={v.progress} />
            )}
            {renderState === 'E' && v.progress && (
              <FailedView
                progress={v.progress}
                current={v.current}
                onRetry={onUpdate}
                onRefresh={onRefresh}
                refreshing={refreshing}
                starting={v.starting}
              />
            )}
            {renderState === 'F' && (
              <NoNetworkView
                error={v.error}
                onRefresh={onRefresh}
                refreshing={refreshing}
              />
            )}
          </motion.div>
        </AnimatePresence>
      </Row>
    </SectionWithAction>
  )
}
