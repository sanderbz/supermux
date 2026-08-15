/**
 * The focused session's pigment, as SURFACE — one property write, whole chat
 * surface re-skinned (concept contract C7, master plan §11.3).
 * ─────────────────────────────────────────────────────────────────────────────
 * `board-patch-focused.png` is the proof this file exists for: it is the SAME
 * screen as `board-light.png`, re-shot with Patch focused, and everything that
 * changed — roster row wash, composer focus ring, the selected choice — changed
 * because one custom property changed. Nothing recomputed a palette, nothing
 * re-themed; the derived surfaces are `sm-accent-{row,wash,chip}` utilities that
 * substitute at the USE site and therefore see the nearest inherited accent
 * (globals.css explains why they cannot be `:root` variables).
 *
 * TWO NAMES, ONE DERIVATION
 * B0 shipped `--sm-accent` (what the `sm-accent-*` utilities read); the master
 * plan §11.3 calls the side-pane/shell variable `--sm-session-tint`. Rather than
 * fork the utilities or leave §11.3/B1 writing a variable nobody sets, A3 writes
 * BOTH from a single derivation — they are the same colour by construction, so
 * the two names can never drift apart into two different "session colours".
 *
 * WHERE IT MAY BE WRITTEN
 * On the chat surface root (`<ChatSurface>`'s outermost div) and on the header
 * pill. Never on `:root` — `:root`'s `--sm-accent` is the brand amber, the
 * no-session fallback, and a session must not leak its identity into the shell
 * chrome. Never on a status affordance: status has its own family
 * (`--status-*`), and an accent there would make "which session" and "how is it
 * going" the same channel. That rule is a test, not a comment
 * (`tests/unit/chat-accent.test.ts`).
 *
 * WHY NOT `accentInkVars`
 * `accent-ink.ts` publishes a hue as TYPE (mention chips, provenance names) and
 * is written by the component that names a session — which is frequently a
 * DIFFERENT session from the focused one (`●Patch sent over the failing job`).
 * That is why the two exist: this module paints the room, that one inks a word.
 */
import type { CSSProperties } from 'react'

// Relative, not `@/`: this module is rendered by `bun test`, whose resolver
// reads the root tsconfig.json — which carries no `paths`. Same reason
// `chat/ui/accent-ink.ts` reaches the marks engine the long way round.
import { bodyColor, characterFromSeed, type MarkPin } from '../../brand/marks'

/** The two custom properties this module owns. Exported for the C7 guard. */
export const SESSION_ACCENT_VARS = ['--sm-accent', '--sm-session-tint'] as const

/**
 * Seed → the accent custom properties, as an inline `style` object.
 *
 * The seed is a session's **immutable slug** (`session.name`), never its
 * `display_name`: a rename must not change a face, and the mark beside every
 * message is derived from the same seed — two derivations from two different
 * strings would put a teal face next to an amber room.
 */
export function sessionAccentVars(seed: string, pin?: MarkPin): CSSProperties {
  // `bodyColor(hue)` is the flat body fill of the mark — theme-independent by
  // design, so one value serves both papers. (The text-capable tier is
  // `accentInk`, and it is theme-dependent; see accent-ink.ts.)
  const color = bodyColor(characterFromSeed(seed, pin).hue)
  return {
    '--sm-accent': color,
    '--sm-session-tint': color,
  } as CSSProperties
}

/**
 * The same, addressed by the session row the surface is rendering.
 *
 * No session (still loading, or the renderer mounted without one) writes
 * NOTHING — the surface then inherits `:root`'s `--sm-accent`, which is the
 * brand amber fallback. An empty object here is a deliberate value: it is the
 * difference between "no session focused" and "a session whose colour is amber".
 */
export function sessionAccentVarsFor(
  session: { name: string } | null | undefined,
  pin?: MarkPin,
): CSSProperties {
  if (!session?.name) return {}
  // TODO(§10): the wire has no `mark_*` columns yet, so nothing is pinned in the
  // app and the character is hash-pure. The parameter exists because a caller
  // that DOES have a pin (the `/dev/chat-live` bench today, the roster when §10
  // lands) must hand it to this derivation as well as to every `<SessionMark>`
  // on the surface — a pinned face over an unpinned room is two different
  // "session colours" for one session.
  return sessionAccentVars(session.name, pin)
}
