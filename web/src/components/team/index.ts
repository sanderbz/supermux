// Agent Teams overview surface — public barrel.
//
// The overview imports the TEAM CARD from here; mission control can reuse
// the teammate primitives (chip, card, focus) directly. A teammate tap now
// navigates directly to the FOCUS page (`/focus/<lead>?teammate=<agent_id>`) —
// the in-overview peek half-sheet was deleted; full-screen focus is the single
// teammate-view surface on every viewport.

export { TeamCard } from './team-card'
export type { TeamCardProps } from './team-card'
export { TeammateChip } from './teammate-chip'
export type { TeammateChipProps } from './teammate-chip'
export { TeammateCard } from './teammate-card'
export type { TeammateCardProps } from './teammate-card'
export { TeammateFocus } from './teammate-focus'
export type { TeammateFocusProps } from './teammate-focus'
export { MemberStatusDot, MEMBER_STATUS_LABEL } from './member-status-dot'
export { TeamRollupBadges } from './team-rollup-badges'
export type { TeamRollupDensity } from './team-rollup-badges'
export { TeamWidthToggle } from './team-width-toggle'
export type { TeamWidthToggleProps } from './team-width-toggle'
