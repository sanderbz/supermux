// The shared-browser WORKSPACE client — the human's tab CRUD + per-tab grants.
//
// Mirrors `server/src/connectors/browser/api.rs` (the BEARER door) exactly; the
// agent's door (`/api/hook/browser/*`, hook-token) is deliberately somewhere
// else and this module never touches it. Every call rides the same
// `settingsRequest` the rest of the app uses — one fetch discipline, one bearer,
// one `ApiError` carrying the status code.
//
// HONESTY LIVES HERE, NOT IN THE COMPONENTS. A tab has two orthogonal states —
// *persisted* (the row: id/title/url/pinned/grants/login_state) and *live* (a
// CDP target inside a running Chrome). A tab that is not `live` is DEHYDRATED,
// not lost, and a tab whose `login_state` is `needs_login` must read as such
// wherever it is drawn. `tabState()` below is the single place that resolves
// those two axes into one label + tone, so no surface can invent a green dot
// (spec §7.3).

import { settingsRequest } from './client'
import { ALL_AGENTS, COMPANY_PREFIX } from './connectors'

// ── wire types (mirror the Rust `tab_json` / `TabGrant`) ─────────────────────

/** `ok` | `needs_login` | `unknown` — `db::browser_tabs::LOGIN_*`. */
export type LoginState = 'ok' | 'needs_login' | 'unknown'

/** One grantee of one tab. The keyspace is the connector store's, unchanged:
 *  a bot slug, `@company:<id>`, or the `*` all-agents sentinel. */
export interface TabGrant {
  tab_id: string
  grantee: string
  /** SQLite integer bool — `0` is a grant that exists but is switched off. */
  enabled: number
  granted_at: number
  /** Has a launch since the grant already bound the Shared Browser connector it
   *  implies? Lending a tab now also grants that connector server-side, but a
   *  connector only reaches a bot's toolset at LAUNCH — so a bot that was
   *  already running when the tab was lent holds the grant and not the tools.
   *  Server-computed with the SAME predicate the store's grant list uses.
   *  Absent for a `*` / `@company:<id>` sentinel: those name no one process, so
   *  there is no honest answer. */
  applied?: boolean
  /** Is a restart even meaningful — i.e. is that bot running right now? A
   *  stopped bot binds the grant on its next start with nothing to press. */
  running?: boolean
}

/** Does this grant name a bot that has the tab but cannot use it YET — the
 *  grant landed while the bot was already running, so the `browser_*` tools
 *  arrive at its next restart. The one state the workspace must not hide: it is
 *  the whole difference between "lent" and "usable". */
export function tabGrantNeedsRestart(g: TabGrant): boolean {
  return g.enabled !== 0 && g.applied === false && g.running === true
}

/** One workspace tab, as `GET /api/browser/tabs` renders it. */
export interface BrowserTab {
  id: string
  title: string
  url: string
  pinned: boolean
  /** Owning company (`null` = HQ / global). The containment axis of §8.3. */
  company_id: number | null
  /** Host rules — an exact host, or a leading-dot suffix the human opted into. */
  origins: string[]
  login_state: LoginState
  /** Unix seconds of the last probe, or `null` when nothing has ever checked. */
  last_probe_at: number | null
  /** Transient: a live CDP target exists right now. `false` = dehydrated. */
  live: boolean
  /** "Keep me signed in" — the human's per-tab toggle. */
  keepalive_enabled: boolean
  /** Minutes between checks, as the sweep last LEARNED it from the cookie jar.
   *  Server-derived: there is no interval picker, by design. */
  keepalive_every: number
  /** `soft` = the tab is being refreshed; `watch` = this site expires sessions
   *  in minutes, so supermux reads the jar and pings nothing. Any other value
   *  (including the column's legacy `reload` default) means soft. */
  keepalive_action: string
  /** Unix seconds of the last COMPLETED check, or `null` for "never" — which is
   *  also what the server reads as "due now". */
  last_keepalive_at: number | null
  grants: TabGrant[]
  created_at: number
  last_used_at: number | null
}

interface TabsResponse {
  tabs: BrowserTab[]
}
interface GrantsResponse {
  grants: TabGrant[]
}

// ── the seven endpoints ──────────────────────────────────────────────────────

function enc(id: string): string {
  return encodeURIComponent(id)
}

/** `GET /api/browser/tabs` — EVERY tab. The human owns the browser and sees all
 *  of it; the grant-filtered view is the agent's (`browser_list_tabs`). */
export async function listTabs(): Promise<BrowserTab[]> {
  const r = await settingsRequest<TabsResponse>('/api/browser/tabs')
  return r.tabs ?? []
}

