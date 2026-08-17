/**
 * The fact ladder — which facts render on which surface at which density.
 * ─────────────────────────────────────────────────────────────────────────────
 * Before B2 there was no ladder, and that is the honest starting point: the
 * overview's four density tiers (`lib/overview-size.ts`) are PURELY spatial —
 * `idleLines`, `livePreviewPx`, `gridColsLg`, `tileMinPx`, `containerMaxRem` —
 * and every tile shows the same facts at every tier, gated by *content*
 * conditions (`tile.tsx`) rather than by density. Meanwhile `SessionRow` showed
 * a strictly smaller, hand-picked set, and the palette row a smaller one again.
 * Three divergent sets, no table, no way to prove a refactor had not quietly
 * dropped one.
 *
 * This module is that table. It is deliberately DESCRIPTIVE first: the tile's
 * row is today's rendered set, tier for tier, and its unit test asserts exactly
 * that. The tier axis on the tile buys pixels, not facts — recording it as
 * constant is the whole point, because it turns "no tier drops a fact" from a
 * claim into an assertion.
 *
 * ── The rules the test enforces ─────────────────────────────────────────────
 *   1. MONOTONIC. A fact present at tier n is present at every tier above it on
 *      the same surface. Density may add, never subtract.
 *   2. `mark` and `attention` on EVERY row of EVERY surface (§12.4): attention
 *      has to survive collapse, or the densest surface becomes the one where you
 *      miss the thing that needed you.
 *   3. `picker` carries no TICKING fact. A row that mutates under the keyboard
 *      cursor — a relative timestamp, a live preview, a status word — is a bug
 *      in a list you are arrowing through, not a feature.
 *   4. `tile` tier 4 equals today's rendered set, exactly.
 *
 * ── contextPct is NOT here ──────────────────────────────────────────────────
 * The master plan wants context % at high density. It does not exist anywhere
 * in the app: the A2 statusline tap feeds the chat header only, and the sessions
 * delta has no `statuslines` field. Promising it here — even as an unused
 * member of the union — would make the ladder lie. It is listed as deferred in
 * the plan's §5 and named here as a deliberate hole.
 */

/** Every fact a session row can carry. */
export const FACTS = [
  /** The session's face. Identity, and (through the eyes) status. */
  'mark',
  /** The needs-you dot. */
  'attention',
  /** The session's own label — display name or slug. */
  'name',
  /** Claude's chat summary of what this session is doing. */
  'taskSummary',
  /** A relative or absolute timestamp. Ticks. */
  'time',
  /** The session's last line — the preview IS the status line (§12.1). Ticks. */
  'preview',
  /** The status word / pill ("Needs input", "Stopped"). Ticks. */
  'statusLabel',
  /** Cumulative token count. */
  'tokens',
  /** Git branch / worktree. */
  'branch',
  /** Remote-host globe + name. */
  'hostBadge',
  /** The unrecovered-agent-error badge (`session.error`, not a status). */
  'errorBadge',
  /** The ⌘N / Ctrl+N jump chip. */
  'jumpChip',
  /** Tag chips. */
  'tags',
  /** The hover-revealed archive affordance. */
  'archiveAction',
] as const
export type Fact = (typeof FACTS)[number]

/** The four surfaces a session row is drawn on. */
export const SURFACES = ['tile', 'list', 'strip', 'picker'] as const
export type Surface = (typeof SURFACES)[number]

/** The overview's density tiers. Only `tile` and `list` are actually placed on
 *  this axis by a control; `strip` and `picker` have a fixed density and are
 *  written as constant rows so the table stays total. */
export const TIERS = [1, 2, 3, 4] as const
export type Tier = (typeof TIERS)[number]

/** The facts that CHANGE while the user is looking at a static list. A picker
 *  must contain none of them. */
export const TICKING_FACTS: readonly Fact[] = ['time', 'preview', 'statusLabel']

/** Present on every row of every surface, at every tier. Identity and "this one
 *  wants you" are not density-negotiable. */
const ALWAYS: readonly Fact[] = ['mark', 'attention']

/**
 * The ladder, one row per surface. Each entry lists what that tier ADDS to the
 * tier below it, so monotonicity is structural rather than something to
 * remember — and each carries the one-line rationale for why the fact sits at
 * that rung.
 */
