/**
 * The supermux-brokered OAuth round trip, browser side — PURE and dependency-
 * injected so the unit runner (no DOM) can exercise every branch.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * The owner taps "Sign in with InhouseSEO". The SPA asks the server to start a
 * flow (`POST /api/connectors/{id}/oauth/start`), keeps the returned `state` in
 * `sessionStorage` (THIS tab only — the state never rides a URL), and hands the
 * tab to the provider with a top-level `location.assign` (same tab on purpose:
 * on the iOS PWA a popup would open Safari and strand the session). The provider
 * sends the browser back to the PUBLIC callback, which exchanges the code and
 * stashes the tokens server-side, then 302s to `return_to?oauth_pending=1`. On
 * boot, `handleOauthReturn` reads the pending key and calls the AUTHENTICATED
 * `complete` — the only step that seals + grants + probes.
 *
 * Defence in depth: the authorize URL must be `https:` (the server already
 * refuses a `javascript:`/`http:` endpoint from malicious metadata; the client
 * checks again before it hands the tab over).
 */
import { ApiError } from './api/client'

/** Where the in-flight sign-in lives between the hop out and the hop back. */
export const PENDING_KEY = 'supermux.oauth.pending'

export interface PendingSignIn {
  id: string
  target: string
  returnTo: string
  state: string
}

/** The smallest storage contract the round trip needs (a `Storage` satisfies it). */
export interface PendingStore {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
  removeItem(key: string): void
}

export function readPending(store: PendingStore | null | undefined): PendingSignIn | null {
  if (!store) return null
  try {
    const raw = store.getItem(PENDING_KEY)
    if (!raw) return null
    const v = JSON.parse(raw) as Partial<PendingSignIn>
    if (typeof v.id !== 'string' || typeof v.state !== 'string') return null
    return {
      id: v.id,
      target: typeof v.target === 'string' ? v.target : '*',
      returnTo: typeof v.returnTo === 'string' ? v.returnTo : '/store',
      state: v.state,
    }
  } catch {
    return null
  }
}

export function writePending(store: PendingStore | null | undefined, p: PendingSignIn): void {
  try {
    store?.setItem(PENDING_KEY, JSON.stringify(p))
  } catch {
    /* private mode / quota — the return then reads "finished outside supermux" */
  }
}

export function clearPending(store: PendingStore | null | undefined): void {
  try {
    store?.removeItem(PENDING_KEY)
  } catch {
    /* ignore */
  }
}

/** The browser's session storage, or `null` where it throws (SSR, private mode). */
export function browserPendingStore(): PendingStore | null {
  try {
    return typeof sessionStorage === 'undefined' ? null : sessionStorage
  } catch {
    return null
  }
}

// ── begin ─────────────────────────────────────────────────────────────────────

export interface BeginDeps {
  /** `startMcpOauth(id, { session_name, return_to })`. */
  start: (id: string, args: { session_name: string; return_to: string }) => Promise<{ authorize_url: string; state: string }>
  store: PendingStore | null
  /** `window.location.assign`. */
  assign: (url: string) => void
  toast: (message: string) => void
}

/** Start a brokered sign-in and hand the tab to the provider. Resolves `true`
 *  when the tab was handed over, `false` when it was refused (toast shown). */
export async function beginSignIn(
  deps: BeginDeps,
  id: string,
  target: string,
  returnTo: string,
): Promise<boolean> {
  clearPending(deps.store)
  let r: { authorize_url: string; state: string }
  try {
    r = await deps.start(id, { session_name: target, return_to: returnTo })
  } catch (e) {
    const msg = e instanceof ApiError || e instanceof Error ? e.message : ''
    deps.toast(msg ? `Couldn't start the sign-in — ${msg}` : "Couldn't start the sign-in")
    return false
  }
  writePending(deps.store, { id, target, returnTo, state: r.state })
  if (!isHttpsUrl(r.authorize_url)) {
    clearPending(deps.store)
    deps.toast("Couldn't start the sign-in")
    return false
  }
  deps.assign(r.authorize_url)
  return true
}

/** Independent of the server's own check: the provider page must be `https:`. */
export function isHttpsUrl(u: string): boolean {
  try {
    return new URL(u).protocol === 'https:'
  } catch {
    return false
  }
}