/** `POST /api/browser/tabs` — mint a tab row, seeded with the exact host of its
 *  first URL.
 *
 *  `open` is the human's half of the lazy-start invariant. Without it the call
 *  mints a BOOKMARK: a row whose `live` is `false`, which is exactly the dead
 *  end the workspace used to hand a human who typed an address and pressed
 *  Enter. `?open=true` asks the server to `ensure_tab` the row it just wrote
 *  and hand it back already live, so `+` means "open a page", not "insert a
 *  row". Agents keep the lazy path (they pass nothing). */
export async function createTab(
  url: string,
  companyId?: number | null,
  open = false,
): Promise<BrowserTab> {
  return settingsRequest<BrowserTab>(`/api/browser/tabs${open ? '?open=true' : ''}`, {
    method: 'POST',
    body: JSON.stringify({ url, company_id: companyId ?? null }),
  })
}

/** `POST /api/browser/tabs/{id}/navigate` — the human's NAVIGATE verb.
 *
 *  Not `PATCH {url}`: that writes the `url` column and never touches a page, so
 *  a human editing the address bar with it would watch the text change and the
 *  page stay put. This wakes the tab if it is asleep (`ensure_tab`) and then
 *  drives `PageContext::navigate`, so the response is the tab AS IT NOW IS —
 *  `live: true`, the real URL, the real title. */
export async function navigateTab(id: string, url: string): Promise<BrowserTab> {
  return settingsRequest<BrowserTab>(`/api/browser/tabs/${enc(id)}/navigate`, {
    method: 'POST',
    body: JSON.stringify({ url }),
  })
}

/**
 * `POST /api/browser/tabs/{id}/{back,forward,reload,stop}` — the human's
 * navigation controls, over HTTP.
 *
 * THE SECOND DOOR, and the one that can wake a sleeping tab: each of these
 * `ensure_tab`s first (a human pressing Reload is somebody USING a browser —
 * the lazy-start invariant is honoured, not repealed) and then runs the verb as
 * `Actor::Human`. When a takeover socket is attached the UI prefers the socket
 * instead (`ClientMsg::Back` &c), because that frame lands in the relay already
 * holding the page — see `workspace.tsx`'s `drive()`.
 *
 * `moved:false` is the HONEST answer, not an error: Back at the start of the
 * history did not go anywhere. The UI greys the arrow from `can_go_back` on the
 * nav-state feed and reconciles against this if it did not.
 */
export type NavControl = 'back' | 'forward' | 'reload' | 'stop'

export interface NavControlResult extends BrowserTab {
  moved: boolean
}

export async function navControlTab(
  id: string,
  verb: NavControl,
): Promise<NavControlResult> {
  return settingsRequest<NavControlResult>(`/api/browser/tabs/${enc(id)}/${verb}`, {
    method: 'POST',
  })
}

/** `POST /api/browser/tabs/{id}/open` — wake a dehydrated tab where it stands.
 *
 *  Idempotent (`ensure_tab` is), and it reopens at the row's own `url` with the
 *  on-disk profile, so the sign-in comes back with the page. This is the button
 *  the asleep card was missing. */
export async function openTab(id: string): Promise<BrowserTab> {
  return settingsRequest<BrowserTab>(`/api/browser/tabs/${enc(id)}/open`, {
    method: 'POST',
  })
}

export async function getTab(id: string): Promise<BrowserTab> {
  return settingsRequest<BrowserTab>(`/api/browser/tabs/${enc(id)}`)
}

/** The patchable half. `origins` and `login_state` are HUMAN acts — an agent can
 *  never widen an allowlist or clear a stale sign-in state. */
export interface TabPatch {
  title?: string
  url?: string
  pinned?: boolean
  origins?: string[]
  login_state?: LoginState
  /** "Keep me signed in". The ONLY keepalive field the server accepts from a
   *  body — the interval and the mode are learned, never asked for. */
  keepalive_enabled?: boolean
}

/** `PATCH /api/browser/tabs/{id}` — pin/unpin, rename, re-scope, clear a state. */
export async function patchTab(id: string, patch: TabPatch): Promise<BrowserTab> {
  return settingsRequest<BrowserTab>(`/api/browser/tabs/${enc(id)}`, {
    method: 'PATCH',
    body: JSON.stringify(patch),
  })
}

/** `POST /api/browser/tabs/{id}/close` — **close the page, keep the tab.**
 *
 *  Dehydrate: the target closes, the row, the grants and the cookies stay. The
 *  exact inverse of [[openTab]], and deliberately NOT an overload of `DELETE`,
 *  which destroys the row — one verb per act. `closed:false` is the honest
 *  answer for a tab that was already asleep; it is a state, not an error. */
