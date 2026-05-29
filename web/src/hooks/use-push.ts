// Web push subscription hook.
//
// Owns the "Enable phone notifications" lifecycle for the Settings toggle:
//   - support detection (SW + PushManager + Notification; iOS needs the PWA
//     installed to the home screen, which is handled gracefully — `unsupported`)
//   - permission state (default / granted / denied → blocked)
//   - subscribe: request permission → serviceWorker.ready →
//     pushManager.subscribe({ userVisibleOnly, applicationServerKey }) → POST
//     /api/push/subscribe
//   - unsubscribe: PushSubscription.unsubscribe() + POST /api/push/unsubscribe
//
// The VAPID public key comes from GET /api/push/key. Subscription objects are
// user data and are never logged.

import * as React from 'react'

import { pushApi, type PushSubscriptionJSON } from '@/lib/api'

/** The toggle's externally-visible state. */
export type PushState =
  | 'unsupported' // no SW / PushManager / Notification (e.g. iOS Safari not installed)
  | 'loading' // resolving the initial subscription/permission state
  | 'enabled' // subscribed + permission granted
  | 'disabled' // supported, permission not denied, not subscribed
  | 'blocked' // Notification.permission === 'denied'

interface UsePush {
  state: PushState
  /** True while an enable/disable round-trip is in flight. */
  busy: boolean
  /** Last error message (e.g. subscribe failed), or null. */
  error: string | null
  enable: () => Promise<void>
  disable: () => Promise<void>
}

/** True when the runtime can actually do web push. */
function isSupported(): boolean {
  return (
    typeof navigator !== 'undefined' &&
    'serviceWorker' in navigator &&
    typeof window !== 'undefined' &&
    'PushManager' in window &&
    'Notification' in window
  )
}

/** Convert the base64url VAPID public key to the `ArrayBuffer` PushManager wants
 *  for `applicationServerKey` (a plain `ArrayBuffer`-backed `BufferSource`). */
function urlBase64ToBuffer(base64: string): ArrayBuffer {
  const padding = '='.repeat((4 - (base64.length % 4)) % 4)
  const normalized = (base64 + padding).replace(/-/g, '+').replace(/_/g, '/')
  const raw = atob(normalized)
  const buffer = new ArrayBuffer(raw.length)
  const view = new Uint8Array(buffer)
  for (let i = 0; i < raw.length; i++) view[i] = raw.charCodeAt(i)
  return buffer
}

export function usePush(): UsePush {
  const supported = React.useMemo(() => isSupported(), [])
  const [state, setState] = React.useState<PushState>(
    supported ? 'loading' : 'unsupported',
  )
  const [busy, setBusy] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)

  // Resolve the initial state: a denied permission is `blocked`; otherwise we
  // check for an existing browser subscription to decide enabled vs disabled.
  React.useEffect(() => {
    if (!supported) return
    let cancelled = false
    ;(async () => {
      try {
        if (Notification.permission === 'denied') {
          if (!cancelled) setState('blocked')
          return
        }
        const reg = await navigator.serviceWorker.ready
        const sub = await reg.pushManager.getSubscription()
        if (cancelled) return
        setState(sub && Notification.permission === 'granted' ? 'enabled' : 'disabled')
      } catch {
        if (!cancelled) setState('disabled')
      }
    })()
    return () => {
      cancelled = true
    }
  }, [supported])

  const enable = React.useCallback(async () => {
    if (!supported || busy) return
    setBusy(true)
    setError(null)
    try {
      // 1. Permission. Must be driven by a user gesture (the toggle tap).
      const permission = await Notification.requestPermission()
      if (permission !== 'granted') {
        setState(permission === 'denied' ? 'blocked' : 'disabled')
        return
      }
      // 2. VAPID public key from the server.
      const { key } = await pushApi.getKey()
      if (!key) {
        setError('Push is not configured on the server.')
        setState('disabled')
        return
      }
      // 3. Subscribe via the service worker's PushManager.
      const reg = await navigator.serviceWorker.ready
      let sub = await reg.pushManager.getSubscription()
      if (!sub) {
        sub = await reg.pushManager.subscribe({
          userVisibleOnly: true,
          applicationServerKey: urlBase64ToBuffer(key),
        })
      }
      // 4. Persist on the server (PushSubscription.toJSON() → {endpoint,keys}).
      await pushApi.subscribe(sub.toJSON() as PushSubscriptionJSON)
      setState('enabled')
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not enable notifications.')
      // Re-derive a best-effort state rather than leaving it stuck.
      setState(Notification.permission === 'denied' ? 'blocked' : 'disabled')
    } finally {
      setBusy(false)
    }
  }, [supported, busy])

  const disable = React.useCallback(async () => {
    if (!supported || busy) return
    setBusy(true)
    setError(null)
    try {
      const reg = await navigator.serviceWorker.ready
      const sub = await reg.pushManager.getSubscription()
      if (sub) {
        const endpoint = sub.endpoint
        await sub.unsubscribe().catch(() => {
          /* already gone client-side — still drop it server-side below */
        })
        await pushApi.unsubscribe(endpoint).catch(() => {
          /* server prune is best-effort — the client is already unsubscribed */
        })
      }
      setState('disabled')
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not disable notifications.')
    } finally {
      setBusy(false)
    }
  }, [supported, busy])

  return { state, busy, error, enable, disable }
}
