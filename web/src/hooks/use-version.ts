// use-version — the single source of truth for the Updates panel
// (UPDATE-MECH-FE).
//
// Polls `/api/version` every 30s while a subscriber is active, surfaces the
// "should we offer an update?" decision, exposes a manual refresh (which hits
// `/api/version/refresh` to force a fresh GitHub fetch), and — when the user
// presses "Update now" — opens an SSE stream to `/api/update/progress/:job_id`
// so the panel reflects every pipeline step live.
//
// SSE recovery: the EventSource lifecycle isn't shared with `use-sse.ts`
// (that's a multiplexed always-on channel for app data); the update stream is
// per-job and short-lived, so we own its own EventSource here. We reconnect
// with exponential backoff (3s → 6s → 12s) and give up after 30s of failed
// retries — by then the build has either succeeded or actually failed, and the
// best UX is "refresh the page to see the new status" rather than a spinner
// that never resolves.
//
// On `done`: schedule a 3s grace then `window.location.reload()` so the user
// lands on the new binary's UI without having to think about it.
// On `failed` / `rolled_back`: keep the panel in failure mode so the user can
// inspect the last log line and retry.
//
// MOCK MODE (test-only): when the URL contains `?mock-updates=true` the hook
// short-circuits all HTTP and replays a fixture set keyed off
// `?mock-state=<A..F>`. This is purely for screenshotting the panel states from
// the frontend worker before the backend lands — it doesn't affect production
// behaviour and is gated on a query string the user would never naturally type.

import * as React from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'

import {
  ApiError,
  updateProgressUrl,
  versionApi,
  type BlockedReason,
  type InstallMode,
  type LatestRelease,
  type UpdateEvent,
  type UpdateStep,
  type VersionInfo,
  type VersionResponse,
} from '@/lib/api'

// ── Public types ──────────────────────────────────────────────────────────────

/** Append-only chronological log of every SSE event, plus the most recent
 *  message convenience fields. Consumers render `history` as a checklist; the
 *  top-level `step` drives which "state" the panel is in. */
export interface UpdateProgress {
  step: UpdateStep
  message: string
  ts: string
  history: UpdateEvent[]
  /** Set when the SSE connection itself failed (network / 5xx after retries).
   *  Distinct from a `failed` step event from the server. */
  streamError?: string
}

export interface UseVersionResult {
  current: VersionInfo | null
  latest: LatestRelease | null
  updateAvailable: boolean
  blockedReasons: BlockedReason[]
  installMode: InstallMode | null
  loading: boolean
  error: Error | null
  refresh: () => Promise<void>
  startUpdate: () => Promise<{ jobId: string }>
  progress: UpdateProgress | null
  /** True while the user-initiated `startUpdate` call is in flight, before any
   *  SSE event has arrived (the gap between POST + first server-sent event). */
  starting: boolean
}

const VERSION_QUERY_KEY = ['version'] as const
const POLL_INTERVAL_MS = 30_000

// ── Mock fixture (test-only; gated on ?mock-updates=true) ─────────────────────

/** When `?mock-updates=true` is present in the URL, the hook serves this
 *  fixture instead of hitting the network. The variant is picked by
 *  `?mock-state=A|B|C|D|E|F` (defaults to A). Used to screenshot each state
 *  before the backend lands. NEVER referenced in production. */
type MockState = 'A' | 'B' | 'C' | 'D' | 'E' | 'F'

function readMockMode(): MockState | null {
  if (typeof window === 'undefined') return null
  const params = new URLSearchParams(window.location.search)
  if (params.get('mock-updates') !== 'true') return null
  const s = (params.get('mock-state') ?? 'A').toUpperCase() as MockState
  return ['A', 'B', 'C', 'D', 'E', 'F'].includes(s) ? s : 'A'
}

const MOCK_CURRENT: VersionInfo = {
  tag: 'v0.2.0',
  sha: 'b373091',
  built_at: '2026-05-27T22:48:00Z',
}

const MOCK_LATEST: LatestRelease = {
  tag: 'v0.3.0',
  sha: 'a1b2c3d4e5f6789',
  body:
    '## What’s new\n\n- **Faster overview** — tile reflow is 3× quicker on long lists.\n- New _Updates_ panel — you’re looking at it.\n- Several small focus-mode papercuts smoothed out.\n\n_Full notes on GitHub._',
  html_url: 'https://github.com/sanderbz/supermux/releases/tag/v0.3.0',
  published_at: '2026-05-28T08:12:00Z',
}

const MOCK_INSTALL_SYSTEMD: InstallMode = {
  kind: 'systemd',
  path_unit_present: true,
}

