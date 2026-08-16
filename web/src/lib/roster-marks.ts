/**
 * One roster, one set of faces.
 * ─────────────────────────────────────────────────────────────────────────────
 * B0 shipped the character engine (`brand/marks/character.ts`): 9 silhouettes ×
 * 7 pigments = 63 identity tokens, and `assignRoster()`, which probes each
 * name's own hash position for the cheapest free token so a roster of ≤ 63 gets
 * 63 guaranteed-distinct faces. What B0 did NOT ship is a caller: `assignRoster`
 * was consumed only by `/dev/marks`' dedupe panel, so in the product every mark
 * was hash-pure and two sessions could — and at ~20 sessions, with ~99%
 * probability, did — wear the same silhouette in the same pigment. Which
 * destroys the one thing the mark exists for.
 *
 * This module is that caller, and it is deliberately the ONLY one: the pins are
 * computed once per roster change by `hooks/use-roster-marks.ts` and read per
 * row through `usePin(name)`. Computing them per row would be both O(n²) and
 * wrong — dedupe is a property of the roster, not of a row.
 *
 * ── Order is creation order ──────────────────────────────────────────────────
 * `assignRoster` is order-sensitive by construction (each seed takes the
 * cheapest token still free), so the order it is fed IS the stability contract.
 * Feeding it the *rendered* order would repaint half the roster every time you
 * changed the sort. Feeding it creation order (`created_at`, tie-broken by the
 * immutable slug) means a pin only ever depends on the sessions that existed
 * before it — so deleting a session never moves anyone else's face, and a new
 * session lands at the tail without disturbing the roster it joins.
 *
 * ── Overrides are seated first ───────────────────────────────────────────────
 * T8's reroll persists ONE nullable `mark_pin` column, and a user's explicit
 * choice outranks the deduper. So overrides claim their token before assignment
 * runs, and the derived roster fills in around them.
 *
 * ── Why this is first-fit and not `assignRoster`'s balanced cost ─────────────
 * This is the one place where B2 knowingly declines to call the engine's
 * allocator, so the reason is written down rather than left to be rediscovered.
 *
 * `assignRoster` (character.ts:494) minimises
 * `usedPair·10000 + usedSilhouette·100 + usedHue`, which SPREADS a roster
 * evenly over the wheel: a session is moved off its hash-pure token merely
 * because its pigment has been used once already. That is the right allocator
 * for `/dev/marks`' 63-token demo — and it is fatal for a live roster, because
 * the counts depend on the entire prefix. Archive one old session and every
 * later colleague's pigment can change. Measured, not assumed: on the 14-name
 * fixture in `roster-marks.test.ts`, deleting the first row repainted two
 * survivors under the balanced cost.
 *
 * A face that moves when an unrelated session is deleted is not a face. So the
 * assignment here is FIRST-FIT from each seed's own hash position, walking the
 * engine's own 63-token cycle with the engine's own coprime step:
 *
 *   · distinctness is preserved exactly as strongly — the probe visits all 63
 *     tokens, so distinct pairs are still *guaranteed* for n ≤ 63;
 *   · a seed only ever moves off its hash-pure token when that token is already
 *     worn, so most faces are hash-pure — the property the engine's own doc
 *     calls out for a solo session, generalised to the roster;
 *   · deleting a session can only move the sessions it had displaced. In
 *     practice, on a roster well under 63, that set is empty.
 *
 * `assignRoster` stays the engine's allocator and is re-exported here so there
 * is exactly one import surface for roster identity. The engine is a dependency
 * in this fase, never a canvas: nothing in `brand/marks/*` is edited.
 */
import {
  assignRoster,
  characterFromSeed,
  hash32,
  HUE_SLOTS,
  SILHOUETTES,
  type MarkPin,
  type MarkToken,
} from '@/brand/marks'

// Re-export, never re-implement. Consumers that need the engine reach it
// through here so there is exactly one import surface for "roster identity".
export { assignRoster, characterFromSeed }
export type { MarkPin, MarkToken }

/** The minimum a session has to be for a face to be assigned to it. */
export interface RosterCandidate {
  /** The immutable slug — the seed. Never the display name: renaming a session
   *  must not change its face. */
  name: string
  /** RFC3339 creation stamp (`ApiSession.created_at`). Missing sorts last, in
   *  which case the slug alone orders the row — still deterministic. */
  created_at?: string | null
}

/** `name → pin`, as persisted by T8's `mark_pin` column. */
export type MarkOverrides = ReadonlyMap<string, MarkPin> | Readonly<Record<string, MarkPin>>

const TOKEN_COUNT = SILHOUETTES.length * HUE_SLOTS.length // 63
/** Coprime with 63 ⇒ the probe visits every token exactly once (the engine's
 *  own step, so a nudged face lands where the engine would have put it). */
const PROBE_STEP = 17

const tokenKey = (t: MarkToken): string => `${t.silhouette}:${t.hue}`

function lookup(overrides: MarkOverrides | undefined, name: string): MarkPin | undefined {
  if (!overrides) return undefined
  if (overrides instanceof Map) return overrides.get(name)
  return (overrides as Record<string, MarkPin | undefined>)[name]
}

/**
 * Creation order: `created_at` ascending, then the slug.
 *
 * Sessions with no `created_at` sort *after* the dated ones rather than being
 * dropped — a roster row with no face is worse than a face assigned late.
 */
function creationOrder(sessions: readonly RosterCandidate[]): RosterCandidate[] {
  return [...sessions].sort((a, b) => {
    const at = a.created_at ?? ''
    const bt = b.created_at ?? ''
    if (at && bt && at !== bt) return at < bt ? -1 : 1
    if (at && !bt) return -1
    if (!at && bt) return 1
    return a.name < b.name ? -1 : a.name > b.name ? 1 : 0
  })
}

