/**
 * The IN-CHAT half of the brokered sign-in: no picker, and it comes back
 * resolved.
 * ─────────────────────────────────────────────────────────────────────────────
 * From a bot's own Connect card the grant target is settled — it is THAT bot — so
 * the card must never show a "Grant to" step, and after the sign-in's redirect it
 * must read "Connected as …" with the one-tap restart, not "Connect <name>" all
 * over again.
 *
 * Structure is asserted against the source text because this suite has no DOM,
 * and because the ConnectCard mounts `<ConnectFlow>` through `React.lazy` —
 * `renderToStaticMarkup` resolves the Suspense fallback, not the lane. The lane's
 * own rendering is exercised directly, in the chat variant, below. (The full
 * round trip in a real browser is `tests/e2e/smoke/connector-oauth-signin.spec.ts`;
 * raising a live in-chat card needs a credentialed Claude agent, which the smoke
 * suite deliberately cannot run.)
 */
import { readFileSync } from 'node:fs'

import { describe, expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'

import { ConnectFlow } from '../../src/components/store/connect-flow'
import type { ConnectorAccount, ConnectorCard } from '../../src/lib/api/connectors'

const code = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
const CARD_SRC = code(readFileSync(new URL('../../src/components/chat/ui/connect-card.tsx', import.meta.url), 'utf8'))

const card = (accounts?: ConnectorAccount[]): ConnectorCard => ({
  id: 'pmcp-inhouseseo',
  kind: 'mcp_catalog',
  display_name: 'InhouseSEO',
  icon: '',
  description: '',
  tools: [],
  credentials: [],
  auth: { kind: 'mcp_oauth' },
  source: 'local',
  accounts,
})

const live: ConnectorAccount = {
  id: 'acct-1',
  account_label: 'owner@mock.test',
  status: 'active',
  has_secret: true,
  last_used_at: 0,
  health: 'ok',
  last_checked_at: 10,
  tool_count: 2,
  grant_level: { scope: 'bot', label: 'folderwijzer', count: 1 },
}

describe('the chat lane has no picker and one action', () => {
  test('not connected: the sign-in button, no grant step, no key field', () => {
    const html = renderToStaticMarkup(
      <ConnectFlow
        card={card()}
        variant="chat"
        onSubmit={async () => ({ restartHint: false })}
        oauthTarget="folderwijzer"
        oauthReturnTo="/focus/folderwijzer"
      />,
    )
    expect(html).toContain('data-state="not_connected"')
    expect(html).toContain('Sign in with InhouseSEO')
    expect(html).not.toContain('Grant to')
    expect(html).not.toContain('<input')
    expect(html).not.toContain('terminal')
  })

  test('connected: the identity, the tools, and the one-tap restart', () => {
    const html = renderToStaticMarkup(
      <ConnectFlow
        card={card([live])}
        variant="chat"
        onSubmit={async () => ({ restartHint: false })}
        oauthTarget="folderwijzer"
        oauthReturnTo="/focus/folderwijzer"
        renderAddedExtra={() => <button type="button">Restart folderwijzer to apply</button>}
      />,
    )
    expect(html).toContain('data-state="connected"')
    expect(html).toContain('Connected as owner@mock.test — 2 tools')
    expect(html).toContain('Restart folderwijzer to apply')
    expect(html).not.toContain('Sign in with InhouseSEO')
  })
})

describe('the ConnectCard wires the bot as the fixed target', () => {
  test('the grant target is the session, and no picker is ever passed down', () => {
    expect(CARD_SRC).toContain('oauthTarget={oauthReturnTo ? sessionName : undefined}')
    // <ConnectFlow> renders a picker only from `children`; the chat card passes
    // none, which is what makes "no picker in chat" structural rather than styled.
    expect(CARD_SRC).not.toMatch(/<ConnectFlow[\s\S]*?>[\s\S]*?<\/ConnectFlow>/)
  })

  test('"added" is derived from the SERVER, so a redirect cannot un-connect it', () => {
    expect(CARD_SRC).toContain('oauthConnection(effectiveCard)')
    expect(CARD_SRC).toContain('added || connected')
    // The restart affordance is the shared one, not a second implementation.
    expect(CARD_SRC).toContain('RestartIfNeeded')
  })
})