function mockResponse(state: MockState): VersionResponse {
  switch (state) {
    case 'A':
      return {
        current: MOCK_CURRENT,
        latest: { ...MOCK_LATEST, tag: 'v0.2.0' },
        update_available: false,
        blocked_reasons: [],
        install_mode: MOCK_INSTALL_SYSTEMD,
      }
    case 'B':
      return {
        current: MOCK_CURRENT,
        latest: MOCK_LATEST,
        update_available: true,
        blocked_reasons: [],
        install_mode: MOCK_INSTALL_SYSTEMD,
      }
    case 'C':
      return {
        current: MOCK_CURRENT,
        latest: MOCK_LATEST,
        update_available: true,
        blocked_reasons: [
          {
            kind: 'not_on_main',
            message:
              "You’re on branch `feat/foo` — switch to main to install updates.",
            current_branch: 'feat/foo',
          },
          {
            kind: 'uncommitted_changes',
            message:
              'Stash or commit your local changes before updating.',
          },
        ],
        install_mode: MOCK_INSTALL_SYSTEMD,
      }
    case 'D':
      // Panel renders state D when `progress` is non-null AND the step is
      // pre-terminal; the version snapshot underneath stays at "update available".
      return {
        current: MOCK_CURRENT,
        latest: MOCK_LATEST,
        update_available: true,
        blocked_reasons: [],
        install_mode: MOCK_INSTALL_SYSTEMD,
      }
    case 'E':
      return {
        current: MOCK_CURRENT,
        latest: MOCK_LATEST,
        update_available: true,
        blocked_reasons: [],
        install_mode: MOCK_INSTALL_SYSTEMD,
      }
    case 'F':
      return {
        current: MOCK_CURRENT,
        latest: null,
        update_available: false,
        blocked_reasons: [
          {
            kind: 'no_network',
            message: "Couldn’t reach GitHub to check for a newer release.",
          },
        ],
        install_mode: MOCK_INSTALL_SYSTEMD,
      }
  }
}

function mockProgress(state: MockState): UpdateProgress | null {
  if (state === 'D') {
    const t = new Date().toISOString()
    return {
      step: 'building',
      message: 'Building from source… please don’t close this tab.',
      ts: t,
      history: [
        { step: 'fetching', message: 'Pulled origin/main', ts: t },
        { step: 'building', message: 'cargo build --release', ts: t },
      ],
    }
  }
  if (state === 'E') {
    const t = new Date().toISOString()
    return {
      step: 'rolled_back',
      message:
        'cargo build failed: error[E0599]: no method named `nope` — rolled back to v0.2.0.',
      ts: t,
      history: [
        { step: 'fetching', message: 'Pulled origin/main', ts: t },
        { step: 'building', message: 'cargo build --release', ts: t },
        { step: 'failed', message: 'cargo build failed', ts: t },
        { step: 'rolled_back', message: 'Restored previous binary', ts: t },
      ],
    }
  }
  return null
}

// ── Hook ──────────────────────────────────────────────────────────────────────

const TERMINAL_STEPS: ReadonlySet<UpdateStep> = new Set([
  'done',
  'failed',
  'rolled_back',
])

