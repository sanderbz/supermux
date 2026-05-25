import * as React from 'react'
import { Drawer } from 'vaul'
import { X, Square, RotateCcw } from 'lucide-react'
import { useQueryClient } from '@tanstack/react-query'

import { cn } from '@/lib/utils'
import { CONFIRM } from '@/brand/copy'
import { focusApi } from '@/lib/api/focus'
import { SESSIONS_KEY } from '@/hooks/use-sessions'
import { useToast } from '@/components/ui/use-toast'
import { LiveTerminal } from '@/components/terminal/live-terminal'
import { StatusDot } from './status-dot'
import { TailPreview } from './tail-preview'
import type { TileSession } from './types'

export interface QuickPeekModalProps {
  session: TileSession
  open: boolean
  onOpenChange: (open: boolean) => void
}

/** Mobile long-press quick-peek (§4.3). A Vaul half-sheet over the overview —
 *  the ONLY surface this renders on (touch/coarse-pointer press-hold of a tile;
 *  the desktop hover-peek is a separate path, `TileLiveTerminal`, untouched).
 *
 *  Shows the session's REAL terminal in colour: a running session mounts a
 *  read-only `<LiveTerminal>` (full ANSI palette + live content + scrollback) —
 *  the same renderer the desktop peek uses — so the peek is no longer a flat,
 *  colourless text tail. A stopped session has no live pane, so it falls back to
 *  the static `<TailPreview>` (its last captured tail). The WS opens only while
 *  the sheet is mounted and tears down on close (this subtree unmounts).
 *
 *  Carries the two session actions that aren't reachable elsewhere on mobile:
 *  Restart (stop→start, resumes the same chat) and Stop (confirms first). Both
 *  refresh the shared `['sessions']` cache so the overview reflects the change. */
