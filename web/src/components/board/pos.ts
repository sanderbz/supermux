// Midpoint `pos` computation for board drag-and-drop.
//
// Issues carry a REAL `pos`; the column renders them ascending. To drop a card at
// index `i` within a (target) column we set its `pos` to the MIDPOINT between the
// neighbours that will straddle it — so a single PATCH reorders without renumbering
// the whole column. Edges use a fixed ±1024 step (matches the backend's "new card
// at top = min(pos) - 1024" rule).

const STEP = 1024

/**
 * Compute a `pos` value for inserting at `index` into `ordered` (a column's
 * issues already sorted ascending by `pos`). `index` is the slot the card lands
 * in AFTER removal of the dragged card from its old place (caller passes the
 * target column's list WITHOUT the dragged card).
 */
export function midpointPos(orderedPos: number[], index: number): number {
  const n = orderedPos.length
  if (n === 0) return 0
  if (index <= 0) return orderedPos[0] - STEP
  if (index >= n) return orderedPos[n - 1] + STEP
  const before = orderedPos[index - 1]
  const after = orderedPos[index]
  return (before + after) / 2
}
