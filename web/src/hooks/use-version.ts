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
//     can tail, and the restarted process 404s this job id. The restart often
//     lands BEFORE the `installing` event even reaches the client (last seen
//     step = `building`), so we cannot rely on the SSE for the terminal state.
//     Once we reach `building` we arm a version watcher that polls
//     /api/version and resolves the update when the running sha changes (a
//     release is always a new commit) or the server is seen to bounce down→up.

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
  // The systemd path-unit runner restarts supermux during `installing`, which
  // KILLS this server process (and the in-memory job registry + this SSE
  // connection) BEFORE the terminal `done` line can be delivered — often before
  // `installing` itself reaches the client, so the last event we see is
  // `building`. We therefore don't trust the SSE for the terminal state: once
  // we reach `building` we arm a version watcher (`watchForRestart`) that
  // resolves the update by polling /api/version for a sha change.
  const reachedBuildRef = React.useRef(false)
  const watcherStartedRef = React.useRef(false)
  // The sha running BEFORE the update (captured in `startUpdate`) and a live
  // mirror of the currently-running sha. The watcher compares the two: a change
  // means the new binary is up.
  const preUpdateShaRef = React.useRef<string | null>(null)
  const currentShaRef = React.useRef<string | null>(null)
  // Live mirror of `progress` so the watcher loop can see a terminal event
  // pushed by the backstop effect (or the SSE) and stop without a stale closure.
  const progressRef = React.useRef<UpdateEvent[]>([])

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

  // Keep a ref mirror of the running sha so `startUpdate` can snapshot the
  // pre-update commit without a stale closure.
  React.useEffect(() => {
    currentShaRef.current = snapshot?.current?.sha ?? null
  }, [snapshot])

  // Mirror `progress` into a ref for the watcher loop's terminal check.
  React.useEffect(() => {
    progressRef.current = progress
  }, [progress])

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

  // Mark the update DONE iff the running binary is a NEW commit. A release is
  // ALWAYS a new sha, and a rollback comes back on the OLD commit — so a sha
  // change is the only signal that distinguishes a successful update from a
  // failed-and-rolled-back one (a plain down→up bounce does NOT). Dedupe-guarded
  // so the fast watcher AND the regular version poll can both call it without
  // racing. Pushes a synthetic `done` so the modal reaches its terminal
  // "Update complete" + "Reload now" state (we never auto-reload — a forced
  // reload could drop work in another tab; the user drives navigation).
  const resolveDoneIfNewBinary = React.useCallback(
    (snap: PreflightStatus): boolean => {
      const pre = preUpdateShaRef.current
      const sha = snap.current?.sha ?? null
      if (!sha || !pre || sha === pre) return false
      const tag = snap.current?.tag ?? sha.slice(0, 7)
      setProgress((prev) =>
        prev.some((p) => p.step === 'done' || p.step === 'failed')
          ? prev
          : [
              ...prev,
              {
                job_id: jobIdRef.current ?? '',
                step: 'done',
                message: `Update complete. Now running ${tag}.`,
                ts: Math.floor(Date.now() / 1000),
              },
            ],
      )
      return true
    },
    [],
  )

  // Armed once the update reaches `building` (see startUpdate). Polls the server
  // fast so the new binary's version surfaces within seconds of the restart;
  // `resolveDoneIfNewBinary` (also wired to the 30s poll via an effect) owns the
  // DONE transition on a sha change. INDEPENDENT of the SSE, which the
  // install-phase restart takes down before it can deliver a terminal event. If
  // the deadline passes without a new commit, surface a failure so the modal
  // never spins forever (one last check first, in case a throttled background
  // tab missed the change).
  const watchForRestart = React.useCallback(async () => {
    const deadline = Date.now() + 8 * 60_000
    let sawServerDown = false
    await new Promise((r) => setTimeout(r, 1_500))
    while (Date.now() < deadline) {
      if (progressRef.current.some((p) => p.step === 'done' || p.step === 'failed')) {
        return
      }
      try {
        const snap = await updatesApi.getVersion()
        setSnapshot(snap) // keep the panel behind the modal fresh too
        setFetchError(null)
        if (resolveDoneIfNewBinary(snap)) return
      } catch {
        // A failed probe means the server is restarting / briefly unreachable.
        sawServerDown = true
      }
      await new Promise((r) => setTimeout(r, 2_500))
    }
    // One last check before failing (covers a throttled background poll).
    try {
      const snap = await updatesApi.getVersion()
      setSnapshot(snap)
      if (resolveDoneIfNewBinary(snap)) return
    } catch {
      sawServerDown = true
    }
    setProgress((prev) =>
      prev.some((p) => p.step === 'failed' || p.step === 'done')
        ? prev
        : [
            ...prev,
            {
              job_id: jobIdRef.current ?? '',
              step: 'failed',
              message: sawServerDown
                ? 'Could not confirm the update from this device — the server never settled on a new version. Check the version above (it may already be updated) or the supermux-deploy unit on the server.'
                : 'The update did not complete in time. Check the version above or the supermux-deploy unit on the server.',
              ts: Math.floor(Date.now() / 1000),
            },
          ],
    )
  }, [resolveDoneIfNewBinary])

  // Backstop done-resolver: while a building+ update is in flight, ANY version
  // poll (the fast watcher OR the 30s cadence OR a manual refresh) that shows a
  // new commit resolves the modal. Keeps the terminal state robust even if the
  // watcher loop is throttled (e.g. a backgrounded PWA tab).
  React.useEffect(() => {
    if (!watcherStartedRef.current || !snapshot) return
    resolveDoneIfNewBinary(snapshot)
  }, [snapshot, resolveDoneIfNewBinary])

  const startUpdate = React.useCallback(async (): Promise<string> => {
    setProgress([])
    setJobId(null)
    jobIdRef.current = null
    reachedBuildRef.current = false
    watcherStartedRef.current = false
    // Snapshot the commit we're updating FROM so the watcher can detect the new
    // binary by sha change.
    preUpdateShaRef.current = currentShaRef.current
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
          data.step === 'building' ||
          data.step === 'installing' ||
          data.step === 'verifying' ||
          data.step === 'done'
        ) {
          reachedBuildRef.current = true
          // Arm the version watcher once: the SSE cannot deliver the terminal
          // `done` across the install-phase restart, so the watcher owns
          // terminal resolution from here.
          if (!watcherStartedRef.current) {
            watcherStartedRef.current = true
            void watchForRestart()
          }
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
      // EventSource auto-reconnects transient blips (and the server replays the
      // latest event on resubscribe), so a plain drop needs no action. After
      // the install-phase restart the socket dies for good (the new process
      // 404s this job id) — but `watchForRestart`, armed once we reach
      // `building`, owns terminal resolution by polling the version. Arm it
      // here too, in case `building` was the only event we got before the drop.
      if (reachedBuildRef.current && !watcherStartedRef.current) {
        watcherStartedRef.current = true
        void watchForRestart()
      }
    }
    return job_id
  }, [watchForRestart])

  const resetUpdate = React.useCallback(() => {
    if (esRef.current) {
      esRef.current.close()
      esRef.current = null
    }
    jobIdRef.current = null
    reachedBuildRef.current = false
    watcherStartedRef.current = false
    preUpdateShaRef.current = null
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
