/**
 * The focused session's identity hue, as the Grok-mode `--sm-agent-*` family.
 * ─────────────────────────────────────────────────────────────────────────────
 * WS1 shipped `grok-mode.css` with the five `--sm-agent-*` custom properties
 * defined as DEFAULTS on `[data-grok]` (all pointing at the single accent) and a
 * comment marking the runtime write "WS4/WS5". This module is that write: one
 * property write on the shell root re-skins the ~6 non-semantic surfaces that
 * read the family (the side-pane 6% wash, mention chips, the composer focus
 * ring, the selected-choice border, the thinking coat) — a session switch is a
 * variable write, not a re-theme (`mechanics.md §1.3, §2.1`; `tokens.md §6`).
 *
 * DERIVED FROM THE IMMUTABLE SLUG. The hue is a pure function of `session.name`
 * (the slug), never the mutable `display_name`: a rename must not recolour a
 * room, and the `<SessionMark>` beside every message derives its body from the
 * same slug + roster pin — two derivations from two strings would seat a teal
 * face in an amber room. When a deduped roster pin is available (`usePin`), it is
 * threaded through so the shell's hue is the SAME slot the mark on screen wears.
 *
 * THE FIREWALL (non-negotiable — `mechanics.md §1.3`, `tokens.md §6`). This
 * family lives ONLY on non-semantic surfaces. Status semantics own their own
 * family (`--sm-tone-*`): dots, state words, the left-edge bar. The two never
 * share a surface, so two different focused sessions produce byte-identical
 * neutral page/rail pixels — only the accent surfaces recolour. This module
 * therefore writes NOTHING but the `--sm-agent-*` five, and touches no tone.
 *
 * WHY NOT `session-accent.ts` / `accent-ink.ts`. Those two predate Grok mode and
 * own DIFFERENT variables for the substrate skin: `session-accent.ts` writes
 * `--sm-accent` + `--sm-session-tint` (the focused room, one value), and
 * `accent-ink.ts` publishes `--sm-ink-accent-{light,dark}` for a chip that names
 * a *different* session as type. This module owns the Grok-mode `--sm-agent-*`
 * family and only that; the three coexist without collision.
 *
 * PURE. No DOM, no React — a plain seed→CSSProperties derivation, so `bun test`
 * pins it directly (`tests/unit/grok-agent-hue.test.ts`) and any surface (shell
 * root today, a roster row when WS5 lands) can apply the same object.
 */
import type { CSSProperties } from 'react'

import { accentInk, bodyColor, characterFromSeed, type MarkPin } from '@/brand/marks'

/**
 * The five custom properties this module owns — exported for the firewall guard
 * and for any test that wants to assert the write is complete and disjoint from
 * the tone family (`tokens.md §6`).
 */
export const AGENT_HUE_VARS = [
  '--sm-agent-tint',
  '--sm-agent-accent',
  '--sm-agent-bubble',
  '--sm-agent-ink',
  '--sm-agent-coat',
] as const

/**
 * A resolved hue → the five `--sm-agent-*` properties, as an inline `style`.
 *
 *   tint / coat / bubble  the flat body fill (`bodyColor`) — theme-INDEPENDENT
 *                         by design, one value on both papers: it is the mark's
 *                         own pigment, consumed at ≤6% (wash), as a coat (mascot)
 *                         or as a filled chip (bubble).
 *   accent                the text-capable tier (`accentInk`) — theme-DEPENDENT
 *                         (darkened on light paper to `L≈0.475`, lifted on dark
 *                         to `L≈0.82`) so a session's colour stays legible as
 *                         *type*: chips, the focus ring, hover underlines.
 *   ink                   the on-accent text — white on every body, both themes.
 *
 * `dark` selects the accent tier; the caller supplies it from the resolved
 * theme (`useTheme().resolvedTheme === 'dark'`), so this stays DOM-free.
 */
export function agentHueVars(hue: number, dark: boolean): CSSProperties {
  const body = bodyColor(hue)
  return {
    '--sm-agent-tint': body,
    '--sm-agent-coat': body,
    '--sm-agent-bubble': body,
    '--sm-agent-accent': accentInk(hue, dark),
    '--sm-agent-ink': '#fff',
  } as CSSProperties
}

/**
 * The same, addressed by a session's immutable slug (+ its deduped roster pin,
 * when the caller has one). Hash-pure without a pin, which is correct for a
 * session the roster has not deduped yet — a colour that may collide beats no
 * colour at all, exactly as `<SessionMark>` degrades.
 */
export function agentHueVarsForSeed(seed: string, dark: boolean, pin?: MarkPin): CSSProperties {
  return agentHueVars(characterFromSeed(seed, pin).hue, dark)
}

/**
 * The shell-root form: a session (or none) → the write, or an empty object.
 *
 * No session focused writes NOTHING — the shell then inherits `[data-grok]`'s
 * WS1 defaults (the single accent), which is the deliberate difference between
 * "no session focused" and "a session whose hue happens to be the accent". This
 * is what keeps the overview (no focus) neutral and the firewall honest.
 */
export function agentHueVarsFor(
  session: { name: string } | null | undefined,
  dark: boolean,
  pin?: MarkPin,
): CSSProperties {
  if (!session?.name) return {}
  return agentHueVarsForSeed(session.name, dark, pin)
}
