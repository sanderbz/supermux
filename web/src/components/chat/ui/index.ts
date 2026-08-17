/**
 * The chat surface's design-system primitives (fase B0, task 4).
 * ─────────────────────────────────────────────────────────────────────────────
 * Presentational only — every one of these takes props and renders pixels. None
 * of them fetches, subscribes, sends a key or owns state. The renderer slices
 * (`components/chat/*`) keep the data plane; this directory keeps the design.
 *
 * The numbers come from the approved hero mockup (board-light.png /
 * board-dark.png), with the master plan's primitive vocabulary (§4.2) filling in
 * where the mockup is silent; deviations are documented at the point they occur.
 * `/dev/chat-ui` renders every one of them, in both themes, with the boards'
 * own content — that page is the bench these are reviewed and regressed against.
 */
export { accentInkVars, accentInkVarsForSeed, ACCENT_INK_CLASS } from './accent-ink'
export {
  Bubble,
  BubbleCode,
  CodeAdd,
  CodeDel,
  MessageRow,
  PathRef,
  type BubbleProps,
  type MessageRowProps,
} from './bubble'
export { CapturedFrameCard, type CapturedFrameCardProps } from './captured-frame-card'
export {
  CardCode,
  ChoiceCard,
  InlineCode,
  type ChoiceCardProps,
  type ChoiceOption,
} from './choice-card'
export { Composer, type ComposerProps } from './composer'
export { DelegationPill, type DelegationPillProps } from './delegation-pill'
export { Dots } from './dots'
export {
  ArrivalDivider,
  Facepile,
  FaceName,
  type FacepileMember,
  type FacepileProps,
  type FaceNameProps,
} from './facepile'
export {
  ArrowIcon,
  BackIcon,
  ChatGlyph,
  CheckIcon,
  DownIcon,
  FileIcon,
  MicIcon,
  PlusIcon,
  SpinnerIcon,
  TerminalGlyph,
} from './icons'
export {
  ATTENTION_DOT,
  attentionDotSeat,
  BUBBLE_MAX,
  CAPTURED_FRAME,
  FACEPILE,
  MARK_SIZE,
  PHONE,
  RECEIPT_DEFAULT_MAX,
} from './metrics'
export {
  capReceipts,
  coalesceReceipts,
  ReceiptGroup,
  type CoalescedReceipt,
  type Receipt,
  type ReceiptGroupProps,
} from './receipt-group'
export { RosterRow, type RosterRowProps, type AttentionKind } from './roster-row'
export {
  MentionChip,
  SystemEntity,
  SystemLine,
  SystemSep,
  type MentionChipProps,
  type SystemLineProps,
} from './system-line'
export { WorkingRow, type WorkingRowProps } from './working-row'
