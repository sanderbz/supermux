// DEV-only mock for the connector store's Installed tab (`/?mock`). Seeds the
// grid cache with LOCAL (installed) connectors carrying connected `accounts`, so
// `/store → Installed` renders offline — including a connector with TWO accounts
// (Notion), which shows two rows. Never bundled into production: imported only by
// `useDevMockSeed` behind the `import.meta.env.DEV` + `?mock` guard.

import type { ConnectorCard, ConnectorConsumer } from '@/lib/api/connectors'
import { CURATED_FALLBACK } from './catalog'

const NOW = Math.floor(Date.now() / 1000)
const MINUTES = 60
const HOURS = 60 * MINUTES
const DAYS = 24 * HOURS

/** Spread a curated card into an INSTALLED (local) row, overriding fields. */
function local(id: string, patch: Partial<ConnectorCard>): ConnectorCard {
  const base = CURATED_FALLBACK.find((c) => c.id === id)
  if (!base) throw new Error(`mock: no curated card '${id}'`)
  return { ...base, ...patch, source: 'local' }
}

// The four installed connectors — Notion (2 accounts), Slack (2, one signed-out),
// iCloud Mail (1, granted to several bots), Shared Browser (built-in, no account).
export const MOCK_INSTALLED_CONNECTORS: ConnectorCard[] = [
  local('pmcp-notion', {
    accounts: [
      {
        id: 'acc-notion-1',
        account_label: 'sander@acme.com',
        status: 'active',
        has_secret: true,
        last_used_at: NOW - 3 * MINUTES,
        health: 'ok',
        last_checked_at: NOW - 2 * MINUTES,
        grant_level: { scope: 'all', label: 'All agents', count: 1 },
      },
      {
        id: 'acc-notion-2',
        account_label: 'team@globex.com',
        status: 'active',
        has_secret: true,
        last_used_at: NOW - 30 * HOURS,
        health: null,
        grant_level: { scope: 'company', label: 'Globex', count: 1, company_id: 2 },
      },
    ],
  }),
  local('pmcp-slack', {
    accounts: [
      {
        id: 'acc-slack-1',
        account_label: 'eng@acme.com',
        status: 'active',
        has_secret: true,
        last_used_at: NOW - 10 * MINUTES,
        // A tested-broken account reads Error (red) — never Active.
        health: 'error',
        last_checked_at: NOW - 1 * HOURS,
        last_error: "Couldn't reach the endpoint — check the URL and the network.",
        grant_level: { scope: 'bot', label: 'Web App', count: 1 },
      },
      {
        id: 'acc-slack-2',
        account_label: 'ops@acme.com',
        status: 'disconnected',
        has_secret: true,
        last_used_at: NOW - 3 * DAYS,
        health: null,
        grant_level: { scope: 'none', label: 'Not granted', count: 0 },
      },
    ],
  }),
  local('icloud-mail', {
    // The iCloud address is the account's identity — flag it so the Add-account
    // form derives the label from it (mirrors the server's `identity:true`).
    credentials: [
      { key: 'ICLOUD_USER', title: 'iCloud address', type: 'string', sensitive: false, required: true, identity: true },
      { key: 'ICLOUD_APP_PW', title: 'App-specific password', type: 'string', sensitive: true, required: true },
    ],
    accounts: [
      {
        id: 'acc-icloud-1',
        account_label: 'sander@icloud.com',
        status: 'active',
        has_secret: true,
        last_used_at: NOW - 40,
        // An expired app-specific password reads Expired (amber) — never Active.
        health: 'expired',
        last_checked_at: NOW - 15 * MINUTES,
        last_error: 'iCloud rejected the app-specific password — regenerate it at appleid.apple.com and reconnect.',
        grant_level: { scope: 'bots', label: '3 agents', count: 3 },
      },
    ],
  }),
  local('shared-browser', { accounts: [] }),
]

// The consumers (blast-radius) each connector's detail shows.
export const MOCK_CONNECTOR_CONSUMERS: Record<string, ConnectorConsumer[]> = {
  'pmcp-notion': [
    {
      scope: 'all',
      label: 'All agents',
      enabled: true,
      has_secret: true,
      account_ref: 'acc-notion-1',
      account_label: 'sander@acme.com',
      granted_at: NOW - 5 * DAYS,
    },
    {
      scope: 'company',
      company_id: 2,
      slug: 'globex',
      label: 'Globex',
      enabled: true,
      has_secret: true,
      account_ref: 'acc-notion-2',
      account_label: 'team@globex.com',
      granted_at: NOW - 2 * DAYS,
    },
  ],
  'pmcp-slack': [
    {
      scope: 'bot',
      session_name: 'web-app',
      label: 'Web App',
      enabled: true,
      has_secret: true,
      account_ref: 'acc-slack-1',
      account_label: 'eng@acme.com',
      granted_at: NOW - 1 * DAYS,
    },
  ],
  'icloud-mail': [
    {
      scope: 'bot',
      session_name: 'api-server',
      label: 'API Server',
      enabled: true,
      has_secret: true,
      account_ref: 'acc-icloud-1',
      account_label: 'sander@icloud.com',
      granted_at: NOW - 4 * DAYS,
    },
    {
      scope: 'bot',
      session_name: 'docs-writer',
      label: 'Docs Writer',
      enabled: true,
      has_secret: true,
      account_ref: 'acc-icloud-1',
      account_label: 'sander@icloud.com',
      granted_at: NOW - 3 * DAYS,
    },
    {
      scope: 'bot',
      session_name: 'cso-review',
      label: 'CSO Review',
      enabled: false,
      has_secret: true,
      account_ref: 'acc-icloud-1',
      account_label: 'sander@icloud.com',
      granted_at: NOW - 2 * DAYS,
    },
  ],
}

// The merged `{}` grid the `/store` page reads: the installed rows (with accounts)
// plus the rest of the curated catalog (so Browse still looks full). Installed
// ids win, so Notion/Slack/iCloud/Browser render as their local, account-carrying
// selves rather than the catalog mirror.
const INSTALLED_IDS = new Set(MOCK_INSTALLED_CONNECTORS.map((c) => c.id))
export const MOCK_STORE_CARDS: ConnectorCard[] = [
  ...MOCK_INSTALLED_CONNECTORS,
  ...CURATED_FALLBACK.filter((c) => !INSTALLED_IDS.has(c.id)),
]
