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

import * as React from 'react'
import { motion, useReducedMotion } from 'framer-motion'
import { PlayCircle, PowerOff } from 'lucide-react'

import { cn } from '@/lib/utils'
import { springs } from '@/lib/springs'
import { Button } from '@/components/ui/button'
import { EMPTY } from '@/brand/copy'
import { sessionsApi } from '@/lib/api'

export interface StoppedSessionProps {
  /** Session name — the target of the start request. */
  name: string
  className?: string
}

/** Calm "this session is stopped" surface with a start action. Rendered in the
 *  focus pane in place of the live terminal while `session.status === 'stopped'`
 *  (§4.5 terminal state). Once the start succeeds, the SSE status delta flips the
 *  session to running and the focus route swaps back to <LiveTerminal>. */
export function StoppedSession({ name, className }: StoppedSessionProps) {
  const reduce = useReducedMotion()
  const [busy, setBusy] = React.useState(false)
  const [failed, setFailed] = React.useState(false)

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
          {failed
            ? 'Couldn’t start the session. Check the server logs, then try again.'
            : EMPTY.stoppedSession.body}
        </p>
        <Button
          onClick={onStart}
          disabled={busy}
          // 44pt HIG hit-target floor — not the compact button size.
          className="h-11"
        >
          <PlayCircle aria-hidden />
          {busy ? 'Starting…' : EMPTY.stoppedSession.cta}
        </Button>
      </motion.div>
    </div>
  )
}

export default StoppedSession
