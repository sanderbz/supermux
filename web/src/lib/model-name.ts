/**
 * The chat header's model chip — what Claude Code calls the model, shortened.
 * ─────────────────────────────────────────────────────────────────────────────
 * The source is `SessionView.live_model`: the statusline when tapped, else the
 * transcript's last main-agent signal. Shapes seen:
 * `{id: 'claude-fable-5-2', display_name: 'Fable 5.2'}` on Claude Code 2.1.326,
 * `{id: 'claude-opus-5[1m]', display_name: 'Opus 5 (1M context)'}` on 2.1.232.
 * The display name is already the right words; the chip only drops the
 * parenthetical (a header chip has no room for "(1M context)").
 *
 * Pure and import-free on purpose: `header-pill.tsx` is rendered by `bun test`,
 * whose resolver has no `@/` paths.
 */

/** The families Claude Code offers as `/model` aliases. */
export const MODEL_FAMILIES = ['opus', 'fable', 'sonnet', 'haiku'] as const
export type ModelFamily = (typeof MODEL_FAMILIES)[number]

export interface LiveModelLike {
  id: string
  display_name: string
}

const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1)

/** The family a model belongs to, or `null` for one the picker does not offer
 *  (a pinned third-party id, a future family). Read off the id first — it is
 *  the stable half — then the display name. */
export function modelFamily(m: LiveModelLike | null | undefined): ModelFamily | null {
  if (!m) return null
  for (const src of [m.id, m.display_name]) {
    const s = (src ?? '').toLowerCase()
    const hit = MODEL_FAMILIES.find((f) => new RegExp(`(^|[^a-z])${f}([^a-z]|$)`).test(s))
    if (hit) return hit
  }
  return null
}

/** `Opus 5.5`, `Fable 5.2`, `Opus 5` — the desktop chip's words. The server
 *  always fills `display_name` (deriving it from the id when Claude Code gave
 *  none), so this only drops the parenthetical. `null` when there is nothing to
 *  say. */
export function shortModelName(m: LiveModelLike | null | undefined): string | null {
  if (!m) return null
  const shown = (m.display_name ?? '').replace(/\s*\([^)]*\)\s*/g, ' ').trim()
  return shown || null
}

/** The phone chip's single word: the family (`Opus`), else the first word of
 *  the short name. */
export function modelFamilyLabel(m: LiveModelLike | null | undefined): string | null {
  const fam = modelFamily(m)
  if (fam) return cap(fam)
  return shortModelName(m)?.split(' ')[0] ?? null
}