// ── return ────────────────────────────────────────────────────────────────────

/** `connect_error` codes the public callback appends, with their copy. */
export const CONNECT_ERROR_COPY: Record<string, string> = {
  denied: 'Sign-in was cancelled.',
  expired: 'That sign-in link expired — try again.',
  state: "Couldn't verify the sign-in — try again.",
  issuer: "Couldn't verify the sign-in — try again.",
  exchange: '{name} rejected the sign-in — try again.',
  internal: 'Something broke on the server — see the log.',
}

export function connectErrorCopy(code: string, name: string): string {
  const tpl = CONNECT_ERROR_COPY[code] ?? CONNECT_ERROR_COPY.state
  return tpl.replace('{name}', name)
}

export interface CompleteResult {
  account_ref: string
  label: string
  health: {
    status: string | null
    error?: string | null
    /** The probe's own line ("Server answered — 2 tools."). */
    message?: string | null
    /** How many tools the server listed in the probe's real `tools/list`;
     *  null/absent when the probe never got that far — never invented. */
    tool_count?: number | null
  }
  target: string
}

export interface ReturnDeps {
  /** `completeMcpOauth(id, { state })`. */
  complete: (id: string, args: { state: string }) => Promise<CompleteResult>
  store: PendingStore | null
  toast: (message: string, tone?: 'default' | 'error') => void
  /** Refetch the connector grid + a target's grants. */
  invalidate: (target?: string) => void
  /** The connector's display name for the error copy (best effort). */
  nameOf?: (id: string) => string
}

export type ReturnOutcome =
  | { kind: 'none' }
  | { kind: 'connected'; id: string; target: string; label: string; health: string | null }
  | { kind: 'connect_failed'; id: string }
  | { kind: 'lost' }
  | { kind: 'error'; code: string }

/** Does this query string carry an OAuth return at all? Pure. */
export function isOauthReturn(search: string): boolean {
  const p = new URLSearchParams(search)
  return p.get('oauth_pending') === '1' || p.has('connect_error')
}

/** Strip the OAuth return params from a query string (what `replaceState` keeps). */
export function stripOauthParams(search: string): string {
  const p = new URLSearchParams(search)
  p.delete('oauth_pending')
  p.delete('connect_error')
  const s = p.toString()
  return s ? `?${s}` : ''
}

/** The boot-time half: read the URL + the pending key, finish the sign-in,
 *  toast, invalidate. The caller strips the query afterwards. */
export async function handleOauthReturn(search: string, deps: ReturnDeps): Promise<ReturnOutcome> {
  const params = new URLSearchParams(search)
  const pending = readPending(deps.store)
  const err = params.get('connect_error')
  if (err) {
    // A cancelled / failed consent must never leave a permanent "Connecting…".
    clearPending(deps.store)
    const name = pending ? (deps.nameOf?.(pending.id) ?? pending.id) : 'The provider'
    deps.toast(connectErrorCopy(err, name), 'error')
    return { kind: 'error', code: err }
  }
  if (params.get('oauth_pending') !== '1') return { kind: 'none' }
  if (!pending) {
    deps.toast('Sign-in finished outside supermux — tap Connect again from here.', 'error')
    return { kind: 'lost' }
  }
  clearPending(deps.store)
  try {
    const r = await deps.complete(pending.id, { state: pending.state })
    const ok = r.health?.status === 'ok'
    const n = r.health?.tool_count
    // A green carries the count the server actually listed (a real tools/list),
    // never a catalog blurb; a non-ok verdict says why.
    const tools = typeof n === 'number' ? ` — ${n} tool${n === 1 ? '' : 's'}` : ''
    const detail = r.health?.error ? ` — ${r.health.error}` : ok ? tools : ' — not verified yet'
    deps.toast(`Connected as ${r.label}${detail}`, ok ? 'default' : 'error')
    deps.invalidate(r.target || pending.target)
    return { kind: 'connected', id: pending.id, target: r.target || pending.target, label: r.label, health: r.health?.status ?? null }
  } catch (e) {
    const msg = e instanceof Error ? e.message : ''
    deps.toast(msg ? `Couldn't finish the sign-in — ${msg}` : "Couldn't finish the sign-in", 'error')
    deps.invalidate(pending.target)
    return { kind: 'connect_failed', id: pending.id }
  }
}
