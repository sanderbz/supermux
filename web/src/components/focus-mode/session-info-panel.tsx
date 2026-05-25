// SessionInfoPanel (feat-session-info) — the compact "about this session" panel
// that springs from the focus-view TITLE. The title looks IDENTICAL at rest (the
// trigger is a bare button with the header's typography, no padding/border) — no
// resting space is added anywhere.
//
// One component, forked on input modality (the same `useMediaQuery('(pointer:
// coarse)')` signal ResponsiveSheet uses):
//   • DESKTOP (fine pointer) → a Radix Popover anchored to the title, w-80,
//     align="start", sideOffset 6.
//   • MOBILE  (coarse pointer) → the shared ResponsiveSheet (Vaul bottom sheet).
//
// It takes only the session `name` and self-derives the live row via
// `useSession(name)` so it stays live over SSE. Body reuses the board detail
// pane's section/row/pill patterns + the springs bank. Sections: working dir
// (mono + copy), settings (provider / mode / flags / MCP / worktree), schedules
// (live via useSchedules, filtered to this session), git branch, and a primary
// "Clone agent in this directory" footer action.
//
// iOS-native finish: 10px radii, springs.ts, sentence-case copy, ≥44pt targets,
// reduced-motion safe. The panel only MOUNTS while open (the routes gate it).

import * as React from 'react'
import { Link } from 'react-router-dom'
import { motion, useReducedMotion } from 'framer-motion'
import {
  CalendarClock,
  Check,
  Copy,
  Files,
  GitBranch,
  Loader2,
} from 'lucide-react'

import { cn } from '@/lib/utils'
import { springs } from '@/lib/springs'
import { useMediaQuery } from '@/hooks/use-media-query'
import {
  Popover,
  PopoverAnchor,
  PopoverContent,
} from '@/components/ui/popover'
import { ResponsiveSheet } from '@/components/ui/responsive-sheet'
import { useToast } from '@/components/ui/use-toast'
import { useSession } from '@/hooks/use-sessions'
import { useSchedules } from '@/hooks/use-scheduler'
import {
  describeSchedule,
  formatRunTime,
} from '@/components/scheduler/helpers'
import type { ApiSession, SessionMode, ScheduleRow } from '@/lib/api'
import { useCloneSession } from './use-clone-session'

/** Sentence-case label for each Claude permission mode (mirrors mode-menu.tsx). */
const MODE_LABEL: Record<SessionMode, string> = {
  normal: 'Normal',
  accept_edits: 'Accept edits',
  plan: 'Plan mode',
  bypass: 'Bypass',
}

export interface SessionInfoPanelProps {
  /** The focused session name — the panel self-derives its live row. */
  name: string
  open: boolean
  onOpenChange: (open: boolean) => void
  /** Desktop only: the title button the popover anchors to (passed as a Radix
   *  `virtualRef` so the header stays dumb — it just forwards the ref to its
   *  title <button>). Mobile ignores it (the sheet is modal, anchored to the
   *  viewport bottom). */
  triggerRef?: React.RefObject<HTMLElement | null>
  /** Navigate to a freshly-cloned session's focus route. The route passes its own
   *  `goSession` (mobile) / select handler (desktop) so the panel doesn't own
   *  routing. */
  onNavigate: (name: string) => void
}

/**
 * The session info panel. Desktop = Popover anchored to the title; mobile =
 * ResponsiveSheet bottom sheet. Both render the shared <PanelBody>.
 */
export function SessionInfoPanel({
  name,
  open,
  onOpenChange,
  triggerRef,
  onNavigate,
}: SessionInfoPanelProps) {
  const isMobile = useMediaQuery('(pointer: coarse)')

  if (isMobile) {
    return (
      <ResponsiveSheet
        open={open}
        onOpenChange={onOpenChange}
        title="Session"
        description={name}
      >
        {/* Only mounts while open — ResponsiveSheet (Vaul) unmounts its content
            when closed, so the schedules query never runs at rest. */}
        <div className="px-5 py-4">
          <PanelBody
            name={name}
            onNavigate={onNavigate}
            onClose={() => onOpenChange(false)}
          />
        </div>
      </ResponsiveSheet>
    )
  }

  // Desktop: a Popover anchored to the title via a `virtualRef` (the title
  // <button> in the header), so the header stays dumb — it owns no popover state,
  // just the ref + onClick. The content positions against the real title element.
  return (
    <Popover open={open} onOpenChange={onOpenChange}>
      {/* virtualRef wants a non-null RefObject<Measurable>; an HTMLElement ref
          satisfies getBoundingClientRect, and Radix guards a null `.current`. */}
      <PopoverAnchor
        virtualRef={triggerRef as React.RefObject<{ getBoundingClientRect(): DOMRect }>}
      />
      <PopoverContent
        align="start"
        sideOffset={6}
        className="w-80 rounded-[10px] p-0"
      >
        <div className="max-h-[70vh] overflow-y-auto px-4 py-4 [scrollbar-width:thin]">
          <PanelBody
            name={name}
            onNavigate={onNavigate}
            onClose={() => onOpenChange(false)}
          />
        </div>
      </PopoverContent>
    </Popover>
  )
}

