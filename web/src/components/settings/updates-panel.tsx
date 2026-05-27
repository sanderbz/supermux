// Settings → Updates (v0.3.0).
//
// Renders one of four states for the running supermux installation:
//   1. Up to date           — quiet "✓ Up to date" line, no badge.
//   2. Update available     — green badge, release-notes preview, "Update now" button.
//   3. Update blocked       — amber badge, bulleted blocked_reasons w/ actions.
//   4. Update in progress   — modal with live SSE progress + per-step copy.
//
// All copy comes from the server's `blocked_reasons[*].message` field — the
// frontend never invents prose. This keeps server + client in sync when a new
// blocker variant lands.

import * as React from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import {
  AlertTriangle,
  ArrowUpCircle,
  CheckCircle2,
  CircleDot,
  Loader2,
  RefreshCw,
  RotateCcw,
} from 'lucide-react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'

import { cn } from '@/lib/utils'
import { springs } from '@/lib/springs'
import { useVersion } from '@/hooks/use-version'
import type {
  BlockedReason,
  InstallMode,
  UpdateStep,
  VersionInfo,
} from '@/lib/api'
import { Row, Section } from '@/components/settings/primitives'
import { Button } from '@/components/ui/button'
import { ResponsiveSheet } from '@/components/ui/responsive-sheet'

/** Human-friendly time string for the binary's build_time (ISO-8601 UTC). */
function formatBuildTime(iso: string): string {
  if (!iso) return ''
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return iso
  // Local time, short — the user already knows it's recent if they're looking.
  return d.toLocaleString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  })
}

/** Title for an install-mode badge under the version line. */
function installModeLabel(mode: InstallMode | null): string {
  if (!mode) return ''
  switch (mode.kind) {
    case 'systemd':
      return mode.path_unit_present
        ? 'systemd (1-click ready)'
        : 'systemd (path-unit missing)'
    case 'bare_binary':
      return 'bare binary'
    case 'dev':
      return 'dev'
    case 'docker':
      return 'docker'
    case 'unknown':
      return 'unknown'
  }
}

/** Render the version block — tag prominent, sha muted, build time tiny. */
function VersionLine({ current }: { current: VersionInfo }) {
  const shortSha = current.sha === 'dev' ? 'dev' : current.sha.slice(0, 7)
  const tag = current.tag ?? 'dev build'
  return (
    <div className="flex flex-col gap-0.5">
      <div className="flex items-baseline gap-2">
        <span className="text-[15px] font-semibold tracking-tight text-foreground">
          {tag}
        </span>
        <span className="font-mono text-[12px] text-muted-foreground">
          {shortSha}
        </span>
      </div>
      {current.build_time ? (
        <span className="text-[11px] text-muted-foreground">
          Built {formatBuildTime(current.build_time)}
        </span>
      ) : null}
    </div>
  )
}

/** Friendly title + tone for each step of the install. */
function stepMeta(step: UpdateStep | null): {
  label: string
  index: number
  total: number
  done: boolean
  failed: boolean
} {
  const order: UpdateStep[] = ['queued', 'fetching', 'building', 'installing', 'verifying']
  const labels: Record<UpdateStep, string> = {
    queued: 'Queued',
    fetching: 'Fetching',
    building: 'Building',
    installing: 'Installing',
    verifying: 'Verifying',
    done: 'Done',
    failed: 'Failed',
    rolled_back: 'Rolled back',
  }
  if (!step) {
    return { label: 'Starting', index: 0, total: order.length, done: false, failed: false }
  }
  if (step === 'done') {
    return { label: labels.done, index: order.length, total: order.length, done: true, failed: false }
  }
  if (step === 'failed' || step === 'rolled_back') {
    return {
      label: labels[step],
      index: order.length,
      total: order.length,
      done: false,
      failed: true,
    }
  }
  const idx = order.indexOf(step)
  return {
    label: labels[step],
    index: idx >= 0 ? idx + 1 : 0,
    total: order.length,
    done: false,
    failed: false,
  }
}

