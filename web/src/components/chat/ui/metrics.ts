/**
 * The numeric contract of the chat surface (fase B0, task 4).
 * ─────────────────────────────────────────────────────────────────────────────
 * Every number below is lifted from the approved hero mockup — the source that
 * produced `board-light.png` / `board-dark.png` / `avatar-strip@2x.png`. Where
 * the mockup is silent, the master plan's primitive vocabulary (§4.2) is the
 * fallback, and that is called out inline.
 *
 * WHAT LIVES HERE, AND WHAT DOES NOT. Only numbers that JavaScript consumes:
 * mark sizes, the facepile's cluster geometry, the attention dot's seat on a
 * silhouette, the two bubble ceilings. Padding, radii and type scale live in the
 * components' class lists — mirroring them here would be a second source of
 * truth that drifts silently, which is exactly the failure `brand-tokens.test`
 * was written for.
 *
 * Relative imports (not `@/…`) throughout `components/chat/ui/`: the unit runner
 * (`bun test`) resolves these files directly and does not read the app
 * tsconfig's path aliases. Same reason as `brand/marks/session-mark.tsx`.
 */
import type { Character } from '../../../brand/marks'

/**
 * The mark size ladder, per surface. The engine is unitless; these are the rungs
 * the design actually ships (`/dev/marks` benches 18 / 28 / 40).
 */
export const MARK_SIZE = {
  /** Roster row — the sidebar's 64px row. */
  roster: 40,
  /** Transcript gutter + header pill — the mark beside a message. */
  gutter: 28,
  /** In-flight delegation pill (desktop; the phone drops to 24). */
  pill: 26,
  /** Arrival divider ("Messages from ● Patch and ● Quill"). */
  divider: 16,
  /** Facepile member + dense roster. */
  facepile: 18,
  /** Inline provenance chip, sitting on a line of 15px text. */
  chip: 15,
} as const

/**
 * The attention dot — "this session needs you".
 *
 * DEVIATION, flagged for owner review: `#e5484d` is the mockup's literal, and it
 * is deliberately NOT a member of the `--status-*` family. Two reasons it was
 * drawn that way: (1) the dot is 7px and has to survive on any of the seven
 * pigments, including the blue-violet ones a calm-blue `--status-waiting` dot
 * would sink into; (2) BRAND §3.2's "never alarmist red" rule governs the
 * *error status colour*, not an alert dot. If the owner wants the status family
 * instead, this is the one constant to change.
 */
export const ATTENTION_DOT = {
  size: 7,
  /** Page-coloured keyline, so the dot separates from the silhouette under it. */
  ringWidth: 2,
  color: '#e5484d',
} as const

/**
 * Where the attention dot sits: on the silhouette's upper-right shoulder, in box
 * pixels — not floating in the corner of the layout box. A wedge and a sphere
 * have very different shoulders, so the seat is derived from the character's own
 * solid rather than hard-coded (mockup: `data-attnLeft` / `data-attnTop`).
 *
 * `VIEWBOX` is the half-extent of the mark's viewBox; 0.707 = cos 45°, i.e. the
 * point where a 45° ray leaves the body.
 */
export function attentionDotSeat(
  ch: Character,
  size: number,
  viewBox: number,
): { left: number; top: number } {
  const rxp = (size / 2) * (ch.body.rx / viewBox)
  const ryp = (size / 2) * (ch.body.ry / viewBox)
  const half = ATTENTION_DOT.size / 2
  return {
    left: size / 2 + rxp * 0.707 - half,
    top: size / 2 - ryp * 0.707 - half,
  }
}

/**
 * Facepile geometry.
 *
 * `cluster` is the mockup's crew mark: a 40px box holding three 18px members in
 * a 1-over-2 arrangement, each stroked with a page-coloured keyline — it stands
 * in for a single mark in a roster row, so it must occupy exactly one mark's
 * footprint. `row.overlap` is §11.9's −24% margin, used when a pile is inline in
 * a header rather than standing in for a mark.
 */
export const FACEPILE = {
  cluster: {
    box: 40,
    size: MARK_SIZE.facepile,
    /** [left, top] in box px, in z order 1 / 2 / 3 (the top member paints last). */
    offsets: [
      [11, 0],
      [0, 15],
      [22, 15],
    ],
  },
  row: { overlap: -0.24 },
} as const

/**
 * Bubble ceilings, in px. The assistant bubble is allowed to be wide because it
 * carries receipts, code and frames; the user bubble is deliberately narrower so
 * a human sentence never spans the column (mockup `.bubble` / `.msg.me .bubble`).
 */
export const BUBBLE_MAX = {
  assistant: 648,
  user: 420,
  /** The phone column is 390 − 28 of gutter; `mobile-light.png`'s `.phone .bubble`. */
  phoneAssistant: 266,
  phoneUser: 250,
} as const

/**
 * The phone artboard — `mobile-light.png` / `mobile-dark.png`, to the pixel.
 *
 * The phone is not the desktop board at a narrow width: it drops the roster
 * entirely, floats its header as a 60px glass card inset 12px under the status
 * bar, and narrows both bubble ceilings. Those are compositional decisions the
 * approved render made, so the bench has to make them too — a `/dev/chat-ui`
 * that only ever shows the 1440 board cannot review the phone.
 */
export const PHONE = {
  width: 390,
  height: 844,
  radius: 44,
  /** Status bar + notch live above the floating header. */
  topbar: 54,
  head: { top: 54, inset: 12, height: 60, radius: 22 },
  /** Track gutter, and the room the composer needs at the bottom. */
  track: { inset: 14, bottom: 92 },
} as const

/** The captured-frame card: 340px wide on desktop, 16:10 (padding-top 62.5%). */
export const CAPTURED_FRAME = { width: 340, aspectPercent: 62.5 } as const

/**
 * Receipts default to showing everything. Claude turns run 30–100 tool calls
 * (master plan §4.2 P3), so a consumer that renders a whole turn passes a `max`
 * and gets the "Show all N" affordance; a three-line group like the approved
 * board's never trips it.
 */
export const RECEIPT_DEFAULT_MAX = 12