// ── shared body ────────────────────────────────────────────────────────────

function PanelBody({
  name,
  onNavigate,
  onClose,
}: {
  name: string
  onNavigate: (name: string) => void
  onClose: () => void
}) {
  const { session } = useSession(name)
  const clone = useCloneSession()
  const { toast } = useToast()

  const dir = session?.dir?.trim() || ''
  const branch = session?.branch?.trim() || ''

  const doClone = async () => {
    if (clone.pending) return
    try {
      const newName = await clone.run(name)
      toast({ message: `Cloned to ${newName}`, tone: 'active' })
      onClose()
      onNavigate(newName)
    } catch (e) {
      toast({
        message: `Clone failed — ${(e as Error).message}`,
        tone: 'error',
        duration: 4000,
      })
    }
  }

  return (
    <div className="flex flex-col gap-4">
      {/* Working dir */}
      <PaneSection label="Working dir">
        {dir ? (
          <CopyableMono value={dir} ariaLabel="Copy working directory" />
        ) : (
          <p className="text-sm text-muted-foreground">Not set.</p>
        )}
      </PaneSection>

      {/* Settings */}
      <PaneSection label="Settings">
        <SettingsRows session={session} name={name} />
      </PaneSection>

      {/* Schedules */}
      <PaneSection label="Schedules">
        <SchedulesList name={name} />
      </PaneSection>

      {/* Git */}
      <PaneSection label="Git">
        <div className="flex items-center gap-1.5 text-sm text-foreground">
          <GitBranch className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />
          {branch ? (
            <span className="truncate font-mono text-[13px]">{branch}</span>
          ) : (
            <span className="text-muted-foreground">No branch recorded.</span>
          )}
        </div>
      </PaneSection>

      {/* Footer — Clone */}
      <button
        type="button"
        onClick={doClone}
        disabled={clone.pending}
        className={cn(
          'mt-1 inline-flex min-h-11 w-full items-center justify-center gap-2 rounded-[10px]',
          'bg-primary px-4 text-sm font-medium text-primary-foreground shadow-sm',
          'transition-colors hover:bg-primary/90 disabled:pointer-events-none disabled:opacity-50',
          'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
        )}
      >
        {clone.pending ? (
          <Loader2 className="size-4 animate-spin" aria-hidden />
        ) : (
          <Files className="size-4" aria-hidden />
        )}
        {clone.pending ? 'Cloning…' : 'Clone agent in this directory'}
      </button>
    </div>
  )
}

// ── settings rows ────────────────────────────────────────────────────────────

function SettingsRows({
  session,
  name,
}: {
  session: ApiSession | null
  name: string
}) {
  const provider = session?.provider?.trim() || '—'
  const mode = session?.mode
  const flags = session?.flags?.trim() || ''
  const mcp = session?.mcp?.trim() || ''
  const worktree = session?.worktree
  // The mode pill is a Claude-only concept (permission modes don't exist for a
  // plain shell / codex pane), matching the header's gate.
  const showMode = session?.provider === 'claude'

  return (
    <dl className="flex flex-col gap-2">
      <InfoRow label="Provider">
        <span className="text-[13px] capitalize text-foreground">{provider}</span>
      </InfoRow>
      {showMode && (
        <InfoRow label="Mode">
          <span className="inline-flex items-center rounded-full bg-secondary px-2 py-0.5 text-[11px] font-medium text-foreground">
            {MODE_LABEL[mode ?? 'normal']}
          </span>
        </InfoRow>
      )}
      <InfoRow label="Flags">
        {flags ? (
          <code className="block max-w-full truncate rounded-md bg-muted/60 px-1.5 py-0.5 font-mono text-[11px] text-foreground">
            {flags}
          </code>
        ) : (
          <span className="text-[13px] text-muted-foreground">None</span>
        )}
      </InfoRow>
      <InfoRow label="MCP">
        {mcp ? (
          <code className="block max-w-full truncate rounded-md bg-muted/60 px-1.5 py-0.5 font-mono text-[11px] text-foreground">
            {mcp}
          </code>
        ) : (
          <span className="text-[13px] text-muted-foreground">None</span>
        )}
      </InfoRow>
      <InfoRow label="Worktree">
        <span className="text-[13px] text-foreground">
          {/* Default to "—" while the row hasn't loaded; the boolean is explicit. */}
          {session ? (worktree ? 'Yes' : 'No') : '—'}
        </span>
      </InfoRow>
      {/* `name` is the stable identity even before the row loads — keep it as the
          row's accessible label fallback so the section is never empty. */}
      <span className="sr-only">Session {name}</span>
    </dl>
  )
}

