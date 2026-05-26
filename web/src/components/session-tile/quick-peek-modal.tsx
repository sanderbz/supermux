import * as React from 'react'
import { useNavigate } from 'react-router-dom'
import { Drawer } from 'vaul'
import { X, Square, RotateCcw, Archive, Users } from 'lucide-react'
import { useQueryClient } from '@tanstack/react-query'

import { cn } from '@/lib/utils'
import { CONFIRM, killTeamLeadConfirm } from '@/brand/copy'
import { focusApi } from '@/lib/api/focus'
import { sessionsApi, type ApiSession } from '@/lib/api'
import { SESSIONS_KEY } from '@/hooks/use-sessions'
import { ARCHIVED_SESSIONS_KEY } from '@/hooks/use-archived-sessions'
import { useTeams } from '@/hooks/use-teams'
import { useToast } from '@/components/ui/use-toast'
import { LiveTerminal } from '@/components/terminal/live-terminal'
import { StartTeamSheet } from './start-team-sheet'
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
  const [busy, setBusy] = React.useState(false)
  // FEAT-CONVERT-TEAM: the "Make it a team" sheet is mounted lazily inside
  // the peek so the action lives next to Restart/Stop (the natural mobile home
  // for session lifecycle actions). On success we navigate to the lead's focus
  // view AND close the peek — the session is now a team and the focus view's
  // TEAM CARD is the natural next surface.
  const [convertOpen, setConvertOpen] = React.useState(false)
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

  const doStop = React.useCallback(async () => {
    if (busy) return
    // Team-lead awareness: teammates are split-panes INSIDE the lead's session,
    // so stopping a lead ends the whole team. When this session IS a team lead we
    // swap in the team-aware confirm copy (spelling out the N teammates that go
    // down with it); a normal session reads EXACTLY as before.
    const team = teams.find((t) => t.lead_supermux_session === session.name)
    const c = team ? killTeamLeadConfirm(team.members.length) : CONFIRM.killSession
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
  }, [busy, session.name, refresh, toast, teams])

  // Archive replaces the (dead) Stop button once a session is already stopped —
  // the one archive affordance with no other mobile home (the desktop reaches it
  // via the stopped tile's hover-peek). Reuses the SAME server call the desktop
  // peek + header icon use (`sessionsApi.archive`), so there is ONE archive path,
  // not a mobile-only copy. No confirm: archive is reversible from the Archived
  // sheet (`unarchive`), so unlike Stop (which `window.confirm`s) it just needs a
  // tap. Mirrors doStop's robustness — busy guard, success/error toasts. On
  // success we optimistically drop the row from the overview cache (same as the
  // desktop peek), refresh the Archived sheet count, and close the sheet.
  const doArchive = React.useCallback(async () => {
    if (busy) return
    setBusy(true)
    try {
      await sessionsApi.archive(session.name)
      // Optimistically drop the archived row from the live overview list so the
      // overview reflects the change immediately (the next SSE/refetch backfills
      // authoritatively — archived rows are filtered out server-side).
      qc.setQueryData<ApiSession[]>(SESSIONS_KEY, (prev) =>
        (prev ?? []).filter((s) => s.name !== session.name),
      )
      // Keep the Archived sheet's count/list in sync without a manual reopen.
      void qc.invalidateQueries({ queryKey: ARCHIVED_SESSIONS_KEY })
      toast({ message: 'Session archived', tone: 'waiting' })
      onOpenChange(false)
    } catch (e) {
      toast({
        message: e instanceof Error ? e.message : 'Archive failed.',
        tone: 'error',
      })
    } finally {
      setBusy(false)
    }
  }, [busy, qc, session.name, toast, onOpenChange])

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
