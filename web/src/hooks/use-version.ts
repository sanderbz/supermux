// useVersion — single hook backing Settings → Updates (v0.3.0).
//
// Owns:
//   * 30s poll of /api/version while the consuming component is mounted —
//     short enough that a fresh release surfaces in under a minute, long
//     enough that an idle dashboard does not burn the GitHub rate limit
//     (the server's 6h cache absorbs the per-call cost anyway).
//   * Force-refresh action that bypasses the server cache + ALSO bypasses
//     the 30s polling cadence (so "Refresh" feels instant).
//   * Start action that POSTs /api/update/start and, on 202, opens an
//     EventSource against /api/update/progress/:job_id; events stream into
//     React state as they arrive so the UI can render a live progress bar.
//   * Auto-reload detection — when the update SSE reports `done`, the new
//     binary is now serving the SPA shell at the SAME bundle hash IF the
//     deploy was a no-op, or a NEW hash if it shipped a frontend change.
//     The component reads `reloadHint` and prompts the user; we deliberately
//     do NOT auto-reload (the user might be mid-typing in another tab).

import * as React from 'react'

import {
  updatesApi,
  type BlockedReason,
  type LatestRelease,
  type PreflightStatus,
  type UpdateEvent,
  type UpdateStep,
  type VersionInfo,
} from '@/lib/api'

const POLL_INTERVAL_MS = 30_000

export interface UseVersion {
  /** The running binary's identity. Always present once the first /api/version
   *  call resolves. */
  current: VersionInfo | null
  /** The latest published release, or null when GitHub is unreachable. */
  latest: LatestRelease | null
  /** True IFF `latest.tag` is strictly newer than `current.tag`. */
  updateAvailable: boolean
  /** Why the "Update now" button cannot be clicked (empty when clickable). */
  blockedReasons: BlockedReason[]
  /** What kind of install this is — drives the per-mode copy in the UI. */
  installMode: PreflightStatus['install_mode'] | null
  /** True when the dashboard should render an Updates section at all. */
  manageable: boolean
  /** Last fetch failed (network down). UI shows the cached `current` calmly. */
  fetchError: string | null
  /** Force-refresh the latest-release cache + re-run preflight. */
  refresh: () => Promise<void>
  /** True while a refresh / start round-trip is in flight. */
  refreshing: boolean
  /** Kick off the update. Resolves to the job id; throws on a preflight 409
   *  (the caller surfaces the blocked_reasons it gets back). */
  startUpdate: () => Promise<string>
  /** Live progress for the currently-running update. Empty until `startUpdate`
   *  resolves. */
  progress: UpdateEvent[]
  /** Most recent step (the one the progress bar should highlight). */
  currentStep: UpdateStep | null
  /** True once the SSE reported `done` — the UI should suggest a reload. */
  updateDone: boolean
  /** True if the update SSE reported `failed` / `rolled_back`. */
  updateFailed: boolean
  /** The active job id while an update is in flight, else null. */
  jobId: string | null
  /** Reset the per-update state so a fresh "Update now" starts clean. */
  resetUpdate: () => void
}

/** Polling version of the hook. The consuming component decides when to mount
 *  (only the Updates section mounts it, so we never poll on routes that don't
 *  surface the data). */
export function useVersion(): UseVersion {
  const [snapshot, setSnapshot] = React.useState<PreflightStatus | null>(null)
  const [fetchError, setFetchError] = React.useState<string | null>(null)
  const [refreshing, setRefreshing] = React.useState(false)
  const [progress, setProgress] = React.useState<UpdateEvent[]>([])
  const [jobId, setJobId] = React.useState<string | null>(null)
  const esRef = React.useRef<EventSource | null>(null)

  const fetchSnap = React.useCallback(async () => {
    try {
      const snap = await updatesApi.getVersion()
      setSnapshot(snap)
      setFetchError(null)
    } catch (e) {
      setFetchError(e instanceof Error ? e.message : 'Could not load version info.')
    }
  }, [])

  // Initial fetch + 30s polling cadence.
  React.useEffect(() => {
    void fetchSnap()
    const t = window.setInterval(() => void fetchSnap(), POLL_INTERVAL_MS)
    return () => window.clearInterval(t)
  }, [fetchSnap])

  const refresh = React.useCallback(async () => {
    if (refreshing) return
    setRefreshing(true)
    try {
      const { snapshot: snap, fetch_error } = await updatesApi.refresh()
      setSnapshot(snap)
      setFetchError(fetch_error)
    } catch (e) {
      setFetchError(e instanceof Error ? e.message : 'Refresh failed.')
    } finally {
      setRefreshing(false)
    }
  }, [refreshing])

  const startUpdate = React.useCallback(async (): Promise<string> => {
    setProgress([])
    setJobId(null)
    const { job_id } = await updatesApi.start()
    setJobId(job_id)
    // Open SSE for live progress. EventSource auto-reconnects on transport
    // hiccups (and the server replays the LATEST event on each subscribe), so
    // even a fast reconnect picks up the current step.
    const es = new EventSource(updatesApi.progressUrl(job_id))
    esRef.current = es
    es.addEventListener('update', (ev) => {
      try {
        const data = JSON.parse((ev as MessageEvent).data) as UpdateEvent
        setProgress((prev) => {
          // Dedupe (the server replays the latest event on subscribe, so the
          // first event we hear may be the same one we got just before a
          // reconnect). Same job_id + step + ts = same event.
          if (prev.some((p) => p.ts === data.ts && p.step === data.step)) {
            return prev
          }
          return [...prev, data]
        })
        if (
          data.step === 'done' ||
          data.step === 'failed' ||
          data.step === 'rolled_back'
        ) {
          es.close()
          esRef.current = null
        }
      } catch {
        // Malformed event — skip, the client's progress bar simply stalls
        // until the next valid frame.
      }
    })
    es.onerror = () => {
      // EventSource fires `error` on every transient disconnect too — the
      // browser auto-reconnects. Don't close here; only close on a terminal
      // step or in `resetUpdate`.
    }
    return job_id
  }, [])

  const resetUpdate = React.useCallback(() => {
    if (esRef.current) {
      esRef.current.close()
      esRef.current = null
    }
    setProgress([])
    setJobId(null)
  }, [])

  React.useEffect(() => {
    return () => {
      if (esRef.current) {
        esRef.current.close()
        esRef.current = null
      }
    }
  }, [])

  const currentStep =
    progress.length > 0 ? progress[progress.length - 1].step : null
  const updateDone = currentStep === 'done'
  const updateFailed = currentStep === 'failed' || currentStep === 'rolled_back'

  return {
    current: snapshot?.current ?? null,
    latest: snapshot?.latest ?? null,
    updateAvailable: snapshot?.update_available ?? false,
    blockedReasons: snapshot?.blocked_reasons ?? [],
    installMode: snapshot?.install_mode ?? null,
    manageable: snapshot?.manageable ?? false,
    fetchError,
    refresh,
    refreshing,
    startUpdate,
    progress,
    currentStep,
    updateDone,
    updateFailed,
    jobId,
    resetUpdate,
  }
}
