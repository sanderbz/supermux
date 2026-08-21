// use-session-actions — shared lifecycle action handlers for the hover-kebab
// (desktop) AND the long-press quick-peek (mobile). One source of truth for
// "stop this session" and "archive this session", so the two surfaces stay
// byte-for-byte consistent (same confirms, same toasts, same optimistic cache
// updates, same team-lead awareness). Per the user-vision DRY rule + the
// vision-critic's "don't duplicate intent across surfaces" guard.
//
// Why a hook, not a util module: each action wants a busy guard + the
// query-client + toast bus + teams cache, which are all React-tree state.
// Returning the bound async fns + `busy` keeps the call sites tiny.
//
// REUSE: this hook is the same code path quick-peek-modal.tsx previously
// inlined — extracted verbatim, no behavior change.

import * as React from 'react'
import { useQueryClient } from '@tanstack/react-query'

import { focusApi } from '@/lib/api/focus'
import { sessionsApi, type ApiSession } from '@/lib/api'
import { SESSIONS_KEY } from '@/hooks/use-sessions'
import { ARCHIVED_SESSIONS_KEY } from '@/hooks/use-archived-sessions'
import { useTeams } from '@/hooks/use-teams'
import { useToast } from '@/components/ui/use-toast'
import { useConfirm } from '@/components/ui/confirm-dialog'
import { CONFIRM, LIFECYCLE, killTeamLeadConfirm } from '@/brand/copy'

export interface UseSessionActions {
  /** True while any action is mid-flight. Callers should disable their
   *  triggers on `busy` to prevent double-fire. */
  busy: boolean
  /** Restart the session: `POST /stop` (errors ignored — a stopped session has
   *  nothing to stop) then `POST /start`, which resumes the SAME conversation.
   *  The overview cache is invalidated so the row reflects the relaunch. No
   *  confirm — it resumes the same chat rather than discarding it. No-op on
   *  busy. Mirrors the mobile quick-peek's Restart, minus the live-pane nonce
   *  (the overview kebab has no terminal to remount). */
  restart: () => Promise<void>
  /** Stop the session via `POST /api/focus/sessions/:name/stop`. Confirms
   *  first (team-lead-aware copy when applicable). No-op on busy. */
  stop: () => Promise<void>
  /** Archive the session via `POST /api/sessions/:name/archive`. Optimistically
   *  drops the row from the overview cache. Fires `onAfterArchive` (e.g.
   *  dismiss the host sheet) on success.
   *
   *  By default NO confirm — archive is reversible from the Archived sheet, so
   *  a stopped tile's archive is a tap-and-undo. Pass `confirm: true` for
   *  RUNNING sessions where archive also stops + tears down the pty — that's
   *  the destructive variant the user should explicitly opt into (the desktop
   *  hover-kebab uses this for not-yet-stopped sessions). */
  archive: (opts?: {
    onAfterArchive?: () => void
    confirm?: boolean
  }) => Promise<void>
}

/** Shared stop / archive handlers. The session name + status drive gating at
 *  the call site; this hook just performs the action when called. */
