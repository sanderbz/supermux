// useVersion: single hook backing Settings → Updates (v0.3.0).
//
// Owns:
//   * 30s poll of /api/version while the consuming component is mounted:
//     short enough that a fresh release surfaces in under a minute, long
//     enough that an idle dashboard does not burn the GitHub rate limit
//     (the server's 1h cache absorbs the per-call cost anyway).
//   * Force-refresh action that bypasses the server cache + ALSO bypasses
//     the 30s polling cadence (so "Refresh" feels instant).
//   * Start action that POSTs /api/update/start and, on 202, opens an
//     EventSource against /api/update/progress/:job_id; events stream into
//     React state as they arrive so the UI can render a live progress bar.
//   * Auto-reload detection: when the update SSE reports `done`, the new
//     binary is now serving the SPA shell at the SAME bundle hash IF the
//     deploy was a no-op, or a NEW hash if it shipped a frontend change.
//     The component reads `reloadHint` and prompts the user; we deliberately
//     do NOT auto-reload (the user might be mid-typing in another tab).
//   * Restart recovery: a systemd-install update restarts supermux during the
//     `installing` phase, which kills THIS server process (and the SSE). The
//     real terminal `done` line is written afterwards to a log no live client
//     can tail. So when the stream drops after we have reached `installing`,
//     we poll the new binary back to health and synthesize a terminal `done`.

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

/** DEV-only: parse `?mock_version=clean|blocked|uptodate|nolatest` into a fake
 *  preflight snapshot so the panel can be QA'd without a live server. Mirrors
 *  the same flag honoured by `useUpdateBadge` so the nav dot and the panel
 *  agree on the rendered state. */
