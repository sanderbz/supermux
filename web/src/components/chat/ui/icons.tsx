/**
 * The chat surface's icon set — monochrome, `currentColor`, no emoji.
 * ─────────────────────────────────────────────────────────────────────────────
 * Master plan §4.2 P3 is explicit: receipts use small monochrome icons at
 * `currentColor`; the `activity_label` emoji taxonomy stays terminal/tile-only.
 * These are the exact paths of the approved mockup, at the exact sizes it drew
 * them (check 13, arrow 15×12, file 12×13, plus 17, mic 17) — a redrawn icon is
 * a different design, however close.
 *
 * They are `flex:none` by construction (`shrink-0`) so a receipt line's check
 * never squeezes when the outcome text is long.
 */

type IconProps = { className?: string }

/** Receipt line: the completed tool call. */
export function CheckIcon({ className }: IconProps) {
  return (
    <svg
      width="13"
      height="13"
      viewBox="0 0 14 14"
      fill="none"
      aria-hidden
      className={className}
    >
      <path
        d="M2 7.4L5.4 10.8L12 3.6"
        stroke="currentColor"
        strokeWidth="1.7"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  )
}

/**
 * Receipt line: the tool call that is still running. Occupies the check slot so
 * the line does not reflow when it lands (§4.2 P3: the spinner *morphs* into the
 * check). 2.4s per BRAND's slow-spinner convention — see `.sm-spin`.
 */
export function SpinnerIcon({ className }: IconProps) {
  return (
    <svg
      width="13"
      height="13"
      viewBox="0 0 14 14"
      fill="none"
      aria-hidden
      className={className}
    >
      <circle cx="7" cy="7" r="5.2" stroke="currentColor" strokeWidth="1.5" opacity="0.25" />
      <path
        d="M7 1.8a5.2 5.2 0 0 1 5.2 5.2"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
      />
    </svg>
  )
}

/** Receipt line: tool → outcome. */
export function ArrowIcon({ className }: IconProps) {
  return (
    <svg
      width="15"
      height="12"
      viewBox="0 0 16 12"
      fill="none"
      aria-hidden
      className={className}
    >
      <path
        d="M1.6 6h12.2M9.6 1.8L13.8 6l-4.2 4.2"
        stroke="currentColor"
        strokeWidth="1.35"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  )
}

/** Captured-frame caption: the file this frame came from. */
export function FileIcon({ className }: IconProps) {
  return (
    <svg
      width="12"
      height="13"
      viewBox="0 0 12 13"
      fill="none"
      aria-hidden
      className={className}
    >
      <path d="M2.2 1.6h4.3L9.8 5v6.4H2.2z" stroke="currentColor" strokeWidth="1.1" strokeLinejoin="round" />
      <path d="M6.4 1.7V5h3.3" stroke="currentColor" strokeWidth="1.1" strokeLinejoin="round" />
    </svg>
  )
}

/** Jump to the newest message (daily-driver QA #17) — `BackIcon`'s chevron,
 *  turned a quarter, at the weight a 44px disc wants. */
export function DownIcon({ className }: IconProps) {
  return (
    <svg width="17" height="17" viewBox="0 0 16 16" fill="none" aria-hidden className={className}>
      <path
        d="M3.4 6.2L8 10.8l4.6-4.6"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  )
}

/** Composer: attach / `@` / `/` — the one leading affordance. */
export function PlusIcon({ className }: IconProps) {
  return (
    <svg width="17" height="17" viewBox="0 0 16 16" fill="none" aria-hidden className={className}>
      <path d="M8 2.9v10.2M2.9 8h10.2" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
    </svg>
  )
}

/** Phone header: back to the roster. The one nav glyph the phone board needs. */
export function BackIcon({ className }: IconProps) {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden className={className}>
      <path
        d="M10 2.8L4.8 8L10 13.2"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  )
}

/**
 * Renderer switch: the chat surface, at the size where a word will not fit.
 *
 * The phone header card is 366px and has to hold a back button, a face, the
 * session's NAME, a status dot and this control (daily-driver QA #6 — a
 * three-character name rendered as `i…`). The unselected side of the switch
 * gives up its word first; these two glyphs are what it gives it up for.
 */
export function ChatGlyph({ className }: IconProps) {
  return (
    <svg width="15" height="15" viewBox="0 0 16 16" fill="none" aria-hidden className={className}>
      <path
        d="M13.4 8.1c0 2.6-2.4 4.7-5.4 4.7-.6 0-1.2-.1-1.7-.2l-3 1.1.9-2.5C3.3 10.3 2.6 9.3 2.6 8.1c0-2.6 2.4-4.7 5.4-4.7s5.4 2.1 5.4 4.7Z"
        stroke="currentColor"
        strokeWidth="1.3"
        strokeLinejoin="round"
      />
    </svg>
  )
}

/** Renderer switch: the terminal, same reason. */
export function TerminalGlyph({ className }: IconProps) {
  return (
    <svg width="15" height="15" viewBox="0 0 16 16" fill="none" aria-hidden className={className}>
      <path
        d="M3.4 5.1 6 7.9l-2.6 2.8M7.7 11h4.9"
        stroke="currentColor"
        strokeWidth="1.35"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  )
}

/** Composer: dictation. */
export function MicIcon({ className }: IconProps) {
  return (
    <svg width="17" height="17" viewBox="0 0 18 18" fill="none" aria-hidden className={className}>
      <rect x="6.6" y="2.2" width="4.8" height="8.4" rx="2.4" fill="currentColor" />
      <path
        d="M3.9 8.4a5.1 5.1 0 0 0 10.2 0M9 13.5v2.3"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinecap="round"
      />
    </svg>
  )
}
