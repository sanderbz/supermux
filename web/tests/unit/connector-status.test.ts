/**
 * `connectorStatus()` — the ONE honest chip helper (design §5.2 / §4.3).
 * ─────────────────────────────────────────────────────────────────────────────
 * Every surface reads a bot's connector state through this table, so the rules
 * that keep a dead connection from reading green live in one place:
 *   · expired / disconnected / error NEVER render green (`needs_sign_in` / `broken`);
 *   · green comes only from a probe (`health === 'ok'` + a `last_checked_at`),
 *     never from the mere existence of a grant row (→ `not_verified`);
 *   · `applied: false` on a RUNNING bot is `restart` — the server-computed chip
 *     that survives the sign-in's full-page redirect;
 *   · a running bot whose brokered token was minted > 20 h ago is `stale`;
 *   · `mcp_oauth` with no sealed token is `needs_sign_in` (it used to be a false
 *     green "Active" — supermux holds the token now).
 */
import { describe, expect, test } from 'bun:test'

import {
  STALE_AFTER_SECS,
  ageLabel,
  connectorNeedsCredential,
  connectorStatus,
  type AuthKind,
  type ConnectorCard,
} from '../../src/lib/api/connectors'

const NOW = 1_800_000_000

function card(kind: AuthKind): ConnectorCard {
  return { id: 'pmcp-inhouseseo', kind: 'mcp_catalog', display_name: 'InhouseSEO', icon: '', description: '', tools: [], credentials: [], auth: { kind }, source: 'local' }
}

const okAccount = (over: Record<string, unknown> = {}) => ({
  status: 'active',
  health: 'ok',
  last_checked_at: NOW - 60,
  last_used_at: NOW - 3600,
  account_label: 'owner@test',
  has_secret: true,
  ...over,
})

describe('connectorStatus — the honest table', () => {
  test('no grant → not_added; a pending hop → connecting', () => {
    expect(connectorStatus(card('mcp_oauth'), { now: NOW }).key).toBe('not_added')
    expect(connectorStatus(card('mcp_oauth'), { connecting: true, now: NOW }).key).toBe('connecting')
  })

  test('mcp_oauth with no sealed token is Needs sign-in, never green', () => {
    const s = connectorStatus(card('mcp_oauth'), { grant: { has_secret: false, enabled: true }, now: NOW })
    expect(s.key).toBe('needs_sign_in')
    expect(s.tone).not.toBe('active')
    // …and the lane now counts as "needs a credential from you".
    expect(connectorNeedsCredential(card('mcp_oauth'))).toBe(true)
  })

  test('expired / disconnected / error never render green', () => {
    const grant = { has_secret: true, enabled: true, applied: true, running: true }
    for (const account of [okAccount({ health: 'expired' }), okAccount({ status: 'disconnected' })]) {
      const s = connectorStatus(card('mcp_oauth'), { grant, account, now: NOW })
      expect(s.key).toBe('needs_sign_in')
      expect(s.tone).not.toBe('active')
    }
    const broken = connectorStatus(card('mcp_oauth'), { grant, account: okAccount({ health: 'error' }), now: NOW })
    expect(broken.key).toBe('broken')
    expect(broken.tone).toBe('error')
  })

  test('green only from a probe: an untested grant is not_verified', () => {
    const grant = { has_secret: true, enabled: true, applied: true, running: false }
    const s = connectorStatus(card('mcp_oauth'), { grant, account: okAccount({ health: null, last_checked_at: 0 }), now: NOW })
    expect(s.key).toBe('not_verified')
    expect(s.tone).toBe('muted')
    const ok = connectorStatus(card('mcp_oauth'), { grant, account: okAccount(), now: NOW })
    expect(ok.key).toBe('connected')
    expect(ok.label).toBe('Connected as owner@test')
    expect(ok.tone).toBe('active')
  })

  test('applied=false on a RUNNING bot → restart; on a stopped bot nothing to do', () => {
    const acct = okAccount()
    expect(connectorStatus(card('mcp_oauth'), { grant: { has_secret: true, enabled: true, applied: false, running: true }, account: acct, now: NOW }).key).toBe('restart')
    expect(connectorStatus(card('mcp_oauth'), { grant: { has_secret: true, enabled: true, applied: false, running: false }, account: acct, now: NOW }).key).toBe('connected')
    expect(connectorStatus(card('api_key'), { grant: { has_secret: true, enabled: true, applied: false, running: true }, account: acct, now: NOW }).key).toBe('restart')
  })

  test('a running bot whose token is 26h old is stale, 2h old is connected-with-age', () => {
    const grant = { has_secret: true, enabled: true, applied: true, running: true }
    const stale = connectorStatus(card('mcp_oauth'), { grant, account: okAccount({ last_used_at: NOW - 26 * 3600 }), now: NOW })
    expect(stale.key).toBe('stale')
    expect(stale.tone).toBe('warn')
    expect(stale.label).toContain('signed in at start')
    const fresh = connectorStatus(card('mcp_oauth'), { grant, account: okAccount({ last_used_at: NOW - 2 * 3600 }), now: NOW })
    expect(fresh.key).toBe('connected')
    expect(fresh.label).toBe('Connected · signed in at start, 2h ago')
    expect(STALE_AFTER_SECS).toBe(20 * 3600)
  })

  test('a none lane is Ready; a disabled grant is Disabled', () => {
    expect(connectorStatus(card('none'), { grant: { has_secret: false, enabled: true }, now: NOW }).key).toBe('ready')
    expect(connectorStatus(card('none'), { grant: { has_secret: false, enabled: false }, now: NOW }).key).toBe('disabled')
  })

  test('ageLabel is coarse and never negative', () => {
    expect(ageLabel(-5)).toBe('just now')
    expect(ageLabel(90)).toBe('1m ago')
    expect(ageLabel(7200)).toBe('2h ago')
    expect(ageLabel(3 * 86400)).toBe('3d ago')
  })
})
