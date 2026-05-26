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
import { CONFIRM, killTeamLeadConfirm } from '@/brand/copy'

export interface UseSessionActions {
  /** True while either action is mid-flight. Callers should disable their
   *  triggers on `busy` to prevent double-fire. */
  busy: boolean
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
  const [busy, setBusy] = React.useState(false)

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
    if (!window.confirm(`${c.title}\n\n${c.body}`)) return
    setBusy(true)
    try {
      await focusApi.stopSession(sessionName)
      void qc.invalidateQueries({ queryKey: SESSIONS_KEY })
      toast({ message: 'Session stopped', tone: 'waiting' })
    } catch (e) {
      toast({
        message: e instanceof Error ? e.message : 'Stop failed.',
        tone: 'error',
      })
    } finally {
      setBusy(false)
    }
  }, [busy, sessionName, teams, qc, toast])

  const archive = React.useCallback(
    async (opts?: { onAfterArchive?: () => void; confirm?: boolean }) => {
      if (busy) return
      // Archive on a NOT-yet-stopped session also stops + tears down the pty
      // (server-side), so the desktop hover-kebab opts into a confirm for that
      // path. A stopped tile's archive is reversible from the Archived sheet,
      // so it lands without a confirm (the default). Inline copy — small enough
      // that hoisting to brand/copy.ts would be more code than the string.
      if (opts?.confirm) {
        const ok = window.confirm(
          'Archive this running session?\n\nThe agent stops, the tmux session ends, and the tile leaves the overview. You can restore it from the Archived sheet.',
        )
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
    [busy, qc, sessionName, toast],
  )

  return { busy, stop, archive }
}