/** Live progress modal — opens on "Update now", closes on the user's "Done". */
function UpdateProgressSheet({
  open,
  onOpenChange,
  v,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  v: ReturnType<typeof useVersion>
}) {
  const last = v.progress[v.progress.length - 1]
  const meta = stepMeta(v.currentStep)
  const progressPct = meta.failed ? 100 : (meta.index / meta.total) * 100

  return (
    <ResponsiveSheet
      open={open}
      onOpenChange={(o) => {
        // Only allow dismiss after a terminal state — otherwise the user could
        // close the sheet, lose the live tail, and not see if the deploy
        // succeeded. The whole point of the modal is to OWN the user's
        // attention for the ~2 minutes the install runs.
        if (!o && !v.updateDone && !v.updateFailed) return
        onOpenChange(o)
      }}
      title={meta.failed ? 'Update failed' : meta.done ? 'Update complete' : 'Updating supermux'}
      description={
        meta.failed
          ? 'The previous version has been restored.'
          : meta.done
            ? 'Reload the page to see the new version.'
            : 'Keep this window open — usually about two minutes.'
      }
      className="sm:max-w-lg"
      footer={
        <div className="flex justify-end gap-2">
          {meta.done ? (
            <Button
              onClick={() => window.location.reload()}
              className="h-11 gap-1.5"
            >
              <RefreshCw className="size-4" />
              Reload now
            </Button>
          ) : meta.failed ? (
            <Button
              variant="secondary"
              onClick={() => {
                v.resetUpdate()
                onOpenChange(false)
              }}
              className="h-11"
            >
              Close
            </Button>
          ) : (
            <span className="text-[13px] text-muted-foreground">
              {meta.index}/{meta.total}
            </span>
          )}
        </div>
      }
    >
      <div className="flex flex-col gap-5 px-5 py-5">
        {/* Animated progress bar — motion-spring on width transitions. */}
        <div className="flex flex-col gap-2">
          <div className="flex items-center justify-between gap-3">
            <div className="flex items-center gap-2">
              {meta.failed ? (
                <AlertTriangle className="size-4 text-destructive" />
              ) : meta.done ? (
                <CheckCircle2 className="size-4 text-emerald-500" />
              ) : (
                <Loader2 className="size-4 animate-spin text-primary" />
              )}
              <span className="text-[15px] font-medium text-foreground">
                {meta.label}
              </span>
            </div>
            <span className="text-[12px] tabular-nums text-muted-foreground">
              {meta.done || meta.failed ? '' : '~2 min'}
            </span>
          </div>
          <div className="relative h-1.5 overflow-hidden rounded-full bg-muted">
            <motion.div
              className={cn(
                'absolute inset-y-0 left-0 rounded-full',
                meta.failed
                  ? 'bg-destructive'
                  : meta.done
                    ? 'bg-emerald-500'
                    : 'bg-primary',
              )}
              initial={false}
              animate={{ width: `${progressPct}%` }}
              transition={springs.smooth}
            />
          </div>
        </div>

        {/* Latest message line — verbatim from the server's `msg=` payload. */}
        {last ? (
          <div className="rounded-lg border border-border bg-muted/30 px-3 py-2.5 text-[13px] text-foreground">
            {last.message}
          </div>
        ) : null}

        {/* Step timeline — every event the server emitted, newest at the bottom. */}
        {v.progress.length > 1 ? (
          <div className="flex flex-col gap-1.5">
            <p className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
              Timeline
            </p>
            <ul className="flex flex-col gap-1">
              {v.progress.map((ev, i) => (
                <li
                  key={`${ev.ts}-${ev.step}-${i}`}
                  className="flex items-center gap-2 text-[12px] text-muted-foreground"
                >
                  <CircleDot
                    className={cn(
                      'size-3 shrink-0',
                      ev.step === 'failed' || ev.step === 'rolled_back'
                        ? 'text-destructive'
                        : ev.step === 'done'
                          ? 'text-emerald-500'
                          : 'text-primary',
                    )}
                  />
                  <span className="capitalize">{ev.step.replace('_', ' ')}</span>
                  <span className="truncate">— {ev.message}</span>
                </li>
              ))}
            </ul>
          </div>
        ) : null}

        {/* On rollback, link to the runner log for forensics. */}
        {meta.failed && v.jobId ? (
          <p className="text-[12px] text-muted-foreground">
            For details, check the supermux-deploy unit on the server:{' '}
            <code className="rounded bg-muted px-1 py-0.5 font-mono text-[11px]">
              journalctl -u supermux-deploy -n 100
            </code>
          </p>
        ) : null}
      </div>
    </ResponsiveSheet>
  )
}

