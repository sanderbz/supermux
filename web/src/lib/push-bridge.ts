// The in-app half of the notification pipeline.
//
// The service worker hands every push to open windows, whether or not it showed
// a banner. Until now nothing listened — the payload went into a void. This
// module decides what the APP does with one, and keeps the home-screen badge
// honest while the app is in front.
//
// The rules live here as PURE functions so they are unit-testable and so there
// is exactly one place that answers "should this interrupt the user":
//
//   * a BLOCKING tier (attention / error) earns an in-app toast — the user is
//     looking at something else in the app and needs to know a bot is stuck;
//   * a CALM tier (unread / schedule) shows nothing in-app. The roster's own
//     tier dot already carries it, and a toast for "a turn finished" is exactly
//     the noise this redesign exists to remove.

import type { ToastTone } from '@/components/ui/use-toast'
import { needsYouCount, type Team } from '@/lib/api/teams'

/** The payload shape the server sends (server/src/notify.rs::PushPayload). */
export interface PushPayload {
  title: string
  body: string
  url: string
  tier: 'attention' | 'unread' | 'error' | 'schedule'
  session?: string | null
  badge?: number
  icon?: string
  tag?: string
  renotify?: boolean
}

/** What the app should surface for a push that arrived while it is open.
 *  `null` = show nothing (the calm tiers). */
export interface PushToast {
  message: string
  tone: ToastTone
  /** Where tapping it should go — the same deep link the banner uses. */
  url: string
}

/**
 * Should this push interrupt the user in-app, and how?
 *
 * The title is the bot's name and the body is the agent's own words, so the
 * toast reads as "deploy-fix: Needs permission — …" — the same sentence the
 * lock screen shows, because it is the same string.
 */
export function toastForPush(payload: PushPayload | undefined | null): PushToast | null {
  if (!payload || !payload.body) return null
  if (payload.tier !== 'attention' && payload.tier !== 'error') return null
  const title = (payload.title || '').trim()
  return {
    message: title ? `${title}: ${payload.body}` : payload.body,
    tone: payload.tier === 'error' ? 'error' : 'waiting',
    url: payload.url || '/',
  }
}

/** The minimum a session has to expose for the badge count. */
export interface BadgeSession {
  permission_request?: unknown
  notice?: string | null
  error?: unknown
}

/**
 * How many bots currently need the human — the home-screen / dock badge.
 *
 * Deliberately the SAME predicate the server uses when it stamps `badge` on a
 * payload: a live permission dialog, an unanswered notice, or an uncleared
 * error. The app recomputes it from the sessions snapshot it already holds so
 * the badge self-heals on every foreground, which is what covers the one case
 * the server cannot see — a dialog answered without any subsequent push.
 *
 * ── The team term, and its asymmetry (Phase 5c) ─────────────────────────────
 * `teams` adds `Σ needsYouCount(t)` so the badge is honest about a crew that is
 * waiting on you, not just standalone bots. It is deliberately NOT run through
 * the seen-cursor machinery `use-attention.ts` owns: a teammate is not an
 * `/api/sessions` row and has no per-device seen-cursor, and a team's `needs_you`
 * comes straight off the inbox file — it is a LIVE demand, not an "unread since I
 * last looked" signal. Marking a teammate read is meaningless, so nothing here
 * tries to; the term clears the moment the crew stops needing you.
 */
export function attentionCount(
  sessions: readonly BadgeSession[] | undefined,
  teams?: readonly Team[],
): number {
  const bots = sessions
    ? sessions.filter(
        (s) => Boolean(s.permission_request) || Boolean(s.notice) || Boolean(s.error),
      ).length
    : 0
  const crew = teams ? teams.reduce((n, t) => n + needsYouCount(t), 0) : 0
  return bots + crew
}

/** The coalescing slot for a session — must match `notify::tag_for`. */
export function tagForSession(session: string): string {
  return `session:${session}`
}

/** The session a `/focus/<name>` path is about, or `null` for anywhere else.
 *  Used to tell the SW which banner the user has just made stale. */
export function sessionFromPath(pathname: string | undefined): string | null {
  if (!pathname) return null
  const m = /^\/focus\/([^/?#]+)/.exec(pathname)
  return m ? decodeURIComponent(m[1]) : null
}
