// useUpdateBadge: tiny shell-level poll that drives the Settings-icon update
// dot in the nav (v0.3.3).
//
// Separate from `useVersion` on purpose:
//   * useVersion is mounted only by the Settings → Updates panel. That hook
//     owns the full preflight snapshot, the SSE progress stream, and the
//     refresh / start actions. It only polls while the panel is open.
//   * useUpdateBadge runs at shell level so the Settings-icon dot is correct on
//     EVERY route. It needs nothing more than the latest tag + `update_available`
//     + a count of blocked reasons, so we keep its memory footprint to one tiny
//     object and its polling cost to one 30s tick. The server's 6h release-cache
//     absorbs the duplicate when both hooks are mounted at the same time (on
//     /settings).
//
// The "read receipt" UX:
//   The badge is suppressed for a given `latest.tag` once the user has VIEWED
//   the Updates section. We persist the dismissed tag in localStorage so the
//   suppression survives reloads. When a NEWER tag arrives the dot reappears.
//   The panel calls `markUpdatesSeen(tag)` on mount + whenever `latest.tag`
//   changes; from the nav side we just compare snapshot.latest.tag against the
//   stored value.
//
// DEV mock flag:
//   `?mock_version=clean|blocked|uptodate|nolatest` lets us drive every state
//   without a live server. Gated on `import.meta.env.DEV`.

import * as React from 'react'

import { updatesApi, type PreflightStatus } from '@/lib/api'

const POLL_INTERVAL_MS = 30_000
const DISMISSED_TAG_KEY = 'supermux:updates:dismissed_tag'

/** What dot to render on the Settings icon. */
export type UpdateBadgeState = 'none' | 'available' | 'available-blocked'

export interface UseUpdateBadge {
  state: UpdateBadgeState
  /** Current latest tag, for use by the panel's read-receipt call. */
  latestTag: string | null
  /** Record that the user has now seen the Updates panel for this tag. The
   *  badge will stay dismissed until a strictly newer tag arrives. */
  markUpdatesSeen: (tag: string | null) => void
}

/** Read the persisted dismissed tag. SSR-safe. */
function readDismissedTag(): string | null {
  if (typeof window === 'undefined') return null
  try {
    return window.localStorage.getItem(DISMISSED_TAG_KEY)
  } catch {
    return null
  }
}

/** DEV-only: parse `?mock_version=...` into a fake preflight snapshot. */
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

/** Mounted in `Layout`. Polls every 30s for the lightweight badge state. */
export function useUpdateBadge(): UseUpdateBadge {
  const [snap, setSnap] = React.useState<PreflightStatus | null>(() => readMockSnapshot())
  const [dismissedTag, setDismissedTag] = React.useState<string | null>(() => readDismissedTag())

  const fetchSnap = React.useCallback(async () => {
    // Honour the DEV mock flag: skip the network entirely so the badge state
    // is deterministic.
    const mock = readMockSnapshot()
    if (mock) {
      setSnap(mock)
      return
    }
    try {
      const next = await updatesApi.getVersion()
      setSnap(next)
    } catch {
      // Quiet failure: a transient network blip should not flip the badge on
      // or off. Keep the prior snapshot.
    }
  }, [])

  React.useEffect(() => {
    void fetchSnap()
    const t = window.setInterval(() => void fetchSnap(), POLL_INTERVAL_MS)
    return () => window.clearInterval(t)
  }, [fetchSnap])

  // Watch localStorage from other tabs (a "Mark as seen" in tab B should also
  // clear the dot in tab A within ~event-loop time).
  React.useEffect(() => {
    if (typeof window === 'undefined') return
    function onStorage(e: StorageEvent) {
      if (e.key === DISMISSED_TAG_KEY) {
        setDismissedTag(e.newValue)
      }
    }
    window.addEventListener('storage', onStorage)
    return () => window.removeEventListener('storage', onStorage)
  }, [])

  const markUpdatesSeen = React.useCallback((tag: string | null) => {
    if (!tag) return
    try {
      window.localStorage.setItem(DISMISSED_TAG_KEY, tag)
    } catch {
      // localStorage quota / disabled. Fall back to in-memory dismissal only.
    }
    setDismissedTag(tag)
  }, [])

  const state: UpdateBadgeState = React.useMemo(() => {
    if (!snap) return 'none'
    if (!snap.update_available) return 'none'
    if (!snap.latest) return 'none'
    // Suppress when the user has already seen this exact tag.
    if (dismissedTag === snap.latest.tag) return 'none'
    return snap.blocked_reasons.length > 0 ? 'available-blocked' : 'available'
  }, [snap, dismissedTag])

  return {
    state,
    latestTag: snap?.latest?.tag ?? null,
    markUpdatesSeen,
  }
}

/** Read-only sibling: just the markUpdatesSeen action, for callers that don't
 *  need the polling (e.g. the Updates panel which has its own `useVersion`).
 *  Writes go straight to localStorage + fire the `storage` event so any other
 *  mounted `useUpdateBadge` instance updates immediately. */
export function useMarkUpdatesSeen(): (tag: string | null) => void {
  return React.useCallback((tag: string | null) => {
    if (!tag) return
    try {
      const prior = window.localStorage.getItem(DISMISSED_TAG_KEY)
      if (prior === tag) return
      window.localStorage.setItem(DISMISSED_TAG_KEY, tag)
      // Manually dispatch a storage event: the spec only fires `storage` in
      // OTHER tabs/windows, so without this the SAME-tab `useUpdateBadge`
      // would only see the change on its next poll. Mirror what the browser
      // would emit cross-tab.
      window.dispatchEvent(
        new StorageEvent('storage', {
          key: DISMISSED_TAG_KEY,
          oldValue: prior,
          newValue: tag,
          storageArea: window.localStorage,
        }),
      )
    } catch {
      // Disabled / quota: silent no-op; the badge will just stay until the
      // next fresh release.
    }
  }, [])
}
