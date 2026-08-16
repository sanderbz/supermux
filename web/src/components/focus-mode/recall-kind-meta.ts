/** Display metadata per recall entry kind: chip text + icon.
 *  ───────────────────────────────────────────────────────────────────────────
 *  Lives in its own alias-free module for two reasons: it is the one piece of
 *  the recall popover that is pure (and therefore testable without a DOM), and
 *  it is a hand-maintained MIRROR of `server/src/sessions/recall.rs`'s `Kind`
 *  enum. TypeScript keeps the map total over the client's union; nothing keeps
 *  the union total over the server's enum, and the two ship independently — a
 *  cached SPA routinely talks to a newer server. So the lookup degrades to a
 *  plain chip for an unrecognised kind instead of throwing, mirroring
 *  `classify_by_wrapper`'s server-side catch-all.
 *
 *  `prompt` has no entry: the user's own typing is the unmarked default and
 *  renders without a chip. */
import {
  Bell,
  Clock,
  Image as ImageIcon,
  Info,
  TerminalSquare,
  Users,
  Wrench,
} from 'lucide-react'

import type { RecallEntryKind } from '../../lib/api/sessions'

/** What a chip shows. `Icon` is a lucide component. */
export interface KindBadgeMeta {
  label: string
  Icon: typeof Bell
}

const KIND_BADGE: Record<Exclude<RecallEntryKind, 'prompt'>, KindBadgeMeta> = {
  command: { label: 'slash', Icon: TerminalSquare },
  teammate: { label: 'teammate', Icon: Users },
  // A prompt another session handed to this one (`<supermux-delegation from>`).
  // Same face as a teammate turn: somebody else asked for this.
  delegation: { label: 'delegated', Icon: Users },
  // A prompt one of this session's schedules fired (`<supermux-schedule …>`).
  schedule: { label: 'scheduled', Icon: Clock },
  notification: { label: 'agent done', Icon: Bell },
  system: { label: 'system', Icon: Info },
  tool: { label: 'tool', Icon: Wrench },
  image: { label: 'image', Icon: ImageIcon },
  // Chat-view kinds (fase A1): only ever returned for `?chat=true`, which the
  // popover never requests. Listed so the map stays total over the union.
  assistant: { label: 'assistant', Icon: Info },
  tool_use: { label: 'tool', Icon: Wrench },
}

/** Chip metadata for `kind`, or `null` for `prompt` (which renders bare).
 *  Never throws: an unknown kind becomes its own raw name on a neutral chip. */
export function kindBadgeMeta(kind: RecallEntryKind): KindBadgeMeta | null {
  if (kind === 'prompt') return null
  return KIND_BADGE[kind] ?? { label: String(kind), Icon: Info }
}

/** Who the transcript row is attributed to. Delegated and teammate turns are
 *  somebody else's request and must not read as "You" — nor as "System", which
 *  is what an unmapped kind used to fall through to. */
export function kindSpeaker(kind: RecallEntryKind, label?: string): string {
  if (kind === 'prompt' || kind === 'command') return 'You'
  if (kind === 'teammate') return label || 'Teammate'
  if (kind === 'delegation') return label || 'Another session'
  if (kind === 'schedule') return label || 'Schedule'
  return 'System'
}
