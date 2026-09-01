// THE VIEWER STORE — resolved ONCE at boot, then read everywhere.
//
// The shell may not render until this has an answer: an invited colleague must
// never glimpse the owner's HQ shell (or the Bot-Mode onboarding intro) while a
// fetch is in flight. `App.tsx` mounts `<ViewerBoundary>` above the routes to
// enforce exactly that.
//
// THE OWNER PATH IS SYNCHRONOUS AND UNCHANGED. When the SPA shell carries the
// spliced admin bearer (`window._SUPERMUX_AUTH_TOKEN` — a trusted owner
// transport), or we are on a `?mock` / `/dev/*` bench, the INITIAL state is
// already `{kind:'owner'}`: no fetch, no suspense, no extra frame, so every
// existing e2e path and every owner load is byte-identical. Only a
// token-less shell (a company / quick-tunnel host) pays for the `/auth/me`
// round-trip — and that shell had no working app before this.

import { create } from 'zustand'

import { authApi } from '@/lib/api/auth'
import {
  clearAccessKey,
  loginCapabilitiesFromMe,
  NO_LOGIN_CAPABILITIES,
  storedAccessKey,
  viewerFromMe,
  type LoginCapabilities,
  type Viewer,
} from '@/lib/viewer'
import { useUI } from '@/stores/ui-store'

/** `?mock` / `/dev/*` — the offline benches, which have no server to ask and are
 *  authored as the owner's view. DEV-gated: in a production bundle neither a
 *  query param nor a path may skip the identity check. */
function devOwnerEquivalent(): boolean {
  if (!import.meta.env.DEV) return false
  if (typeof window === 'undefined') return false
  if (new URLSearchParams(window.location.search).has('mock')) return true
  return window.location.pathname.startsWith('/dev/')
}

/** The owner short-circuit: a spliced bearer, or a dev bench. */
export function isOwnerShell(): boolean {
  if (typeof window !== 'undefined' && window._SUPERMUX_AUTH_TOKEN) return true
  return devOwnerEquivalent()
}

/** The state the store opens on — `owner` with zero async work when the shell
 *  carries the bearer, otherwise `pending` until `/auth/me` answers. */
function initialViewer(): Viewer {
  return isOwnerShell() ? { kind: 'owner' } : { kind: 'pending' }
}

interface ViewerStore {
  viewer: Viewer
  /** Which sign-in paths this box offers on THIS host, straight from the same
   *  anonymous `/auth/me` answer that produced `anon`. Only the login gate reads
   *  it; it stays fail-closed (`google:false`) for an owner shell, which never
   *  makes the call, and for any answer that did not say otherwise. */
  login: LoginCapabilities
  /** Has a resolution round-trip already been started? (StrictMode double-mounts
   *  every effect in dev; this keeps that to ONE request.) */
  started: boolean
  /** Ask `/auth/me` and adopt the answer. No-op for an owner shell. */
  resolve: () => Promise<void>
  /** Adopt an identity we already hold (the login gate, after verifying a key). */
  adopt: (v: Viewer) => void
  /** Local sign-out: drop any stored access key and fall back to the gate. The
   *  caller revokes the server session (`POST /auth/logout`) and reloads. */
  signOut: () => void
}

export const useViewer = create<ViewerStore>()((set, get) => ({
  viewer: initialViewer(),
  login: NO_LOGIN_CAPABILITIES,
  started: false,
  resolve: async () => {
    if (get().started) return
    set({ started: true })
    if (isOwnerShell()) {
      applyViewer({ kind: 'owner' })
      set({ viewer: { kind: 'owner' } })
      return
    }
    // A pasted access key rides as the bearer; a colleague's cookie rides on its
    // own (`credentials: 'same-origin'`).
    const key = storedAccessKey()
    const payload = await authApi.me(key || undefined)
    const next = viewerFromMe(payload)
    applyViewer(next)
    // The capabilities ride along with the identity: ONE round-trip answers both
    // "who is this" and "what may we offer them", so the gate never flashes an
    // access-key-only face and then grows a Google button a moment later.
    set({ viewer: next, login: loginCapabilitiesFromMe(payload) })
  },
  adopt: (v) => {
    applyViewer(v)
    set({ viewer: v, started: true })
  },
  signOut: () => {
    clearAccessKey()
    set({ viewer: { kind: 'anon' }, started: true })
  },
}))

/**
 * Push the consequences of an identity into the UI store — the MEMBER LOCK.
 *
 * A member is data-fenced server-side to one company; the presentation has to
 * agree, and it has to agree DERIVED rather than written-once: persisted state
 * from a previous visit (`supermux-ui` in localStorage) and any later UI action
 * must both be unable to escape it. So this does two things:
 *
 *   • sets `botMode` on and `activeCompany` to their company — an invited user is
 *     ALWAYS in bot mode; there is no HQ scope for them; and
 *   • raises `memberCompany`, which makes `setBotMode` / `setActiveCompany`
 *     no-ops for as long as it holds (see ui-store.ts).
 *
 * Called before the shell mounts, so `<Layout>`'s mount-time read of `botMode`
 * already sees the locked value. For an owner it is a pure no-op.
 */
function applyViewer(v: Viewer): void {
  if (v.kind === 'member') {
    useUI.getState().lockToCompany(v.companyId)
  }
}

/** Selector: the current viewer. */
export function useViewerIdentity(): Viewer {
  return useViewer((s) => s.viewer)
}

/** Selector: is the viewer an invited, company-scoped colleague? The one
 *  predicate every presentation fence reads, so "what a member may see" is
 *  spelled the same way everywhere. */
export function useIsMember(): boolean {
  return useViewer((s) => s.viewer.kind === 'member')
}

/** Selector: may this viewer see the OWNER/ADMIN plane — updates, remote hosts,
 *  external access + invite management, company create/delete, the HQ scope?
 *  False while `pending` too (fail-closed: no admin affordance paints before we
 *  know who is looking). */
export function useIsOwnerPlane(): boolean {
  return useViewer((s) => s.viewer.kind === 'owner')
}