export function useSessionActions(sessionName: string): UseSessionActions {
  const qc = useQueryClient()
  const { toast } = useToast()
  const { teams } = useTeams()
  const confirm = useConfirm()
  const [busy, setBusy] = React.useState(false)

  const restart = React.useCallback(async () => {
    if (busy) return
    setBusy(true)
    // Optimistic head-start: flip the cached row to `starting` so the overview
    // reads "relaunching" the instant Restart is tapped (the server also
    // broadcasts the fresh status over SSE; this is only the head-start).
    qc.setQueryData<ApiSession[]>(SESSIONS_KEY, (prev) =>
      (prev ?? []).map((s) =>
        s.name === sessionName ? { ...s, status: 'starting' as const } : s,
      ),
    )
    try {
      // Restart = stop (ignored/no-op if already stopped) then start; the
      // server resumes the SAME conversation. No live pane here, so — unlike
      // the mobile quick-peek — there is no `restartNonce` remount to bump.
      await focusApi.stopSession(sessionName).catch(() => {})
      await focusApi.startSession(sessionName)
      void qc.invalidateQueries({ queryKey: SESSIONS_KEY })
      toast({ message: 'Session restarting', tone: 'active' })
    } catch (e) {
      void qc.invalidateQueries({ queryKey: SESSIONS_KEY })
      toast({
        message: e instanceof Error ? e.message : 'Restart failed.',
        tone: 'error',
      })
    } finally {
      setBusy(false)
    }
  }, [busy, sessionName, qc, toast])

  const stop = React.useCallback(async () => {
    if (busy) return
    // Team-lead awareness: teammates are split-panes INSIDE the lead's session,
    // so stopping a lead ends the whole team. When this session IS a team lead
    // we swap in the team-aware confirm copy (spelling out the N teammates that
    // go down with it); a normal session reads exactly as before.
    const team = teams.find((t) => t.lead_supermux_session === sessionName)
    const c = team
      ? killTeamLeadConfirm(team.members.length)
      : CONFIRM.killSession
    // B5/T9.3 — `window.confirm` could only render a string, which is why the
    // team consequence had to be crammed into the body. The dialog enumerates
    // it instead: each teammate that goes down is its own line.
    const ok = await confirm({
      ...c,
      ...(team && team.members.length > 0
        ? {
            consequences: team.members.map(
              (m) => `${m.name} stops with it (it is a pane in this session)`,
            ),
          }
        : {}),
    })
    if (!ok) return
    setBusy(true)
    // OPTIMISTIC head-start, lifted here from `routes/focus/desktop.tsx` when
    // that route stopped reimplementing this (B5/T9.4). Flip the cached row to
    // `stopped` the instant Stop is confirmed, so the header dot, the strip row
    // and the dock all read stopped immediately — the user never perceives the
    // server-side teardown as "it didn't work". The backend also broadcasts
    // `stopped` over SSE, so this is only the head-start; the invalidate below
    // backfills the authoritative row.
    qc.setQueryData<ApiSession[]>(SESSIONS_KEY, (prev) =>
      (prev ?? []).map((s) =>
        s.name === sessionName ? { ...s, status: 'stopped' as const } : s,
      ),
    )
    try {
      await focusApi.stopSession(sessionName)
      void qc.invalidateQueries({ queryKey: SESSIONS_KEY })
      toast({ message: 'Session stopped', tone: 'waiting' })
    } catch (e) {
      // The optimistic write said "stopped"; the server disagreed. Reconcile
      // rather than leaving a tile lying about its state.
      void qc.invalidateQueries({ queryKey: SESSIONS_KEY })
      toast({
        message: e instanceof Error ? e.message : 'Stop failed.',
        tone: 'error',
      })
    } finally {
      setBusy(false)
    }
  }, [busy, sessionName, teams, qc, toast, confirm])

  const archive = React.useCallback(
    async (opts?: { onAfterArchive?: () => void; confirm?: boolean }) => {
      if (busy) return
      // Archive on a NOT-yet-stopped session also stops + tears down the pty
      // (server-side), so the desktop hover-kebab opts into a confirm for that
      // path. A stopped tile's archive is reversible from the Archived sheet,
      // so it lands without a confirm (the default).
      //
      // B5/T5.3: the copy moved to `brand/copy.ts` and now carries the
      // archive/schedule contract sentence — the SAME sentence the Archived
      // sheet renders. Archiving pauses this session's scheduled jobs, which
      // is the half of the transaction users could not previously see.
      if (opts?.confirm) {
        const c = CONFIRM.archiveRunningSession
        const ok = await confirm({
          ...c,
          consequences: [
            LIFECYCLE.archivePausesSchedules,
            LIFECYCLE.archiveIsTheUndo,
          ],
        })
        if (!ok) return
      }
      setBusy(true)
      try {
        await sessionsApi.archive(sessionName)
        // Optimistically drop the archived row from the live overview list so
        // the overview reflects the change immediately (the next SSE/refetch
        // backfills authoritatively — archived rows are filtered server-side).
        qc.setQueryData<ApiSession[]>(SESSIONS_KEY, (prev) =>
          (prev ?? []).filter((s) => s.name !== sessionName),
        )
        // Keep the Archived sheet's count/list in sync without a manual reopen.
        void qc.invalidateQueries({ queryKey: ARCHIVED_SESSIONS_KEY })
        toast({ message: 'Session archived', tone: 'waiting' })
        opts?.onAfterArchive?.()
      } catch (e) {
        toast({
          message: e instanceof Error ? e.message : 'Archive failed.',
          tone: 'error',
        })
      } finally {
        setBusy(false)
      }
    },
    [busy, qc, sessionName, toast, confirm],
  )

  return { busy, restart, stop, archive }
}
