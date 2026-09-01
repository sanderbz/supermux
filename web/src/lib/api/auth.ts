// The `/auth/*` client — the identity surface (`server/src/auth_human/router.rs`).
//
// These four calls sit OUTSIDE the bearer-only API client on purpose: they are
// the routes a viewer reaches BEFORE the app knows who they are, and (except for
// the owner's optional bearer) they authenticate by COOKIE. So every request
// here sends `credentials: 'same-origin'`, and the two state-changing ones echo
// the readable `supermux_csrf` cookie in the `x-supermux-csrf` header — the
// server's double-submit check (`auth_human/middleware.rs`).

import { apiUrl } from './client'
import type { MePayload } from '../viewer'

/** The readable CSRF companion cookie the session mint set (NOT HttpOnly, by
 *  design — the SPA has to echo it). `''` when absent. */
export function csrfCookie(): string {
  if (typeof document === 'undefined') return ''
  for (const part of document.cookie.split(';')) {
    const [k, ...rest] = part.trim().split('=')
    if (k === 'supermux_csrf') return decodeURIComponent(rest.join('='))
  }
  return ''
}

/**
 * The href for the Google sign-in button — `GET /auth/login`, reached by a plain
 * full-page NAVIGATION, never by fetch.
 *
 * That is not a stylistic choice: the route answers `302 → accounts.google.com`
 * with `state`/PKCE bound to the inbound Host, and only the browser's own
 * top-level navigation can follow that into Google's consent screen and come
 * back to `/auth/callback` carrying cookies. An XHR would follow the redirect
 * invisibly and land nowhere.
 *
 * Same-origin and base-path aware (an install served under a sub-path). Falls
 * back to the bare path when there is no `window` at all — server-side rendering
 * in the unit tests — so importing this module never throws.
 */
export function googleLoginUrl(): string {
  try {
    return apiUrl('/auth/login')
  } catch {
    return '/auth/login'
  }
}

export const authApi = {
  /**
   * `GET /auth/me` — the resolved identity. Answers for BOTH credentials:
   * an `Authorization: Bearer` (the owner) and the `supermux_hsess` cookie (a
   * human colleague). `token` is passed only by the login gate, which is
   * VERIFYING a freshly pasted key and must not rely on it being stored yet.
   *
   * Never throws: an offline / 5xx / non-JSON answer resolves to
   * `{authenticated:false}` so the caller lands on the gate rather than a blank
   * screen. (The gate distinguishes "wrong key" from "could not reach the
   * server" via {@link verifyAccessKey}.)
   */
  async me(token?: string): Promise<MePayload> {
    try {
      const res = await fetch(apiUrl('/auth/me'), {
        credentials: 'same-origin',
        headers: token ? { Authorization: `Bearer ${token}` } : undefined,
      })
      if (!res.ok) return { authenticated: false }
      return (await res.json()) as MePayload
    } catch {
      return { authenticated: false }
    }
  },

  /** `POST /auth/profile` — the colleague names themselves. Throws on refusal so
   *  the welcome sheet can say what went wrong instead of pretending it saved. */
  async setDisplayName(displayName: string): Promise<void> {
    const res = await fetch(apiUrl('/auth/profile'), {
      method: 'POST',
      credentials: 'same-origin',
      headers: {
        'Content-Type': 'application/json',
        'x-supermux-csrf': csrfCookie(),
      },
      body: JSON.stringify({ display_name: displayName }),
    })
    if (!res.ok) {
      throw new Error(
        res.status === 400
          ? 'Please enter a name of 1–64 characters.'
          : "Couldn't save your name. Please try again.",
      )
    }
  },

  /** `POST /auth/logout` — revoke the session cookie server-side. Best-effort:
   *  the caller clears local state and reloads either way, so a failed round-trip
   *  never strands somebody inside a session they asked to leave. */
  async logout(): Promise<void> {
    try {
      await fetch(apiUrl('/auth/logout'), {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'x-supermux-csrf': csrfCookie() },
      })
    } catch {
      /* offline — local sign-out still proceeds */
    }
  },
}

/** Verification result for a pasted access key — three OUTCOMES, not two, so the
 *  gate can tell "that key is wrong" from "we couldn't reach the server". */
export type KeyCheck = 'ok' | 'rejected' | 'unreachable'

/** Verify a pasted access key by asking `/auth/me` with it as the bearer. */
export async function verifyAccessKey(key: string): Promise<KeyCheck> {
  let res: Response
  try {
    res = await fetch(apiUrl('/auth/me'), {
      credentials: 'same-origin',
      headers: { Authorization: `Bearer ${key}` },
    })
  } catch {
    return 'unreachable'
  }
  if (!res.ok) return 'unreachable'
  let body: MePayload
  try {
    body = (await res.json()) as MePayload
  } catch {
    return 'unreachable'
  }
  return body.authenticated === true ? 'ok' : 'rejected'
}