function readMockSnapshot(): PreflightStatus | null {
  if (!import.meta.env.DEV) return null
  if (typeof window === 'undefined') return null
  const params = new URLSearchParams(window.location.search)
  const mock = params.get('mock_version')
  if (!mock) return null
  const baseCurrent = {
    tag: 'v0.3.2',
    sha: 'deadbeefcafe1234567890abcdef1234567890ab',
    build_time: '2026-05-27T12:00:00Z',
  }
  const baseLatest = {
    tag: 'v0.3.3',
    sha: 'main',
    body: '- cleaner updater copy\n- settings-icon update badge\n- no em-dashes',
    html_url: 'https://github.com/sanderbz/supermux/releases/tag/v0.3.3',
    published_at: '2026-05-28T01:00:00Z',
  }
  switch (mock) {
    case 'clean':
      return {
        current: baseCurrent,
        latest: baseLatest,
        update_available: true,
        blocked_reasons: [],
        install_mode: { kind: 'systemd', path_unit_present: true },
        manageable: true,
      }
    case 'blocked':
      return {
        current: baseCurrent,
        latest: baseLatest,
        update_available: true,
        blocked_reasons: [
          {
            kind: 'uncommitted_changes',
            count: 3,
            message:
              'Your supermux folder has 3 uncommitted changes. Commit or stash them before updating, otherwise they would be lost.',
          },
          {
            kind: 'ahead_of_remote',
            count: 1,
            message:
              "Your supermux folder has 1 local commit that hasn't been pushed yet. Push or reset before updating, otherwise the commits would be discarded.",
          },
        ],
        install_mode: { kind: 'systemd', path_unit_present: true },
        manageable: true,
      }
    case 'uptodate':
      return {
        current: { ...baseCurrent, tag: 'v0.3.3' },
        latest: baseLatest,
        update_available: false,
        blocked_reasons: [],
        install_mode: { kind: 'systemd', path_unit_present: true },
        manageable: true,
      }
    case 'nolatest':
      return {
        current: baseCurrent,
        latest: null,
        update_available: false,
        blocked_reasons: [
          {
            kind: 'no_latest_release',
            message:
              "Couldn't reach GitHub to check for updates. The currently running version is shown above.",
          },
        ],
        install_mode: { kind: 'systemd', path_unit_present: true },
        manageable: true,
      }
    default:
      return null
  }
}

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
  /** What kind of install this is. Drives the per-mode copy in the UI. */
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
  /** True once the SSE reported `done`. The UI should suggest a reload. */
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
  const [snapshot, setSnapshot] = React.useState<PreflightStatus | null>(() => readMockSnapshot())
  const [fetchError, setFetchError] = React.useState<string | null>(null)
  const [refreshing, setRefreshing] = React.useState(false)
  const [progress, setProgress] = React.useState<UpdateEvent[]>([])
  const [jobId, setJobId] = React.useState<string | null>(null)
  const esRef = React.useRef<EventSource | null>(null)
  // Mirror of `jobId` readable from closures without re-creating callbacks.
  const jobIdRef = React.useRef<string | null>(null)
  // Tracks whether we have reached the `installing` step, so the SSE `onerror`
  // handler can tell a transient blip from the install-phase service restart.
  // The systemd path-unit runner restarts supermux during `installing`, which
  // KILLS this server process (and the in-memory job registry + this SSE
  // connection). After that the runner keeps writing `verifying` / `done` to
  // its log, but no live SSE can deliver them: the new process has no record
  // of this job id and 404s the reconnect. So once we have reached `installing`
  // and the stream drops, we stop trusting the SSE for a terminal event and
  // instead poll the server back to health, then synthesize a terminal `done`.
  const reachedInstallRef = React.useRef(false)
  const recoveryRef = React.useRef(false)

  const fetchSnap = React.useCallback(async () => {
    // DEV mock: short-circuit the network so the panel renders a deterministic
    // state for QA / screenshots. See `readMockSnapshot` above.
    const mock = readMockSnapshot()
    if (mock) {
      setSnapshot(mock)
      setFetchError(null)
      return
    }
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

  // After the install-phase restart took our SSE down, poll the server back to
  // health on the NEW binary, then surface a terminal `done`. We push a
  // synthetic `done` event so the progress UI reaches its terminal state
  // (CheckCircle + "Reload now") even though the real `done` line was written
  // to a log no live client could tail. We do NOT auto-reload silently: a
  // forced reload could drop work in another tab, so we render the terminal
  // state and let the existing "Reload now" button (and the user) drive the
  // actual navigation.
  const recoverAfterRestart = React.useCallback(async () => {
    const deadline = Date.now() + 5 * 60_000 // 5 min ceiling, matches the runner verify window.
    // Give the restart a moment before the first probe.
    await new Promise((r) => setTimeout(r, 1_500))
    while (Date.now() < deadline) {
      try {
        const snap = await updatesApi.getVersion()
        // The new binary answered. Surface a terminal `done` so the UI shows
        // "Update complete" + the Reload button.
        setProgress((prev) => {
          if (prev.some((p) => p.step === 'done')) return prev
          const tag = snap.current?.tag ?? snap.current?.sha?.slice(0, 7) ?? 'the new build'
          return [
            ...prev,
            {
              job_id: jobIdRef.current ?? '',
              step: 'done',
              message: `Update complete. Now running ${tag}.`,
              ts: Math.floor(Date.now() / 1000),
            },
          ]
        })
        return
      } catch {
        // Server still restarting / unreachable; keep probing.
        await new Promise((r) => setTimeout(r, 2_000))
      }
    }
    // Never came back healthy in time: surface a failure so the UI does not
    // hang on a half-finished bar forever.
    setProgress((prev) => {
      if (prev.some((p) => p.step === 'failed' || p.step === 'done')) return prev
      return [
        ...prev,
        {
          job_id: jobIdRef.current ?? '',
          step: 'failed',
          message:
            'The server did not come back after the restart. Check the supermux-deploy unit on the server.',
          ts: Math.floor(Date.now() / 1000),
        },
      ]
    })
  }, [])

  const startUpdate = React.useCallback(async (): Promise<string> => {
    setProgress([])
    setJobId(null)
    jobIdRef.current = null
    reachedInstallRef.current = false
    recoveryRef.current = false
    const { job_id } = await updatesApi.start()
    setJobId(job_id)
    jobIdRef.current = job_id
    // Open SSE for live progress. EventSource auto-reconnects on transport
    // hiccups (and the server replays the LATEST event on each subscribe), so
    // even a fast reconnect picks up the current step.
    const es = new EventSource(updatesApi.progressUrl(job_id))
    esRef.current = es
    es.addEventListener('update', (ev) => {
      try {
        const data = JSON.parse((ev as MessageEvent).data) as UpdateEvent
        if (
          data.step === 'installing' ||
          data.step === 'verifying' ||
          data.step === 'done'
        ) {
          reachedInstallRef.current = true
        }
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
        // Malformed event; skip, the client's progress bar simply stalls
        // until the next valid frame.
      }
    })
    es.onerror = () => {
      // EventSource fires `error` on every transient disconnect too; the
      // browser auto-reconnects. We do NOT close on a plain blip. BUT if we
      // already reached `installing`, this drop is almost certainly the service
      // restart taking our process down (see reachedInstallRef above). The
      // terminal `done` will never arrive over this socket, so kick off the
      // recovery poll: wait for the new binary to answer /api/version, then
      // surface a synthetic terminal `done`. This is what turns "stuck after
      // Installing" into a clean "Update complete" + Reload.
      if (reachedInstallRef.current && !recoveryRef.current) {
        recoveryRef.current = true
        es.close()
        esRef.current = null
        void recoverAfterRestart()
      }
    }
    return job_id
  }, [recoverAfterRestart])

  const resetUpdate = React.useCallback(() => {
    if (esRef.current) {
      esRef.current.close()
      esRef.current = null
    }
    jobIdRef.current = null
    reachedInstallRef.current = false
    recoveryRef.current = false
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
