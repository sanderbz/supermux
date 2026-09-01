// VIEWER IDENTITY — who is looking at this app.
//
// Before this module the web client had no identity concept at all: it read the
// admin bearer off `window._SUPERMUX_AUTH_TOKEN` and assumed the owner. That
// assumption is what produced the four owner-reported invite failures — an
// anonymous visitor on a company host got the Bot-Mode onboarding intro instead
// of a login screen, and an invited colleague landed in the owner's HQ shell.
//
// There are exactly three viewers:
//
//   • OWNER  — the operator. Recognised by the SPA shell carrying the spliced
//     admin bearer (loopback / `*.ts.net` / a configured owner host — see
//     `static_assets::should_splice_admin_token`), or by a pasted access key
//     that `/auth/me` confirms. Sees everything; the shell is UNCHANGED for them.
//   • MEMBER — an invited colleague on a company host, authenticated by the
//     `supermux_hsess` cookie and FENCED server-side to exactly one company
//     (`server/src/scope.rs`). The presentation must match that fence.
//   • ANON   — nobody. Gets the login gate, never the app.
//
// This file is the PURE half (no fetch, no React, no store) so the resolution
// rules can be unit-tested exactly. The store lives in `stores/viewer-store.ts`.

/** The `identity` object `GET /auth/me` returns for an authenticated viewer. */
export interface MeIdentity {
  user_id?: number | null
  email?: string | null
  display_name?: string | null
  company_id?: number | null
  role?: string | null
}

/** The sign-in paths this box actually offers on the host the visitor typed —
 *  the only thing an ANONYMOUS `/auth/me` says beyond `authenticated:false`.
 *
 *  Owner-reported: a company host with Google OIDC configured and verified
 *  "Ready" still showed a gate with nothing but an access-key field. The server
 *  ran a complete OIDC start at `GET /auth/login` the whole time; the client had
 *  no way to know. The server computes this with the SAME checks `/auth/login`
 *  performs, so a `true` here means that URL really does redirect to Google. */
export interface LoginCapabilities {
  /** May the gate offer "Sign in with Google" on THIS host? */
  google: boolean
}

/** What a viewer is offered before we hear otherwise: nothing. Fail-closed, so
 *  an offline / 5xx / old-server answer can never paint a button that 404s. */
export const NO_LOGIN_CAPABILITIES: LoginCapabilities = { google: false }

/** The `GET /auth/me` envelope. */
export interface MePayload {
  authenticated?: boolean
  identity?: MeIdentity | null
  /** Present on the ANONYMOUS answer only. Absent from an older server. */
  login?: { google?: boolean } | null
}

/** Read the offered sign-in paths off a `/auth/me` payload. PURE, and strictly
 *  `=== true`: anything else — absent, null, a string, an old server — is "no". */
export function loginCapabilitiesFromMe(
  payload: MePayload | null | undefined,
): LoginCapabilities {
  return { google: payload?.login?.google === true }
}

/** The resolved viewer. `pending` is the pre-resolution state — the app renders
 *  neither the shell nor the gate while it holds, so an invited colleague can
 *  never glimpse the owner shell (or the onboarding intro) before we know. */
export type Viewer =
  | { kind: 'pending' }
  | { kind: 'owner' }
  | { kind: 'anon' }
  | {
      kind: 'member'
      userId: number
      companyId: number
      role: string
      displayName: string
      email: string
    }

/** localStorage key holding an access key the viewer pasted into the login gate.
 *  Same role the spliced `window._SUPERMUX_AUTH_TOKEN` plays on a trusted owner
 *  transport — it is the OWNER's own bearer, typed in by hand on a host that (by
 *  design) is never given one. An invited colleague never has one; they arrive
 *  through `/auth/invite`, which mints an HttpOnly cookie instead. */
export const ACCESS_KEY_STORAGE = 'supermux:access-key'

/** Read the pasted access key. Total: private-mode / disabled storage ⇒ `''`. */
export function storedAccessKey(): string {
  try {
    return globalThis.localStorage?.getItem(ACCESS_KEY_STORAGE) ?? ''
  } catch {
    return ''
  }
}

/** Persist a verified access key. Returns false when storage refused it (private
 *  mode) — the caller keeps the session usable but says so honestly. */
export function storeAccessKey(key: string): boolean {
  try {
    globalThis.localStorage?.setItem(ACCESS_KEY_STORAGE, key)
    return true
  } catch {
    return false
  }
}

/** Drop the pasted access key (sign out). */
export function clearAccessKey(): void {
  try {
    globalThis.localStorage?.removeItem(ACCESS_KEY_STORAGE)
  } catch {
    /* private mode — nothing to clear */
  }
}

/**
 * Map a `/auth/me` payload onto a {@link Viewer}. PURE — the one place the
 * owner/member/anon rule is written down.
 *
 * `company_id: null` is the ADMIN-ALL human (`server/src/auth_human/middleware.rs`
 * → `is_admin_or_owner`): company-unscoped, so owner-equivalent for presentation.
 * A `Some(company)` human is a member REGARDLESS of the `role` string — the same
 * conjunct the server uses, so a forged role can never widen the UI either.
 */
export function viewerFromMe(payload: MePayload | null | undefined): Viewer {
  if (!payload || payload.authenticated !== true) return { kind: 'anon' }
  const id = payload.identity ?? {}
  const companyId = id.company_id
  if (typeof companyId !== 'number') return { kind: 'owner' }
  return {
    kind: 'member',
    userId: typeof id.user_id === 'number' ? id.user_id : 0,
    companyId,
    role: typeof id.role === 'string' ? id.role : 'member',
    displayName: typeof id.display_name === 'string' ? id.display_name : '',
    email: typeof id.email === 'string' ? id.email : '',
  }
}

/** Narrowing helper — a member, or `null` for every other viewer. */
export function asMember(v: Viewer): Extract<Viewer, { kind: 'member' }> | null {
  return v.kind === 'member' ? v : null
}

/** Is this viewer allowed to see the OWNER/ADMIN plane — updates, remote hosts,
 *  external access + invite management, company create/delete, the HQ scope?
 *  A `pending` viewer is not (fail-closed: nothing admin renders before we know). */
export function isOwnerPlane(v: Viewer): boolean {
  return v.kind === 'owner'
}

/**
 * Does the member still need to introduce themselves?
 *
 * The owner seeds a colleague row with a placeholder name; until they set one,
 * their chat rows and their avatar monogram have nothing honest to show. The
 * welcome sheet is gated on exactly this, so a member who already has a name
 * never sees it again.
 */
export function needsDisplayName(v: Viewer): boolean {
  return v.kind === 'member' && v.displayName.trim() === ''
}
