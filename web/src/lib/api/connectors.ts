// Connector-store client — the foundation API (server `connectors::api`).
//
// Nine secret-free endpoints: the merged store grid (local rows + the PulseMCP
// catalog mirror), one card, manifest upsert / `.mcpb` import / delete, the
// WRITE-ONLY credential→vault write, per-session grant / revoke, and a session's
// applied grants. Built on `settingsRequest<T>` (client.ts) — the same envelope
// helper every sibling client uses.
//
// SECRET HYGIENE (load-bearing): a credential VALUE is only ever SENT (in
// `putCredential`); it never comes back. The server echoes masked field KEYS
// (`"••••••"`) and a `secret_ref`, never a value. Nothing here reads a secret.

import { settingsRequest } from './client'

// ── card / schema shapes (mirror server `connectors::api::card`) ──────────────

/** One declared tool on a connector card. */
export interface ConnectorTool {
  name: string
  description?: string
}

/** One credential field — the `.mcpb` `user_config` vocabulary. `key` doubles as
 *  the env-var name the emit block references and the vault field-map key. A
 *  `sensitive` field is the secure paste; a non-sensitive one is a plain input. */
export interface CredentialField {
  key: string
  title?: string
  /** JSON-schema-ish primitive: `string` | `number` | `boolean` | `directory` … */
  type?: string
  sensitive?: boolean
  required?: boolean
  default?: unknown
  /** This NON-secret field's value doubles as the connected-account label (e.g.
   *  `ICLOUD_EMAIL` → `sander@icloud.com`). The server derives the account_label
   *  from it when no explicit label is sent. A `sensitive` field is never treated
   *  as identity (secret hygiene), even if mis-flagged. */
  identity?: boolean
}

/** Connector kind (mirrors `connectors.kind`). */
export type ConnectorKind =
  | 'mcp_catalog'
  | 'agent_authored'
  | 'builtin_browser'
  | string

/** The single-chip summary of an account's grants (server `grant_level`). The
 *  broadest tier wins: `all` > a lone `company`/`bot` > same-company > `bots`
 *  ("N agents"). `none` = the account exists but feeds no visible grant. */
export interface GrantLevel {
  scope: 'all' | 'company' | 'bot' | 'bots' | 'none'
  label: string
  count: number
  /** Present when `scope === 'company'` (drives the `CompanyMark` hue lookup). */
  company_id?: number | null
}

/** A connected ACCOUNT on a local connector (multi-account, migration 0035). Each
 *  carries its own display identity, lifecycle status, and grant-level summary.
 *  Secret-free: `has_secret` is a boolean, the sealed value never rides here. A
 *  member only receives accounts they hold a visible grant for (identity privacy). */
export interface ConnectorAccount {
  /** The `account_ref` — the stable id grants and lifecycle verbs reference. */
  id: string
  /** Cleartext, display-only (e.g. `sander@acme.com`). NON-secret by construction. */
  account_label: string
  /** `active` | `disconnected` (secret kept for one-tap reconnect). */
  status: 'active' | 'disconnected' | string
  has_secret: boolean
  last_used_at: number
  /** `null` | `ok` | `expired` | `error` (passive freshness, migration 0036). */
  health: string | null
  grant_level: GrantLevel
}

/** A store card — secret-free by construction. Local rows carry a subset;
 *  catalog rows add `tool_count`, `featured`, `categories`, popularity. */
export interface ConnectorCard {
  id: string
  kind: ConnectorKind
  display_name: string
  /** A data: URI, an absolute URL, or (catalog) a mirror path. May be empty →
   *  the card renders a tinted monogram tile. */
  icon: string
  description: string
  tools: ConnectorTool[]
  credentials: CredentialField[]
  /** `local` (created / agent-authored / imported) or `catalog` (mirror). */
  source: 'local' | 'catalog' | string
  /** Catalog preview cards declare no tools[]; the count rides here instead. */
  tool_count?: number | null
  featured?: boolean
  /** First-party Anthropic/MCP reference server — wears the "Official" badge. */
  official?: boolean
  /** The exact one-line install/connect command (shown on the detail sheet). */
  install?: string
  /** A lucide icon NAME (kebab-case) the curated card ships as its reliable icon
   *  fallback when no brand mark / mirrored asset is present. */
  lucide?: string
  /** A short editorial hook for the Featured hero — one curated line, distinct
   *  from the functional `description`. Optional; the hero derives a social-proof
   *  line from `stars`/category when it is absent. */
  hook?: string
  categories?: string[]
  created_at?: string
  /** Local (installed) rows only: the connected accounts, each with its own
   *  identity + status + grant-level. Empty/absent for a catalog card and for an
   *  installed-but-never-connected connector (built-in browser, etc). */
  accounts?: ConnectorAccount[]
  /** Local rows only: the provenance block (`imported`/`builtin` markers) —
   *  secret-free (`source_json` never holds a value). Drives the KIND label. */
  provenance?: Record<string, unknown>
  // Catalog popularity / provenance (optional, all secret-free).
  stars?: number | null
  downloads?: number | null
  homepage_url?: string | null
  source_url?: string | null
  pulsemcp_url?: string | null
}

