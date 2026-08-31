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

/** The minimum a session has to expose for the badge count.
 *
 *  There is deliberately no `notice` field. The badge predicate used to carry a
 *  `notice` term, but no `/api/sessions` row has ever had one: `SessionSummary`
 *  and `ApiSession` have no such property (the server dropped its own `notice`
 *  term in B5/T1.3 — a `Notification` hook fires ~60 s AFTER a turn finishes, so
 *  counting it would relight the home screen a minute after every completed
 *  turn). The term was dead weight that made this predicate LOOK different from
 *  the server's; it is gone, and the two now read the same sentence. */
export interface BadgeSession {
  /** The wire status (`SessionStatus`). Absent = unknown, which counts. */
  status?: string
  permission_request?: unknown
  error?: unknown
}

/** The statuses on which an attention signal is no longer ACTIONABLE.
 *  Mirrors the server's `Status::Stopped` term in `notify::attention_badge`. */
const DEAD_STATUS = 'stopped'

/**
 * Does this ONE session earn a home-screen badge count?
 *
 * ── The actionable rule (the one place it lives, client side) ───────────────
 *
 *   (permission_request || error)  &&  status !== 'stopped'
 *
 * `server/src/notify.rs::attention_badge` encodes the same sentence, so the
 * count the server stamps on a push and the count this page recomputes on every
 * foreground cannot disagree.
 *
 * **Why the status term** (live evidence). The owner's iOS home screen carried a
 * permanent badge "1" from `persoonlijk-assistant`: status `stopped`, error
 * `holder_died`. An in-memory error is only cleared by a `SessionStart` on that
 * same name, so a bot whose terminal died kept the icon lit forever — for a
 * thing the human cannot act on from the home screen. It still renders in-app
 * (the stopped-session card owns the Resume affordance) and it still produced
 * its banner at death time; it just stops keeping a count lit.
 *
 * **Why `permission_request` is gated too, not "always counted"**: verified in
 * `hooks::apply_payload`, a clean `SessionEnd` clears the dialog BEFORE forcing
 * `stopped`, so the pair is unreachable on that path. The only producer of
 * `stopped + permission_request` is an UNCLEAN death (`holder_died`), which
 * records the stop without clearing the dialog — and that dialog died with the
 * pty. One uniform rule, no special case.
 *
 * ARCHIVED needs no term: `GET /api/sessions` lists `archived = 0` only, and an
 * `archived: true` delta REMOVES the row from the cached list, so an archived
 * bot is never in this array.
 */
export function needsAttention(s: BadgeSession | undefined | null): boolean {
  if (!s) return false
  if (s.status === DEAD_STATUS) return false
  return Boolean(s.permission_request) || Boolean(s.error)
}

/**
 * How many bots currently need the human — the home-screen / dock badge.
 *
 * Deliberately the SAME predicate the server uses when it stamps `badge` on a
 * payload (see [`needsAttention`]). The app recomputes it from the sessions
 * snapshot it already holds so the badge self-heals on every foreground, which
 * is what covers the one case the server cannot see — a dialog answered without
 * any subsequent push.
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
  const bots = sessions ? sessions.filter(needsAttention).length : 0
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

/** The message the page posts to the service worker when it comes to the front.
 *
 *  Carries BOTH halves of "what the user now sees": the recomputed badge, and
 *  the exact set of session slots that still need them. The worker closes every
 *  DELIVERED session notification whose tag is not in `tags` — see
 *  `public/push-sw.js::staleSessionTags`.
 *
 *  Why a distinct type from `{type:'badge'}`: a plain badge post happens on
 *  every count change, including while the app sits in the BACKGROUND with a
 *  possibly-stale sessions snapshot. Closing banners off that would race a push
 *  that had just arrived. Foregrounding is the moment the snapshot is freshest
 *  AND the moment a lock-screen card has demonstrably done its job. */
export interface NotificationsSyncMessage {
  type: 'notifications-sync'
  badge: number
  /** `session:<name>` for every bot still needing the human. */
  tags: string[]
}

/** Build that message from the sessions snapshot the page already holds.
 *
 *  The `tags` set uses the SAME predicate as the badge ([`needsAttention`]), so
 *  a bot that no longer counts also no longer keeps a card on the lock screen —
 *  the two surfaces cannot drift apart. `teams` only moves the number: a crew
 *  is not an `/api/sessions` row and owns no notification slot. */
export function notificationsSyncMessage(
  sessions: readonly (BadgeSession & { name?: string })[] | undefined,
  teams?: readonly Team[],
): NotificationsSyncMessage {
  const tags = (sessions ?? [])
    .filter((s) => needsAttention(s) && typeof s.name === 'string' && s.name.length > 0)
    .map((s) => tagForSession(s.name as string))
  return { type: 'notifications-sync', badge: attentionCount(sessions, teams), tags }
}
