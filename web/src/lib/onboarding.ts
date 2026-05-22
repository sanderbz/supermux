// First-launch / onboarding state (M27 — Time to Wow).
//
// The whole "first 60 seconds" experience keys off ONE localStorage flag:
// `amux-v3-first-launch`. Absent → this is a brand-new install and the
// unboxing surfaces (welcome banner + tour, or the demo-agent CTA) are eligible
// to show. Present → the user has been here; everything stays quiet.
//
// Two branches are decided at runtime by the OnboardingHost (§M27):
//   1. v2 data was migrated  — sessions exist AND the flag is absent → a
//      non-blocking "welcome back" banner + a 3-step tour overlay.
//   2. fresh, no sessions yet — the overview's own empty state carries the
//      primary "boot your first agent" CTA plus a one-tap demo-agent button.
//
// All reads/writes are wrapped: Safari private mode throws on localStorage, and
// a thrown flag-read must NOT crash the app — it just means the surface shows
// again next session, which is acceptable for an onboarding hint.

/** The single source-of-truth key. Namespaced like every other amux-v3 key. */
export const FIRST_LAUNCH_KEY = 'amux-v3-first-launch'

/** localStorage key tracking the one demo session amux booted for the user, so
 *  "Run the 30-second demo" can delete exactly that session on replay and never
 *  touch a real one. */
export const DEMO_SESSION_KEY = 'amux-v3-demo-session'

/** True when this looks like a brand-new install — the first-launch flag has
 *  never been written. Safe to call at first render (reads only localStorage).
 *  Defaults to `false` (treat as a returning user) if storage is unavailable,
 *  so a private-mode tab never gets stuck replaying the unboxing forever. */
export function isFirstLaunch(): boolean {
  try {
    return localStorage.getItem(FIRST_LAUNCH_KEY) == null
  } catch {
    return false
  }
}

/** Mark the unboxing as seen. Idempotent; survives a storage failure silently. */
export function completeFirstLaunch(): void {
  try {
    localStorage.setItem(FIRST_LAUNCH_KEY, String(Date.now()))
  } catch {
    /* private mode — the hint simply shows again next session */
  }
}

/** Clear the flag so the unboxing replays on the next visit to `/`. Used by
 *  Settings → "Run the 30-second demo". */
export function resetFirstLaunch(): void {
  try {
    localStorage.removeItem(FIRST_LAUNCH_KEY)
  } catch {
    /* nothing to clear */
  }
}

/** Remember the name of the demo session amux booted, so the replay flow can
 *  delete precisely that one. */
export function rememberDemoSession(name: string): void {
  try {
    localStorage.setItem(DEMO_SESSION_KEY, name)
  } catch {
    /* fine — replay will simply skip the delete step */
  }
}

/** The remembered demo-session name, or `null` if none was booted. */
export function getDemoSession(): string | null {
  try {
    return localStorage.getItem(DEMO_SESSION_KEY)
  } catch {
    return null
  }
}

/** Forget the demo session (after it has been deleted). */
export function forgetDemoSession(): void {
  try {
    localStorage.removeItem(DEMO_SESSION_KEY)
  } catch {
    /* nothing to clear */
  }
}