/** One CONSUMER of a connector — a resolved grant from `GET /{id}/grants` (the
 *  blast-radius). Secret-free; `account_label` names which account it feeds. */
export interface ConnectorConsumer {
  scope: 'all' | 'company' | 'bot'
  label: string
  enabled: boolean
  has_secret: boolean
  account_ref: string | null
  account_label: string | null
  granted_at: number
  /** `scope === 'company'`. */
  company_id?: number | null
  slug?: string | null
  /** `scope === 'bot'`. */
  session_name?: string | null
}

/** A grant that applies to one session (own or the `*` all-agents sentinel),
 *  carrying its connector card. `has_secret` is a boolean, never the value. */
export interface SessionConnector {
  connector_id: string
  has_secret: boolean
  enabled: boolean
  card: ConnectorCard | null
}

/** The supermux connector manifest (the runtime/listing format). */
export interface Manifest {
  id: string
  kind?: ConnectorKind
  display_name?: string
  icon?: string
  description?: string
  tools?: ConnectorTool[]
  credentials?: CredentialField[]
  /** `mcpServers` entry template with `${VAR}` placeholders. */
  emit?: unknown
}

/** The `*` all-agents grant sentinel (server `connectors::ALL_AGENTS`). */
export const ALL_AGENTS = '*'

/** The `@company:<id>` grant-key prefix (server `connectors::COMPANY_PREFIX`).
 *  A grant keyed `@company:<id>` applies to every bot in that company — the
 *  middle scope tier between an own-bot grant and the all-agents `*` sentinel
 *  (precedence: own > company > all). Build a key with `companyGrantKey(id)`. */
export const COMPANY_PREFIX = '@company:'

/** The stored `session_name` for a company-scoped grant. */
export function companyGrantKey(companyId: number): string {
  return `${COMPANY_PREFIX}${companyId}`
}

// ── response envelopes (raw server JSON — NOT the `{ ok, data }` wrapper) ──────

interface ListResponse {
  connectors: ConnectorCard[]
}
interface SessionConnectorsResponse {
  session_name: string
  connectors: SessionConnector[]
}
interface MutationResponse {
  ok: boolean
  id?: string
  session_name?: string
  restartHint?: boolean
}
interface CredentialResponse {
  ok: boolean
  secret_ref: string
  /** Masked echo — every value is the `••••••` sentinel. */
  fields: Record<string, string>
  restartHint: boolean
}

// ── query for the merged grid ─────────────────────────────────────────────────

export interface ListParams {
  /** `local` | `catalog` | `all` (default `all`). */
  source?: 'local' | 'catalog' | 'all'
  /** Free-text over id / display_name / description. */
  q?: string
  /** A category tag (or `featured`). */
  category?: string
  featured?: boolean
}

function qs(params: ListParams): string {
  const p = new URLSearchParams()
  if (params.source) p.set('source', params.source)
  if (params.q) p.set('q', params.q)
  if (params.category) p.set('category', params.category)
  if (params.featured) p.set('featured', 'true')
  const s = p.toString()
  return s ? `?${s}` : ''
}

function enc(id: string): string {
  return encodeURIComponent(id)
}

// ── the nine endpoints ────────────────────────────────────────────────────────

/** `GET /api/connectors` — the merged store grid (local rows + catalog mirror).
 *  Secret-free; the catalog half reads the in-memory mirror (never blocks). */
export async function listConnectors(
  params: ListParams = {},
): Promise<ConnectorCard[]> {
  const r = await settingsRequest<ListResponse>(`/api/connectors${qs(params)}`)
  return r.connectors ?? []
}

