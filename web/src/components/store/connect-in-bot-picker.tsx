// The "Connect in a bot" target picker — a ResponsiveSheet (Vaul bottom-sheet on
// coarse pointers, side panel on desktop) shown when more than one bot is
// eligible for the store→chat CONNECT handoff. Each row is an identity mark
// (HqMark / CompanyMark) + the bot's display label + its live status, mirroring
// the roster row grammar; tapping one POSTs the handoff and navigates into that
// bot's Focus chat, where the existing ConnectCard renders the pushed card.
//
// Reuses: ResponsiveSheet, displayLabel, CompanyMark/HqMark — no new list widget.
import { displayLabel } from '@/lib/api'
import type { Company } from '@/lib/companies'
import { CompanyMark, HqMark } from '@/components/roster/company-mark'
import { ResponsiveSheet } from '@/components/ui/responsive-sheet'
import { cn } from '@/lib/utils'

import type { BotChoice } from './connector-detail'

export function ConnectInBotPicker({
  open,
  onOpenChange,
  bots,
  companies,
  busyName,
  onPick,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** The eligible bots (already scoped to the active space by the caller). */
  bots: BotChoice[]
  /** Live company set, to resolve a company bot's mark (slug + name). */
  companies: Company[]
  /** The bot the handoff POST is in flight for — its row shows a pending state
   *  and the list locks (a double-tap can't fire two handoffs). */
  busyName: string | null
  onPick: (name: string) => void
}) {
  return (
    <ResponsiveSheet
      open={open}
      onOpenChange={onOpenChange}
      title="Connect in a bot"
      description="Open the connect card in a running bot's chat, then finish sign-in there."
      className="sm:max-w-md"
    >
      <div className="flex flex-col gap-0.5 px-5 py-4">
        {bots.map((b) => {
          const co =
            b.company_id != null ? companies.find((c) => c.id === b.company_id) : undefined
          const busy = busyName === b.name
          return (
            <button
              key={b.name}
              type="button"
              disabled={busyName !== null}
              onClick={() => onPick(b.name)}
              className={cn(
                'flex min-h-[52px] items-center gap-3 rounded-xl px-2.5 py-2 text-left hover:bg-muted disabled:cursor-default',
                busy && 'bg-muted',
              )}
            >
              {co ? (
                <CompanyMark slug={co.slug} name={co.display_name} size={28} />
              ) : (
                <HqMark size={28} />
              )}
              <span className="flex min-w-0 flex-1 flex-col leading-tight">
                <span className="truncate text-[14px] font-medium text-foreground">
                  {displayLabel(b)}
                </span>
                <span className="truncate text-[12px] capitalize text-muted-foreground">
                  {busy ? 'Opening…' : b.status}
                </span>
              </span>
            </button>
          )
        })}
      </div>
    </ResponsiveSheet>
  )
}
