/**
 * `<LoginGate>` — the full-screen sign-in wall for an ANONYMOUS visitor.
 * ─────────────────────────────────────────────────────────────────────────────
 * OWNER BUG #1: opening the app URL on a company / quick-tunnel host with no
 * credentials rendered the Bot-Mode onboarding intro — a five-screen story
 * pitching a product the visitor cannot use, before any login existed. There was
 * no login screen at all: the web client had no identity concept, so an
 * unauthenticated shell simply behaved like a signed-in one with a broken API.
 *
 * This replaces the entire app for `viewer.kind === 'anon'`, mounted ABOVE the
 * routes and above `<OnboardingHost>` (App.tsx), so nothing else can paint first.
 *
 * Two audiences, one screen:
 *   • the OWNER, reaching their own box on a host that (by design) never gets the
 *     spliced admin bearer — they paste their access key. It is VERIFIED against
 *     `/auth/me` before it is stored, so a wrong key can never be persisted into
 *     a half-broken session.
 *   • an INVITED colleague, who has no key at all — they open their invite link,
 *     which mints the session cookie server-side. That is the secondary line.
 *
 * OWNER BUG #2 (this change): on a company host with Google OIDC configured and
 * verified "Ready", the gate STILL showed only "This is a private workspace /
 * Access key". `GET /auth/login` had been running the full OIDC start the whole
 * time — the client simply had no way to know it existed. So the anonymous
 * `/auth/me` answer now carries `login.google`, computed by the server with the
 * SAME checks `/auth/login` performs, and where it is true this screen leads
 * with the Google button and folds the access key away behind one line of text.
 * Where it is false the screen is UNCHANGED, byte for byte: an invite-only /
 * quick-tunnel box must not grow a button that answers 404.
 *
 * Mobile-first: one column, 44px targets, safe-area padding, nothing wider than
 * the viewport at 390px. Theme-correct in both light and dark (all colours are
 * semantic tokens, so the shell's `.dark` class drives it).
 */
import * as React from 'react'

import { Logo } from '@/components/logo'
import { googleLoginUrl, verifyAccessKey } from '@/lib/api/auth'
import { storeAccessKey } from '@/lib/viewer'

export interface LoginGateProps {
  /** Called with the verified key once the server has accepted it. Defaults to a
   *  full reload, which is what production wants: every store, query and socket
   *  re-reads the now-authenticated world from scratch. Injected by tests. */
  onAuthenticated?: (key: string) => void
  /** Does THIS host actually offer Google sign-in? Straight from the anonymous
   *  `/auth/me` answer (`<ViewerBoundary>` passes it), which the server computes
   *  with the same `enabled()` + allowlisted-Host pair `/auth/login` itself
   *  checks — so a true here means the button's target really does redirect to
   *  Google. Defaults to false: fail closed, never advertise a dead route. */
  google?: boolean
}

