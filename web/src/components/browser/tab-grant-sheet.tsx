// "Who may use this tab" — the per-tab lending sheet.
//
// This is where the human hands an agent a tab they are ALREADY signed into, so
// it is the highest-consequence control in the workspace and it deliberately
// reuses the store's `GrantControl` rather than growing a second, subtly
// different grant UI. Same three tiers (this bot / this company / all agents),
// same `@company:<id>` keyspace, same hide-at-HQ rule, and — the part that
// matters — the same honesty rule: a grant that reaches a bot via a BROADER
// scope is read-only here, because revoking it from one bot would be a phantom
// revoke that changes nothing (shared-browser v1 §6.5).
//
// A `ResponsiveSheet`, so this is a drag-detent bottom sheet on a phone and a
// side panel on a mouse — one component, both shells, `pb-safe` handled there.
//
// EVERYTHING HERE STATES ITS EVIDENCE. The header repeats the tab's honest
// state (`tabState`), the origin list says an agent can never widen it, and the
// close-tab note says a delete is not a sign-out — because it is not.
import * as React from 'react'

import { Loader2, Pin, PinOff, Plus, Shield, ShieldAlert, ShieldCheck, X } from 'lucide-react'

import { ALL_AGENTS, companyGrantKey } from '@/lib/api/connectors'
import {
  activeGrantees,
  grantCandidates,
  granteeLabel,
  mayGrantAll,
  tabGrantNeedsRestart,
  tabHost,
  tabState,
  type BrowserTab,
  type GrantCandidate,
  type TabGrant,
} from '@/lib/api/browser'
import { canKeepSignedIn, keepAliveSheetRow } from '@/lib/browser/keep-signed-in'
import { GrantControl, type GrantScope } from '@/components/store/grant-control'
import { RestartToApply } from '@/components/roster/granted-connectors'
import { ResponsiveSheet } from '@/components/ui/responsive-sheet'
import { cn } from '@/lib/utils'
import { SessionPicker } from '@/components/session/session-picker'
import { useCompanies } from '@/hooks/use-companies'

export interface TabGrantSheetProps {
  tab: BrowserTab | null
  open: boolean
  onOpenChange: (open: boolean) => void
  /** Candidate grantees WITH their company, so the sheet can offer only the
   *  ones this tab's company containment will accept. Injected so the bench
   *  needs no server. */
  bots: GrantCandidate[]
  onGrant: (grantee: string) => Promise<unknown>
  onRevoke: (grantee: string) => Promise<unknown>
  onPin: (pinned: boolean) => void
  /** "Keep me signed in". Omit to hide the row (a host with no such verb). */
  onKeepAlive?: (on: boolean) => void
  /** Replace the origin allowlist. Omit to render it read-only. */
  onOrigins?: (origins: string[]) => void
  /** Offline bench only — see `ResponsiveSheet.contentTheme`. */
  contentTheme?: 'light' | 'dark'
}

