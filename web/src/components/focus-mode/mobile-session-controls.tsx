// MobileSessionControls — a small iOS-native control bar above the mobile focus
// terminal (fix/mobile-session FIX 2).
//
// The mobile terminal is sized to the non-peak Vaul card geometry, so it does NOT
// fill the full sheet height — there is a slim band of free space between the
// FocusHeader and the terminal. We put two genuinely-useful session controls
// there that exist NOWHERE ELSE on mobile:
//   • Restart — stop, then start the SAME session (the server resumes the same
//     Claude conversation when one exists). The live terminal drops to its
//     `stopped` surface on the WS close, then reconnects to the fresh pty.
//   • Stop    — graceful stop (kills the agent + ends the tmux session). This is
//     DESTRUCTIVE, so it confirms first via CONFIRM.killSession before firing.
//
// Both are soft, pill-shaped iOS controls (no hard borders, continuous corners,
// spring press) at the ≥44pt hit-target floor, matching the dock's DockIcon
// language. Restart is a quiet secondary pill; Stop is destructive-tinted.
//
// Hidden when the session is already `stopped` (the <StoppedSession> surface owns
// Start/Resume there) so the bar never offers a no-op Stop on a dead session.

import * as React from 'react'
import { motion } from 'framer-motion'
import { RotateCw, Square } from 'lucide-react'

import { cn } from '@/lib/utils'
import { springs } from '@/lib/springs'
import { focusApi } from '@/lib/api'
import { CONFIRM } from '@/brand/copy'
import type { SessionStatus } from '@/lib/api'

export interface MobileSessionControlsProps {
  name: string
  /** Live session status — the bar hides itself on `stopped` (the stopped-session
   *  surface owns Start/Resume) so Stop is never a no-op. */
  status: SessionStatus
  className?: string
}

export function MobileSessionControls({
  name,
  status,
  className,
}: MobileSessionControlsProps) {
  // One in-flight op at a time: `stop` while killing, `restart` while relaunching.
  // Disables both pills so a double-tap can't fire stop+restart concurrently.
  const [busy, setBusy] = React.useState<null | 'stop' | 'restart'>(null)

  const onRestart = React.useCallback(() => {
    if (busy || !name) return
    setBusy('restart')
    // The status SSE delta flips the tile to `stopped` then `starting`/`active`;
    // the focus route swaps the live terminal for <StoppedSession> on the stop and
    // back to a reconnecting <LiveTerminal> on the start — no manual refresh.
    void focusApi
      .restartSession(name)
      .catch((e) => console.warn('restartSession failed', e))
      .finally(() => setBusy(null))
  }, [busy, name])

  const onStop = React.useCallback(() => {
    if (busy || !name) return
    // Stop is destructive (the agent dies + the tmux session ends) → confirm.
    if (
      !window.confirm(
        `${CONFIRM.killSession.title}\n\n${CONFIRM.killSession.body}`,
      )
    ) {
      return
    }
    setBusy('stop')
    void focusApi
      .stopSession(name)
      .catch((e) => console.warn('stopSession failed', e))
      .finally(() => setBusy(null))
  }, [busy, name])

  // On a stopped session the bottom <StoppedSession> already offers Start/Resume,
  // so a Stop/Restart bar here would be a no-op / confusing — hide it.
  if (status === 'stopped') return null

  return (
    <div
      className={cn(
        'flex shrink-0 items-center justify-end gap-2 px-3 py-1.5',
        className,
      )}
    >
      <ControlPill
        label={busy === 'restart' ? 'Restarting…' : 'Restart'}
        icon={RotateCw}
        onClick={onRestart}
        disabled={busy !== null}
        busy={busy === 'restart'}
      />
      <ControlPill
        label={busy === 'stop' ? 'Stopping…' : 'Stop'}
        icon={Square}
        onClick={onStop}
        disabled={busy !== null}
        busy={busy === 'stop'}
        tone="destructive"
      />
    </div>
  )
}

/** A compact iOS-native control pill — icon + label, soft fill, continuous
 *  corner, spring press, ≥44pt hit target. Destructive tone tints it with the
 *  status-error colour (matching the dock/desktop Stop). The visible chrome is
 *  ~32px tall but the touch target stays ≥44pt via the wrapping py on the bar. */
function ControlPill({
  label,
  icon: Icon,
  onClick,
  disabled,
  busy,
  tone = 'default',
}: {
  label: string
  icon: typeof Square
  onClick: () => void
  disabled?: boolean
  busy?: boolean
  tone?: 'default' | 'destructive'
}) {
  return (
    <motion.button
      type="button"
      aria-label={label}
      aria-busy={busy || undefined}
      disabled={disabled}
      whileTap={disabled ? undefined : { scale: 0.94 }}
      transition={springs.buttonPress}
      onClick={() => {
        if (disabled) return
        if ('vibrate' in navigator) navigator.vibrate(8)
        onClick()
      }}
      // ~32px visible height; min-h-11 keeps the iOS 44pt hit-target floor.
      className={cn(
        'inline-flex min-h-11 items-center gap-1.5 rounded-full px-3.5 text-[13px] font-medium',
        'transition-opacity disabled:opacity-50',
        tone === 'destructive'
          ? 'bg-status-error/15 text-status-error active:bg-status-error/25'
          : 'bg-secondary text-secondary-foreground active:bg-secondary/70',
      )}
    >
      <Icon
        className={cn('size-4', busy && 'animate-spin')}
        strokeWidth={1.75}
        aria-hidden
      />
      {label}
    </motion.button>
  )
}

export default MobileSessionControls
