/**
 * **What a blocked agent is — TypeScript twin of `chat/agent_error.rs`.**
 * ─────────────────────────────────────────────────────────────────────────────
 * The server already classifies a failure banner it reads out of the
 * transcript, and stamps the result onto the wire entry. So why does this exist
 * at all?
 *
 * Because the transcript is not the only plane a banner arrives on. The
 * `StopFailure` hook forwards the SAME sentence as `last_assistant_message`,
 * and that path reaches the roster — every tile in the overview, the error
 * badge, the push body — WITHOUT a chat store, because `chat_store()` is
 * deliberately non-creating and a roster is exactly the list of sessions nobody
 * has open. On that plane the client holds `error: {type, message}` and nothing
 * else, and "Rate-limited" is not an answer to which of the six buckets it is
 * or when the session comes back.
 *
 * So the same copy is read twice, in two languages, and
 * `server/tests/fixtures/chat/claude-states.jsonl` pins them together — the
 * same discipline `wire-entries.ts`'s wrapper classifier is held to.
 *
 * Pure and dependency-free, like `entries.ts`.
 */

/** Coarse class: what KIND of blocked, for styling and for the badge. */
export type AgentErrorClass = 'limit' | 'throttle' | 'auth' | 'api' | 'error' | 'refusal'

/** Which quota ran out. NOT interchangeable: waiting is the wrong answer to
 *  four of these — `/model` answers two and `/usage-credits` answers one. */
export type LimitBucket = 'session_5h' | 'weekly' | 'opus' | 'sonnet' | 'usage_credit' | 'model'

export interface AgentErrorInfo {
  cls: AgentErrorClass
  /** The bucket, when `cls === 'limit'`. */
  limit?: LimitBucket
  /** Claude Code's own noun phrase, verbatim (`session limit`, `Fable 5
   *  limit`) — so a bucket this map has not seen still shows CC's words. */
  label?: string
  /** The verbatim `· resets …` clause (`4:40am (Europe/Amsterdam)`). */
  resetsAt?: string
  /** Does this stop the session until a human acts? A quota or an auth failure
   *  does; a 529 retry and a server-side throttle do not. */
  blocking: boolean
}

/** CC writes `" · resets "` with U+00B7. */
const RESETS = '· resets '

/**
 * Classify a banner from its text plus whatever the line's own error fields
 * said. Total — an unrecognised banner is still an `error`.
 *
 * The TEXT wins where the hints disagree, because the text is what CC decided
 * to show the human and the class is a coarser bucket: a server-side throttle
 * is `rate_limit` too.
 */
export function classifyAgentError(
  text: string,
  errorClass?: string | null,
  status?: number | null,
): AgentErrorInfo {
  const t = (text ?? '').trim()
  const lower = t.toLowerCase()
  const resetsAt = resetClause(t)

  // 1. THE DISAMBIGUATION CC ITSELF MAKES, and the reason this arm is first:
  //    telling the owner he is out of quota when he is not is the one wrong
  //    answer this module exists to avoid.
  if (lower.includes('not your usage limit')) {
    return { cls: 'throttle', resetsAt, blocking: false }
  }
  // 1b. THE REFUSAL (catalog `err.safeguards_refusal`). Checked before the API
  //     family because it arrives wearing that family's clothes — `API Error:
  //     {Model}'s safeguards flagged this message …` — and it is the opposite of
  //     transient: `stop_reason` was `refusal`, nothing retries, and the turn is
  //     over. Not blocking: sending something ELSE is the remedy, so the composer
  //     stays live.
  if (isRefusalText(lower)) {
    return { cls: 'refusal', resetsAt, blocking: false }
  }
  // 2. Auth — dead until a human runs /login in the terminal.
  if (errorClass === 'authentication_failed' || isAuthText(lower)) {
    return { cls: 'auth', resetsAt, blocking: true }
  }
  // 3. The quota family.
  const bucket = limitBucket(t, lower)
  if (bucket) {
    return { cls: 'limit', limit: bucket.limit, label: bucket.label, resetsAt, blocking: true }
  }
  if (errorClass === 'rate_limit') {
    // A rate_limit whose copy this map has not seen. Still a limit, still
    // blocking, just without a bucket to name.
    return { cls: 'limit', resetsAt, blocking: true }
  }
  // 4. Transient API failures. The turn is damaged, the session is not blocked.
  if (
    errorClass === 'server_error' ||
    (typeof status === 'number' && status >= 500 && status < 600) ||
    lower.startsWith('api error:')
  ) {
    return { cls: 'api', resetsAt, blocking: false }
  }
  return { cls: 'error', resetsAt, blocking: false }
}

function resetClause(text: string): string | undefined {
  const at = text.indexOf(RESETS)
  if (at < 0) return undefined
  const rest = text.slice(at + RESETS.length).trim()
  const clause = (rest.split('\n')[0] ?? '').trim().replace(/\.$/, '')
  return clause || undefined
}