function InfoRow({
  label,
  children,
}: {
  label: string
  children: React.ReactNode
}) {
  return (
    <div className="flex items-baseline justify-between gap-3">
      <dt className="shrink-0 text-xs text-muted-foreground">{label}</dt>
      <dd className="min-w-0 text-right">{children}</dd>
    </div>
  )
}

// ── schedules ────────────────────────────────────────────────────────────────

function SchedulesList({ name }: { name: string }) {
  const { data, isLoading } = useSchedules()
  const reduce = useReducedMotion()

  const mine = React.useMemo<ScheduleRow[]>(
    () => (data ?? []).filter((s) => s.session === name && !s.deleted),
    [data, name],
  )

  if (isLoading && !data) {
    return (
      <div className="flex items-center gap-2 text-sm text-muted-foreground">
        <Loader2 className="size-3.5 animate-spin" aria-hidden />
        Loading…
      </div>
    )
  }

  if (mine.length === 0) {
    return (
      <p className="text-sm text-muted-foreground">
        No schedules.{' '}
        <Link
          to="/scheduler"
          className="font-medium text-primary underline-offset-2 hover:underline"
        >
          Add one
        </Link>
        .
      </p>
    )
  }

  return (
    <ul className="flex flex-col gap-1.5">
      {mine.map((s, i) => (
        <motion.li
          key={s.id}
          initial={reduce ? false : { opacity: 0, y: 4 }}
          animate={{ opacity: 1, y: 0 }}
          transition={reduce ? { duration: 0 } : { ...springs.snappy, delay: i * 0.02 }}
        >
          <Link
            to="/scheduler"
            className={cn(
              'flex min-h-11 items-center gap-2 rounded-[10px] border border-border bg-card px-2.5 py-1.5',
              'transition-colors hover:bg-accent/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
            )}
          >
            <CalendarClock
              className="size-4 shrink-0 text-muted-foreground"
              aria-hidden
            />
            <span className="flex min-w-0 flex-1 flex-col">
              <span className="truncate text-[13px] font-medium text-foreground">
                {s.title}
              </span>
              <span className="truncate text-[11px] text-muted-foreground">
                {describeSchedule(s.schedule_expr)}
                {s.next_run ? ` · next ${formatRunTime(s.next_run)}` : ''}
              </span>
            </span>
          </Link>
        </motion.li>
      ))}
    </ul>
  )
}

// ── primitives ────────────────────────────────────────────────────────────────

/** A mono value row with a copy-to-clipboard affordance (≥44pt copy target). */
function CopyableMono({
  value,
  ariaLabel,
}: {
  value: string
  ariaLabel: string
}) {
  const [copied, setCopied] = React.useState(false)
  const timer = React.useRef<ReturnType<typeof setTimeout> | null>(null)

  React.useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current)
    },
    [],
  )

  const copy = () => {
    void navigator.clipboard?.writeText(value)
    setCopied(true)
    if (timer.current) clearTimeout(timer.current)
    timer.current = setTimeout(() => setCopied(false), 1500)
  }

  return (
    <div className="flex items-center gap-1.5">
      <code className="min-w-0 flex-1 truncate rounded-md bg-muted/60 px-2 py-1.5 font-mono text-[12px] text-foreground">
        {value}
      </code>
      <button
        type="button"
        onClick={copy}
        aria-label={ariaLabel}
        title={copied ? 'Copied' : 'Copy'}
        className="grid size-11 shrink-0 place-items-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        {copied ? (
          <Check className="size-4 text-status-active" aria-hidden />
        ) : (
          <Copy className="size-4" aria-hidden />
        )}
      </button>
    </div>
  )
}

/** A labelled section — mirrors board-detail-pane's PaneSection. */
function PaneSection({
  label,
  children,
}: {
  label: string
  children: React.ReactNode
}) {
  return (
    <div className="flex flex-col gap-2">
      <span className="text-xs font-medium text-muted-foreground">{label}</span>
      {children}
    </div>
  )
}

export default SessionInfoPanel
