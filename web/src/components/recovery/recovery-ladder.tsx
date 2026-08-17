/**
 * The recovery ladder, in its two shapes (B5/T8).
 *
 * §15.5 asks for a graded, consequence-labelled recovery ladder, "inline AND
 * canonical in Settings". Those are two renderings of ONE model
 * (`hooks/use-recovery.ts`), not two components that happen to agree:
 *
 * * `<InlineRecovery>` — what a dead tile offers. ONE button, the
 *   least-destructive rung that can help, labelled with what it keeps, plus a
 *   link to the full list. Not a menu: asking someone to compare three
 *   destructive options while something is broken is the opposite of help.
 * * `<RecoveryLadder>` — the canonical list in Settings. All three rungs with
 *   the same labels, each stating what it preserves AND what it destroys.
 *
 * The `destroys` half is never softened or hidden behind a disclosure. It is
 * the sentence that prevents regret, and a ladder that hides it is a trap.
 */

import { Link } from 'react-router-dom'

import { cn } from '@/lib/utils'
import { RECOVERY } from '@/brand/copy'
import {
  lowestUsefulRung,
  rungsFor,
  useRecovery,
  type RungSpec,
} from '@/hooks/use-recovery'
import type { ApiSession } from '@/lib/api/sessions'

type RecoverySession = Pick<ApiSession, 'runtime' | 'host_id'> | null

/**
 * The inline affordance — one button, the lowest rung that can help.
 *
 * Rendered beside the "Terminal died" badge. The label leads with the VERB and
 * carries what it keeps as its title, so the button is honest at a glance and
 * complete on hover.
 */
export function InlineRecovery({
  name,
  session,
  className,
}: {
  name: string
  session: RecoverySession
  className?: string
}) {
  const { run, pending } = useRecovery()
  const rung = lowestUsefulRung(session)
  const busy = pending === rung.key

  return (
    <span className={cn('inline-flex items-center gap-1.5', className)}>
      <button
        type="button"
        disabled={busy}
        onClick={() => {
          void run(name, rung.key).catch(() => {})
        }}
        title={`${rung.preserves} ${rung.destroys}`}
        className="inline-flex shrink-0 items-center rounded-full bg-secondary px-2 py-0.5 text-[10px] font-semibold leading-none text-foreground hover:bg-secondary/80 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50"
      >
        {busy ? 'Working…' : rung.label}
      </button>
      {/* The escape hatch to the canonical list. A single inline button must
          never be the ONLY way out — if the lowest rung cannot help, the user
          needs somewhere to go that explains the rest. */}
      <Link
        to="/settings#recovery"
        className="text-[10px] text-muted-foreground underline-offset-2 hover:underline"
      >
        More
      </Link>
    </span>
  )
}

/** One row of the canonical list. */
function RungRow({
  rung,
  name,
  busy,
  onRun,
}: {
  rung: RungSpec
  name: string
  busy: boolean
  onRun: () => void
}) {
  const blocked = Boolean(rung.blockedReason)
  return (
    <div className="flex flex-col gap-1.5 rounded-lg border border-border/60 p-3 sm:flex-row sm:items-start sm:justify-between sm:gap-4">
      <div className="min-w-0">
        <p className="text-[13px] font-medium text-foreground">{rung.label}</p>
        <p className="text-[12px] leading-snug text-muted-foreground">
          {rung.preserves} {rung.destroys}
        </p>
        {/* A blocked rung says WHY, with the same sentence the inline
            affordance would use. Silence here reads as a broken button. */}
        {blocked ? (
          <p className="pt-1 text-[12px] leading-snug text-muted-foreground">
            {rung.blockedReason}
          </p>
        ) : null}
      </div>
      <button
        type="button"
        disabled={blocked || busy || !name}
        onClick={onRun}
        className="shrink-0 self-start rounded-md bg-secondary px-2.5 py-1 text-[12px] font-medium text-foreground hover:bg-secondary/80 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50"
      >
        {busy ? 'Working…' : rung.label}
      </button>
    </div>
  )
}

/**
 * The canonical list. Rendered in Settings, where there is room to state both
 * halves of every rung rather than only the reassuring one.
 *
 * `name` is the session to act on; when there is none (Settings opened with no
 * session in context) the rows still render — the list is documentation as much
 * as it is a control, and hiding it would leave the vocabulary undiscoverable.
 */
export function RecoveryLadder({
  name,
  session,
}: {
  name?: string
  session?: RecoverySession
}) {
  const { run, pending } = useRecovery()
  const rungs = rungsFor(session ?? null)

  return (
    <div className="flex flex-col gap-2">
      {rungs.map((rung) => (
        <RungRow
          key={rung.key}
          rung={rung}
          name={name ?? ''}
          busy={pending === rung.key}
          onRun={() => {
            if (name) void run(name, rung.key).catch(() => {})
          }}
        />
      ))}
    </div>
  )
}

/** The AUTOMATIC layer's switch — a real pref (`recovery.auto_heal`) that had
 *  zero UI anywhere in `web/src` before B5 and was reachable only by
 *  hand-crafting a `PUT /api/prefs`. Default ON: a terminal dying under a
 *  running agent is a fault, so this is the operator's off-switch, not an
 *  opt-in. */
export function AutoHealToggle({
  enabled,
  onChange,
  busy,
}: {
  enabled: boolean
  onChange: (next: boolean) => void
  busy?: boolean
}) {
  return (
    <div className="flex items-start justify-between gap-4 rounded-lg border border-border/60 p-3">
      <label htmlFor="recovery-auto-heal" className="min-w-0">
        <span className="block text-[13px] font-medium text-foreground">
          {RECOVERY.autoHealLabel}
        </span>
        {/* The hint names the guard rails. Turning on something that takes a
            real action unattended is otherwise an act of faith. */}
        <span className="block text-[12px] leading-snug text-muted-foreground">
          {RECOVERY.autoHealHint}
        </span>
      </label>
      <input
        id="recovery-auto-heal"
        type="checkbox"
        checked={enabled}
        disabled={busy}
        onChange={(e) => onChange(e.target.checked)}
        className="mt-0.5 size-4 shrink-0 accent-primary disabled:opacity-50"
      />
    </div>
  )
}
