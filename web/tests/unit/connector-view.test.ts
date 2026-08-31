/**
 * The Domain step's tunnel/connector decision — the pure half of the
 * "Connecting… forever, while nothing was running" bug.
 * ─────────────────────────────────────────────────────────────────────────────
 * Live evidence this pins: `provision-tunnel` answered `connector: "unavailable"`
 * (the box had no systemd user manager, so the connector unit could never start)
 * while the wizard, branching on `tunnel === 'connecting'` ALONE, showed a
 * spinner captioned "This runs the connector on your box and waits for
 * Cloudflare to report it healthy". Nothing was running, so nothing would ever
 * report healthy — the spinner was a claim, and it was false.
 *
 * The three states the step must keep apart:
 *   connecting — a connector IS up; Cloudflare just hasn't caught up. Spin.
 *   stalled    — Cloudflare says connecting, the box says nothing is running.
 *                Reason + retry, NEVER a spinner.
 *   connected  — healthy.
 */
import { describe, expect, test } from 'bun:test'

import { connectorLabel, connectorReason, tunnelSetupView } from '../../src/lib/connector-view'
import type { ConnectorStatus } from '../../src/lib/api/external-access'

const LIVE: ConnectorStatus = {
  running: true,
  via: 'child',
  pid: 4242,
  detail: 'supermux is running the connector',
}
const DEAD: ConnectorStatus = {
  running: false,
  via: 'none',
  detail: 'could not start /home/supermux/bin/cloudflared: No such file or directory',
}

describe('tunnelSetupView', () => {
  test('connecting WITH a live connector → the one honest spinner', () => {
    expect(tunnelSetupView({ tunnel: 'connecting', connector: LIVE })).toBe('connecting')
  })

  test('connecting with NO connector running → stalled, never a spinner', () => {
    const view = tunnelSetupView({ tunnel: 'connecting', connector: DEAD })
    expect(view).toBe('stalled')
    expect(view).not.toBe('connecting')
  })

  test('healthy → connected', () => {
    expect(tunnelSetupView({ tunnel: 'healthy', connector: LIVE })).toBe('connected')
    // Healthy is healthy even if the box has not (yet) reported a connector.
    expect(tunnelSetupView({ tunnel: 'healthy' })).toBe('connected')
  })

  test('not provisioned → idle (offer "Set up access")', () => {
    expect(tunnelSetupView({ tunnel: 'none', connector: null })).toBe('idle')
    expect(tunnelSetupView({ tunnel: 'none', connector: DEAD })).toBe('idle')
  })

  test('a provision call in flight is honestly working, whatever the box says', () => {
    expect(tunnelSetupView({ tunnel: 'none', connector: DEAD, provisionPending: true })).toBe(
      'connecting',
    )
  })

  test('an older server that reports no connector keeps the old optimistic spinner', () => {
    expect(tunnelSetupView({ tunnel: 'connecting' })).toBe('connecting')
    expect(tunnelSetupView({ tunnel: 'connecting', connector: null })).toBe('connecting')
  })
})

describe('connectorReason', () => {
  test('surfaces the box’s own reason verbatim', () => {
    expect(connectorReason(DEAD)).toContain('could not start')
  })

  test('never empty — "we could not tell" still beats a silent spinner', () => {
    expect(connectorReason(null).length).toBeGreaterThan(0)
    expect(connectorReason({ running: false, via: 'none', detail: '   ' }).length).toBeGreaterThan(0)
    expect(connectorReason(undefined)).toContain('could not tell')
  })
})

describe('connectorLabel', () => {
  test('says which connector is carrying the tunnel', () => {
    expect(connectorLabel(LIVE)).toContain('supermux is running')
    expect(connectorLabel({ running: true, via: 'adopted', pid: 7 })).toContain('already running')
  })

  test('claims nothing about a connector that is not running', () => {
    expect(connectorLabel(DEAD)).toBe('Connected')
  })
})