export function LoginGate({ onAuthenticated, google = false }: LoginGateProps) {
  const [key, setKey] = React.useState('')
  const [busy, setBusy] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)
  // Only meaningful when Google is on offer: the key field starts folded away so
  // the screen asks ONE question. Without Google there is nothing to fold behind
  // — the key IS the sign-in — so the form is simply always open.
  const [keyOpen, setKeyOpen] = React.useState(false)
  const showKeyForm = !google || keyOpen

  const submit = async (e: React.FormEvent) => {
    e.preventDefault()
    const candidate = key.trim()
    if (!candidate || busy) return
    setBusy(true)
    setError(null)
    const result = await verifyAccessKey(candidate)
    if (result === 'ok') {
      // Honest about the ONE way this can half-succeed: the key works, but
      // private-mode storage refused to keep it, so the next load asks again.
      const kept = storeAccessKey(candidate)
      if (!kept) {
        setError("Signed in, but this browser wouldn't remember the key.")
      }
      if (onAuthenticated) {
        onAuthenticated(candidate)
      } else {
        window.location.reload()
      }
      return
    }
    setBusy(false)
    setError(
      result === 'rejected'
        ? "That access key wasn't accepted."
        : "Couldn't reach the server. Check your connection and try again.",
    )
  }

  return (
    <div
      data-login-gate=""
      className="flex min-h-dvh w-full flex-col items-center justify-center bg-background px-6 py-10 pb-safe pt-safe text-foreground"
    >
      <div className="w-full max-w-sm">
        <div className="flex flex-col items-center text-center">
          <Logo className="h-10 w-auto" />
          <h1 className="mt-5 text-xl font-semibold tracking-tight">
            This is a private workspace
          </h1>
          <p className="mt-2 text-sm text-muted-foreground">
            Sign in to continue.
          </p>
        </div>

        {/* THE PRIMARY PATH where it exists. A plain anchor, not a fetch and not a
            popup: `/auth/login` answers `302 → accounts.google.com` with
            state/PKCE bound to this Host, and only a top-level navigation can
            follow that to the consent screen and back to `/auth/callback`. */}
        {google && (
          <a
            href={googleLoginUrl()}
            data-google-signin=""
            className="mt-7 flex h-11 w-full items-center justify-center gap-2.5 rounded-lg bg-primary px-4 text-base font-medium text-primary-foreground"
          >
            <GoogleMark />
            Sign in with Google
          </a>
        )}

        {/* The owner's own way in, stepped back to one line. It is still here,
            still verified the same way — it is just no longer the first thing a
            colleague is asked for on a box where Google works. */}
        {google && !keyOpen && (
          <button
            type="button"
            onClick={() => setKeyOpen(true)}
            className="mt-4 h-11 w-full rounded-lg text-sm text-muted-foreground underline-offset-4 hover:underline"
          >
            I have an access key
          </button>
        )}

        {showKeyForm && (
          <form
            onSubmit={submit}
            className={
              google ? 'mt-5 flex flex-col gap-3' : 'mt-7 flex flex-col gap-3'
            }
          >
            <label htmlFor="supermux-access-key" className="text-sm font-medium">
              Access key
            </label>
            <input
              id="supermux-access-key"
              name="access-key"
              type="password"
              value={key}
              autoComplete="current-password"
              autoCapitalize="off"
              autoCorrect="off"
              spellCheck={false}
              // Opened by hand ⇒ put the caret where they just asked to type.
              // Never on the Google-less gate, where the field is the whole
              // screen and stealing focus on load helps nobody.
              autoFocus={keyOpen}
              placeholder="Paste your access key"
              aria-invalid={error ? true : undefined}
              aria-describedby={error ? 'supermux-access-key-error' : undefined}
              onChange={(e) => {
                setKey(e.target.value)
                if (error) setError(null)
              }}
              className="h-11 w-full rounded-lg border border-input bg-card px-3 text-base outline-none placeholder:text-muted-foreground focus-visible:ring-2 focus-visible:ring-ring"
            />
            {error && (
              <p
                id="supermux-access-key-error"
                role="alert"
                className="text-sm text-destructive"
              >
                {error}
              </p>
            )}
            <button
              type="submit"
              disabled={busy || key.trim() === ''}
              className={
                google
                  ? 'h-11 w-full rounded-lg border border-input bg-secondary text-base font-medium text-secondary-foreground transition-opacity disabled:opacity-50'
                  : 'h-11 w-full rounded-lg bg-primary text-base font-medium text-primary-foreground transition-opacity disabled:opacity-50'
              }
            >
              {busy ? 'Checking…' : 'Connect'}
            </button>
          </form>
        )}

        {/* The invited colleague's path. They have no key — the magic link IS
            their credential (`GET /auth/invite?token=…` mints the cookie). */}
        <p className="mt-6 text-center text-sm text-muted-foreground">
          Got an invite link? Open it — it signs you in.
        </p>
      </div>
    </div>
  )
}

/** The Google "G", official four-colour mark, in a white disc so it stays legible
 *  on the primary surface in BOTH themes. Decorative: the button's own text says
 *  what it does, so the glyph is `aria-hidden`. */
function GoogleMark() {
  return (
    <span
      aria-hidden="true"
      className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-white"
    >
      <svg viewBox="0 0 48 48" className="h-3.5 w-3.5" focusable="false">
        <path
          fill="#4285F4"
          d="M45.12 24.5c0-1.56-.14-3.06-.4-4.5H24v8.51h11.84c-.51 2.75-2.06 5.08-4.39 6.64v5.52h7.11c4.16-3.83 6.56-9.47 6.56-16.17z"
        />
        <path
          fill="#34A853"
          d="M24 46c5.94 0 10.92-1.97 14.56-5.33l-7.11-5.52c-1.97 1.32-4.49 2.1-7.45 2.1-5.73 0-10.58-3.87-12.31-9.07H4.34v5.7C7.96 41.07 15.4 46 24 46z"
        />
        <path
          fill="#FBBC05"
          d="M11.69 28.18C11.25 26.86 11 25.45 11 24s.25-2.86.69-4.18v-5.7H4.34C2.85 17.09 2 20.45 2 24s.85 6.91 2.34 9.88l7.35-5.7z"
        />
        <path
          fill="#EA4335"
          d="M24 10.75c3.23 0 6.13 1.11 8.41 3.29l6.31-6.31C34.91 4.18 29.93 2 24 2 15.4 2 7.96 6.93 4.34 14.12l7.35 5.7c1.73-5.2 6.58-9.07 12.31-9.07z"
        />
      </svg>
    </span>
  )
}
