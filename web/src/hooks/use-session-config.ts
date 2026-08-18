/**
 * The phantom fields get a writer.
 * ─────────────────────────────────────────────────────────────────────────────
 * `pinned`, `tags` and `desc` have been wired end to end since long before B2:
 * `SessionView.desc/pinned/tags` server-side, `ConfigInput.toggle_pin/tags/desc`
 * on `PATCH /api/sessions/{name}/config`, and `ApiSession.desc/tags/pinned` on
 * the wire. `pinned` is read by `smartSort` and the focus strip's ordering;
 * `desc`/`tags` are matched by the overview's search. And **no component in the
 * app has ever written any of them** — the only `config` writer in the UI was
 * rename.
 *
 * This is that writer. One hook, three verbs, one optimistic idiom
 * (`use-session-actions.ts`'s): patch the cache, call the API, roll the cache
 * back on failure, invalidate so the authoritative row lands. The config PATCH
 * emits no SSE, so the invalidate is what propagates a change to every other
 * surface — the same reason `use-rename-session.ts` does it.
 */
import * as React from 'react'
import { useQueryClient } from '@tanstack/react-query'

import { sessionsApi, type ApiSession } from '@/lib/api/sessions'
import { SESSIONS_KEY } from '@/hooks/use-sessions'
import { useToast } from '@/components/ui/use-toast'

export interface SessionConfigApi {
  pending: boolean
  /** Pin / unpin. `smartSort` already orders by `pinned`; this is the control
   *  that was missing. */
  togglePin: (name: string, current?: boolean) => Promise<void>
  setTags: (name: string, tags: string[]) => Promise<void>
  /** The session's standing instructions (`desc`). */
  setDesc: (name: string, desc: string) => Promise<void>
  /** Per-bot launch MODEL (migration 0030). A launch-line change: the PATCH
   *  response carries `restart_required`, which this resolves so the caller can
   *  show "Applies on next start" (the live agent is NOT relaunched). Resolves
   *  `false` on failure (a toast already surfaced the error). */
  setModel: (name: string, model: string) => Promise<boolean>
  /** The bot's "Notes it keeps" (`memory`, migration 0030) — injected read-only
   *  into the system prompt at launch. Also a launch-line change → resolves the
   *  response's `restart_required`. */
  setMemory: (name: string, memory: string) => Promise<boolean>
}

export function useSessionConfig(): SessionConfigApi {
  const qc = useQueryClient()
  const { toast } = useToast()
  const [pending, setPending] = React.useState(false)

  /** Patch one row in the shared list cache, returning the previous list so a
   *  failure can put it back exactly as it was. */
  const patchCache = React.useCallback(
    (name: string, patch: Partial<ApiSession>): ApiSession[] | undefined => {
      const prev = qc.getQueryData<ApiSession[]>(SESSIONS_KEY)
      qc.setQueryData<ApiSession[]>(SESSIONS_KEY, (rows) =>
        (rows ?? []).map((s) => (s.name === name ? { ...s, ...patch } : s)),
      )
      return prev
    },
    [qc],
  )

  const run = React.useCallback(
    async (
      name: string,
      optimistic: Partial<ApiSession>,
      call: () => Promise<unknown>,
      failure: string,
    ) => {
      if (pending) return
      setPending(true)
      const prev = patchCache(name, optimistic)
      try {
        await call()
        // The config PATCH emits no SSE — the refetch is what propagates the
        // change to the overview, the strip and every picker.
        void qc.invalidateQueries({ queryKey: SESSIONS_KEY })
      } catch (e) {
        // Put the cache back. A silently-wrong optimistic row is worse than the
        // failure itself: the user would believe the pin stuck.
        if (prev) qc.setQueryData<ApiSession[]>(SESSIONS_KEY, prev)
        toast({
          message: `${failure} — ${e instanceof Error ? e.message : 'unknown error'}`,
          tone: 'error',
          duration: 4000,
        })
      } finally {
        setPending(false)
      }
    },
    [pending, patchCache, qc, toast],
  )

  const togglePin = React.useCallback(
    (name: string, current?: boolean) =>
      run(
        name,
        { pinned: !current },
        () => sessionsApi.config(name, { toggle_pin: true }),
        'Pin failed',
      ),
    [run],
  )

  const setTags = React.useCallback(
    (name: string, tags: string[]) =>
      run(name, { tags }, () => sessionsApi.config(name, { tags }), 'Tags failed'),
    [run],
  )

  const setDesc = React.useCallback(
    (name: string, desc: string) =>
      run(name, { desc }, () => sessionsApi.config(name, { desc }), 'Save failed'),
    [run],
  )

  /** Launch-line write that RESOLVES the server's `restart_required` advisory.
   *  Same optimistic idiom as `run`, but the resolved row is what tells the
   *  caller whether the change is deferred to the next start. */
  const runLaunchLine = React.useCallback(
    async (
      name: string,
      optimistic: Partial<ApiSession>,
      call: () => Promise<ApiSession>,
      failure: string,
    ): Promise<boolean> => {
      if (pending) return false
      setPending(true)
      const prev = patchCache(name, optimistic)
      try {
        const row = await call()
        void qc.invalidateQueries({ queryKey: SESSIONS_KEY })
        return row?.restart_required ?? false
      } catch (e) {
        if (prev) qc.setQueryData<ApiSession[]>(SESSIONS_KEY, prev)
        toast({
          message: `${failure} — ${e instanceof Error ? e.message : 'unknown error'}`,
          tone: 'error',
          duration: 4000,
        })
        return false
      } finally {
        setPending(false)
      }
    },
    [pending, patchCache, qc, toast],
  )

  const setModel = React.useCallback(
    (name: string, model: string) =>
      runLaunchLine(name, { model }, () => sessionsApi.config(name, { model }), 'Model change failed'),
    [runLaunchLine],
  )

  const setMemory = React.useCallback(
    (name: string, memory: string) =>
      runLaunchLine(name, { memory }, () => sessionsApi.config(name, { memory }), 'Save failed'),
    [runLaunchLine],
  )

  return { pending, togglePin, setTags, setDesc, setModel, setMemory }
}

/**
 * Where the pinned block ends — the index of the first UNPINNED row.
 *
 * Pure, and exported for its own unit test, because the hairline it drives has
 * exactly two ways to be wrong and both are invisible in a screenshot: drawing
 * when there is nothing to separate, and not drawing when there is.
 *
 * Returns `null` when no separator should render — no pinned rows, or no
 * unpinned ones. §12.4: a 0.5px separator and NO "Pinned" text header; the
 * boundary is visible, the label is not needed.
 *
 * The rows must already be in render order (`smartSort` puts pinned first).
 */
export function pinnedBoundary(rows: readonly { pinned?: boolean }[]): number | null {
  if (rows.length === 0) return null
  const first = rows.findIndex((r) => !r.pinned)
  // Every row pinned (`first === -1`) or none pinned (`first === 0`) ⇒ nothing
  // to separate.
  if (first <= 0) return null
  // A pinned row AFTER the boundary means the list is not pinned-first — the
  // sort mode is a manual/custom one, and a hairline there would be a lie.
  if (rows.slice(first).some((r) => r.pinned)) return null
  return first
}
