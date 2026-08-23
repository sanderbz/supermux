/**
 * The connector AUTH-LANE helpers — the logic that replaced the `OAUTH_BRANDS`
 * brand-name regex (connect flow P0+P1).
 * ─────────────────────────────────────────────────────────────────────────────
 * These three pure functions decide which card the connect flow renders, and each
 * encodes a bug the descriptor fixes:
 *   · `connectorHasOAuth`      — a "Sign in with X" primary shows ONLY for the real
 *     OAuth lanes, NOT for `mcp_oauth` (terminal note) and NOT for `api_key`.
 *   · `connectorNeedsCredential` — a missing secret is an honest "Needs sign-in"
 *     ONLY for the paste/OAuth lanes; `none` needs nothing and `mcp_oauth` signs in
 *     in the terminal (so neither is a false "Needs sign-in" / false green).
 *   · `connectorAuthKind`      — reads the server descriptor, and DERIVES from the
 *     credential schema when a payload predates it (never a blind generic dialog).
 */
import { describe, expect, test } from 'bun:test'

import {
  connectorAuthKind,
  connectorHasOAuth,
  connectorNeedsCredential,
  type AuthKind,
  type ConnectorCard,
  type CredentialField,
} from '../../src/lib/api/connectors'

function card(auth: { kind: AuthKind } | null, credentials: CredentialField[] = []): ConnectorCard {
  return {
    id: 'x',
    kind: 'mcp_catalog',
    display_name: 'X',
    icon: '',
    description: '',
    tools: [],
    credentials,
    auth,
    source: 'catalog',
  }
}

describe('connectorAuthKind', () => {
  test('reads the server descriptor', () => {
    expect(connectorAuthKind(card({ kind: 'mcp_oauth' }))).toBe('mcp_oauth')
    expect(connectorAuthKind(card({ kind: 'api_key' }))).toBe('api_key')
    expect(connectorAuthKind(card({ kind: 'none' }))).toBe('none')
  })

  test('derives from the schema when the descriptor is absent / unspecified', () => {
    // A lone secret → api_key; identity(non-secret) + secret → form; nothing → none.
    expect(connectorAuthKind(card(null, [{ key: 'TOKEN', sensitive: true }]))).toBe('api_key')
    expect(
      connectorAuthKind(
        card({ kind: 'unspecified' }, [
          { key: 'EMAIL', sensitive: false, identity: true },
          { key: 'PW', sensitive: true },
        ]),
      ),
    ).toBe('form')
    expect(connectorAuthKind(card(null, []))).toBe('none')
  })
})

describe('connectorHasOAuth — the "Sign in with X" primary', () => {
  test('true ONLY for the supermux-driven OAuth lanes', () => {
    expect(connectorHasOAuth(card({ kind: 'oauth_device' }))).toBe(true)
    expect(connectorHasOAuth(card({ kind: 'oauth_redirect' }))).toBe(true)
  })
  test('false for mcp_oauth (terminal note), api_key, form and none', () => {
    // The Slack bug: a hosted mcp_oauth must NOT lead with a fake sign-in button.
    expect(connectorHasOAuth(card({ kind: 'mcp_oauth' }))).toBe(false)
    expect(connectorHasOAuth(card({ kind: 'api_key' }))).toBe(false)
    expect(connectorHasOAuth(card({ kind: 'form' }))).toBe(false)
    expect(connectorHasOAuth(card({ kind: 'none' }))).toBe(false)
  })
})

describe('connectorNeedsCredential — the honest "Needs sign-in"', () => {
  test('true for the paste + OAuth lanes', () => {
    expect(connectorNeedsCredential(card({ kind: 'api_key' }))).toBe(true)
    expect(connectorNeedsCredential(card({ kind: 'form' }))).toBe(true)
    expect(connectorNeedsCredential(card({ kind: 'oauth_device' }))).toBe(true)
  })
  test('false for none (no auth) and mcp_oauth (signs in in the terminal)', () => {
    // The false-green fix: a hosted mcp_oauth without a vaulted secret is NOT a
    // "Needs sign-in" that implies a paste, and `none` needs nothing at all.
    expect(connectorNeedsCredential(card({ kind: 'none' }))).toBe(false)
    expect(connectorNeedsCredential(card({ kind: 'mcp_oauth' }))).toBe(false)
  })
})
