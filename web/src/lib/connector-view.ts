// The Domain step's "is external access actually coming up?" decision, kept out
// of the wizard's JSX so it is testable without a DOM.
//
// WHY this file exists: the step branched on `tunnel === 'connecting'` ALONE and
// rendered a spinner reading "Connecting… setting up the tunnel · This runs the
// connector on your box and waits for Cloudflare to report it healthy". On a
// server install that spinner ran FOREVER: `provision` had returned
// `connector: "unavailable"` with a reason, no connector process existed, and
// Cloudflare was never going to report a tunnel healthy with nothing connected
// to it. The spinner was a claim ("this runs the connector") that was false.
//
// `box_status.connector` now carries the truth from the box, so the step can
// separate "connecting, and something is genuinely connecting" from "connecting,
// with nothing running" — which is a failure that needs a reason and a retry.

import type { ConnectorStatus } from './api/external-access'

/** What the Domain step should render for the tunnel/connector pair.
 *  - `idle`       — not provisioned yet; offer "Set up access".
 *  - `connecting` — a connector IS running (or a provision call is in flight)
 *    and Cloudflare has not reported healthy yet. The only honest spinner.
 *  - `stalled`    — Cloudflare says "connecting" but NO connector is running on
 *    the box. Say what happened, show the reason, offer a retry. NEVER a spinner.
 *  - `connected`  — Cloudflare reports the tunnel healthy. */
export type TunnelSetupView = 'idle' | 'connecting' | 'stalled' | 'connected'

export interface TunnelSetupInput {
  /** `box_status.tunnel`: `none` | `connecting` | `healthy`. */
  tunnel: string
  /** `box_status.connector` — absent on an older server, which is the ONLY case
   *  that still falls back to the old optimistic spinner. */
  connector?: ConnectorStatus | null
  /** A `provision-tunnel` POST is in flight. */
  provisionPending?: boolean
}

export function tunnelSetupView({
  tunnel,
  connector,
  provisionPending = false,
}: TunnelSetupInput): TunnelSetupView {
  // A call in flight is honestly "working" — we are mid-request, not mid-lie.
  if (provisionPending) return 'connecting'
  if (tunnel === 'healthy') return 'connected'
  if (tunnel !== 'connecting') return 'idle'
  // Cloudflare has a tunnel that is not healthy. Whether that is "coming up" or
  // "nothing is running" is a question only the box can answer.
  if (connector && !connector.running) return 'stalled'
  return 'connecting'
}

/** The sentence to show for a connector that is NOT running. Always non-empty:
 *  "we don't know" is itself an answer, and better than a spinner. */
export function connectorReason(connector?: ConnectorStatus | null): string {
  const detail = connector?.detail?.trim()
  if (detail) return detail
  return 'supermux could not tell what happened to the connector on this box.'
}

/** The done-chip label — says WHICH connector is carrying the tunnel, because
 *  "adopted" (a cloudflared already running on the box) is a different fact from
 *  "supermux is running it" and the owner is the one who has to know. */
export function connectorLabel(connector?: ConnectorStatus | null): string {
  if (!connector?.running) return 'Connected'
  if (connector.via === 'adopted') {
    return 'Connected · using the connector already running on this box'
  }
  return 'Connected · supermux is running the connector'
}
