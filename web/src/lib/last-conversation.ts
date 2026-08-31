/**
 * "Open where I left off" — the PURE half.
 * ─────────────────────────────────────────────────────────────────────────────
 * Two facts survive a page load today: the active company scope
 * (`ui-store.activeCompany`) and, from here on, the conversation that was OPEN
 * inside that scope. This module owns the second one's shape, its per-scope
 * bookkeeping and — the load-bearing part — the rule that decides whether a
 * remembered conversation may be reopened at all.
 *
 * Everything here is `window`-free and React-free so the rule is unit-tested as
 * itself (`tests/unit/resume-last-conversation.test.ts`) rather than through a
 * rendered roster.
 *
 * THE HONESTY RULE. A remembered conversation is reopened only when it still
 * exists AND still belongs to the scope we are restoring into. Anything else —
 * archived, deleted, moved to another company, a member whose fence has moved,
 * a blob from another install, an explicit deep link that says otherwise —
 * restores NOTHING, silently. Never an error, and never someone else's thread.
 */

import { inCompanyScope } from '@/lib/companies'

/** The conversation surfaces the roster can reopen. A team is deliberately NOT
 *  one of them: a crew list is a roster view, not a conversation, and selecting
 *  one CLEARS the memory rather than growing a third arm no one asked for. */
export type LastConversation =
  | { kind: 'bot'; name: string }
  | { kind: 'channel' }

/** The persisted map's key: one entry per browse scope, so switching back to a
 *  company reopens what was open THERE, not what was open in HQ. */
export function scopeKey(activeCompany: number | null): string {
  return activeCompany === null ? 'hq' : `c:${activeCompany}`
}

/** How many scopes we remember. The map is a convenience, not a history: a
 *  bounded LRU keeps a long-lived localStorage blob from growing without end
 *  (the same discipline `capPins` applies to the renderer pins). */
export const MAX_REMEMBERED_SCOPES = 12

/** Shape guard for one persisted entry — a hand-edited / older / foreign blob
 *  must never reach the roster as a half-typed object. */
export function isLastConversation(v: unknown): v is LastConversation {
  if (!v || typeof v !== 'object') return false
  const k = (v as { kind?: unknown }).kind
  if (k === 'channel') return true
  if (k !== 'bot') return false
  const name = (v as { name?: unknown }).name
  return typeof name === 'string' && name.length > 0
}

/** Read one scope's remembered conversation out of a persisted map, validating
 *  it on the way. Anything unrecognised reads as `null` (= remember nothing),
 *  which is exactly how an OLDER blob — one written before this field existed —
 *  behaves. */
export function readConversation(
  map: Readonly<Record<string, LastConversation>> | undefined,
  key: string,
): LastConversation | null {
  if (!map || typeof map !== 'object') return null
  const v = (map as Record<string, unknown>)[key]
  return isLastConversation(v) ? v : null
}

/**
 * Write one scope's conversation into the map, LRU-capped.
 *
 * `next === null` forgets that scope (the user closed the pane). A write always
 * moves its key to the end, so the cap drops the least-recently-opened scope
 * rather than an arbitrary one. Returns the SAME object reference when nothing
 * changed, so a store `set` off this helper cannot loop.
 */
export function rememberConversation(
  map: Readonly<Record<string, LastConversation>>,
  key: string,
  next: LastConversation | null,
): Record<string, LastConversation> {
  // A hand-edited / foreign blob can hand us anything; treat a non-object as an
  // empty memory rather than throwing on the way through the store.
  const src: Readonly<Record<string, LastConversation>> =
    map && typeof map === 'object' ? map : {}
  const current = readConversation(src, key)
  const same =
    next === null
      ? current === null
      : current !== null &&
        current.kind === next.kind &&
        (next.kind !== 'bot' || (current as { name: string }).name === next.name)
  // Already the freshest entry with the same value ⇒ nothing to write.
  if (same && (next === null || Object.keys(src).at(-1) === key)) {
    return src as Record<string, LastConversation>
  }

  const out: Record<string, LastConversation> = {}
  for (const [k, v] of Object.entries(src)) {
    if (k === key) continue
    if (isLastConversation(v)) out[k] = v
  }
  if (next !== null) out[key] = next

  const keys = Object.keys(out)
  if (keys.length <= MAX_REMEMBERED_SCOPES) return out
  const trimmed: Record<string, LastConversation> = {}
  for (const k of keys.slice(keys.length - MAX_REMEMBERED_SCOPES)) trimmed[k] = out[k]!
  return trimmed
}

/** The minimum a session row has to carry for the eligibility rule. */
export interface ScopedSession {
  name: string
  company_id?: number | null
}

export interface RestoreInput {
  /** What was remembered for the scope being restored into. */
  saved: LastConversation | null
  /** The scope the roster actually resolved to for this load. */
  activeCompany: number | null
  /** The member lock (`ui-store.memberCompany`) — `null` for the owner. */
  memberCompany?: number | null
  /** The FULL live session list (never a search/hide-stopped view — a merely
   *  hidden bot is still a bot you may return to). */
  sessions: readonly ScopedSession[]
  /** Does the active company have a group channel right now (its Router session
   *  exists)? Mirrors `useCompanyChannel().enabled`. */
  channelAvailable: boolean
  /** An explicit deep link (a `/company/:id/chat` hop, a `?session=` style
   *  link) is already opening something. It WINS — a remembered conversation
   *  must never fight a URL the user just followed. */
  deepLinkActive?: boolean
}

/**
 * May the remembered conversation be reopened, and as what?
 *
 * `null` ⇒ restore nothing (and say nothing). The four ways to get there are the
 * honesty rule spelled out: an explicit deep link owns the surface; the bot is
 * gone (archived / deleted); the bot moved out of the scope we are restoring
 * into; or the channel we remembered is not available in this scope.
 */
export function restorableConversation(input: RestoreInput): LastConversation | null {
  const {
    saved,
    activeCompany,
    memberCompany = null,
    sessions,
    channelAvailable,
    deepLinkActive = false,
  } = input

  if (deepLinkActive) return null
  if (!isLastConversation(saved)) return null

  // THE MEMBER LOCK. A member's scope is pinned server-side; if the scope we are
  // restoring into is not their company, restore nothing rather than reason
  // about it. (`setActiveCompany` is already sealed under the lock, so this is
  // a belt-and-braces fence, not the only one.)
  if (memberCompany !== null && activeCompany !== memberCompany) return null

  if (saved.kind === 'channel') {
    // HQ has no channel, and neither does a company that never opted in.
    if (activeCompany === null) return null
    return channelAvailable ? saved : null
  }

  const row = sessions.find((s) => s.name === saved.name)
  if (!row) return null
  // The SAME scope predicate the roster filters its rows with — imported, never
  // restated, so a restored thread can never appear under a scope that would not
  // list it.
  if (!inCompanyScope(row.company_id, activeCompany)) return null
  return saved
}