export function QuickPeekModal({
  session,
  open,
  onOpenChange,
}: QuickPeekModalProps) {
  const qc = useQueryClient()
  const { toast } = useToast()
  const [busy, setBusy] = React.useState(false)
  // Bumped after a Restart completes to force the live pane to REMOUNT. A stop
  // closes the terminal WS with a terminal (no-retry) code, and nothing else
  // re-subscribes the already-mounted <LiveTerminal> — so without this the pane
  // stays frozen on "Session stopped" after Restart. Keying the terminal on this
  // nonce tears it down and opens a fresh WS to the NEW pty once start resolves.
  const [restartNonce, setRestartNonce] = React.useState(0)
  const isStopped = session.status === 'stopped'

  const refresh = React.useCallback(
    () => void qc.invalidateQueries({ queryKey: SESSIONS_KEY }),
    [qc],
  )

  const doStop = React.useCallback(async () => {
    if (busy) return
    const c = CONFIRM.killSession
    if (!window.confirm(`${c.title}\n\n${c.body}`)) return
    setBusy(true)
    try {
      await focusApi.stopSession(session.name)
      refresh()
      toast({ message: 'Session stopped', tone: 'waiting' })
    } catch (e) {
      toast({ message: e instanceof Error ? e.message : 'Stop failed.', tone: 'error' })
    } finally {
      setBusy(false)
    }
  }, [busy, session.name, refresh, toast])

  const doRestart = React.useCallback(async () => {
    if (busy) return
    setBusy(true)
    try {
      // Restart = stop (no-op/ignored if already stopped) then start; the server
      // resumes the same conversation. Bump the nonce so the live pane remounts
      // onto the freshly-started pty (its old WS was closed terminally by stop).
      await focusApi.stopSession(session.name).catch(() => {})
      await focusApi.startSession(session.name)
      refresh()
      setRestartNonce((n) => n + 1)
      toast({ message: 'Session restarting', tone: 'active' })
    } catch (e) {
      toast({ message: e instanceof Error ? e.message : 'Restart failed.', tone: 'error' })
    } finally {
      setBusy(false)
    }
  }, [busy, session.name, refresh, toast])

  return (
    <Drawer.Root open={open} onOpenChange={onOpenChange}>
      <Drawer.Portal>
        <Drawer.Overlay className="fixed inset-0 z-50 bg-black/50" />
        <Drawer.Content className="fixed inset-x-0 bottom-0 z-50 flex h-[78vh] flex-col rounded-t-2xl border-t border-border bg-card/85 outline-none backdrop-blur-xl">
          {/* Drag handle — 36×5, 2.5px radius, tertiary tint (§4.4 / Termius #11). */}
          <div className="mx-auto mt-1.5 h-[5px] w-9 shrink-0 rounded-full bg-muted-foreground/30" />

          <div className="flex items-center gap-2 px-4 py-3">
            <StatusDot status={session.status} />
            <Drawer.Title className="min-w-0 flex-1 truncate text-sm font-medium">
              {session.task_summary || session.name}
            </Drawer.Title>

            {/* Session actions — Restart + Stop (the two controls with no other
                mobile home). Small, iOS-native; Stop is destructive + disabled
                once already stopped. */}
            <PeekAction
              label="Restart"
              icon={RotateCcw}
              onClick={doRestart}
              disabled={busy}
            />
            <PeekAction
              label="Stop"
              icon={Square}
              onClick={doStop}
              disabled={busy || isStopped}
              tone="destructive"
            />

            <button
              type="button"
              aria-label="Close peek"
              onClick={() => onOpenChange(false)}
              className="-mr-2 flex size-11 items-center justify-center text-muted-foreground"
            >
              <X className="size-5" />
            </button>
          </div>
          <Drawer.Description className="sr-only">
            Terminal preview of {session.name}
          </Drawer.Description>

          <div
            className="relative mx-3 mb-3 min-h-0 flex-1 overflow-hidden rounded-xl"
            style={{ backgroundColor: 'var(--terminal-bg)' }}
          >
            {isStopped ? (
              <TailPreview lines={session.preview_lines} fill className="py-2" />
            ) : (
              <div className="absolute inset-0">
                <LiveTerminal
                  // Remount across a Restart so a fresh WS connects to the new
                  // pty (the old one was closed terminally — it never retries).
                  key={`${session.name}:${restartNonce}`}
                  name={session.name}
                  readOnly
                  className="rounded-none"
                  // Seed the instant cached-screen overlay with the tile's OWN
                  // last capture (SGR-coloured `preview_ansi`, plain
                  // `preview_lines` fallback) so the peek shows the real coloured
                  // screen the moment it opens — no blank-black flash while the
                  // WS connects, then it crossfades to live once pinned.
                  previewAnsi={session.preview_ansi}
                  previewLines={session.preview_lines}
                />
              </div>
            )}
          </div>
        </Drawer.Content>
      </Drawer.Portal>
    </Drawer.Root>
  )
}

/** A compact peek action chip — icon + label. The tappable box is h-11 (44pt,
 *  the iOS HIG minimum) while `-my-1` keeps the visual chip ~36pt so the header
 *  stays tight. `destructive` tints it red for Stop. */
function PeekAction({
  label,
  icon: Icon,
  onClick,
  disabled,
  tone = 'default',
}: {
  label: string
  icon: typeof Square
  onClick: () => void
  disabled?: boolean
  tone?: 'default' | 'destructive'
}) {
  return (
    <button
      type="button"
      aria-label={`${label} session`}
      onClick={onClick}
      disabled={disabled}
      className={cn(
        '-my-1 flex h-11 shrink-0 items-center gap-1 rounded-lg px-2.5 text-[13px] font-medium disabled:opacity-40',
        tone === 'destructive'
          ? 'text-destructive active:bg-destructive/10'
          : 'text-foreground/80 active:bg-secondary',
      )}
    >
      <Icon className="size-4" />
      {label}
    </button>
  )
}
