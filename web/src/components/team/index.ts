// Agent Teams overview surface — public barrel (AT-F-FRONT / F1+F2+F5).
//
// The overview imports the TEAM CARD from here; AT-F3 (mission control) can reuse
// the teammate primitives (chip, card, terminal, peek, focus) directly.

export { TeamCard } from './team-card'
export type { TeamCardProps } from './team-card'
export { TeammateChip } from './teammate-chip'
export type { TeammateChipProps } from './teammate-chip'
export { TeammateCard } from './teammate-card'
export type { TeammateCardProps } from './teammate-card'
export { TeammatePeekSheet } from './teammate-peek-sheet'
export type { TeammatePeekSheetProps } from './teammate-peek-sheet'
export { TeammateFocus } from './teammate-focus'
export type { TeammateFocusProps } from './teammate-focus'
export { MemberStatusDot, MEMBER_STATUS_LABEL } from './member-status-dot'
export { TeamRollupBadges } from './team-rollup-badges'
export type { TeamRollupDensity } from './team-rollup-badges'
export { TeamWidthToggle } from './team-width-toggle'
export type { TeamWidthToggleProps } from './team-width-toggle'
