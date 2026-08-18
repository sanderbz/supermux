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
  /**
   * The UNREAD dot — the middle tier of the three-tier model, which had no
   * affordance at all until now (`attentionFor` set `dot: tier === 'needs'`, so
   * an unread row was pixel-identical to a quiet one).
   *
   * Smaller and calmer than the needs dot ON PURPOSE, and that difference is the
   * whole design: `needs` is a demand ("decide something"), `unread` is a fact
   * ("it spoke while you were away"). Same seat, same keyline, so the two read
   * as one channel at two volumes rather than as two competing badges — and a
   * roster where everything is loud is a roster nobody reads.
   *
   * The pigment is the app's own accent rather than a second alarm colour, for
   * the same reason §3.2 keeps the error family off the alert dot.
   */
  unreadSize: 5,
  unreadColor: 'var(--primary)',
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
 * `cluster` is the mockup's crew mark: a 40px box holding three 20px members in
 * a 1-over-2 arrangement, each stroked with a page-coloured keyline — it stands
 * in for a single mark in a roster row, so it must occupy exactly one mark's
 * footprint. `row.overlap` is §11.9's −24% margin, used when a pile is inline in
 * a header rather than standing in for a mark.
 */
export const FACEPILE = {
  cluster: {
    box: 40,
    // 20px members (bumped from the facepile's 18px): the crew badge stands in for
    // a 40px roster mark, so its members were reading small and the boxy/green one
    // got lost at phone density (jury R3 #5). 20px in the same 40px box packs the
    // 1-over-2 stack tighter with a fuller footprint — still one mark's box, still
    // keyline-separated — so each face (and its red `needs` halo) is legible on a
    // phone. Offsets re-seated to keep all three inside the box at the new size.
    size: 20,
    /** [left, top] in box px, in z order 1 / 2 / 3 (the top member paints last). */
    offsets: [
      [10, 0],
      [0, 16],
      [20, 16],
    ],
  },
  row: { overlap: -0.24 },
} as const

/**
 * Bubble ceilings. The assistant bubble is allowed to be wide because it carries
 * receipts, code and frames; the user bubble is deliberately narrower so a human
 * sentence never spans the column (mockup `.bubble` / `.msg.me .bubble`).
 *
 * DESKTOP is a px ceiling — the 744px track is wider than a comfortable measure,
 * so the number is what stops a line from running too long.
 *
 * THE PHONE IS NOT A CEILING PROBLEM. It used to be: both sides carried the
 * artboard's literal 266 / 250, lifted off `mobile-light.png`. On a real 390pt
 * screen those px turned into a SECOND indent stacked on the track's own 14px
 * gutter — the assistant bubble stopped 66px short of the right edge and the
 * text column came out at 232px, 59% of the screen, inset on BOTH sides. A
 * transcript is the one surface where horizontal room IS the product.
 *
 * So the phone reads like Grok instead, and the asymmetry does the work the two
 * ceilings were doing:
 *   · the agent runs the column — `100%`, i.e. only the track's gutter insets it,
 *   · the human's own line is right-aligned and capped PROPORTIONALLY (`84%`),
 *     so the indent is ~16% of whatever phone it is on rather than 126px on a
 *     390 and nothing on a 320.
 * Percentages, not px, because `max-width` here is resolved against the row —
 * which is exactly the box that varies between phones.
 */
export const BUBBLE_MAX = {
  assistant: 648,
  user: 420,
  /** Phone, agent side: the column, less the track's own 14px gutter. */
  phoneAssistant: '100%',
  /** Phone, human side: right-aligned, indented ~16% — never a px cliff. */
  phoneUser: '84%',
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
