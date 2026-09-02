/**
 * The sign-in comes back CONNECTED — the derivation, the copy, and the lane.
 * ─────────────────────────────────────────────────────────────────────────────
 * The owner signed in with InhouseSEO, approved the consent, landed back in
 * supermux — and the sheet showed its INITIAL state: "Choose who gets it first",
 * the bot list with nothing selected, and a second "Grant to" segment below it.
 * Nothing said he was connected, so he signed in again. And again. The server had
 * completed BOTH times (`connector.oauth.connected`, 32 tools).
 *
 * The cause was that the surface derived "connected" from its own React state,
 * seeded from the CURRENT SCOPE's grant set — and a brokered sign-in is the one
 * flow that leaves the page entirely, while a grant to a single bot is invisible
 * to the library scope. So this covers the replacement: a PURE derivation from
 * what the server says (`card.accounts`), the targets from the server's own grant
 * list, the honest return copy, and the lane that renders them.
 */
import { describe, expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'

import { ConnectFlow } from '../../src/components/store/connect-flow'
import {
  consumerTargets,
  oauthConnection,
  type ConnectorAccount,
  type ConnectorCard,
  type ConnectorConsumer,
} from '../../src/lib/api/connectors'
import {
  PENDING_LOST_COPY,
  completeFailedCopy,
  handleOauthReturn,
  type PendingStore,
} from '../../src/lib/oauth-pending'

const CARD: ConnectorCard = {
  id: 'pmcp-inhouseseo',
  kind: 'mcp_catalog',
  display_name: 'InhouseSEO',
  icon: '',
  description: 'SEO tools',
  tools: [],
  credentials: [],
  auth: { kind: 'mcp_oauth' },
  source: 'local',
}

function account(over: Partial<ConnectorAccount> = {}): ConnectorAccount {
  return {
    id: 'acct-1',
    account_label: 'sander@acme.com',
    status: 'active',
    has_secret: true,
    last_used_at: 0,
    health: 'ok',
    last_checked_at: 1_000,
    tool_count: 32,
    grant_level: { scope: 'bot', label: 'folderwijzer', count: 1 },
    ...over,
  }
}

describe('oauthConnection — the state comes from the server, not the tab', () => {
  test('no account at all is simply "Not connected"', () => {
    expect(oauthConnection(CARD).key).toBe('not_connected')
    expect(oauthConnection({ ...CARD, accounts: [] }).title).toBe('Not connected')
  })

  test('a live account names the identity AND the tools the probe really counted', () => {
    const c = oauthConnection({ ...CARD, accounts: [account()] })
    expect(c.key).toBe('connected')
    expect(c.title).toBe('Connected as sander@acme.com — 32 tools')
    expect(c.tone).toBe('active')
  })

  test('one tool is singular, and an uncounted account claims no number', () => {
    expect(oauthConnection({ ...CARD, accounts: [account({ tool_count: 1 })] }).title).toBe(
      'Connected as sander@acme.com — 1 tool',
    )
    // Never invented: no count stored ⇒ no count shown (not "0 tools").
    expect(oauthConnection({ ...CARD, accounts: [account({ tool_count: null })] }).title).toBe(
      'Connected as sander@acme.com',
    )
  })

  test('expired / disconnected / broken never read as connected', () => {
    expect(oauthConnection({ ...CARD, accounts: [account({ health: 'expired' })] }).key).toBe('needs_sign_in')
    expect(oauthConnection({ ...CARD, accounts: [account({ status: 'disconnected' })] }).key).toBe('needs_sign_in')
    const broken = oauthConnection({
      ...CARD,
      accounts: [account({ health: 'error', last_error: 'Server refused the token.' })],
    })
    expect(broken.key).toBe('broken')
    expect(broken.detail).toBe('Server refused the token.')
    expect(broken.tone).toBe('error')
  })

  test('an ACTIVE account wins over a stale disconnected one on the same card', () => {
    const c = oauthConnection({
      ...CARD,
      accounts: [account({ id: 'old', status: 'disconnected' }), account({ id: 'new' })],
    })
    expect(c.key).toBe('connected')
    expect(c.account?.id).toBe('new')
  })
})

describe('consumerTargets — who already holds it, per the server', () => {
  const consumers: ConnectorConsumer[] = [
    {
      scope: 'bot',
      label: 'folderwijzer',
      enabled: true,
      has_secret: true,
      account_ref: 'acct-1',
      account_label: 'sander@acme.com',
      granted_at: 1,
      session_name: 'folderwijzer',
    },
    { scope: 'company', label: 'Acme', enabled: true, has_secret: true, account_ref: null, account_label: null, granted_at: 2, company_id: 7 },
    { scope: 'all', label: 'All agents', enabled: true, has_secret: true, account_ref: null, account_label: null, granted_at: 3 },
  ]

  test('each scope maps onto the grant-target string the sheet uses', () => {
    expect(consumerTargets(consumers)).toEqual(['folderwijzer', '@company:7', '*'])
  })

  test('nothing granted, or nothing fetched yet, is an empty list', () => {
    expect(consumerTargets([])).toEqual([])
    expect(consumerTargets(undefined)).toEqual([])
  })

  test('the same bot twice (two accounts) is ONE target', () => {
    expect(consumerTargets([consumers[0], { ...consumers[0], account_ref: 'acct-2' }])).toEqual(['folderwijzer'])
  })
})

describe('the return copy is honest and always names the way out', () => {
  const store = (): PendingStore => {
    const map = new Map<string, string>()
    return {
      getItem: (k) => map.get(k) ?? null,
      setItem: (k, v) => void map.set(k, v),
      removeItem: (k) => void map.delete(k),
    }
  }

  test('a return with NO pending key says so, and says to sign in again', async () => {
    const said: string[] = []
    const outcome = await handleOauthReturn('?oauth_pending=1', {
      complete: async () => {
        throw new Error('must not be called without a pending key')
      },
      store: store(),
      toast: (m) => said.push(m),
      invalidate: () => {},
    })
    expect(outcome.kind).toBe('lost')
    expect(said).toEqual([PENDING_LOST_COPY])
    // Plain about WHAT happened and WHAT to do — never a silent reset.
    expect(PENDING_LOST_COPY).toContain('another tab')
    expect(PENDING_LOST_COPY).toContain('Sign in again')
  })

  test('a failing `complete` shows the reason and offers another go', () => {
    expect(completeFailedCopy('token endpoint refused')).toBe(
      "Couldn't finish the sign-in — token endpoint refused. Try again.",
    )
    expect(completeFailedCopy('')).toBe("Couldn't finish the sign-in — try again.")
    expect(completeFailedCopy(null)).toContain('try again')
  })
})

describe('<ConnectFlow> Lane D renders the state, and exactly one picker', () => {
  const picker = <div data-testid="grant-picker">Grant to</div>

  test('not connected: the picker, the sign-in button, and no terminal copy', () => {
    const html = renderToStaticMarkup(
      <ConnectFlow
        card={CARD}
        variant="store"
        onSubmit={async () => ({ restartHint: false })}
        oauthTarget="folderwijzer"
        oauthReturnTo="/store/pmcp-inhouseseo"
      >
        {picker}
      </ConnectFlow>,
    )
    expect(html).toContain('data-state="not_connected"')
    expect(html).toContain('Not connected')
    expect(html).toContain('grant-picker')
    expect(html).toContain('Sign in with InhouseSEO')
    expect(html).toContain("you&#x27;ll come straight back here")
    expect(html).not.toContain('terminal')
  })

  test('connected: the identity + the tools, and the picker is GONE', () => {
    const html = renderToStaticMarkup(
      <ConnectFlow
        card={{ ...CARD, accounts: [account()] }}
        variant="store"
        onSubmit={async () => ({ restartHint: false })}
        oauthTarget="folderwijzer"
        oauthReturnTo="/store/pmcp-inhouseseo"
        renderAddedExtra={() => <span data-testid="restart-slot">Restart folderwijzer to apply</span>}
      >
        {picker}
      </ConnectFlow>,
    )
    expect(html).toContain('data-state="connected"')
    expect(html).toContain('Connected as sander@acme.com — 32 tools')
    expect(html).not.toContain('grant-picker')
    // No second sign-in button competing with the connected state.
    expect(html).not.toContain('Sign in with InhouseSEO')
    expect(html).toContain('Restart folderwijzer to apply')
  })

  test('a dead account offers "Sign in again", and still no key field', () => {
    const html = renderToStaticMarkup(
      <ConnectFlow
        card={{ ...CARD, accounts: [account({ health: 'expired' })] }}
        variant="store"
        onSubmit={async () => ({ restartHint: false })}
        oauthTarget="folderwijzer"
        oauthReturnTo="/store/pmcp-inhouseseo"
      />,
    )
    expect(html).toContain('data-state="needs_sign_in"')
    expect(html).toContain('Sign in again with InhouseSEO')
    expect(html).not.toContain('<input')
  })
})