const LADDER: Readonly<Record<Surface, Readonly<Record<Tier, readonly Fact[]>>>> = {
  // ── tile ──────────────────────────────────────────────────────────────────
  // Today's rendered set, verbatim, at EVERY tier. The tile's facts have never
  // varied by density — the tiers buy preview lines and column width — and B2
  // does not change that. Written out so the test can prove nothing was lost:
  // the mark replaces the status dot (T4), everything else is what `tile.tsx`
  // draws today.
  tile: {
    1: [
      'taskSummary', // the hero line: Claude's own summary, not the slug
      'statusLabel', // the "Needs input" / "Stopped" pills
      'tokens', // the meta row, yielded to the activity line while working
      'branch', // the meta row's other half
      'hostBadge', // only when the session is remote; zero space otherwise
      'errorBadge', // reads `session.error`, which is NOT a status
      'jumpChip', // ⌘N, desktop only, hover-faded
      'archiveAction', // hover-revealed, on every tile
      'preview', // the tail; the tier changes its HEIGHT, not its presence
    ],
    2: [],
    3: [],
    4: [],
  },

  // ── list ──────────────────────────────────────────────────────────────────
  // The reconciliation. `SessionRow` shows dot · title · status · branch · ⌘N ·
  // host badge · needs-input pill · time — and no preview, no tokens, no tags.
  // Tier 1 keeps every one of those (nothing may be dropped); the roster row's
  // own contribution, the PREVIEW, arrives at tier 2, where there is vertical
  // room for a second line. Tokens and tags follow as the rows get roomier.
  list: {
    1: [
      'name', // the row's label; the tile prefers taskSummary, a row prefers identity
      'statusLabel',
      'branch',
      'time', // right-pinned, tabular — the roster row's own geometry
      'jumpChip',
      'hostBadge',
      'errorBadge', // additive: the row could not show a blocked agent before
    ],
    2: ['preview'], // the second line the h64 row was designed around
    3: ['tokens'],
    4: ['tags'],
  },

  // ── strip ─────────────────────────────────────────────────────────────────
  // The focus strip, 320px wide and h48 after B2. Constant across tiers: the
  // strip has no density control, and its facts are exactly what `CompactTile`
  // shows today (name · tokens · branch · ⌘N) plus the two that are never
  // negotiable. No preview — the strip's preview is the dwell popover, which is
  // an interaction, not a fact.
  strip: {
    1: ['name', 'tokens', 'branch', 'jumpChip'],
    2: [],
    3: [],
    4: [],
  },

  // ── picker ────────────────────────────────────────────────────────────────
  // The command palette and every session picker. h40, static, no ticking fact:
  // you are arrowing through this list, and a row that changes under the cursor
  // is a row you mis-click. `taskSummary` is here because it is what the palette
  // already shows, and it is the only way to tell two similarly-named sessions
  // apart at 40px.
  picker: {
    1: ['name', 'taskSummary'],
    2: [],
    3: [],
    4: [],
  },
}

/** Cached, because this is read per row per render. */
const CACHE = new Map<string, ReadonlySet<Fact>>()

/**
 * The facts a surface renders at a tier. Total: every (surface, tier) pair has
 * an answer, and every answer contains `mark` and `attention`.
 */
export function facts(surface: Surface, tier: Tier = 1): ReadonlySet<Fact> {
  const key = `${surface}:${tier}`
  const hit = CACHE.get(key)
  if (hit) return hit
  const out = new Set<Fact>(ALWAYS)
  for (const t of TIERS) {
    if (t > tier) break
    for (const f of LADDER[surface][t]) out.add(f)
  }
  CACHE.set(key, out)
  return out
}

/** Convenience for the JSX: `has('list', tier, 'preview') && <Preview/>`. */
export function hasFact(surface: Surface, tier: Tier, fact: Fact): boolean {
  return facts(surface, tier).has(fact)
}

/**
 * The tile's set as the app renders it TODAY — the union floor the ladder may
 * never fall below. Kept as data (not derived from the table) precisely so the
 * test compares two independent statements of the same claim.
 */
export const TILE_FACTS_TODAY: readonly Fact[] = [
  'mark',
  'attention',
  'taskSummary',
  'statusLabel',
  'tokens',
  'branch',
  'hostBadge',
  'errorBadge',
  'jumpChip',
  'archiveAction',
  'preview',
]

/** What one row can actually SHOW, per the list ladder's content-bound rungs. */
export interface ListRowFacts {
  /** A token count exists (tier 3). */
  tokens: boolean
  /** At least one tag exists (tier 4). */
  tags: boolean
}

/**
 * The highest LIST rung that would render something new on this roster.
 *
 * The density ladder's top rung was byte-identical to the one below it for every
 * row measured: tier 4 adds `tags`, and no session on the instance had any — so
 * the last step of a density control changed nothing, which reads as broken
 * rather than as honest. The rungs are still four; the CONTROL now stops where
 * the content does, and says why.
 *
 * FLOORED AT 2 on purpose. Tier 2's fact is the preview line, and a preview is
 * transient — a session prints a line and the rung fills — so gating the control
 * on whether one exists right now would make it flicker, and would take the
 * second line away from a roster that is about to have one. Tokens and tags are
 * session PROPERTIES: they are there or they are not, and that is a thing a
 * control may honestly refuse to pretend about.
 *
 * Note the asymmetry with the ladder itself: this is about the roster in front
 * of you, not about the table. Give one session a tag and the fourth rung comes
 * back for everybody.
 */
export function listDetailCeiling(rows: readonly ListRowFacts[]): Tier {
  if (rows.some((r) => r.tags)) return 4
  if (rows.some((r) => r.tokens)) return 3
  return 2
}

/** Why the ladder stops where it does — the sentence the control shows when the
 *  next rung would add nothing. `null` when the ceiling is the real one. */
export function listDetailCeilingNote(ceiling: Tier): string | null {
  if (ceiling >= 4) return null
  return ceiling === 3
    ? 'More detail would add tag chips — no session here has tags yet.'
    : 'More detail would add token counts — no session here reports any.'
}