/** `GET /api/connectors/catalog` — the PulseMCP mirror on its own. */
export async function listCatalog(
  params: ListParams = {},
): Promise<ConnectorCard[]> {
  const r = await settingsRequest<ListResponse>(
    `/api/connectors/catalog${qs({ ...params, source: 'catalog' })}`,
  )
  return r.connectors ?? []
}

/** `POST /api/connectors/catalog/refresh` — force a mirror refetch now. */
export async function refreshCatalog(): Promise<void> {
  await settingsRequest(`/api/connectors/catalog/refresh`, { method: 'POST' })
}

/** `GET /api/connectors/{id}` — one card (secret-free). */
export async function getConnector(id: string): Promise<ConnectorCard> {
  return settingsRequest<ConnectorCard>(`/api/connectors/${enc(id)}`)
}

/** `POST /api/connectors` — create-or-update from a supermux manifest. Returns
 *  the stored id (installs a catalog card into the local registry). */
export async function upsertConnector(manifest: Manifest): Promise<string> {
  const r = await settingsRequest<MutationResponse>(`/api/connectors`, {
    method: 'POST',
    body: JSON.stringify(manifest),
  })
  return r.id ?? manifest.id
}

/** `POST /api/connectors/import` — import a `.mcpb` `manifest.json`. */
export async function importMcpb(bundle: unknown): Promise<string> {
  const r = await settingsRequest<MutationResponse>(`/api/connectors/import`, {
    method: 'POST',
    body: JSON.stringify(bundle),
  })
  return r.id ?? ''
}

/** `DELETE /api/connectors/{id}` — remove (grants + vault CASCADE). */
export async function removeConnector(id: string): Promise<void> {
  await settingsRequest(`/api/connectors/${enc(id)}`, { method: 'DELETE' })
}

export interface PutCredentialArgs {
  /** env-var-name → secret value. WRITE-ONLY — never comes back. */
  fields: Record<string, string>
  /** When set, also grant to this session (or `*`) pointing at the fresh secret
   *  — the one-tap Connect-card flow. */
  session_name?: string
  /** Reuse this secret_ref (rotation) instead of minting a new one. */
  secret_ref?: string
  /** The connected-account's NON-secret display identity (e.g. `sander@acme.com`).
   *  When omitted, the server derives it from the connector's `identity:true`
   *  credential field. A new label mints a new account; re-using one updates it. */
  account_label?: string
  /** REPLACE an existing account in place — swap its identity/secret while keeping
   *  every grant wired (the safe key-rotation path). */
  account_ref?: string
}

interface AccountMutationResponse {
  ok: boolean
  id?: string
  account_ref?: string
  status?: string
  restartHint?: boolean
}

/** `POST /api/connectors/{id}/credential` — seal a credential into the vault
 *  (write-only) and optionally grant it. The response is masked: keys survive,
 *  every value is `••••••`. `restartHint` is always true. */
export async function putCredential(
  id: string,
  args: PutCredentialArgs,
): Promise<CredentialResponse> {
  return settingsRequest<CredentialResponse>(
    `/api/connectors/${enc(id)}/credential`,
    { method: 'POST', body: JSON.stringify(args) },
  )
}

export interface GrantArgs {
  /** Session slug, or `*` / `"all"` for every agent. */
  session_name: string
  secret_ref?: string
  /** Pin which account this grant feeds (multi-account). Absent = the legacy path
   *  (a re-grant KEEPS whatever account the row already had). */
  account_ref?: string
  enabled?: boolean
}

/** `POST /api/connectors/{id}/grant` — grant to one session or all agents. */
export async function grant(
  id: string,
  args: GrantArgs,
): Promise<MutationResponse> {
  return settingsRequest<MutationResponse>(`/api/connectors/${enc(id)}/grant`, {
    method: 'POST',
    body: JSON.stringify(args),
  })
}

/** `DELETE /api/connectors/{id}/grant?session_name=` — revoke a grant. */
export async function revoke(
  id: string,
  sessionName: string,
): Promise<MutationResponse> {
  return settingsRequest<MutationResponse>(
    `/api/connectors/${enc(id)}/grant?session_name=${encodeURIComponent(sessionName)}`,
    { method: 'DELETE' },
  )
}

/** `GET /api/sessions/{name}/connectors` — the grants that apply to this session
 *  (own + all-agents), each with its card. Secret-free. */