/** Confirmation sheet — release notes + "Yes, update". */
function ConfirmUpdateSheet({
  open,
  onOpenChange,
  v,
  onConfirm,
  starting,
  startError,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  v: ReturnType<typeof useVersion>
  onConfirm: () => void
  starting: boolean
  startError: string | null
}) {
  return (
    <ResponsiveSheet
      open={open}
      onOpenChange={onOpenChange}
      title={`Update to ${v.latest?.tag ?? 'latest'}`}
      description={
        v.latest?.published_at
          ? `Published ${new Date(v.latest.published_at).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' })}`
          : 'Pulled from the GitHub release.'
      }
      className="sm:max-w-2xl"
      footer={
        <div className="flex items-center justify-between gap-3">
          {v.latest?.html_url ? (
            <a
              href={v.latest.html_url}
              target="_blank"
              rel="noopener noreferrer"
              className="text-[13px] text-muted-foreground underline-offset-2 hover:underline"
            >
              View on GitHub
            </a>
          ) : (
            <span />
          )}
          <div className="flex items-center gap-2">
            <Button
              variant="ghost"
              onClick={() => onOpenChange(false)}
              disabled={starting}
              className="h-11"
            >
              Cancel
            </Button>
            <Button
              asChild
              onClick={onConfirm}
              disabled={starting}
              className="h-11 gap-1.5"
            >
              <motion.button whileTap={{ scale: 0.96 }} transition={springs.buttonPress}>
                {starting ? (
                  <Loader2 className="size-4 animate-spin" />
                ) : (
                  <ArrowUpCircle className="size-4" />
                )}
                {starting ? 'Starting…' : 'Yes, update'}
              </motion.button>
            </Button>
          </div>
        </div>
      }
    >
      <div className="flex flex-col gap-4 px-5 py-5">
        {startError ? (
          <div className="rounded-lg border border-destructive/40 bg-destructive/5 px-3 py-2 text-[13px] text-destructive">
            {startError}
          </div>
        ) : null}
        {v.latest?.body ? (
          <div className="prose prose-sm max-w-none text-foreground">
            <ReactMarkdown
              remarkPlugins={[remarkGfm]}
              components={{
                a: ({ href, children, ...rest }) => (
                  <a
                    href={href}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-primary underline-offset-2 hover:underline"
                    {...rest}
                  >
                    {children}
                  </a>
                ),
                ul: ({ children }) => (
                  <ul className="ml-4 list-disc text-[14px] leading-relaxed">{children}</ul>
                ),
                ol: ({ children }) => (
                  <ol className="ml-4 list-decimal text-[14px] leading-relaxed">{children}</ol>
                ),
                p: ({ children }) => (
                  <p className="text-[14px] leading-relaxed text-foreground">{children}</p>
                ),
                h1: ({ children }) => (
                  <h1 className="text-[18px] font-semibold tracking-tight">{children}</h1>
                ),
                h2: ({ children }) => (
                  <h2 className="text-[16px] font-semibold tracking-tight">{children}</h2>
                ),
                h3: ({ children }) => (
                  <h3 className="text-[15px] font-semibold tracking-tight">{children}</h3>
                ),
                code: ({ children, ...rest }) => (
                  <code
                    className="rounded bg-muted px-1 py-0.5 font-mono text-[12px]"
                    {...rest}
                  >
                    {children}
                  </code>
                ),
              }}
            >
              {v.latest.body}
            </ReactMarkdown>
          </div>
        ) : (
          <p className="text-[13px] text-muted-foreground">
            The release notes are empty — see the GitHub link for full details.
          </p>
        )}
      </div>
    </ResponsiveSheet>
  )
}

