// StoppedSession — the calm focus-pane state for a `stopped` session.
//
// When a session's `status` is `stopped` (its DB row outlived its tmux session
// — e.g. after a host reboot), the focus route renders THIS instead of mounting
// the live <LiveTerminal>. Opening a WS to a dead pty just 101-upgrades, then
// gets closed by the server, then reconnects — a no-op storm the user sees as a
// hang. Detecting `stopped` up front from the session object avoids opening that
// WS at all.
//
// The primary action calls `POST /api/sessions/:name/start` (the existing M2
// endpoint). On success the SSE `status` delta flips the session to `starting`/
// `active` and the focus route swaps this surface for the live terminal — no
// manual refresh, no remount churn.
//
// VISUAL: design tokens only, sentence-case copy, springs from lib/springs.ts,
// the 44pt HIG hit-target floor on the action. Matches <EmptyStatePlaceholder>.
//
// REUSE: the inner button cluster is factored out as <StoppedSessionActions>
// so the overview-tile hover-peek (feat-stopped-peek-actions) can render the
// SAME Start + Archive controls without remounting a dead-terminal peek. One
// source of truth for the action behaviour, two surfaces (focus-pane + peek).

import * as React from 'react'
import { useNavigate } from 'react-router-dom'
import { useQueryClient } from '@tanstack/react-query'
import { AnimatePresence, motion, useReducedMotion } from 'framer-motion'
import { Archive, History, PlayCircle, PowerOff } from 'lucide-react'

import { cn } from '@/lib/utils'
import { springs } from '@/lib/springs'
import { Button } from '@/components/ui/button'
import { EMPTY } from '@/brand/copy'
import {
  sessionsApi,
  type ApiSession,
  type ResumableConversation,
} from '@/lib/api'
import { SESSIONS_KEY } from '@/hooks/use-sessions'
import { ResumePicker } from './resume-picker'

export interface StoppedSessionProps {
  /** Session name — the target of the start / archive request. */
  name: string
  className?: string
}

export interface StoppedSessionActionsProps {
  /** Session name — the target of the start / archive request. */
  name: string
  /** Compact layout for tight surfaces (e.g. the overview hover-peek). The
   *  focus pane uses the default. Compact still respects the 44pt hit-target
   *  floor — only the spacing tightens. */
  compact?: boolean
  /** Optional callback after a successful archive — the focus pane navigates
   *  to '/', the peek host just dismisses itself. */
  onAfterArchive?: () => void
  /** Imperative trigger handle — the peek wires this so an Enter keystroke
   *  while hovered acts as the primary "Start" action. */
  triggerRef?: React.MutableRefObject<StoppedSessionActionsHandle | null>
  className?: string
}

export interface StoppedSessionActionsHandle {
  /** Programmatic primary action — used by the peek's Enter shortcut. */
  start: () => void
}

/** Action cluster — Start (primary) + Archive (secondary, inline-confirmed).
 *  Used by both the focus-pane <StoppedSession> and the overview hover-peek
 *  so the two surfaces stay byte-for-byte consistent (same copy, same motion,
 *  same API wiring). */
