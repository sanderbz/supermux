// Web push API client (PUSH milestone — spec TRACK 2 §3).
//
// Talks to the bearer-gated `/api/push/*` endpoints. The dashboard bearer token
// is read from `window._SUPERMUX_AUTH_TOKEN` at call time (via the shared
// `settingsRequest` in ./client) — never hard-coded here. Subscription objects
// are user data; they are sent to the server but never logged.

import { settingsRequest } from './client'

/** `GET /api/push/key` response — the VAPID public key + whether any device is
 *  currently subscribed (drives the Settings toggle's initial state). `key` is
 *  empty when the server could not load/generate a VAPID keypair (push off). */
export interface PushKeyInfo {
  key: string
  subscribed: boolean
}

/** The browser `PushSubscription.toJSON()` shape the server stores. */
export interface PushSubscriptionJSON {
  endpoint: string
  keys: { p256dh: string; auth: string }
}

export const pushApi = {
  /** GET `/api/push/key` — VAPID public key + subscribed flag. */
  getKey: (): Promise<PushKeyInfo> => settingsRequest('/api/push/key'),

  /** POST `/api/push/subscribe` — store a browser PushSubscription. */
  subscribe: (sub: PushSubscriptionJSON): Promise<void> =>
    settingsRequest('/api/push/subscribe', {
      method: 'POST',
      body: JSON.stringify(sub),
    }),

  /** POST `/api/push/unsubscribe` — remove a subscription by endpoint. */
  unsubscribe: (endpoint: string): Promise<void> =>
    settingsRequest('/api/push/unsubscribe', {
      method: 'POST',
      body: JSON.stringify({ endpoint }),
    }),
}