/** The token a seed hashes to with nothing in its way — `characterFromSeed`'s
 *  own two channels, computed without building a whole character. */
function hashToken(seed: string): MarkToken {
  return {
    silhouette: SILHOUETTES[hash32(seed + '#shape') % SILHOUETTES.length],
    hue: HUE_SLOTS[hash32(seed + '#hue') % HUE_SLOTS.length],
  }
}

/**
 * The first free token for a seed, probed from its own hash position along the
 * engine's 63-token cycle.
 *
 * "Free" is the whole cost function — see the module doc for why the engine's
 * count-balanced cost is deliberately not used here. If every token is taken (a
 * roster past 63), the seed keeps its hash-pure token: repeats past the token
 * space are the honest degradation, never an exception.
 */
function firstFree(seed: string, taken: ReadonlySet<string>): MarkToken {
  const sil0 = hash32(seed + '#shape') % SILHOUETTES.length
  const hue0 = hash32(seed + '#hue') % HUE_SLOTS.length
  const t0 = sil0 * HUE_SLOTS.length + hue0
  for (let k = 0; k < TOKEN_COUNT; k++) {
    const t = (t0 + k * PROBE_STEP) % TOKEN_COUNT
    const candidate: MarkToken = {
      silhouette: SILHOUETTES[Math.floor(t / HUE_SLOTS.length)],
      hue: HUE_SLOTS[t % HUE_SLOTS.length],
    }
    if (!taken.has(tokenKey(candidate))) return candidate
  }
  return hashToken(seed)
}

/**
 * The roster's faces: `name → MarkPin`, deduped as one unit.
 *
 * Total and pure. Every candidate gets a pin — an unknown provider, a remote
 * host, a team, an archived row all get one — because a row with no face is not
 * a lesser row, it is a broken one.
 *
 * A pin carries the two deduped channels (`silhouette`, `hue`); everything else
 * about the character (eye size, spacing, seat, asymmetry, pose, blink phase)
 * still comes from the seed, so these are the real characters, not drawings of
 * them. An override's `gaze` / `tilt` ride through untouched.
 */
export function rosterPins(
  sessions: readonly RosterCandidate[],
  overrides?: MarkOverrides,
): Map<string, MarkPin> {
  const ordered = creationOrder(sessions)
  const taken = new Set<string>()
  const pins = new Map<string, MarkPin>()
  const overridden = new Set<string>()

  // Pass 1 — overrides claim their tokens. A partial override (hue only, say)
  // takes the missing channel from the seed's hash-pure token, so half a choice
  // still dedupes instead of collapsing to an arbitrary default.
  for (const s of ordered) {
    const o = lookup(overrides, s.name)
    if (!o || (o.silhouette === undefined && o.hue === undefined)) continue
    if (overridden.has(s.name)) continue
    const base = hashToken(s.name)
    const token: MarkToken = {
      silhouette: o.silhouette ?? base.silhouette,
      hue: o.hue ?? base.hue,
    }
    overridden.add(s.name)
    taken.add(tokenKey(token))
    pins.set(s.name, { ...o, silhouette: token.silhouette, hue: token.hue })
  }

  // Pass 2 — the derived roster fills in around them, in creation order,
  // first-fit from each seed's own hash position.
  for (const s of ordered) {
    if (overridden.has(s.name) || pins.has(s.name)) continue
    const token = firstFree(s.name, taken)
    taken.add(tokenKey(token))
    const o = lookup(overrides, s.name)
    pins.set(s.name, { ...o, silhouette: token.silhouette, hue: token.hue })
  }

  return pins
}

/**
 * The compact wire encoding of a pin — `"<silhouette>:<hue>"`, the shape T8's
 * `mark_pin` column stores. Kept here, next to the reader, so the two halves of
 * the format cannot drift apart.
 */
export function encodeMarkPin(pin: MarkPin): string | null {
  if (pin.silhouette === undefined || pin.hue === undefined) return null
  return `${pin.silhouette}:${pin.hue}`
}

/**
 * Parse a stored `mark_pin`. Returns `undefined` for anything it does not
 * recognise — an unknown silhouette or a hue off the 7-slot ladder is a stale
 * or hand-edited value, and falling back to the derived face is always better
 * than rendering a face the engine cannot draw.
 */
export function decodeMarkPin(raw: string | null | undefined): MarkPin | undefined {
  if (!raw) return undefined
  const [sil, hueRaw] = raw.split(':')
  const hue = Number(hueRaw)
  if (!SILHOUETTES.includes(sil as (typeof SILHOUETTES)[number])) return undefined
  if (!HUE_SLOTS.includes(hue as (typeof HUE_SLOTS)[number])) return undefined
  return { silhouette: sil as (typeof SILHOUETTES)[number], hue }
}

/**
 * The tokens no one in the roster is wearing — what T8's reroll cycles through,
 * so a reroll can never hand out a duplicate.
 *
 * `exclude` is the session doing the rerolling: its own current token is free
 * for the purposes of its own reroll (otherwise the list would be missing the
 * face it is standing on and the cycle would be off by one).
 */
export function freeTokens(
  pins: ReadonlyMap<string, MarkPin>,
  exclude?: string,
): MarkToken[] {
  const taken = new Set<string>()
  for (const [name, pin] of pins) {
    if (name === exclude) continue
    if (pin.silhouette === undefined || pin.hue === undefined) continue
    taken.add(`${pin.silhouette}:${pin.hue}`)
  }
  const out: MarkToken[] = []
  for (const silhouette of SILHOUETTES) {
    for (const hue of HUE_SLOTS) {
      if (!taken.has(`${silhouette}:${hue}`)) out.push({ silhouette, hue })
    }
  }
  return out
}