/** One blocked reason rendered as a single bullet line. */
function BlockedRow({ reason }: { reason: BlockedReason }) {
  return (
    <div className="flex items-start gap-2.5 py-1.5">
      <AlertTriangle className="mt-0.5 size-4 shrink-0 text-amber-500" />
      <div className="flex flex-col gap-1 text-[13px]">
        <p className="text-foreground">{reason.message}</p>
        {reason.kind === 'manual_update_required' ? (
          <code className="w-fit rounded bg-muted px-1.5 py-0.5 font-mono text-[12px] text-foreground">
            {reason.command}
          </code>
        ) : null}
      </div>
    </div>
  )
}

/** The header card: tag + sha + build time + install mode. */
function CurrentVersionCard({
  current,
  installMode,
}: {
  current: VersionInfo
  installMode: InstallMode | null
}) {
  return (
    <div className="flex items-start justify-between gap-3 px-4 py-3">
      <VersionLine current={current} />
      {installMode ? (
        <span className="rounded-full bg-muted px-2 py-0.5 text-[11px] font-medium text-muted-foreground">
          {installModeLabel(installMode)}
        </span>
      ) : null}
    </div>
  )
}

/** The Section that lives in the Settings route. */
export function UpdatesSection() {
  const v = useVersion()
  const [confirmOpen, setConfirmOpen] = React.useState(false)
  const [progressOpen, setProgressOpen] = React.useState(false)
  const [starting, setStarting] = React.useState(false)
  const [startError, setStartError] = React.useState<string | null>(null)

  // The progress sheet should open as soon as `jobId` lands and stay open
  // through done/failed (the user explicitly closes it).
  React.useEffect(() => {
    if (v.jobId) setProgressOpen(true)
  }, [v.jobId])

  // Loading skeleton — keep it modest, this is one of many Settings sections.
  if (!v.current) {
    return (
      <Section title="Updates">
        <Row>
          <div className="flex items-center gap-3 py-2 text-[13px] text-muted-foreground">
            <Loader2 className="size-4 animate-spin" />
            Checking for updates…
          </div>
        </Row>
      </Section>
    )
  }

  // Docker / unknown installs hide the section entirely — the user has no
  // actionable surface here.
  if (!v.manageable) {
    return (
      <Section
        title="Updates"
        footnote="In-app updates aren't available on this install type. Update through your container/orchestrator instead."
      >
        <CurrentVersionCard current={v.current} installMode={v.installMode} />
      </Section>
    )
  }

  const clickable =
    v.updateAvailable && v.blockedReasons.length === 0 && !v.jobId

  // The hierarchy of states the section can render:
  //   1. Update available + no blockers → green badge + "Update now"
  //   2. Update available + blockers    → amber badge + bulleted reasons
  //   3. Up to date                     → quiet "✓ Up to date"
  //   4. GitHub unreachable + no cache  → muted "couldn't check" line
  const noLatest = v.latest === null
  const hasBlockers = v.blockedReasons.length > 0

  async function onConfirm() {
    setStarting(true)
    setStartError(null)
    try {
      await v.startUpdate()
      setConfirmOpen(false)
      // The useEffect above opens the progress sheet once `jobId` arrives.
    } catch (e) {
      // Preflight changed under us — pull the fresh blocked_reasons through.
      const message = e instanceof Error ? e.message : 'Could not start the update.'
      setStartError(message)
      await v.refresh()
    } finally {
      setStarting(false)
    }
  }

  const footnote = noLatest
    ? `Couldn't reach GitHub to check for updates. The running version is shown above; supermux will try again automatically.`
    : `supermux checks for new releases every 30 seconds while this page is open.`

  return (
    <Section title="Updates" footnote={footnote}>
      <CurrentVersionCard current={v.current} installMode={v.installMode} />

      <Row>
        <AnimatePresence mode="wait">
          {v.updateAvailable ? (
            <motion.div
              key="available"
              initial={{ opacity: 0, y: 4 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0 }}
              transition={springs.cardExpand}
              className="flex flex-col gap-3 py-1"
            >
              <div className="flex items-center justify-between gap-3">
                <div className="flex items-center gap-2">
                  <span
                    className={cn(
                      'inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-[12px] font-medium',
                      hasBlockers
                        ? 'bg-amber-500/15 text-amber-600 dark:text-amber-400'
                        : 'bg-emerald-500/15 text-emerald-600 dark:text-emerald-400',
                    )}
                  >
                    {hasBlockers ? (
                      <AlertTriangle className="size-3.5" />
                    ) : (
                      <ArrowUpCircle className="size-3.5" />
                    )}
                    {hasBlockers
                      ? `Update available — action needed`
                      : `Update available: ${v.latest?.tag}`}
                  </span>
                </div>
                <div className="flex items-center gap-2">
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => void v.refresh()}
                    disabled={v.refreshing}
                    className="h-8 gap-1.5 text-[12px]"
                  >
                    <RotateCcw className={cn('size-3.5', v.refreshing && 'animate-spin')} />
                    {v.refreshing ? 'Checking…' : 'Refresh'}
                  </Button>
                  {clickable ? (
                    <Button
                      asChild
                      onClick={() => {
                        setStartError(null)
                        setConfirmOpen(true)
                      }}
                      className="h-11 gap-1.5"
                    >
                      <motion.button
                        whileTap={{ scale: 0.96 }}
                        transition={springs.buttonPress}
                      >
                        <ArrowUpCircle className="size-4" />
                        Update now
                      </motion.button>
                    </Button>
                  ) : null}
                </div>
              </div>

              {hasBlockers ? (
                <div className="flex flex-col gap-0.5 rounded-lg border border-amber-500/20 bg-amber-500/5 px-3 py-2">
                  {v.blockedReasons.map((reason, i) => (
                    <BlockedRow key={`${reason.kind}-${i}`} reason={reason} />
                  ))}
                </div>
              ) : v.latest?.body ? (
                <div className="rounded-lg border border-border bg-muted/30 px-3 py-2 text-[13px] text-muted-foreground">
                  <p className="mb-1 font-medium text-foreground">
                    What&rsquo;s new
                  </p>
                  <p className="line-clamp-3 whitespace-pre-line">
                    {v.latest.body.replace(/^#+\s.*$/gm, '').trim()}
                  </p>
                </div>
              ) : null}
            </motion.div>
          ) : noLatest ? (
            <motion.div
              key="no-latest"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              className="flex items-center justify-between gap-3 py-1 text-[13px] text-muted-foreground"
            >
              <span>Couldn&rsquo;t reach GitHub.</span>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => void v.refresh()}
                disabled={v.refreshing}
                className="h-8 gap-1.5 text-[12px]"
              >
                <RotateCcw className={cn('size-3.5', v.refreshing && 'animate-spin')} />
                Try again
              </Button>
            </motion.div>
          ) : (
            <motion.div
              key="uptodate"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              className="flex items-center justify-between gap-3 py-1"
            >
              <div className="flex items-center gap-2 text-[13px] text-muted-foreground">
                <CheckCircle2 className="size-4 text-emerald-500" />
                Up to date
              </div>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => void v.refresh()}
                disabled={v.refreshing}
                className="h-8 gap-1.5 text-[12px]"
              >
                <RotateCcw className={cn('size-3.5', v.refreshing && 'animate-spin')} />
                Check again
              </Button>
            </motion.div>
          )}
        </AnimatePresence>
      </Row>

      <ConfirmUpdateSheet
        open={confirmOpen}
        onOpenChange={(o) => {
          setConfirmOpen(o)
          if (!o) setStartError(null)
        }}
        v={v}
        onConfirm={() => void onConfirm()}
        starting={starting}
        startError={startError}
      />
      <UpdateProgressSheet
        open={progressOpen}
        onOpenChange={setProgressOpen}
        v={v}
      />
    </Section>
  )
}
