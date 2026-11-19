// "Messages from companies" — the per-bot switch that lets ONE HQ bot take
// `/supermux-message` from company bots (server: `company_inbox`, PR #205).
//
// A company bot can message only its own company, and that stays the default:
// every HQ bot is closed until the owner flips this on its own Setup tab. Open
// means every company, or only the ticked ones. Closing is the same switch.
//
// Owner/admin only, like the route behind it (`PUT/DELETE
// /api/sessions/{name}/company-inbox`, audited server-side). A member never sees
// it; a company bot shows it switched off with the reason, so the owner learns
// where the setting lives without being able to set it somewhere it means
// nothing. Every row is the server's answer, never an optimistic guess.

import * as React from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'

import { sessionsApi, type ApiSession } from '@/lib/api'
import { useCompanies } from '@/hooks/use-companies'
import { useIsOwnerPlane } from '@/stores/viewer-store'
import { Switch } from '@/components/settings/primitives'
import { useToast } from '@/components/ui/use-toast'
import { cn } from '@/lib/utils'
import { companyInboxKey, inboxSummary, toggledSlugs } from './company-inbox-model'

const HINT =
  'Lets company bots report back to this HQ bot with /supermux-message. Their messages arrive as reports from that bot, not as your instructions. All other HQ bots stay closed.'

export function CompanyInboxField({ name, session }: { name: string; session: ApiSession | null }) {
  return <CompanyInboxView name={name} session={session} owner={useIsOwnerPlane()} />
}

/** The field for a known viewer — split out so the owner fence is a prop a
 *  test can set (the viewer store reads its initial state on a static render). */
export function CompanyInboxView({
  name,
  session,
  owner,
}: {
  name: string
  session: ApiSession | null
  owner: boolean
}) {
  if (!owner || !session) return null
  if (session.company_id != null) {
    return (
      <section className="flex flex-col gap-2" data-testid="company-inbox">
        <Heading />
        <div className="flex items-center justify-between gap-3">
          <p className="text-[12px] leading-snug text-muted-foreground">
            Only HQ bots have this. A company bot already messages its own company, and other
            companies stay closed to it.
          </p>
          <Switch checked={false} onCheckedChange={() => {}} ariaLabel="Allow messages from companies" disabled />
        </div>
      </section>
    )
  }
  return <HqInbox name={name} />
}

function Heading() {
  return (
    <div className="flex flex-col gap-0.5">
      <h3 className="text-[13px] font-semibold tracking-tight text-foreground">Messages from companies</h3>
      <p className="text-[12px] leading-snug text-muted-foreground">{HINT}</p>
    </div>
  )
}

function HqInbox({ name }: { name: string }) {
  const qc = useQueryClient()
  const { toast } = useToast()
  const { companies } = useCompanies()
  const inbox = useQuery({
    queryKey: companyInboxKey(name),
    queryFn: () => sessionsApi.companyInbox(name),
    staleTime: 30_000,
  })
  const [saving, setSaving] = React.useState(false)
  const data = inbox.data
  const open = data?.open ?? false
  const list = data && data.companies !== '*' ? data.companies : []

  async function save(next: '*' | string[] | null) {
    if (saving) return
    setSaving(true)
    try {
      const out =
        next === null
          ? await sessionsApi.closeCompanyInbox(name)
          : await sessionsApi.openCompanyInbox(name, next)
      qc.setQueryData(companyInboxKey(name), out)
    } catch (e) {
      toast({
        message: e instanceof Error ? e.message : 'Could not save that setting.',
        tone: 'error',
      })
    } finally {
      setSaving(false)
    }
  }

  const busy = saving || inbox.isLoading
  return (
    <section className="flex flex-col gap-2" data-testid="company-inbox">
      <Heading />
      <div className="flex items-center justify-between gap-3">
        <p className="text-[13px] text-foreground" data-testid="company-inbox-status">
          {inbox.isError ? 'Couldn’t load this setting.' : inboxSummary(data, companies)}
        </p>
        <Switch
          checked={open}
          onCheckedChange={(on) => void save(on ? '*' : null)}
          ariaLabel="Allow messages from companies"
          disabled={busy || inbox.isError}
        />
      </div>
      {open && (
        <div className="flex flex-col gap-2 rounded-[12px] bg-secondary/60 p-3">
          <div role="radiogroup" aria-label="Which companies" className="flex flex-wrap gap-1.5">
            <Choice
              active={data?.companies === '*'}
              disabled={busy}
              onClick={() => void save('*')}
              label="All companies"
            />
            <Choice
              active={data?.companies !== '*'}
              disabled={busy || companies.length === 0}
              // Switching to a list starts from every company ticked, so the
              // inbox never narrows to nobody; untick from there.
              onClick={() => void save(companies.map((c) => c.slug))}
              label="Only these"
            />
          </div>
          {data?.companies !== '*' && (
            <ul className="flex flex-col" data-testid="company-inbox-list">
              {companies.map((c) => {
                const checked = list.includes(c.slug)
                const last = checked && list.length === 1
                return (
                  <li key={c.slug}>
                    <label
                      className={cn(
                        'flex min-h-11 items-center gap-2.5 text-[13px] text-foreground',
                        last && 'opacity-60',
                      )}
                      title={last ? 'Turn the switch off to close the inbox' : undefined}
                    >
                      <input
                        type="checkbox"
                        className="size-4 rounded border-hairline accent-primary"
                        checked={checked}
                        disabled={busy || last}
                        onChange={() => {
                          const next = toggledSlugs(list, c.slug)
                          if (next) void save(next)
                        }}
                      />
                      {c.display_name || c.slug}
                    </label>
                  </li>
                )
              })}
            </ul>
          )}
        </div>
      )}
    </section>
  )
}

function Choice({
  active,
  disabled,
  onClick,
  label,
}: {
  active: boolean
  disabled: boolean
  onClick: () => void
  label: string
}) {
  return (
    <button
      type="button"
      role="radio"
      aria-checked={active}
      disabled={disabled}
      onClick={() => {
        if (!active) onClick()
      }}
      className={cn(
        'min-h-11 rounded-[10px] px-3 text-[13px] font-medium transition-colors',
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
        'disabled:pointer-events-none disabled:opacity-60',
        active ? 'bg-primary text-primary-foreground shadow-sm' : 'bg-card text-foreground hover:bg-muted',
      )}
    >
      {label}
    </button>
  )
}
