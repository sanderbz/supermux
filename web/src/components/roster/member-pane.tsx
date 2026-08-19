/**
 * `<MemberPane>` — one TEAMMATE as a first-class grok entity (Phase 3, R3).
 * ─────────────────────────────────────────────────────────────────────────────
 * A teammate is NOT an `/api/sessions` row — it is a `tmux split-window` pane
 * running its own Claude inside the lead's window — so it is addressed by the
 * pair it actually has: `(team_name, agent_id)`, which is already its React key
 * (`lib/api/teams.ts`). The roster carries that pair as the `{kind:'member'}`
 * arm of its selection union; this component is what that arm renders.
 *
 * WHAT IT IS: a grok-skinned header (the member's `SessionMark`, its name, a
 * `team · status` sub-line and a calm "Read-only" pill) OVER the EXISTING
 * `<TeammateTerminal>` — which already speaks the read-only teammate WS
 * `/ws/teams/{team}/{member}` with the `?pane_id=` fast-path, replay, backoff
 * and the 4404→stopped contract. Nothing about the terminal is rebuilt here,
 * and `focus-mode/teammate-pane.tsx` (old shadcn chrome, on the retirement
 * list) is deliberately NOT reused — this is its grok replacement.
 *
 * WRITE / STEERING IS DEFERRED, AND SAID SO OUT LOUD (invariant 6 — honest
 * refusals): the teammate WS drops client input by construction, so the pane
 * carries a read-only PILL rather than a fake, disabled composer. When a later
 * slice consumes the §R2.3 pane→conversation map, this same surface gains a
 * real thread + composer without moving.
 *
 * `tmux_pane_id === null` ⇒ the calm "no live pane" placeholder rather than a
 * terminal that can never connect. A member's %id legitimately flips null↔value
 * across ticks, so this is a *right now* statement, not an epitaph.
 *
 * ESC (or the back chevron) returns to the team — the roster owns the actual
 * selection change; this component only reports the intent.
 */
import * as React from 'react'
import { ChevronLeft, Eye } from 'lucide-react'

import { SessionMark } from '@/brand/marks'
import { TeammateTerminal } from '@/components/terminal/teammate-terminal'
import type { Team, TeamMember } from '@/lib/api/teams'

/** The member's live state as a WORD (the roster's law: state is a coloured
 *  word, never a recoloured face). Same four tokens the panel's list uses. */
const STATUS_WORD: Record<TeamMember['status'], string> = {
  needs_you: 'needs you',
  working: 'working',
  idle: 'idle',
  offline: 'offline',
}

export interface MemberPaneProps {
  team: Team
  member: TeamMember
  /** ESC / the back chevron — the roster flips the selection back to the team. */
  onBack: () => void
}

export function MemberPane({ team, member, onBack }: MemberPaneProps) {
  // Only the PANE gates the terminal. Claude flips a teammate to
  // `isActive:false` (→ `offline`) the moment its turn ends while the tmux pane
  // keeps streaming, so gating on `status` would blank a perfectly live pane.
  const gone = !member.tmux_pane_id

  // ESC returns to the team, from anywhere in the pane — including from inside
  // the terminal, which owns its own focus and would otherwise eat the key. It
  // stands down for anything modal layered above (a sheet, a dialog, the
  // palette): those own ESC while they are open, and an already-handled event is
  // never re-handled here.
  React.useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || e.defaultPrevented) return
      if (document.querySelector('[role="dialog"], [role="alertdialog"]')) return
      onBack()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [onBack])

  return (
    <div className="gr-pane" data-shell-pane data-vr="member-pane">
      {/* The pane header is the roster's OWN `.gr-pane-hd` geometry + `.nm`/`.sub`
          inks — no new skin rule is invented for this surface; everything else
          here is the shared Tailwind/shadcn vocabulary the panels already use,
          which is also why it costs the CSS budget nothing. */}
      <header className="gr-pane-hd">
        <button
          type="button"
          onClick={onBack}
          aria-label={`Back to ${team.team_name}`}
          title={`Back to ${team.team_name}`}
          className="grid size-8 shrink-0 place-items-center rounded-[10px] border border-border text-muted-foreground transition-colors hover:bg-accent/40 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          <ChevronLeft className="size-4" aria-hidden />
        </button>
        <SessionMark
          seed={member.name}
          size={38}
          animate={false}
          label={null}
          attention={member.status === 'needs_you' ? 'needs' : null}
        />
        <span className="min-w-0 flex-1">
          <span className="nm block">{member.name}</span>
          <span className="sub block">
            {team.team_name} · {STATUS_WORD[member.status]}
            {member.model ? ` · ${member.model}` : ''}
          </span>
        </span>
        <span className="acts">
          {/* The honest capability statement. Steering a teammate does not exist
              yet (the WS drops input); a pill says so once, calmly, instead of a
              composer that looks typeable and is not. */}
          <span
            data-vr="member-readonly"
            className="inline-flex items-center gap-1.5 rounded-full border border-border bg-muted/50 px-2.5 py-1 text-[12px] font-medium text-muted-foreground"
          >
            <Eye className="size-3.5" aria-hidden />
            Read-only
          </span>
        </span>
      </header>

      <div
        className="relative flex min-h-0 flex-1 flex-col"
        style={{ backgroundColor: 'var(--terminal-bg)' }}
      >
        {gone ? (
          <p
            data-vr="member-no-pane"
            className="m-auto max-w-[46ch] px-6 text-center text-[13px] leading-relaxed text-muted-foreground"
          >
            No live pane for {member.name} right now — it may come back on the next
            tick. The crew list beside it is read from disk, so the teammate itself is
            still part of {team.team_name}.
          </p>
        ) : (
          <TeammateTerminal
            // Remount on a member OR pane-id change so a fresh WS connects
            // rather than a stale socket streaming the previous pane.
            key={`${team.team_name}/${member.name}/${member.tmux_pane_id}`}
            team={team.team_name}
            member={member.name}
            paneId={member.tmux_pane_id}
            className="min-h-0 flex-1"
          />
        )}
      </div>
    </div>
  )
}

export default MemberPane
