// The overlay frame's sizing math — pure, so it can be pinned by tests instead
// of eyeballed in a browser.
//
// `<ShellOverlay variant="frame">` is a raised card floating inside the SHELL
// (not over the whole viewport — the nav rail and the route header stay visible
// behind its scrim). Its size is therefore a function of the CONTENT COLUMN, not
// of the window, which is why it is expressed in container-query units against
// the host: `100cqh` is the column's height, `100cqw` its width.
//
// Three constraints, whichever is smallest:
//
//   1. `100cqh − 72`  — leave 36px of breathing room above and below, so the
//      frame never touches the column's edges and the scrim always reads as a
//      layer rather than as a background colour.
//   2. `62.5cqw − 45` — a frame wider than ~5/8 of the column stops looking
//      like an object placed ON the shell and starts looking like a new page.
//      The −45 keeps the same optical margin at narrow widths.
//   3. `512`          — the hard ceiling. Past this the content inside (a list,
//      a card) stops benefiting from more room and lines get too long to scan.
//
// The CSS below is what the component actually emits; `frameSize()` is the same
// expression evaluated in TS so the tests can pin every branch.

/** The frame's hard ceiling in px — see (3) above. */
export const FRAME_MAX_PX = 512
/** Vertical breathing room subtracted from the container height (2 × 36px). */
export const FRAME_V_INSET = 72
/** The fraction of the container's width the frame may occupy. */
export const FRAME_W_RATIO = 0.625
/** Horizontal slack subtracted after the ratio. */
export const FRAME_W_INSET = 45

export interface ContainerBox {
  /** Container height in px (`100cqh`). */
  cqh: number
  /** Container width in px (`100cqw`). */
  cqw: number
}

/**
 * The frame's edge length in px for a given container box: the smallest of the
 * height budget, the width budget and the ceiling. Never negative — a container
 * smaller than the insets yields 0, and the caller (or CSS `max()`) decides
 * what to do about it rather than getting a nonsense negative size.
 */
export function frameSize({ cqh, cqw }: ContainerBox): number {
  const byHeight = cqh - FRAME_V_INSET
  const byWidth = cqw * FRAME_W_RATIO - FRAME_W_INSET
  return Math.max(0, Math.min(byHeight, byWidth, FRAME_MAX_PX))
}

/**
 * The CSS the component emits. Identical arithmetic to `frameSize`, expressed
 * in container-query units so the browser re-evaluates it on every container
 * resize without a single line of JS.
 */
export const FRAME_SIZE_CSS = `min(100cqh - ${FRAME_V_INSET}px, ${
  FRAME_W_RATIO * 100
}cqw - ${FRAME_W_INSET}px, ${FRAME_MAX_PX}px)`

/** Which of the three constraints is binding for a given box. Exported because
 *  it is what makes a failing size assertion legible ("it was width-bound, not
 *  ceiling-bound") rather than just a wrong number. */
export function frameBinding({ cqh, cqw }: ContainerBox): 'height' | 'width' | 'max' {
  const byHeight = cqh - FRAME_V_INSET
  const byWidth = cqw * FRAME_W_RATIO - FRAME_W_INSET
  const smallest = Math.min(byHeight, byWidth, FRAME_MAX_PX)
  if (smallest === byHeight) return 'height'
  if (smallest === byWidth) return 'width'
  return 'max'
}
