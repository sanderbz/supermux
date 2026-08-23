// "Create your own connector" — the sheet both store entry points open (the
// permanent dashed grid tile + the zero-results CTA). The user names the service,
// optionally adds notes, and picks (or launches) the bot that will BUILD it;
// supermux hands that bot the request + a compact catalog digest + a pointer to
// the `/supermux-connector` guide, then navigates the user into the bot's chat so
// they see it working (§1–§2, §6 of the design).
//
// supermux never authors — it frames the task and delivers it. The bot authors
// the connector into the store the proper way (the guide) and asks the owner to
// one-tap Register it (the admin gate stays with the human).
//
// Reuses: ResponsiveSheet (the shell), the ConnectInBotPicker row grammar
// (identity mark + label + status), `restSessionInput` (the ONE REST write door
// into a pty), and `sessionsApi.create` for the launch-a-new-bot branch.
import * as React from 'react'
import { useNavigate } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import { Loader2, Plus } from 'lucide-react'

import { sessionsApi, displayLabel } from '@/lib/api'
import { SESSIONS_KEY } from '@/hooks/use-sessions'
import { restSessionInput } from '@/lib/session-input/rest'
import { useUI } from '@/stores/ui-store'
import { useCompanies } from '@/hooks/use-companies'
import { CompanyMark, HqMark } from '@/components/roster/company-mark'
import { ResponsiveSheet } from '@/components/ui/responsive-sheet'
import { cn } from '@/lib/utils'
import type { ConnectorCard as Card } from '@/lib/api/connectors'

import type { BotChoice } from './connector-detail'
import { composeConnectorTask } from './connector-task'

/** The sentinel the picker uses for the leading "＋ Launch a new bot" row. */
const LAUNCH_NEW = '__launch_new__'

/** Slugify the requested service into a bot-name candidate. */
function slugify(s: string): string {
  return s
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 32)
}