export interface CloseTabResult extends BrowserTab {
  closed: boolean
}
export async function closeTabPage(id: string): Promise<CloseTabResult> {
  return settingsRequest<CloseTabResult>(`/api/browser/tabs/${enc(id)}/close`, {
    method: 'POST',
  })
}

/** `DELETE /api/browser/tabs/{id}` — closes the target and drops the row.
 *
 *  **This signs nothing out.** The cookies live in one shared profile; the
 *  honest eraser is the profile reset. The server says so in its response and
 *  the UI must repeat it rather than implying a delete is a sign-out (§8.5). */
export interface DeleteTabResult {
  deleted: boolean
  cookies_cleared: boolean
  note: string
}
export async function deleteTab(id: string): Promise<DeleteTabResult> {
  return settingsRequest<DeleteTabResult>(`/api/browser/tabs/${enc(id)}`, {
    method: 'DELETE',
  })
}

export async function tabGrants(id: string): Promise<TabGrant[]> {
  const r = await settingsRequest<GrantsResponse>(`/api/browser/tabs/${enc(id)}/grants`)
  return r.grants ?? []
}

/** `POST /api/browser/tabs/{id}/grant` — lend ONE tab to ONE grantee.
 *  Cross-company grants are refused server-side with a 400 (§8.3), so the
 *  `ApiError` this throws is the honest answer, not a UI guess. */
export async function grantTab(
  id: string,
  grantee: string,
  enabled = true,
): Promise<TabGrant[]> {
  const r = await settingsRequest<GrantsResponse>(`/api/browser/tabs/${enc(id)}/grant`, {
    method: 'POST',
    body: JSON.stringify({ grantee, enabled }),
  })
  return r.grants ?? []
}

/** `DELETE /api/browser/tabs/{id}/grant/{grantee}`. */
export async function revokeTabGrant(id: string, grantee: string): Promise<TabGrant[]> {
  const r = await settingsRequest<GrantsResponse>(
    `/api/browser/tabs/${enc(id)}/grant/${enc(grantee)}`,
    { method: 'DELETE' },
  )
  return r.grants ?? []
}

// ── derived, pure, and tested ────────────────────────────────────────────────

/** The host of a tab's URL, for the chip and the address bar. Falls back to the
 *  raw string rather than throwing — a half-typed URL still has to render. */
export function tabHost(url: string): string {
  try {
    return new URL(url).host || url
  } catch {
    return url
  }
}

/** `https:` ⇒ the padlock is honest. Anything else (http, about:blank, a typo)
 *  is NOT drawn as secure. */
export function isSecure(url: string): boolean {
  try {
    return new URL(url).protocol === 'https:'
  } catch {
    return false
  }
}

/** How the tab reads, in one word for the dot and one line for the human.
 *
 *  `tone` drives colour ONLY: `needs-login` amber, `ok` green, `dehydrated`
 *  slate, `unknown` slate. The order below is the honesty order — a
 *  `needs_login` tab says so even while it is live, and a live-but-never-probed
 *  tab never claims to be signed in. */
export type TabTone = 'ok' | 'needs-login' | 'dehydrated' | 'unknown'

export interface TabState {
  tone: TabTone
  /** Short, for the chip's `title` + the sheet's header. */
  label: string
  /** The evidence and its age — never a bare green dot (§7.3). */
  detail: string
}

/** `now` is injectable so the age line is testable without a clock. */
export function tabState(tab: BrowserTab, now: number = Date.now() / 1000): TabState {
  const age = tab.last_probe_at === null ? null : ago(now - tab.last_probe_at)
  if (tab.login_state === 'needs_login') {
    return {
      tone: 'needs-login',
      label: 'Sign-in needed',
      // A restart is the single most common cause and the one the human can do
      // nothing about, so name it rather than leaving them hunting (§7.1a).
      detail: tab.live
        ? `Signed out${age ? ` — seen ${age}` : ''}. Take the wheel and sign in again.`
        : 'Signed out by a browser restart. Wake the tab and sign in again.',
    }
  }
  if (!tab.live) {
    return {
      tone: 'dehydrated',
      label: 'Asleep',
      // This line used to end "…the tab wakes the next time a granted agent uses
      // it", because at the time nothing on the human's API could rehydrate a
      // tab. `POST …/open` changed that, so the copy names the human's own verb
      // first: a state line that points at somebody else's action, when the
      // reader is looking straight at a Wake button, is the stale one.
      detail:
        'Not open right now — the sign-in is kept on disk. Wake it, or the next granted agent will.',
    }
  }
  if (tab.login_state === 'ok') {
    return {
      tone: 'ok',
      label: 'Signed in',
      detail: age ? `Signed in · verified ${age}` : 'Signed in · not verified yet',
    }
  }
  return {
    tone: 'unknown',
    label: 'Not verified',
    detail: 'Open, but nothing has checked whether the sign-in is still good.',
  }
}