export function TabGrantSheet({
  tab,
  open,
  onOpenChange,
  bots,
  onGrant,
  onRevoke,
  onPin,
  onKeepAlive,
  onOrigins,
  contentTheme,
}: TabGrantSheetProps) {
  const { companies } = useCompanies()
  // The TAB's company, not the roster's. A grant must land in the tab's own
  // company or `grant_handler` refuses it with a 400 — so the globally-active
  // UI company is the wrong scope here, and offering it would draw a tier that
  // can only fail.
  const company =
    tab && tab.company_id !== null
      ? companies.find((c) => c.id === tab.company_id) ?? null
      : null
  const candidates = React.useMemo(
    () => (tab ? grantCandidates(bots, tab) : []),
    [bots, tab],
  )
  const [busy, setBusy] = React.useState<string | null>(null)

  const granted = React.useMemo(() => (tab ? activeGrantees(tab) : []), [tab])
  // The same set as `granted`, but the ROWS — each carries the server's honest
  // `applied` / `running` pair, which is the only way this sheet can tell "lent"
  // from "lent and usable".
  const liveGrants = React.useMemo<TabGrant[]>(
    () => (tab ? tab.grants.filter((g) => g.enabled !== 0) : []),
    [tab],
  )

  // The bots the human can still HAND this tab — the tab's company-mates minus
  // whoever already holds it. This is the roster the picker offers; picking one
  // grants it on the spot (no separate "confirm" tier), which is the "one easy
  // search-and-tap" the cramped chip row could not be.
  const addable = React.useMemo(
    () => candidates.filter((c) => !granted.includes(c.name)),
    [candidates, granted],
  )

  // Only the BROAD scopes live in GrantControl now — All agents (and, for a
  // company-owned tab, that company). There is no single-bot context in the
  // shared browser, so the "This bot" tier is gone; a per-bot grant is made by
  // picking a bot above, not by a tier here.
  const scope: GrantScope = React.useMemo(() => {
    if (granted.includes(ALL_AGENTS)) return 'all'
    if (company && granted.includes(companyGrantKey(company.id))) return 'company'
    return null
  }, [granted, company])

  const state = tab ? tabState(tab) : null
  // One call, one story: the title, the line under it and the icon all come from
  // the same row, so the icon can never disagree with the sentence beside it.
  const keepAlive = tab ? keepAliveSheetRow(tab) : null

  const grant = async (grantee: string) => {
    setBusy(grantee)
    try {
      await onGrant(grantee)
    } finally {
      setBusy(null)
    }
  }

  const revoke = async (grantee: string) => {
    setBusy(grantee)
    try {
      await onRevoke(grantee)
    } finally {
      setBusy(null)
    }
  }

  return (
    <ResponsiveSheet
      open={open}
      onOpenChange={onOpenChange}
      title="Who may use this tab"
      description={
        tab
          ? `${tab.title || tabHost(tab.url)} — ${state?.detail ?? ''}`
          : 'No tab selected.'
      }
      className="sm:max-w-md"
      contentTheme={contentTheme}
    >
      {!tab ? null : (
        <div
          // `px-5` matches the sheet header's own gutter in BOTH shells — the
          // body slot ships without padding on purpose.
          className="flex flex-col gap-5 px-5 pb-5 pt-4"
          data-tab-sheet={tab.id}
        >
          {/* A tab that needs a sign-in refuses agent verbs server-side (409).
              Say so HERE too — an agent blocked by a state the human cannot see
              is the failure this whole surface exists to prevent. */}
          {state?.tone === 'needs-login' && (
            <p
              data-tab-needs-login=""
              className="rounded-xl border border-amber-500/40 bg-amber-500/10 px-3 py-2.5 text-[12.5px] leading-relaxed text-foreground"
            >
              <span className="font-medium">Sign-in needed.</span> Agents granted this
              tab are refused until you take the wheel and sign in again — they will
              not read the login page and call it data.
            </p>
          )}

          {/* Pin — explicit, not a hidden long-press. */}
          <button
            type="button"
            onClick={() => onPin(!tab.pinned)}
            className="flex min-h-11 items-center justify-between gap-3 rounded-xl border border-border px-3 text-left transition-colors hover:bg-secondary/60 motion-reduce:transition-none"
          >
            <span className="flex min-w-0 flex-col">
              <span className="text-[13px] font-medium text-foreground">
                {tab.pinned ? 'Pinned' : 'Not pinned'}
              </span>
              <span className="text-[11.5px] text-muted-foreground">
                {tab.pinned
                  ? 'Kept across restarts and never closed by the idle reaper.'
                  : 'An unpinned tab may be closed when the browser goes idle.'}
              </span>
            </span>
            {tab.pinned ? (
              <PinOff className="size-4 shrink-0 text-muted-foreground" aria-hidden />
            ) : (
              <Pin className="size-4 shrink-0 text-muted-foreground" aria-hidden />
            )}
          </button>

          {/* KEEP ME SIGNED IN — the same primitive as Pin, one row down.
              State-first here (the ⋯ menu says the verb), because this is where
              there is room for the COST: an enabled tab is held open, and a
              held-open tab keeps the browser process up. Say so. */}
          {/* `|| keepalive_enabled`: a tab that drifted to a non-http page is
              still ON and still costs a slot, so the way to switch it off has
              to stay reachable. */}
          {onKeepAlive && (canKeepSignedIn(tab.url) || tab.keepalive_enabled) && (
            <button
              type="button"
              data-tab-keepalive={tab.id}
              onClick={() => onKeepAlive(!tab.keepalive_enabled)}
              className="flex min-h-11 items-center justify-between gap-3 rounded-xl border border-border px-3 text-left transition-colors hover:bg-secondary/60 motion-reduce:transition-none"
            >
              <span className="flex min-w-0 flex-col">
                <span className="text-[13px] font-medium text-foreground">
                  {keepAlive?.title}
                </span>
                <span
                  className={cn(
                    'text-[11.5px]',
                    keepAlive?.attention
                      ? 'text-amber-600 dark:text-amber-500'
                      : 'text-muted-foreground',
                  )}
                >
                  {keepAlive?.detail}
                </span>
              </span>
              {/* The icon is the STATE, and the state is not always good: a
                  check mark over "Can't check this tab" is the false green light
                  this sheet exists to prevent. */}
              {keepAlive?.attention ? (
                <ShieldAlert
                  className="size-4 shrink-0 text-amber-600 dark:text-amber-500"
                  aria-hidden
                />
              ) : tab.keepalive_enabled ? (
                <ShieldCheck className="size-4 shrink-0 text-muted-foreground" aria-hidden />
              ) : (
                <Shield className="size-4 shrink-0 text-muted-foreground" aria-hidden />
              )}
            </button>
          )}

          {/* GIVE A BOT ACCESS — the easy path. The same roster picker the
              workflows composer uses (chic pill + faces, a DropdownMenu on a
              mouse and a Vaul half-sheet on a phone), fed the tab's eligible
              company-mates. Picking one lends the tab immediately; it then shows
              in "Currently lent to" below, with its own Revoke. */}
          {candidates.length > 0 && (
            <div className="flex flex-col gap-2" data-grant-picker="">
              <div className="text-[11.5px] font-medium uppercase tracking-wide text-muted-foreground">
                Give a bot access
              </div>
              {addable.length > 0 ? (
                <SessionPicker
                  value=""
                  onChange={(name) => {
                    if (name) void grant(name)
                  }}
                  sessions={addable}
                  allowEmpty={false}
                  placeholder="Pick a bot to lend this tab"
                  ariaLabel="Give a bot access to this tab"
                  menuLabel="Lend this tab to"
                />
              ) : (
                <p className="text-[12.5px] text-muted-foreground">
                  Every eligible bot already has this tab.
                </p>
              )}
            </div>
          )}

          {/* The BROAD scopes only — All agents, and (for a company-owned tab)
              that company. "This bot" is gone: the shared browser is never
              opened "as" one bot, so a per-bot grant is the picker above, not a
              tier here. */}
          <GrantControl
            connectorId={`tab:${tab.id}`}
            botName={null}
            allowBot={false}
            scope={scope}
            resourceLabel="this tab"
            companyOverride={company}
            allowAll={mayGrantAll(tab)}
            api={{
              grant: async (target) => {
                await onGrant(target)
              },
              revoke: async (target) => {
                await onRevoke(target)
              },
            }}
          />

          {/* Containment, stated where the choice is made. The server enforces
              it either way; saying so here is what stops a human hunting for
              the bot that is deliberately not in the list. */}
          {company && (
            <p className="text-[11.5px] leading-relaxed text-muted-foreground">
              This tab belongs to{' '}
              <span className="font-medium text-foreground">{company.display_name}</span>
              . Only that company's bots can be lent it — a tab is never shared
              across companies.
            </p>
          )}

          {/* Who holds it right now — the blast radius, spelled out. */}
          <div className="flex flex-col gap-2">
            <div className="text-[11.5px] font-medium uppercase tracking-wide text-muted-foreground">
              Currently lent to
            </div>
            {granted.length === 0 ? (
              <p className="text-[12.5px] text-muted-foreground">
                Nobody. This tab is yours alone until you lend it.
              </p>
            ) : (
              <ul className="flex flex-col gap-1.5">
                {liveGrants.map((g) => (
                  <li
                    key={g.grantee}
                    data-tab-grantee={g.grantee}
                    className="flex flex-col gap-1.5 rounded-xl border border-border px-3 py-2"
                  >
                    <div className="flex min-h-9 items-center justify-between gap-2">
                      <span className="min-w-0 truncate text-[12.5px] text-foreground">
                        {granteeLabel(g.grantee, company?.display_name)}
                      </span>
                      <button
                        type="button"
                        onClick={() => void revoke(g.grantee)}
                        disabled={busy !== null}
                        className="inline-flex min-h-9 shrink-0 items-center gap-1 rounded-md px-2 text-[12px] font-medium text-destructive transition-colors hover:bg-destructive/10 disabled:opacity-50 motion-reduce:transition-none"
                      >
                        {busy === g.grantee && (
                          <Loader2 className="size-3 animate-spin" aria-hidden />
                        )}
                        Revoke
                      </button>
                    </div>
                    {/* LENT ≠ USABLE. The tab grant now carries the Shared
                        Browser connector with it, but a connector only reaches a
                        bot's toolset at launch — so a bot that was already
                        running has the tab and not the `browser_*` tools yet.
                        Saying nothing here is what left a bot improvising
                        against the HTTP API and inventing a connect card. One
                        sentence, and the one tap that fixes it. */}
                    {tabGrantNeedsRestart(g) && (
                      <div
                        data-tab-grant-restart={g.grantee}
                        className="flex flex-wrap items-center justify-between gap-2"
                      >
                        <span className="text-[11.5px] leading-relaxed text-muted-foreground">
                          Lent, but {g.grantee} is running without the browser tools.
                          Restart it to hand them over.
                        </span>
                        <RestartToApply name={g.grantee} />
                      </div>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </div>

          <OriginList tab={tab} onOrigins={onOrigins} />

          <p className="text-[11.5px] leading-relaxed text-muted-foreground">
            Closing a tab does not sign you out — the cookies live in one shared
            browser profile. The only real eraser is resetting the profile, which
            signs out everything.
          </p>
        </div>
      )}
    </ResponsiveSheet>
  )
}

/** Where an agent may steer this tab. Widening it is a HUMAN act — the server
 *  refuses an agent `navigate` off-list with a 403, so this list is a real
 *  boundary and not a preference. */
function OriginList({
  tab,
  onOrigins,
}: {
  tab: BrowserTab
  onOrigins?: (origins: string[]) => void
}) {
  const [draft, setDraft] = React.useState('')
  const add = () => {
    const host = draft.trim().toLowerCase()
    if (!host || tab.origins.includes(host)) return
    onOrigins?.([...tab.origins, host])
    setDraft('')
  }
  return (
    <div className="flex flex-col gap-2">
      <div className="text-[11.5px] font-medium uppercase tracking-wide text-muted-foreground">
        Agents may open
      </div>
      <ul className="flex flex-wrap gap-1.5">
        {tab.origins.map((host) => (
          <li
            key={host}
            data-tab-origin={host}
            className="inline-flex min-h-9 items-center gap-1.5 rounded-lg border border-border px-2.5 font-mono text-[11.5px] text-foreground"
          >
            {host}
            {onOrigins && (
              <button
                type="button"
                aria-label={`Remove ${host}`}
                onClick={() => onOrigins(tab.origins.filter((h) => h !== host))}
                className="relative text-muted-foreground after:absolute after:-inset-2.5 after:content-[''] hover:text-foreground"
              >
                <X className="size-3" aria-hidden />
              </button>
            )}
          </li>
        ))}
        {tab.origins.length === 0 && (
          <li className="text-[12.5px] text-muted-foreground">
            Nothing — an agent cannot navigate this tab anywhere at all.
          </li>
        )}
      </ul>
      {onOrigins && (
        <div className="flex items-center gap-1.5">
          <input
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault()
                add()
              }
            }}
            placeholder="mail.example.com or .example.com"
            aria-label="Allow another host on this tab"
            className="min-h-11 min-w-0 flex-1 rounded-xl border border-border bg-background px-3 font-mono text-[12px] text-foreground outline-none placeholder:text-muted-foreground focus:border-primary"
          />
          <button
            type="button"
            onClick={add}
            aria-label="Allow this host"
            className="flex size-11 shrink-0 items-center justify-center rounded-xl border border-border text-muted-foreground transition-colors hover:text-foreground motion-reduce:transition-none"
          >
            <Plus className="size-4" aria-hidden />
          </button>
        </div>
      )}
    </div>
  )
}
