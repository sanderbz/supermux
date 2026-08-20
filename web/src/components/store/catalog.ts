// Store taxonomy + presentation helpers (client seed).
//
// The catalog itself is served by the foundation API (`GET /api/connectors`
// merges local rows with the PulseMCP mirror). This module is the CLIENT-side
// seed: the category taxonomy the chip rail renders, the label/order for each,
// the monogram-tile tint used when a card has no cached icon, and a tiny curated
// fallback set the dev mock renders when no server is behind the grid. No secret,
// no network — pure presentation.

import type { ConnectorCard } from '@/lib/api/connectors'

// ── category taxonomy (the chip rail) ─────────────────────────────────────────

export interface Category {
  /** The wire tag matched against a card's `categories[]` (or `featured`). */
  key: string
  label: string
}

/** Ordered categories. `all` is the resting filter; `featured` mirrors the hero
 *  rail. The rest match the coarse tags the catalog mirror assigns. */
export const CATEGORIES: Category[] = [
  { key: 'all', label: 'All' },
  { key: 'featured', label: 'Featured' },
  { key: 'productivity', label: 'Productivity' },
  { key: 'developer', label: 'Developer' },
  { key: 'communication', label: 'Communication' },
  { key: 'mail', label: 'Mail' },
  { key: 'browser', label: 'Browser' },
  { key: 'data', label: 'Data' },
  { key: 'finance', label: 'Finance' },
  { key: 'ai', label: 'AI' },
]

// ── monogram tile tint (icon fallback) ────────────────────────────────────────

/** Deterministic hue from a card id — so a connector's fallback tile keeps the
 *  same colour across renders. Grok/base neutral: one saturated accent per card,
 *  never the identity hue. */
export function monogramHue(id: string): number {
  let h = 0
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) % 360
  return h
}

/** The 1–2 char monogram for the fallback tile. */
export function monogram(name: string): string {
  const words = name.trim().split(/\s+/).filter(Boolean)
  if (words.length === 0) return '?'
  if (words.length === 1) return words[0].slice(0, 2).toUpperCase()
  return (words[0][0] + words[1][0]).toUpperCase()
}

// ── curated fallback (dev mock / cold API) ────────────────────────────────────
//
// A small, honest featured set the offline dev route renders so the grid has
// cards without a live catalog behind it. These are the same real MCP servers
// the server's curated featured list carries.

