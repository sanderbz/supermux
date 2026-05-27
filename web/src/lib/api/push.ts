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

/** The four per-event toggles a user can flip independently. Mirrors the
 *  `NotifCategory` enum on the server — these strings are both the API field
 *  names AND the prefs storage key suffix, so renaming one is renaming both. */
export type NotifCategory =
  | 'agent_waiting'
  | 'agent_finished'
  | 'agent_stopped'
  | 'schedule_error'

/** `GET /api/push/prefs` response — every category's on/off state. The map is
 *  COMPLETE (server fills every key with a default when absent) so the UI never
 *  has to handle an undefined toggle. */
export type PushPrefs = Record<NotifCategory, boolean>

/** One row in the in-memory diagnostic ring (`GET /api/push/attempts`). The
 *  Settings "Recent activity" panel renders this list. Body / URL are
 *  intentionally NOT carried — they can hold prompt text we treat as
 *  ephemeral user data. */
export interface PushAttempt {
  at: number
  category: string
  title: string
  attempted: number
  delivered: number
  pruned: number
  failed: number
  muted: boolean
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

  /** POST `/api/push/test` — fire a test notification at every stored
   *  subscription. Returns the number of devices the push service accepted.
   *  `delivered: 0` immediately after a fresh enable points at the VAPID `sub`
   *  claim being rejected by the push service (notably APNs on iPhone). When
   *  `kind` is supplied the test goes through the per-category gate so a user
   *  can verify routing of (e.g.) `agent_finished` without waiting for a real
   *  agent to actually finish. */
  test: (kind?: NotifCategory): Promise<{ delivered: number }> =>
    settingsRequest(
      kind ? `/api/push/test?type=${encodeURIComponent(kind)}` : '/api/push/test',
      { method: 'POST' },
    ),

  /** GET `/api/push/prefs` — every category's current on/off state. */
  getPrefs: (): Promise<PushPrefs> => settingsRequest('/api/push/prefs'),

  /** PUT `/api/push/prefs` — partial update; pass only the categories you want
   *  to change. Unknown keys are a 400, so the API JSON and the server enum
   *  can never drift silently. */
  putPrefs: (patch: Partial<PushPrefs>): Promise<void> =>
    settingsRequest('/api/push/prefs', {
      method: 'PUT',
      body: JSON.stringify(patch),
    }),

  /** GET `/api/push/attempts` — newest-first ring of recent fan-outs. The
   *  "Recent activity" panel renders this so the user can answer "why didn't
   *  my phone ring?" without grepping logs. */
  getAttempts: (): Promise<PushAttempt[]> => settingsRequest('/api/push/attempts'),
}