export async function sessionConnectors(
  name: string,
): Promise<SessionConnector[]> {
  const r = await settingsRequest<SessionConnectorsResponse>(
    `/api/sessions/${enc(name)}/connectors`,
  )
  return r.connectors ?? []
}

/** `GET /api/connectors/{id}/grants` — the CONSUMERS of a connector (blast-radius):
 *  every grant resolved to its scope + the account it feeds. Member-filtered
 *  server-side. Secret-free. */
export async function connectorGrants(id: string): Promise<ConnectorConsumer[]> {
  const r = await settingsRequest<{ connector_id: string; grants: ConnectorConsumer[] }>(
    `/api/connectors/${enc(id)}/grants`,
  )
  return r.grants ?? []
}

/** `POST /api/connectors/{id}/disconnect` — revoke every grant an account feeds
 *  but KEEP the sealed secret + the account row (status → `disconnected`) so a
 *  reconnect is one tap. Owner/admin-only. */
export async function disconnectAccount(
  id: string,
  accountRef: string,
): Promise<AccountMutationResponse> {
  return settingsRequest<AccountMutationResponse>(`/api/connectors/${enc(id)}/disconnect`, {
    method: 'POST',
    body: JSON.stringify({ account_ref: accountRef }),
  })
}

/** `POST /api/connectors/{id}/reconnect` — flip a disconnected account back to
 *  `active` and (optionally) re-grant it to a session/scope, REUSING the kept
 *  secret (no re-entry). Owner/admin-only. This is the account-aware grant path:
 *  the server resolves the account's `secret_ref` so the launch path stays wired. */
export async function reconnectAccount(
  id: string,
  accountRef: string,
  sessionName?: string,
): Promise<AccountMutationResponse> {
  return settingsRequest<AccountMutationResponse>(`/api/connectors/${enc(id)}/reconnect`, {
    method: 'POST',
    body: JSON.stringify({ account_ref: accountRef, session_name: sessionName }),
  })
}

// ── derived helpers (pure, shared by the UI) ──────────────────────────────────

/** The tool-count a card advertises: an explicit catalog `tool_count`, else the
 *  length of the declared `tools[]`. `null` when neither is known. */
export function connectorToolCount(card: ConnectorCard): number | null {
  if (typeof card.tool_count === 'number') return card.tool_count
  if (card.tools && card.tools.length > 0) return card.tools.length
  return null
}

/** "14 tools" / "1 tool" / "" — the App-Store trust pill copy.
 *
 *  A built-in card gets the SAME count as every other card (jury STORE_CARD #2:
 *  the Shared Browser answered "built-in" where Playwright answered "15 tools",
 *  so the built-in was the one card in the grid that never stated what it can
 *  do). Provenance is a separate chip — see `isBuiltin` — not a substitute for
 *  the count. */
export function toolCountLabel(card: ConnectorCard): string {
  const n = connectorToolCount(card)
  if (n === null) return ''
  return n === 1 ? '1 tool' : `${n} tools`
}


/** Services that offer a branded OAuth sign-in (the "Sign in with {service}"
 *  primary). The set is intentionally explicit: an OAuth lead is a trust promise,
 *  so we only make it for connectors that genuinely have a hosted sign-in. Others
 *  lead with the secure key paste. Mirrors the server's `auth` hint until the
 *  catalog carries it per-row. */
const OAUTH_BRANDS = /github|notion|slack|linear|sentry|google|gmail|drive|calendar|figma|intercom/i

/** Does this connector advertise a branded OAuth sign-in? Drives the detail's
 *  "Sign in with {service}" primary (blocker B4). */
export function connectorHasOAuth(card: ConnectorCard): boolean {
  // An explicit per-row hint wins when the catalog carries one.
  const auth = (card as { auth?: string | null }).auth
  if (typeof auth === 'string') return auth.toLowerCase() === 'oauth'
  return OAUTH_BRANDS.test(`${card.id} ${card.display_name}`)
}

/** The single sensitive field (the secure paste), if the schema declares one. */
export function secretField(card: ConnectorCard): CredentialField | undefined {
  return card.credentials?.find((f) => f.sensitive)
}

/** The non-secret fields (plain inputs — username, host, port …). */
export function plainFields(card: ConnectorCard): CredentialField[] {
  return (card.credentials ?? []).filter((f) => !f.sensitive)
}