export function StoppedSessionActions({
  name,
  compact = false,
  onAfterArchive,
  triggerRef,
  className,
}: StoppedSessionActionsProps) {
  const reduce = useReducedMotion()
  const navigate = useNavigate()
  const qc = useQueryClient()
  const [busy, setBusy] = React.useState(false)
  const [failed, setFailed] = React.useState(false)
  const [archiveConfirm, setArchiveConfirm] = React.useState(false)
  const [archiving, setArchiving] = React.useState(false)
  // Resume affordance — lazily probes the dir's Claude conversations so the
  // button only appears when there's something to resume (no empty picker).
  const [conversations, setConversations] = React.useState<
    ResumableConversation[]
  >([])
  const [pickerOpen, setPickerOpen] = React.useState(false)

  React.useEffect(() => {
    if (!name) return
    let cancelled = false
    sessionsApi
      .resumable(name)
      .then((list) => {
        if (!cancelled) setConversations(list)
      })
      .catch(() => {
        // Resume just stays hidden on failure — Start is always available.
        if (!cancelled) setConversations([])
      })
    return () => {
      cancelled = true
    }
  }, [name])

  const canResume = conversations.length > 0

  const onStart = React.useCallback(() => {
    if (busy || !name) return
    setBusy(true)
    setFailed(false)
    // The session row's SSE `status` delta flips it to running once tmux boots;
    // the focus route then unmounts this surface and mounts the live terminal.
    sessionsApi
      .start(name)
      .catch(() => setFailed(true))
      .finally(() => setBusy(false))
  }, [busy, name])

  const onArchive = React.useCallback(() => {
    if (archiving || !name) return
    setArchiving(true)
    sessionsApi
      .archive(name)
      .then(() => {
        // Optimistically drop the archived row from the cached list so the
        // overview reflects the change immediately (the next SSE/refetch
        // backfills authoritatively — archived rows are filtered out
        // server-side via `WHERE archived = 0`).
        qc.setQueryData<ApiSession[]>(SESSIONS_KEY, (prev) =>
          (prev ?? []).filter((s) => s.name !== name),
        )
        if (onAfterArchive) onAfterArchive()
        else navigate('/')
      })
      .catch(() => {
        setArchiving(false)
        setArchiveConfirm(false)
        setFailed(true)
      })
  }, [archiving, name, qc, navigate, onAfterArchive])

  // Expose the imperative `start` so the hover-peek can map Enter → start
  // without re-implementing the loading-state guard.
  React.useEffect(() => {
    if (!triggerRef) return
    triggerRef.current = { start: onStart }
    return () => {
      if (triggerRef.current?.start === onStart) {
        triggerRef.current = null
      }
    }
  }, [triggerRef, onStart])

  return (
    <div
      className={cn(
        'flex flex-wrap items-center justify-center',
        compact ? 'gap-1.5' : 'gap-2 pt-1',
        className,
      )}
      // Stop click-through so tapping a button does NOT also fire the tile's
      // onClick (which would navigate to focus view). The peek host relies on
      // this so the Start / Archive buttons remain isolated targets.
      onClick={(e) => e.stopPropagation()}
    >
      <Button
        onClick={onStart}
        disabled={busy || archiving}
        // 44pt HIG hit-target floor — not the compact button size.
        className="h-11"
      >
        <PlayCircle aria-hidden />
        {busy ? 'Starting…' : EMPTY.stoppedSession.cta}
      </Button>

      {/* Resume — only when the dir has past Claude conversations (no empty
          picker). Opens the <ResumePicker> sheet; Start stays = fresh. */}
      {canResume && (
        <Button
          variant="secondary"
          onClick={() => setPickerOpen(true)}
          disabled={busy || archiving}
          className="h-11"
        >
          <History aria-hidden />
          Resume
        </Button>
      )}

      {/* Inline confirm — sentence-case, neutral copy (Archive is reversible
          data loss, not destructive deletion; the confirm guards an
          accidental tap rather than an irrecoverable one). */}
      <AnimatePresence mode="wait" initial={false}>
        {archiveConfirm ? (
          <motion.div
            key="confirm"
            initial={reduce ? false : { opacity: 0, scale: 0.96 }}
            animate={{ opacity: 1, scale: 1 }}
            exit={reduce ? undefined : { opacity: 0, scale: 0.96 }}
            transition={springs.cardExpand}
            className="flex items-center gap-1.5"
          >
            <Button
              variant="secondary"
              onClick={() => setArchiveConfirm(false)}
              disabled={archiving}
              className="h-11"
            >
              Cancel
            </Button>
            <Button
              variant="destructive"
              onClick={onArchive}
              disabled={archiving}
              className="h-11"
            >
              <Archive aria-hidden />
              {archiving ? 'Archiving…' : 'Archive session'}
            </Button>
          </motion.div>
        ) : (
          <motion.div
            key="cta"
            initial={reduce ? false : { opacity: 0, scale: 0.96 }}
            animate={{ opacity: 1, scale: 1 }}
            exit={reduce ? undefined : { opacity: 0, scale: 0.96 }}
            transition={springs.cardExpand}
          >
            <Button
              variant="ghost"
              onClick={() => setArchiveConfirm(true)}
              disabled={busy || archiving}
              className="h-11"
            >
              <Archive aria-hidden />
              Archive
            </Button>
          </motion.div>
        )}
      </AnimatePresence>

      {failed && (
        <span
          role="alert"
          className="basis-full text-center text-xs text-status-error"
        >
          Couldn’t complete that action. Try again.
        </span>
      )}

      {/* Resume picker — mounted lazily; opens on the Resume tap. Selecting a
          conversation starts the session with `claude --resume <id>` and the
          SSE status delta swaps in the live terminal. */}
      {canResume && (
        <ResumePicker
          name={name}
          open={pickerOpen}
          onOpenChange={setPickerOpen}
          conversations={conversations}
        />
      )}
    </div>
  )
}

/** Calm "this session is stopped" surface with Resume + Archive actions
 *  (polish-pass #1). Rendered in the focus pane in place of the live terminal
 *  while `session.status === 'stopped'` (§4.5 terminal state).
 *
 *  Resume calls the existing `/start` endpoint; the SSE `status` delta flips
 *  the session to running, the focus route swaps back to <LiveTerminal>, no
 *  manual refresh. Archive calls `/archive` — the R1 fix makes that correctly
 *  terminate per-session loops + forget the session — then we remove the row
 *  from the cached overview and navigate back so the user lands somewhere sane
 *  (the row is gone from the next refetch anyway). A small inline confirm
 *  guards the destructive action — matches how the desktop dock's stop uses a
 *  CONFIRM-style guard. */
export function StoppedSession({ name, className }: StoppedSessionProps) {
  const reduce = useReducedMotion()

  return (
    <div
      className={cn(
        'flex h-full w-full items-center justify-center bg-[var(--terminal-bg)] p-6',
        className,
      )}
      data-state="stopped"
    >
      <motion.div
        initial={reduce ? false : { opacity: 0, scale: 0.96 }}
        animate={{ opacity: 1, scale: 1 }}
        transition={springs.cardExpand}
        className="flex flex-col items-center gap-4 text-center"
      >
        <div className="flex size-16 items-center justify-center rounded-full bg-muted text-muted-foreground [&_svg]:size-7">
          <PowerOff aria-hidden />
        </div>
        <h2 className="text-base font-semibold text-foreground">
          {EMPTY.stoppedSession.title}
        </h2>
        <p className="max-w-xs text-sm text-muted-foreground">
          {EMPTY.stoppedSession.body}
        </p>

        {/* Action row — Resume primary, Archive secondary. Both ≥44pt; spring
            button-press inherited from <Button>'s shadcn baseline. */}
        <StoppedSessionActions name={name} />
      </motion.div>
    </div>
  )
}

export default StoppedSession