export const CURATED_FALLBACK: ConnectorCard[] = [
  {
    id: 'pmcp-github',
    kind: 'mcp_catalog',
    display_name: 'GitHub',
    icon: '',
    description: 'Code, issues, and pull requests — read and act on your repos right from your bot.',
    tools: [],
    credentials: [{ key: 'GITHUB_TOKEN', title: 'Personal access token', type: 'string', sensitive: true, required: true }],
    source: 'catalog',
    tool_count: 21,
    featured: true,
    hook: "The developer's home base — now your bot's.",
    categories: ['featured', 'developer'],
    stars: 24000,
  },
  {
    id: 'pmcp-notion',
    kind: 'mcp_catalog',
    display_name: 'Notion',
    icon: '',
    description: 'Docs, databases, and pages — let your bot read and update your Notion workspace.',
    tools: [],
    credentials: [{ key: 'NOTION_TOKEN', title: 'Integration token', type: 'string', sensitive: true, required: true }],
    source: 'catalog',
    tool_count: 12,
    featured: true,
    hook: "Your team's knowledge, in your bot's hands.",
    categories: ['featured', 'productivity'],
    stars: 8200,
  },
  {
    // Featured with NO editorial `hook` on purpose — mirrors the live curated
    // catalog (server cards ship no hook), so the hero must fall back to this
    // real description, never a generic "A featured finance connector." line.
    id: 'pmcp-stripe',
    kind: 'mcp_catalog',
    display_name: 'Stripe',
    icon: '',
    description: 'Query payments and customers and manage billing across your Stripe account.',
    tools: [],
    credentials: [],
    source: 'catalog',
    lucide: 'credit-card',
    featured: true,
    categories: ['featured', 'finance'],
  },
  {
    id: 'pmcp-paypal',
    kind: 'mcp_catalog',
    display_name: 'PayPal',
    icon: '',
    description: 'Create invoices and manage orders and payments in PayPal.',
    tools: [],
    credentials: [],
    source: 'catalog',
    lucide: 'wallet',
    categories: ['finance'],
  },
  {
    id: 'pmcp-plaid',
    kind: 'mcp_catalog',
    display_name: 'Plaid',
    icon: '',
    description: 'Access financial account and transaction data through Plaid.',
    tools: [],
    credentials: [],
    source: 'catalog',
    lucide: 'landmark',
    categories: ['finance'],
  },
  {
    id: 'pmcp-square',
    kind: 'mcp_catalog',
    display_name: 'Square',
    icon: '',
    description: 'Manage Square payments, catalog, orders, and customers.',
    tools: [],
    credentials: [],
    source: 'catalog',
    lucide: 'square',
    categories: ['finance'],
  },
  {
    id: 'pmcp-slack',
    kind: 'mcp_catalog',
    display_name: 'Slack',
    icon: '',
    description: 'Send messages, read channels, and react — keep your team in the loop from a bot.',
    tools: [],
    credentials: [{ key: 'SLACK_BOT_TOKEN', title: 'Bot token', type: 'string', sensitive: true, required: true }],
    source: 'catalog',
    tool_count: 7,
    featured: true,
    hook: "Where the team talks — put your bot in the room.",
    categories: ['featured', 'communication'],
    stars: 5100,
  },
  {
    id: 'pmcp-linear',
    kind: 'mcp_catalog',
    display_name: 'Linear',
    icon: '',
    description: 'Track issues and cycles — your bot files, updates, and closes Linear tickets.',
    tools: [],
    credentials: [{ key: 'LINEAR_API_KEY', title: 'API key', type: 'string', sensitive: true, required: true }],
    source: 'catalog',
    tool_count: 9,
    categories: ['productivity', 'developer'],
    stars: 3400,
  },
  {
    id: 'pmcp-postgres',
    kind: 'mcp_catalog',
    display_name: 'Postgres',
    icon: '',
    description: 'Query your database read-only — safe, schema-aware SQL from your bot.',
    tools: [],
    credentials: [{ key: 'DATABASE_URL', title: 'Connection string', type: 'string', sensitive: true, required: true }],
    source: 'catalog',
    tool_count: 4,
    categories: ['developer', 'data'],
    stars: 6800,
  },
  {
    id: 'icloud-mail',
    kind: 'agent_authored',
    display_name: 'iCloud Mail',
    icon: '',
    description: 'Read and send mail over IMAP/SMTP with an app-specific password.',
    tools: [
      { name: 'list_inbox', description: 'List recent messages' },
      { name: 'read_message', description: 'Read one message' },
      { name: 'send_message', description: 'Send a message' },
    ],
    credentials: [
      { key: 'ICLOUD_USER', title: 'iCloud address', type: 'string', sensitive: false, required: true },
      { key: 'ICLOUD_APP_PW', title: 'App-specific password', type: 'string', sensitive: true, required: true },
    ],
    source: 'local',
    categories: ['mail'],
  },
  {
    // MIRRORS the server's built-in card (`connectors::browser::mcp::manifest`):
    // same id, same five tools, same icon — so the offline fallback and the live
    // row are the same card, and a grant made against either lands on the real
    // connector.
    id: 'shared-browser',
    kind: 'builtin_browser',
    display_name: 'Shared Browser',
    icon: 'data:image/svg+xml;utf8,<svg xmlns=\'http://www.w3.org/2000/svg\' viewBox=\'0 0 24 24\' fill=\'none\' stroke=\'%230284c7\' stroke-width=\'1.7\' stroke-linecap=\'round\' stroke-linejoin=\'round\'><rect x=\'2.5\' y=\'4\' width=\'19\' height=\'16\' rx=\'2.5\'/><path d=\'M2.5 9h19\'/><circle cx=\'6\' cy=\'6.5\' r=\'.7\' fill=\'%230284c7\' stroke=\'none\'/><circle cx=\'8.6\' cy=\'6.5\' r=\'.7\' fill=\'%230284c7\' stroke=\'none\'/><path d=\'M8 13.5h8M8 16.5h5\'/></svg>',
    // Short on purpose: this is the OFFLINE fallback line. The live row carries
    // the server's full copy (and this gate counts every byte of the fallback).
    description:
      'One real Chrome, shared with your agents — and when a bot hits a login or 2FA it asks you to take the wheel.',
    tools: [
      { name: 'browser_navigate', description: 'Open a URL in the shared browser and wait for it to load.' },
      { name: 'browser_click', description: 'Click an element (CSS selector) or viewport coordinates.' },
      { name: 'browser_read', description: 'Read the page — visible text or HTML, whole page or one element.' },
      { name: 'browser_screenshot', description: 'See the viewport as an image.' },
      {
        name: 'request_human_takeover',
        description: 'Ask the human to take the wheel (login, 2FA, CAPTCHA) and wait for the hand-back.',
      },
    ],
    credentials: [],
    source: 'local',
    categories: ['browser'],
  },
  {
    id: 'pmcp-playwright',
    kind: 'mcp_catalog',
    display_name: 'Playwright',
    icon: '',
    description: 'Drive a real browser — click, type, and screenshot pages programmatically.',
    tools: [],
    credentials: [],
    source: 'catalog',
    tool_count: 15,
    categories: ['browser', 'developer'],
    stars: 9900,
  },
]