/** The two shapes CC's refusal renderer emits, both anchored on the sentence
 *  only a refusal produces — never on the `API Error:` prefix, which every
 *  transient failure shares. Twin of `agent_error.rs::is_refusal_text`. */
function isRefusalText(lower: string): boolean {
  return (
    lower.includes('safeguards flagged this message') ||
    ((lower.includes("can't help with this") || lower.includes('can’t help with this')) &&
      lower.includes('start a new session'))
  )
}

function isAuthText(lower: string): boolean {
  return (
    lower.includes('run /login') ||
    lower.includes('session expired') ||
    lower.includes('session has expired') ||
    lower.includes('401 invalid api key') ||
    lower.includes('sign in again')
  )
}

function limitBucket(
  text: string,
  lower: string,
): { limit: LimitBucket; label?: string } | undefined {
  // Credit exhaustion first: "You're out of usage credits" carries no "limit"
  // noun, and a monthly SPEND limit is a credit limit rather than a plan one.
  if (
    lower.includes('out of usage credit') ||
    lower.includes('monthly spend limit') ||
    lower.includes('requires usage credits') ||
    lower.includes('usage credits are required') ||
    lower.includes('out of usage ') ||
    lower.includes('usage allocation has been disabled')
  ) {
    return { limit: 'usage_credit' }
  }
  const label = nounPhrase(text)
  if (!label) return undefined
  const l = label.toLowerCase()
  const limit: LimitBucket = l.startsWith('session limit')
    ? 'session_5h'
    : l.startsWith('weekly limit')
      ? 'weekly'
      : l.startsWith('opus limit')
        ? 'opus'
        : l.startsWith('sonnet limit')
          ? 'sonnet'
          : l.startsWith('usage credit limit')
            ? 'usage_credit'
            : // `seven_day_overage_included` renders the MODEL's name ("Fable 5
              // limit"), and CC resolves some buckets at runtime — so an unknown
              // noun phrase is a model-scoped limit carrying its own words.
              'model'
  return { limit, label }
}

/** The `{label}` slot of CC's two banner templates, verbatim. */
function nounPhrase(text: string): string | undefined {
  const heads = ["You've hit your ", 'You’ve hit your ', "You've reached your ", 'You’ve reached your ']
  let rest: string | undefined
  for (const h of heads) {
    const i = text.indexOf(h)
    if (i >= 0) {
      rest = text.slice(i + h.length)
      break
    }
  }
  if (rest === undefined) return undefined
  let end = rest.length
  for (const stop of [' ·', '. ', '\n']) {
    const i = rest.indexOf(stop)
    if (i >= 0) end = Math.min(end, i)
  }
  const label = rest.slice(0, end).trim().replace(/\.$/, '').trim()
  // "limit" is the noun every template ends on; a slot without it is not one of
  // these banners ("You've hit your stride").
  if (!label || !label.toLowerCase().endsWith('limit')) return undefined
  return label
}

/** Human name for a bucket — the words the amber card and the tile badge say.
 *
 *  `label` (CC's own noun phrase) wins when we have it, so a bucket added in a
 *  patch release reads correctly before this map knows about it. */
export function limitName(info: AgentErrorInfo): string {
  if (info.label) return capitalise(info.label)
  switch (info.limit) {
    case 'session_5h':
      return 'Session limit'
    case 'weekly':
      return 'Weekly limit'
    case 'opus':
      return 'Opus limit'
    case 'sonnet':
      return 'Sonnet limit'
    case 'usage_credit':
      return 'Usage credits'
    default:
      return 'Usage limit'
  }
}

function capitalise(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1)
}

/**
 * The badge word for the roster tile, derived from the hook's `(type, message)`
 * pair — the plane that has no chat store behind it.
 *
 * This is what turns `⚠ Error` on every dead session into the sentence that
 * says which one it is. `null` when the pair carries nothing more specific than
 * the caller already knows.
 */
export function errorBadgeLabel(type: string, message?: string): string | null {
  const info = classifyAgentError(message ?? '', type)
  // The throttle arm comes FIRST and it is the whole reason this is a function
  // rather than a lookup: CC sends a server-side throttle with `rate_limit` as
  // its class and then says in prose that it is not your usage limit. A badge
  // keyed on the class alone tells the owner he is out of quota when he is not.
  if (info.cls === 'throttle') return 'Server busy'
  if (type === 'rate_limit' || info.cls === 'limit') {
    return info.limit || info.label ? limitName(info) : 'Rate-limited'
  }
  switch (type) {
    case 'billing_error':
      return 'Billing'
    case 'authentication_failed':
      return 'Auth error'
    case 'server_error':
      return 'Server error'
    case 'holder_died':
      return 'Terminal died'
    default:
      return info.cls === 'auth' ? 'Auth error' : null
  }
}

/**
 * The one line under the badge that answers "when can I work again".
 * `undefined` when the banner carried no reset clause — which is honest: four
 * of the six buckets are answered by a slash command rather than by a clock.
 */
export function resetNote(info: AgentErrorInfo): string | undefined {
  return info.resetsAt ? `Resets ${info.resetsAt}` : undefined
}
