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
    categories: ['featured', 'productivity'],
    stars: 8200,
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
    id: 'builtin-browser',
    kind: 'builtin_browser',
    display_name: 'Shared Browser',
    icon: '',
    description: 'A stealth browser your bots share — no sign-in needed, already built in.',
    tools: [],
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