export function CreateYourOwnSheet({
  open,
  onOpenChange,
  initialQuery,
  cards,
  botsOverride,
  onRegister,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** Pre-fills the "What do you want to connect?" input (Entry B pre-types the
   *  search query; Entry A opens empty). */
  initialQuery?: string
  /** The merged store cards the grid already holds — the catalog digest source. */
  cards: Card[]
  /** Offline bench only: seed the bot picker instead of `GET /api/sessions`. */
  botsOverride?: BotChoice[]
  /** Owner escape hatch: a bot already authored a manifest → jump to the review +
   *  admin-install surface. Absent = the link is hidden. */
  onRegister?: () => void
}) {
  const navigate = useNavigate()
  const activeCompany = useUI((s) => s.activeCompany)
  const { companies } = useCompanies()

  // State is seeded from props at MOUNT; the parent remounts this sheet (a `key`
  // nonce bumped on each open) so a reopen re-seeds fresh — the lint-clean
  // alternative to a reset-on-open effect (the EnableSigninSheet pattern).
  const [request, setRequest] = React.useState(initialQuery ?? '')
  const [notes, setNotes] = React.useState('')
  // The bot the handoff is in flight for (locks the list + button); `LAUNCH_NEW`
  // while a fresh bot is being created.
  const [busy, setBusy] = React.useState<string | null>(null)
  const [error, setError] = React.useState(false)

  const sessionsQuery = useQuery({
    queryKey: SESSIONS_KEY,
    queryFn: sessionsApi.list,
    staleTime: 30_000,
    enabled: open && !botsOverride,
  })
  const bots: BotChoice[] = botsOverride ?? sessionsQuery.data ?? []
  // Scope the eligible builders to the active space, exactly like the connect
  // handoff: HQ (no company) reaches every bot; a company reaches only its own.
  const eligibleBots: BotChoice[] = React.useMemo(
    () => (activeCompany === null ? bots : bots.filter((b) => b.company_id === activeCompany)),
    [bots, activeCompany],
  )

  const canSubmit = request.trim().length > 0 && busy === null

  // Compose → send → navigate. Shared tail for both the pick-an-existing-bot and
  // the launch-a-new-bot paths.
  const handoff = async (name: string) => {
    const text = composeConnectorTask({ request, notes, cards })
    await restSessionInput(name).submit(text)
    onOpenChange(false)
    navigate(`/focus/${encodeURIComponent(name)}`)
  }

  const pickExisting = async (name: string) => {
    if (!canSubmit) return
    setBusy(name)
    setError(false)
    try {
      await handoff(name)
    } catch {
      setError(true)
      setBusy(null)
    }
  }

  const launchNew = async () => {
    if (!canSubmit) return
    setBusy(LAUNCH_NEW)
    setError(false)
    const svc = request.trim()
    const base = slugify(svc) || 'connector'
    // A short suffix avoids a 409 collision without a round-trip; on the rare
    // clash we retry once with a fresh suffix.
    const mkName = () => `${base}-${Math.random().toString(36).slice(2, 6)}`
    try {
      let created
      try {
        created = await sessionsApi.create({
          name: mkName(),
          company_id: activeCompany ?? null,
          desc: `Builds the ${svc} connector`,
        })
      } catch {
        created = await sessionsApi.create({
          name: mkName(),
          company_id: activeCompany ?? null,
          desc: `Builds the ${svc} connector`,
        })
      }
      await handoff(created.name)
    } catch {
      setError(true)
      setBusy(null)
    }
  }

  return (
    <ResponsiveSheet
      open={open}
      onOpenChange={onOpenChange}
      title="Create your own connector"
      description="Tell a bot what to connect — it builds it into your store."
      className="sm:max-w-md"
    >
      <div className="flex flex-col gap-5 px-5 py-5" data-vr="create-your-own-sheet">
        {/* 1 — what to connect (required, pre-filled from the search query) */}
        <label className="flex flex-col gap-1.5">
          <span className="text-[12.5px] font-medium text-foreground">
            What do you want to connect? <span className="text-muted-foreground">(a service or API)</span>
          </span>
          <input
            type="text"
            value={request}
            autoFocus
            onChange={(e) => setRequest(e.target.value)}
            placeholder="Linear"
            aria-label="What do you want to connect?"
            data-vr="create-your-own-request"
            className="h-11 w-full rounded-xl border border-input bg-background px-3 text-[13px] text-foreground outline-none placeholder:text-muted-foreground focus-visible:ring-2 focus-visible:ring-ring"
          />
        </label>

        {/* 2 — optional notes */}
        <label className="flex flex-col gap-1.5">
          <span className="text-[12.5px] font-medium text-foreground">
            Anything specific? <span className="text-muted-foreground">(optional)</span>
          </span>
          <textarea
            value={notes}
            rows={3}
            onChange={(e) => setNotes(e.target.value)}
            placeholder="API-key auth; I mainly need to create + list issues. Docs: linear.app/developers"
            aria-label="Anything specific?"
            className="w-full resize-y rounded-xl border border-input bg-background px-3 py-2.5 text-[13px] leading-relaxed text-foreground outline-none placeholder:text-muted-foreground focus-visible:ring-2 focus-visible:ring-ring"
          />
        </label>

        {/* 3 — who should build it */}
        <div className="flex flex-col gap-2">
          <span className="text-[11.5px] font-medium uppercase tracking-wide text-muted-foreground">
            Who should build it?
          </span>
          <div className="flex flex-col gap-0.5 rounded-xl border border-border bg-background p-1.5">
            {/* leading dashed "launch a new bot" row */}
            <button
              type="button"
              disabled={busy !== null || request.trim().length === 0}
              onClick={() => void launchNew()}
              data-vr="create-your-own-launch-new"
              className={cn(
                'flex min-h-[52px] items-center gap-3 rounded-lg border border-dashed border-border px-2.5 py-2 text-left transition-colors hover:bg-muted disabled:cursor-default disabled:opacity-60',
                busy === LAUNCH_NEW && 'bg-muted',
              )}
            >
              <span className="grid size-7 shrink-0 place-items-center rounded-full bg-primary/10 text-primary">
                {busy === LAUNCH_NEW ? (
                  <Loader2 className="size-4 animate-spin" aria-hidden />
                ) : (
                  <Plus className="size-4" aria-hidden />
                )}
              </span>
              <span className="flex min-w-0 flex-1 flex-col leading-tight">
                <span className="truncate text-[14px] font-medium text-foreground">
                  Launch a new bot to build it
                </span>
                <span className="truncate text-[12px] text-muted-foreground">
                  {busy === LAUNCH_NEW ? 'Starting…' : 'A fresh bot in this space'}
                </span>
              </span>
            </button>

            {sessionsQuery.isLoading && eligibleBots.length === 0 && !botsOverride ? (
              <span className="px-2.5 py-1.5 text-[12px] text-muted-foreground">Loading bots…</span>
            ) : (
              eligibleBots.map((b) => {
                const co = b.company_id != null ? companies.find((c) => c.id === b.company_id) : undefined
                const rowBusy = busy === b.name
                return (
                  <button
                    key={b.name}
                    type="button"
                    disabled={busy !== null || request.trim().length === 0}
                    onClick={() => void pickExisting(b.name)}
                    className={cn(
                      'flex min-h-[52px] items-center gap-3 rounded-lg px-2.5 py-2 text-left transition-colors hover:bg-muted disabled:cursor-default disabled:opacity-60',
                      rowBusy && 'bg-muted',
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
                        {rowBusy ? 'Handing off…' : b.status}
                      </span>
                    </span>
                    {rowBusy && <Loader2 className="size-4 shrink-0 animate-spin text-muted-foreground" aria-hidden />}
                  </button>
                )
              })
            )}
          </div>
          {error && (
            <span className="text-[12px] text-destructive">
              Couldn't hand it off — try again.
            </span>
          )}
        </div>

        {onRegister && (
          <button
            type="button"
            onClick={onRegister}
            data-vr="create-your-own-register-link"
            className="inline-flex min-h-9 w-fit items-center self-start text-[12.5px] font-medium text-muted-foreground underline-offset-2 transition-colors hover:text-foreground hover:underline"
          >
            A bot already built one? Register it →
          </button>
        )}
      </div>
    </ResponsiveSheet>
  )
}