export function useVersion(): UseVersionResult {
  const qc = useQueryClient()
  const mockMode = React.useMemo(() => readMockMode(), [])

  // 30s polling query. `retry: false` so a 404 (server doesn't have the
  // endpoint yet) surfaces immediately as an error state we render as "couldn't
  // check for updates" — never an infinite spinner.
  const query = useQuery<VersionResponse, Error>({
    queryKey: VERSION_QUERY_KEY,
    queryFn: async () => {
      if (mockMode) return mockResponse(mockMode)
      return versionApi.get()
    },
    refetchInterval: POLL_INTERVAL_MS,
    refetchOnWindowFocus: true,
    retry: false,
    staleTime: POLL_INTERVAL_MS / 2,
  })

  const refresh = React.useCallback(async () => {
    if (mockMode) {
      // The refresh in mock mode is a no-op — the fixture is static.
      qc.setQueryData(VERSION_QUERY_KEY, mockResponse(mockMode))
      return
    }
    const data = await versionApi.refresh()
    qc.setQueryData(VERSION_QUERY_KEY, data)
  }, [mockMode, qc])

  // ── SSE: in-flight progress ────────────────────────────────────────────────

  const [progress, setProgress] = React.useState<UpdateProgress | null>(() => {
    return mockMode ? mockProgress(mockMode) : null
  })

  // EventSource owned per-job; cleared on dismount or after a terminal event.
  const esRef = React.useRef<EventSource | null>(null)
  const retryTimerRef = React.useRef<ReturnType<typeof setTimeout> | null>(null)
  const reloadTimerRef = React.useRef<ReturnType<typeof setTimeout> | null>(
    null,
  )

  const cleanupStream = React.useCallback(() => {
    if (esRef.current) {
      try {
        esRef.current.close()
      } catch {
        /* closing a dead source is fine */
      }
      esRef.current = null
    }
    if (retryTimerRef.current) {
      clearTimeout(retryTimerRef.current)
      retryTimerRef.current = null
    }
  }, [])

  // Tear everything down on unmount — prevents a leaked EventSource if the user
  // navigates away mid-build.
  React.useEffect(() => {
    return () => {
      cleanupStream()
      if (reloadTimerRef.current) {
        clearTimeout(reloadTimerRef.current)
        reloadTimerRef.current = null
      }
    }
  }, [cleanupStream])

  /** Connect (or reconnect) the SSE stream for `jobId`. `attempt` is the retry
   *  count; we give up after the 30s budget (3 + 6 + 12 + 9 = 30) and surface
   *  `streamError` so the panel can render a "lost connection" hint. */
  const connectStream = React.useCallback(
    (jobId: string, attempt = 0) => {
      // Always tear the previous source down before opening a new one —
      // otherwise a stale onerror fires after we move on.
      cleanupStream()
      let es: EventSource
      try {
        es = new EventSource(updateProgressUrl(jobId))
      } catch (err) {
        setProgress((prev) => ({
          step: prev?.step ?? 'failed',
          message: prev?.message ?? 'Could not open the progress stream.',
          ts: prev?.ts ?? new Date().toISOString(),
          history: prev?.history ?? [],
          streamError:
            err instanceof Error ? err.message : 'Connection failed',
        }))
        return
      }
      esRef.current = es

      es.onmessage = (ev) => {
        let evt: UpdateEvent | null = null
        try {
          evt = JSON.parse(ev.data) as UpdateEvent
        } catch {
          // Non-JSON payload — keep the stream open, the server might recover.
          return
        }
        if (!evt?.step) return

        setProgress((prev) => {
          const history = [...(prev?.history ?? []), evt!]
          return {
            step: evt!.step,
            message: evt!.message,
            ts: evt!.ts,
            history,
          }
        })

        if (TERMINAL_STEPS.has(evt.step)) {
          cleanupStream()
          if (evt.step === 'done') {
            // Soft reload after a grace period so the user sees the green check
            // settle before the new binary's UI takes over.
            reloadTimerRef.current = setTimeout(() => {
              try {
                window.location.reload()
              } catch {
                /* SSR / test env — no-op */
              }
            }, 3000)
          }
          // For failed / rolled_back we deliberately do nothing else: the
          // panel reads `progress.step` and renders the failure UI.
        }
      }

      es.onerror = () => {
        try {
          es.close()
        } catch {
          /* fine */
        }
        esRef.current = null

        // Exponential backoff (3, 6, 12s) with a 30s overall budget. Beyond
        // that, surface the disconnection so the user knows to refresh.
        const delays = [3000, 6000, 12000]
        if (attempt >= delays.length) {
          setProgress((prev) => ({
            step: prev?.step ?? 'failed',
            message:
              prev?.message ??
              'Lost connection to the update stream — refresh the page to see the latest status.',
            ts: prev?.ts ?? new Date().toISOString(),
            history: prev?.history ?? [],
            streamError: 'connection lost',
          }))
          return
        }
        retryTimerRef.current = setTimeout(() => {
          retryTimerRef.current = null
          connectStream(jobId, attempt + 1)
        }, delays[attempt])
      }
    },
    [cleanupStream],
  )

  // ── start: POST /api/update/start + open stream ────────────────────────────

  const startMutation = useMutation({
    mutationFn: async () => {
      if (mockMode) {
        // Simulate a happy-path build in mock mode: schedule a synthetic SSE
        // sequence so we can screenshot the in-flight state without a backend.
        const jobId = 'mock-job'
        const t = () => new Date().toISOString()
        setProgress({
          step: 'fetching',
          message: 'Pulling origin/main',
          ts: t(),
          history: [{ step: 'fetching', message: 'Pulling origin/main', ts: t() }],
        })
        // Don't auto-advance — leave it on `fetching` so screenshots stay
        // deterministic. The mock-state=D fixture covers the building view.
        return { job_id: jobId }
      }
      return versionApi.start()
    },
    onSuccess: ({ job_id }) => {
      if (!mockMode) {
        // Seed the progress card with a "Starting…" placeholder so the user
        // sees IMMEDIATE feedback even before the first SSE frame lands.
        setProgress({
          step: 'fetching',
          message: 'Starting update…',
          ts: new Date().toISOString(),
          history: [],
        })
        connectStream(job_id)
      }
    },
  })

  const startUpdate = React.useCallback(async () => {
    try {
      const { job_id } = await startMutation.mutateAsync()
      return { jobId: job_id }
    } catch (err) {
      // 409 carries `{ blocked_reasons }` — surface as an error the panel can
      // read. The query re-fetches in the background so blocked_reasons stays
      // current.
      if (err instanceof ApiError && err.status === 409) {
        void qc.invalidateQueries({ queryKey: VERSION_QUERY_KEY })
      }
      throw err
    }
  }, [qc, startMutation])

  // ── Assemble the public surface ────────────────────────────────────────────

  const data = query.data
  return {
    current: data?.current ?? null,
    latest: data?.latest ?? null,
    updateAvailable: data?.update_available ?? false,
    blockedReasons: data?.blocked_reasons ?? [],
    installMode: data?.install_mode ?? null,
    loading: query.isLoading,
    error: query.error,
    refresh,
    startUpdate,
    progress,
    starting: startMutation.isPending,
  }
}
