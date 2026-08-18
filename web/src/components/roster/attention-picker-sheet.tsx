/**
 * `<AttentionPickerSheet>` — the "needs you" list, as a sheet.
 * ─────────────────────────────────────────────────────────────────────────────
 * What the overview header's rollup opens on tap. Built on `ResponsiveSheet` —
 * the sanctioned sheet primitive (T10.5's ratchet) — so it is a glass drag-
 * detent BOTTOM SHEET on a touch device (`pb-safe`, 36×5 handle, backdrop-tap
 * dismiss) and a right-side panel on a desktop, from one call. It lists EXACTLY
 * the sessions counted in "needs you: N", oldest-waiting first.
 *
 * Each row is the roster's own language: the session's face (`SessionFace`, so
 * the roster-marks kill switch still falls back to a `StatusDot`), its display
 * name, and a one-line reason for WHY it needs you (`rollupReason`). Tapping a
 * row routes to THAT session's focus via `rollupTarget` — never a random jump.
 *
 * ── Testable seam ───────────────────────────────────────────────────────────
 * The rows live in `<AttentionPickerList>`, a plain list with no sheet around
 * it. `ResponsiveSheet` portals its content, which `renderToStaticMarkup`
 * renders as nothing, so a test of the shell would assert on an empty string.
 * The list is separated out so the unit test renders IT — one row per needs-you
 * session, in order, each carrying `data-session` and the resolved `data-href` —
 * and proves row *i* opens session *i*, not a random one.
 */
import { ChevronRight } from 'lucide-react'

import { cn } from '@/lib/utils'
import { displayLabel } from '@/lib/api/sessions'
import { ResponsiveSheet } from '@/components/ui/responsive-sheet'
import { SessionFace } from '@/components/roster/session-face'
import type { AttentionSession } from '@/lib/attention-tiers'
import { rollupReason, rollupTarget } from './attention-rollup'

export interface AttentionPickerSheetProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** The ordered needs-you list — the same one the rollup counts. */
  sessions: readonly AttentionSession[]
  /** Tap a row → open THAT session. The rollup wires this to navigate +
   *  close; taking the session (not a name) keeps the target resolution in one
   *  place (`rollupTarget`). */
  onPick: (s: AttentionSession) => void
}

export function AttentionPickerSheet({
  open,
  onOpenChange,
  sessions,
  onPick,
}: AttentionPickerSheetProps) {
  const n = sessions.length
  return (
    <ResponsiveSheet
      open={open}
      onOpenChange={onOpenChange}
      title="Needs you"
      description={n === 1 ? 'One session is waiting' : `${n} sessions are waiting`}
      className="sm:max-w-sm"
    >
      <div data-vr="attention-picker-sheet" className="px-2 py-2">
        {n === 0 ? (
          <p className="px-2 py-6 text-center text-sm text-muted-foreground">
            Nothing needs you right now.
          </p>
        ) : (
          <AttentionPickerList sessions={sessions} onPick={onPick} />
        )}
      </div>
    </ResponsiveSheet>
  )
}

/** The rows, with no Drawer around them — the sheet's body, and the unit test's
 *  render target. Exported for exactly that reason. */
export function AttentionPickerList({
  sessions,
  onPick,
}: {
  sessions: readonly AttentionSession[]
  onPick: (s: AttentionSession) => void
}) {
  return (
    <ul data-vr="attention-picker-list" className="space-y-0.5">
      {sessions.map((s) => (
        <li key={s.name}>
          <AttentionPickerRow session={s} onPick={() => onPick(s)} />
        </li>
      ))}
    </ul>
  )
}

/** One picker row: face · name · reason · chevron. The roster's language, sized
 *  for a thumb (≥44px) and carrying its own destination in the DOM so a tap is
 *  never ambiguous about which session it opens. */
function AttentionPickerRow({
  session,
  onPick,
}: {
  session: AttentionSession
  onPick: () => void
}) {
  const name = displayLabel(session as never)
  const reason = rollupReason(session)
  const target = rollupTarget(session)
  return (
    <button
      type="button"
      data-vr="attention-picker-row"
      data-session={session.name}
      data-target={target.kind}
      data-href={target.href}
      aria-label={`${name} — ${reason.toLowerCase()}`}
      onClick={onPick}
      className={cn(
        'flex min-h-[52px] w-full items-center gap-3 rounded-xl px-3 py-2 text-left',
        'transition-colors active:bg-secondary/60 hover:bg-fill-soft',
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
      )}
    >
      <SessionFace
        name={session.name}
        status={session.status}
        size={28}
        animate={false}
        className="shrink-0"
      />
      <span className="min-w-0 flex-1">
        <span className="block truncate text-[15px] font-medium tracking-[-0.15px] text-ink">
          {name}
        </span>
        <span className="mt-[2px] block truncate text-[13px] text-ink-2">{reason}</span>
      </span>
      <ChevronRight aria-hidden className="size-4 shrink-0 text-ink-3" />
    </button>
  )
}