/** "6 min ago" / "just now" — seconds in, one short phrase out. Negative (a
 *  clock skew) reads as "just now" rather than a time-travelling probe. */
export function ago(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 45) return 'just now'
  const mins = Math.round(seconds / 60)
  if (mins < 60) return `${mins} min ago`
  const hours = Math.round(mins / 60)
  if (hours < 24) return `${hours} h ago`
  return `${Math.round(hours / 24)} d ago`
}

/** Pinned first, then most-recently-used, then title — the rail's order. Pure,
 *  so the strip never sorts differently from the sheet's list. */
export function sortTabs(tabs: BrowserTab[]): BrowserTab[] {
  return [...tabs].sort((a, b) => {
    if (a.pinned !== b.pinned) return a.pinned ? -1 : 1
    const au = a.last_used_at ?? a.created_at
    const bu = b.last_used_at ?? b.created_at
    if (au !== bu) return bu - au
    return (a.title || a.url).localeCompare(b.title || b.url)
  })
}

/** A bare host typed into the new-tab box becomes `https://…`; anything already
 *  carrying a scheme is left alone, and a NON-http scheme (`javascript:`,
 *  `file:`) is refused outright rather than handed to the server to reject —
 *  the one place a typo could become a scheme the workspace never opens. */
export function normalizeUrl(input: string): string | null {
  const raw = input.trim()
  if (!raw) return null
  if (/^https?:\/\//i.test(raw)) return raw
  if (/^[a-z][a-z0-9+.-]*:/i.test(raw)) return null
  return `https://${raw}`
}

/* ── the omnibox: what one line of typing MEANS ──────────────────────────── */

/** Where a query that is not a URL goes. One constant, so the parse and the
 *  "Search for …" affordance can never disagree about the engine. */
export const SEARCH_URL = 'https://www.google.com/search?q='

/** What the address bar decided the human meant. A discriminated union rather
 *  than a nullable string because "this is a search" and "this is a page" are
 *  different acts and the bar SHOWS which one it is about to take. */
export type AddressIntent =
  | { kind: 'empty' }
  | { kind: 'navigate'; url: string }
  | { kind: 'search'; url: string; query: string }
  | { kind: 'refuse'; reason: string }

/** A dotted name: `mail.example`, `a.b.co.uk`, a trailing root dot allowed. */
const DOTTED = /^[a-z0-9-]+(\.[a-z0-9-]+)+\.?$/i
/** A dotted quad. Written without a bounded quantifier on purpose — see the
 *  repo's grep rule; `\d\d?\d?` costs nothing and reads the same. */
const IPV4 = /^\d\d?\d?(\.\d\d?\d?){3}$/
/** The hosts where `https://` is the WRONG default — a dev server on loopback
 *  has no certificate, and every real browser sends these to `http://`. */
const LOOPBACK = /^(localhost|127\.\d\d?\d?\.\d\d?\d?\.\d\d?\d?|0\.0\.0\.0)$/i
/** `[::1]`, `[fe80::1]:8080` — bracketed, so the port split below is safe. */
const IPV6 = /^\[[0-9a-f:.]+\]$/i

function searched(query: string): AddressIntent {
  return { kind: 'search', url: `${SEARCH_URL}${encodeURIComponent(query)}`, query }
}

/**
 * One line of typing → one act.
 *
 * The order is the order every browser uses, and each step is a defect that was
 * reproduced in the old box:
 *
 *   1. empty → nothing happens (it used to mint nothing and close the form).
 *   2. `http(s)://…` → go there verbatim.
 *   3. whitespace, or a leading `?` → SEARCH. `how to bake bread` used to
 *      become `https://how to bake bread`, which the server answered with a 400
 *      and the human read as "this browser is broken".
 *   4. a scheme that is not http(s) (`javascript:`, `file:`, `mailto:`) →
 *      refused IN PLACE, with a reason, instead of being handed to the server.
 *   5. a host — dotted name, IPv4/IPv6 literal, or `localhost`, each with an
 *      optional `:port` and path → schemed and opened. Loopback gets `http`,
 *      everything else `https`.
 *   6. anything else (`github`, `q3 numbers`) → SEARCH.
 */
export function parseAddress(input: string): AddressIntent {
  const raw = input.trim()
  if (!raw) return { kind: 'empty' }
  if (/^https?:\/\//i.test(raw)) return { kind: 'navigate', url: raw }
  // A leading `?` is the explicit "search for this" prefix; anything with a
  // space in it cannot be a host, whatever else it looks like.
  if (raw.startsWith('?')) return searched(raw.slice(1).trim() || raw)
  if (/\s/.test(raw)) return searched(raw)

  // The authority is everything before the first path / query / fragment mark.
  const authority = raw.split(/[/?#]/)[0]
  let host = authority
  let port = ''
  const cut = authority.startsWith('[')
    ? authority.indexOf(':', authority.indexOf(']'))
    : authority.indexOf(':')
  if (cut >= 0) {
    host = authority.slice(0, cut)
    port = authority.slice(cut + 1)
  }
  // A colon whose right-hand side is not a port is a SCHEME. `javascript:` and
  // `file:` are refused here rather than at the server, because the server's
  // 400 arrives as a red toast that never names the scheme.
  if (cut >= 0 && !/^\d+$/.test(port)) {
    return {
      kind: 'refuse',
      reason: `Only http and https pages open here — ${host}: can't.`,
    }
  }
  if (LOOPBACK.test(host) || IPV6.test(host)) return { kind: 'navigate', url: `http://${raw}` }
  if (IPV4.test(host)) return { kind: 'navigate', url: `http://${raw}` }
  // `3.5` and `1.2.3.4.5` are dotted but are not hosts — a browser searches for
  // them, and so does this.
  if (/^[\d.]+$/.test(host)) return searched(raw)
  if (DOTTED.test(host)) return { kind: 'navigate', url: `https://${raw}` }
  return searched(raw)
}

/**
 * The URL as the bar SHOWS it while it is idle: `https://` hidden, `www.`
 * trimmed, a bare `/` path dropped.
 *
 * `http://` is deliberately NOT hidden — hiding the one scheme that is not
 * secure is the phishing-friendly half of scheme-trimming, and this workspace
 * lends its tabs to agents. Anything that does not parse is echoed unchanged:
 * a half-typed address still has to render.
 */
export function displayUrl(url: string): string {
  try {
    const u = new URL(url)
    if (u.protocol !== 'https:' && u.protocol !== 'http:') return url
    const host = u.host.replace(/^www\./i, '')
    const rest = `${u.pathname === '/' ? '' : u.pathname}${u.search}${u.hash}`
    return `${u.protocol === 'https:' ? '' : 'http://'}${host}${rest}`
  } catch {
    return url
  }
}

/** How a grantee reads to a human. The keyspace is the connector store's,
 *  unchanged: a bot slug, `@company:<id>`, or the `*` all-agents sentinel. */
export function granteeLabel(grantee: string, companyName?: string): string {
  if (grantee === ALL_AGENTS) return 'All agents'
  if (grantee.startsWith(COMPANY_PREFIX)) return companyName ?? 'This company'
  return grantee
}

/** The grants that actually confer access — a row with `enabled = 0` exists but
 *  grants nothing, and drawing it as a grantee would be a lie about the blast
 *  radius. */
export function activeGrantees(tab: BrowserTab): string[] {
  return tab.grants.filter((g) => g.enabled !== 0).map((g) => g.grantee)
}

/** A bot the workspace could lend a tab to. `company_id` is what decides
 *  whether the SERVER will accept it — see [[grantCandidates]]. */
export interface GrantCandidate {
  name: string
  company_id: number | null
}

/**
 * The bots the server will actually accept for THIS tab.
 *
 * `api.rs::grant_handler` refuses (400) unless
 * `company_of_grant_target(grantee) == tab.company_id`, and `has_tab_grant`
 * re-checks the same predicate on every agent call — a tab is never shared
 * across companies. Offering a bot from another company is therefore not a
 * hole (the server holds), it is a control that can only ever fail, so it is
 * not offered.
 */
export function grantCandidates(bots: GrantCandidate[], tab: BrowserTab): GrantCandidate[] {
  const owner = tab.company_id ?? null
  return bots.filter((b) => (b.company_id ?? null) === owner)
}

/** `company_of_grant_target('*')` resolves to NO company, so the all-agents
 *  sentinel is a legal target only for an HQ tab (`company_id === null`). On a
 *  company-owned tab the tier is hidden rather than drawn and refused. */
export function mayGrantAll(tab: BrowserTab): boolean {
  return (tab.company_id ?? null) === null
}
