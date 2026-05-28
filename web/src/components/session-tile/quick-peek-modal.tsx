import * as React from 'react'
import { useNavigate } from 'react-router-dom'
import { Drawer } from 'vaul'
import { X, Square, RotateCcw, Archive, Users, Info } from 'lucide-react'
import { useQueryClient } from '@tanstack/react-query'

import { cn } from '@/lib/utils'
import { focusApi } from '@/lib/api/focus'
import { SESSIONS_KEY } from '@/hooks/use-sessions'
import { useTeams } from '@/hooks/use-teams'
import { useToast } from '@/components/ui/use-toast'
import { useSessionActions } from '@/hooks/use-session-actions'
import { LiveTerminal } from '@/components/terminal/live-terminal'
import { SessionInfoPanel } from '@/components/focus-mode/session-info-panel'
import { StartTeamSheet } from './start-team-sheet'
import { StatusDot } from './status-dot'
import { TailPreview } from './tail-preview'
import type { TileSession } from './types'
import { sessionTitle } from '@/lib/api'

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
 *  Carries the session actions that aren't reachable elsewhere on mobile:
 *  Restart (stop→start, resumes the same chat) and a state-dependent secondary —
 *  Stop (confirms first) while running, or Archive once already stopped (the
 *  desktop reaches archive via the stopped tile's hover-peek; this is the mobile
 *  home for it). All refresh the shared `['sessions']` cache so the overview
 *  reflects the change. */
export function QuickPeekModal({
  session,
  open,
  onOpenChange,
}: QuickPeekModalProps) {
  const qc = useQueryClient()
  const navigate = useNavigate()
  const { toast } = useToast()
  const { teams } = useTeams()
  // Stop / Archive share their logic with the desktop hover-kebab via
  // `useSessionActions` — one source of truth for lifecycle behaviour across
  // surfaces. Restart stays local (it's quick-peek-specific: it pairs with the
  // live pane's `restartNonce` remount, which the kebab has no use for).
  const { busy: actionsBusy, stop, archive } = useSessionActions(session.name)
  const [restartBusy, setRestartBusy] = React.useState(false)
  const busy = actionsBusy || restartBusy
  // FEAT-CONVERT-TEAM: the "Make it a team" sheet is mounted lazily inside
  // the peek so the action lives next to Restart/Stop (the natural mobile home
  // for session lifecycle actions). On success we navigate to the lead's focus
  // view AND close the peek — the session is now a team and the focus view's
  // TEAM CARD is the natural next surface.
  const [convertOpen, setConvertOpen] = React.useState(false)
  // FEAT-SESSION-INFO: the same Info panel the focus-page title-click opens —
  // mounted here so mobile gets parity with the desktop hover-kebab. Reuses the
  // SAME <SessionInfoPanel> component (mobile fork = bottom Sheet) so there is
  // ONE info surface app-wide, two entry points. Tapping a clone navigates to
  // its focus route AND closes both this peek and the info sheet.
  const [infoOpen, setInfoOpen] = React.useState(false)
  const isAlreadyLead = React.useMemo(
    () => teams.some((t) => t.lead_supermux_session === session.name),
    [teams, session.name],
  )
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

  const doStop = stop
  // Archive dismisses the host sheet on success — same intent as before, now
  // expressed via the shared hook's `onAfterArchive` option. Mobile quick-peek
  // ONLY shows Archive when the session is already stopped (the secondary
  // swaps to Stop while running), so no `confirm: true` here — archive is
  // reversible from the Archived sheet.
  const doArchive = React.useCallback(
    () => archive({ onAfterArchive: () => onOpenChange(false) }),
    [archive, onOpenChange],
  )

  const doRestart = React.useCallback(async () => {
    if (busy) return
    setRestartBusy(true)
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
      setRestartBusy(false)
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
              {sessionTitle(session)}
            </Drawer.Title>

            {/* Session actions — Restart + a state-dependent secondary (the two
                controls with no other mobile home) + (when applicable) Make
                team. Small, iOS-native. While the session is running the
                secondary is Stop (destructive); once it's already stopped, Stop
                has nothing to do, so it becomes Archive — the same archive the
                desktop reaches via the stopped tile's hover-peek (no confirm:
                archive is reversible from the Archived sheet).
                "Make team" (FEAT-CONVERT-TEAM) is hidden once the session IS
                already a team lead — there's nothing to convert. */}
            <PeekAction
              label="Info"
              icon={Info}
              onClick={() => setInfoOpen(true)}
              disabled={busy}
            />
            <PeekAction
              label="Restart"
              icon={RotateCcw}
              onClick={doRestart}
              disabled={busy}
            />
            {!isAlreadyLead && (
              <PeekAction
                label="Make team"
                icon={Users}
                onClick={() => setConvertOpen(true)}
                disabled={busy}
              />
            )}
            {isStopped ? (
              <PeekAction
                label="Archive"
                icon={Archive}
                onClick={doArchive}
                disabled={busy}
              />
            ) : (
              <PeekAction
                label="Stop"
                icon={Square}
                onClick={doStop}
                disabled={busy}
                tone="destructive"
              />
            )}

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

      {/* FEAT-CONVERT-TEAM: the convert sheet mounts OUTSIDE Drawer.Portal so a
          Vaul-managed peek closing/opening doesn't tear the sheet down. On
          success we dismiss the peek AND navigate to the (now team-lead) focus
          view — the team's TEAM CARD is the natural next surface. */}
      <StartTeamSheet
        mode="convert"
        sessionName={session.name}
        sessionDir={session.dir}
        open={convertOpen}
        onOpenChange={setConvertOpen}
        onStarted={(name) => {
          onOpenChange(false)
          void qc.invalidateQueries({ queryKey: SESSIONS_KEY })
          toast({ message: 'Team starting', tone: 'active' })
          navigate(`/focus/${encodeURIComponent(name)}`)
        }}
      />

      {/* FEAT-SESSION-INFO (mobile parity) — the same Info panel the focus-page
          title-click opens. Mounted OUTSIDE Drawer.Portal so the Vaul peek
          stays alive underneath while the info sheet is on top. Cloning an
          agent navigates to its focus route AND dismisses the peek. */}
      <SessionInfoPanel
        name={session.name}
        open={infoOpen}
        onOpenChange={setInfoOpen}
        onNavigate={(name) => {
          setInfoOpen(false)
          onOpenChange(false)
          navigate(`/focus/${encodeURIComponent(name)}`)
        }}
      />
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
