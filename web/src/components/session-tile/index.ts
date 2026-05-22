// Session-tile (HERO) public surface — TECH_PLAN §4.3 / M11.
// The overview grid (M12) and the focus session-strip (M14) both import from
// here so there is one canonical tile, one set of springs, one preview source.

export { SessionTile } from './tile'
export type { SessionTileProps } from './tile'
export { TailPreview } from './tail-preview'
export type { TailPreviewProps } from './tail-preview'
export { StatusDot, STATUS_LABEL } from './status-dot'
export { TileSkeleton } from './tile-skeleton'
export { TileError } from './tile-error'
export type { TileErrorProps } from './tile-error'
export { QuickPeekModal } from './quick-peek-modal'
export type { QuickPeekModalProps } from './quick-peek-modal'
export type { TileSession } from './types'
