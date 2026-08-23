// The connector detail sheet — the store's expand: full tool list, the connect
// flow (secure credential paste OR sign-in), the grant control, and remove.
//
// This is where the store's connect actually happens: paste a key once → it is
// sealed into the vault (`POST /{id}/credential`, write-only) and, when a bot
// scope is active, granted to that bot in the same call. The secret is never
// echoed back — the field flips to a masked "Added" state.
import * as React from 'react'
import { useQuery } from '@tanstack/react-query'
import { Check, Loader2, Trash2 } from 'lucide-react'

import {
  ALL_AGENTS,
  companyGrantKey,
  secretField,
  toolCountLabel,
  type ConnectorCard as Card,
  type CredentialField,
} from '@/lib/api/connectors'
import { sessionsApi, displayLabel } from '@/lib/api'
import { SESSIONS_KEY } from '@/hooks/use-sessions'
import { useConnectorActions } from '@/stores/connectors-store'
import { useUI } from '@/stores/ui-store'
import { useCompanies } from '@/hooks/use-companies'
import { CompanyMark } from '@/components/roster/company-mark'
import { cn } from '@/lib/utils'

import { ConnectorIcon } from './connector-icon'
import { OfficialBadge } from './connector-card'
import { GrantControl, type GrantScope } from './grant-control'
import { ConnectFlow, type ConnectFlowResult } from './connect-flow'

/** A pickable grant target in the library "Grant to" step. */
export interface BotChoice {
  name: string
  display_name?: string
  status?: string
}

export function ConnectorDetail({
  card,
  installed,
  granted,
  grantTarget,
  onDone,
  onRemoved,
  botsOverride,
}: {
  card: Card
  installed: boolean
  granted: GrantScope
  /** The active scope: a bot slug, `*`, or `null` (library view). */
  grantTarget: string | null
  onDone: () => void
  onRemoved?: () => void
  /** Offline bench only: seed the "Grant to" bot list instead of `GET
   *  /api/sessions`. Undefined in production, where the live query supplies it. */
  botsOverride?: BotChoice[]
}) {
  const actions = useConnectorActions()
  const secret = secretField(card)
  const needsSecret = !!secret
  // The connect flow's outcome once sealed/granted (seeded to an added state when
  // the connector is already granted, so re-opening it shows the confirmation).
  const [added, setAdded] = React.useState<ConnectFlowResult | null>(
    granted ? { restartHint: false } : null,
  )
  const [localGrant, setLocalGrant] = React.useState<GrantScope>(granted)

  // The top-level `/store` detail has NO bot in scope (`grantTarget === null`),
  // so without this it silently sealed the credential to the vault and granted to
  // no one — the connect then read as "install = everyone" once you tapped the
  // lone "All agents" toggle below. The "Grant to" step makes the choice explicit:
  // a multi-select of known bots + an "All agents" toggle, defaulting to NOTHING
  // selected so Connect stays disabled until you pick who gets it.
  const isLibrary = grantTarget === null
  // Enabled in BOTH scopes (not just library): the "Added" panel's Restart-bot
  // buttons resolve each granted bot's display label and its live status (to guard
  // a mid-turn restart) from this list. The offline bench passes `botsOverride`, so
  // the live query stays off there.
  const sessionsQuery = useQuery({
    queryKey: SESSIONS_KEY,
    queryFn: sessionsApi.list,
    staleTime: 30_000,
    enabled: !botsOverride,
  })
  const bots: BotChoice[] = botsOverride ?? sessionsQuery.data ?? []
  const [selectedBots, setSelectedBots] = React.useState<Set<string>>(
    () => new Set(),
  )
  const [allAgents, setAllAgents] = React.useState(false)
  // The active company (roster scope) is a third library grant target — "All bots
  // in this company". Only offered inside a company (`activeCompany !== null`).
  const activeCompany = useUI((s) => s.activeCompany)
  const { companies } = useCompanies()
  const company =
    activeCompany !== null ? companies.find((c) => c.id === activeCompany) ?? null : null
  const companyKey = company ? companyGrantKey(company.id) : null
  // With a company active in the library view, the company is the DEFAULT install
  // target — so one tap on "Install" grants the connector to `@company:<id>` and
  // it lands in the company store, no picker step required. HQ (no company) keeps
  // the deliberate empty default (Connect stays disabled until a scope is chosen).
  const [companyChosen, setCompanyChosen] = React.useState(
    () => isLibrary && activeCompany !== null,
  )
  // "All agents" is a superset — when it is on, the per-bot rows AND the company
  // row show as checked (and locked), and the grant resolves to a single `*` row.
  const chosenTargets: string[] = allAgents
    ? [ALL_AGENTS]
    : [...(companyChosen && companyKey ? [companyKey] : []), ...selectedBots]
  const needChoice = isLibrary && chosenTargets.length === 0
  // What we actually granted to, for the "Added to …" confirmation. Seeded from
  // an already-granted open so re-opening a granted connector still names it.
  const [addedTargets, setAddedTargets] = React.useState<string[]>(() =>
    granted && grantTarget ? [grantTarget] : [],
  )
  const toggleBot = (name: string) => {
    if (allAgents) return
    setSelectedBots((prev) => {
      const next = new Set(prev)
      if (next.has(name)) next.delete(name)
      else next.add(name)
      return next
    })
  }

  // The seal + grant strategy the SHARED <ConnectFlow> calls. It owns the fields,
  // the lane and the test leg; this owns the store's install + multi-target grant.
  const onSubmit = async ({ fields }: { fields: Record<string, string> }): Promise<ConnectFlowResult> => {
    // Install a catalog card into the local registry first (idempotent). Carry the
    // auth descriptor so the installed row keeps its lane.
    if (!installed) {
      await actions.install({
        id: card.id,
        kind: card.kind,
        display_name: card.display_name,
        icon: card.icon,
        description: card.description,
        tools: card.tools,
        credentials: card.credentials,
        auth: card.auth ?? undefined,
      })
    }
    // Resolve the scope to the grant targets. Library view = the "Grant to"
    // selection (N bots, or the single `*` all-agents row); a bot scope = the one
    // target the sheet was opened with.
    const targets = isLibrary ? chosenTargets : grantTarget ? [grantTarget] : []
    let restartHint = false
    let accountRef: string | null = null
    let accountLabel: string | null = null
    if (Object.keys(fields).length > 0) {
      // Seal ONCE (attaching the first target's grant), then reuse the returned
      // `secret_ref` + `account_ref` for the remaining bots so N grants share one
      // vault secret + one account instead of re-sealing per bot.
      const res = await actions.putCredentialFull(card.id, {
        fields,
        session_name: targets[0] ?? undefined,
      })
      accountRef = res.account_ref ?? null
      accountLabel = res.account_label ?? null
      for (const t of targets.slice(1)) {
        await actions.grant(card.id, t, res.secret_ref, accountRef ?? undefined)
      }
      restartHint = true
    } else if (targets.length > 0) {
      // No credential (built-in / mcp_oauth / none) — just land the grant(s).
      for (const t of targets) {
        restartHint = (await actions.grant(card.id, t)) || restartHint
      }
    }
    setAddedTargets(targets)
    setLocalGrant(
      targets.includes(ALL_AGENTS)
        ? 'all'
        : companyKey && targets.includes(companyKey)
          ? 'company'
          : isLibrary
            ? null
            : 'bot',
    )
    return { restartHint, accountRef, accountLabel }
  }

  const tools = toolCountLabel(card)
  const botName = grantTarget && grantTarget !== '*' ? grantTarget : null

  return (
    // The sheet body (ResponsiveSheet) has NO horizontal padding of its own, so
    // the detail content owns its inset. Without this the description, the header
    // and the Remove link ran flush to the screen edge while the p-4 cards read as
    // inset — an untidy split. A single content inset (px-5, matching the sheet
    // header's px-5) pulls everything to one tidy left/right margin; the cards keep
    // their internal p-4 on top of it. (owner device feedback)
    <div className="flex flex-col gap-5 px-5 py-5">
      {/* header */}
      <div className="flex items-start gap-3.5">
        <ConnectorIcon card={card} size={56} />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <h2 className="text-[19px] font-semibold leading-tight tracking-tight text-foreground">
              {card.display_name}
            </h2>
            {card.official && <OfficialBadge label />}
          </div>
          <div className="mt-1 flex flex-wrap items-center gap-2 text-[12.5px] text-muted-foreground">
            {tools && <span className="font-medium">{tools}</span>}
            <span className="capitalize">{kindLabel(card.kind)}</span>
            {primaryCategory(card) && <span className="capitalize">{primaryCategory(card)}</span>}
          </div>
        </div>
      </div>

      <p className="text-[14px] leading-relaxed text-foreground/90">{card.description}</p>

      {/* Install / connect command — the exact one-liner to wire this connector. */}
      {card.install && <InstallBlock command={card.install} />}

      {/* connect / credential flow — the ONE shared <ConnectFlow> (same lane,
          fields, seal and test leg the in-chat ConnectCard mounts). The store's
          bespoke duplicate render is gone; only the "Grant to" picker and the CTA
          copy are store-specific, passed in below. */}
      <ConnectFlow
        card={card}
        variant="store"
        onSubmit={onSubmit}
        onDone={(r) => setAdded(r)}
        initialAdded={!!added}
        submitLabel={needsSecret ? 'Connect' : grantTarget ? 'Add to this bot' : 'Install'}
        blockedLabel={`${needsSecret ? 'Connect' : 'Install'} — choose who gets it`}
        submitDisabled={needChoice}
        renderAddedExtra={() => <RestartTargets targets={addedTargets} bots={bots} />}
      >
        {/* GRANT TO — the choose-who-gets-it step, library scope only. In a bot
            scope the sheet already carries the one target, so this is skipped. */}
        {isLibrary && (
          <GrantPicker
            bots={bots}
            selectedBots={selectedBots}
            allAgents={allAgents}
            company={company}
            companyChosen={companyChosen}
            loading={sessionsQuery.isLoading && !botsOverride}
            onToggleBot={toggleBot}
            onToggleAll={() => setAllAgents((v) => !v)}
            onToggleCompany={() => setCompanyChosen((v) => !v)}
          />
        )}
      </ConnectFlow>

      {/* grant control (once installed) */}
      {(installed || added) && (
        <div className="rounded-2xl border border-border bg-card p-4">
          <GrantControl
            connectorId={card.id}
            botName={botName}
            scope={localGrant}
            onGranted={() => {
              setLocalGrant(grantTarget === '*' ? 'all' : 'bot')
            }}
            onRevoked={() => setLocalGrant(null)}
          />
        </div>
      )}

      {/* tools */}
      {card.tools && card.tools.length > 0 && (
        <div className="flex flex-col gap-2">
          <h3 className="text-[13px] font-semibold text-foreground">Tools</h3>
          <ul className="flex flex-col divide-y divide-border overflow-hidden rounded-2xl border border-border">
            {card.tools.map((t) => (
              <li key={t.name} className="flex flex-col gap-0.5 px-3.5 py-2.5">
                <span className="font-mono text-[12.5px] font-medium text-foreground">{t.name}</span>
                {t.description && <span className="text-[12px] text-muted-foreground">{t.description}</span>}
              </li>
            ))}
          </ul>
        </div>
      )}

      {/* remove (local rows only) */}
      {installed && (
        <button
          type="button"
          onClick={async () => {
            await actions.remove(card.id)
            onRemoved?.()
            onDone()
          }}
          className="inline-flex items-center gap-1.5 self-start rounded-lg px-2 py-1.5 text-[12.5px] font-medium text-destructive transition-colors hover:bg-destructive/10"
        >
          <Trash2 className="size-3.5" aria-hidden />
          Remove connector
        </button>
      )}
    </div>
  )
}

/** The connector's primary chip-rail category (skips the `featured` meta tag). */
function primaryCategory(card: Card): string | null {
  return (card.categories ?? []).find((c) => c !== 'featured') ?? null
}

/** The install/connect command — monospace, selectable, horizontally scrollable. */
function InstallBlock({ command }: { command: string }) {
  return (
    <div className="flex flex-col gap-1.5">
      <span className="text-[12px] font-medium text-muted-foreground">Install</span>
      <code className="block w-full select-all overflow-x-auto whitespace-pre rounded-xl border border-border bg-muted/50 px-3 py-2.5 font-mono text-[12px] leading-relaxed text-foreground">
        {command}
      </code>
    </div>
  )
}

/** The per-bot restart buttons, shown inside <ConnectFlow>'s added panel (via
 *  `renderAddedExtra`). One button per named grant target; for the `*` all-agents
 *  grant, one per known bot. A mid-turn bot asks for a confirm tap first — a running
 *  turn is never torn down by a stray tap. */
function RestartTargets({ targets, bots }: { targets: string[]; bots: BotChoice[] }) {
  const isAll = targets.includes(ALL_AGENTS)
  const named = targets.filter((t) => t !== ALL_AGENTS)
  const restartTargets: BotChoice[] = isAll
    ? bots
    : named.map((n) => bots.find((b) => b.name === n) ?? { name: n })
  if (restartTargets.length === 0) return null
  return (
    <div className="mt-1 flex flex-col gap-1.5">
      {isAll && (
        <span className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
          Restart all granted bots
        </span>
      )}
      {restartTargets.map((b) => (
        <RestartButton
          key={b.name}
          name={b.name}
          label={displayLabel(b)}
          busy={b.status === 'active' || b.status === 'starting'}
        />
      ))}
    </div>
  )
}

/** A single "Restart <bot>" action wired to `POST /api/sessions/{name}/restart`
 *  (the atomic stop→start; conversation, worktree and schedules survive, the live
 *  terminal is rebuilt so the new grants bind). Idempotent-safe: a bot that is
 *  mid-turn (`active`/`starting`) needs a second confirm tap before it fires, so a
 *  running turn is never torn down by a stray tap. */
function RestartButton({ name, label, busy }: { name: string; label: string; busy: boolean }) {
  type S = 'idle' | 'confirm' | 'running' | 'done' | 'error'
  const [state, setState] = React.useState<S>('idle')

  const run = async () => {
    setState('running')
    try {
      await sessionsApi.restart(name)
      setState('done')
    } catch {
      setState('error')
    }
  }
  const onClick = () => {
    if (state === 'running' || state === 'done') return
    if (state === 'idle' && busy) {
      setState('confirm')
      return
    }
    void run()
  }

  return (
    <button
      type="button"
      onClick={onClick}
      disabled={state === 'running' || state === 'done'}
      aria-label={`Restart ${label}`}
      className={cn(
        'inline-flex h-9 items-center justify-center gap-1.5 self-start rounded-lg px-3 text-[12.5px] font-medium transition-colors',
        state === 'confirm'
          ? 'bg-status-active/15 text-status-active-ink hover:bg-status-active/25'
          : state === 'done'
            ? 'bg-status-ready/15 text-status-ready-ink'
            : 'bg-foreground/[0.06] text-foreground hover:bg-foreground/10',
      )}
    >
      {state === 'running' && <Loader2 className="size-3.5 animate-spin" aria-hidden />}
      {state === 'done' && <Check className="size-3.5" aria-hidden />}
      {state === 'confirm'
        ? `${label} is mid-turn — restart anyway?`
        : state === 'running'
          ? 'Restarting…'
          : state === 'done'
            ? 'Restarted'
            : state === 'error'
              ? 'Restart failed — retry'
              : `Restart ${label}`}
    </button>
  )
}

/** The library-scope "Grant to" step: an explicit "All agents" toggle plus a
 *  checkbox list of known bots. Default is NOTHING selected so the Connect button
 *  stays disabled until a scope is chosen — install never silently means everyone.
 *  "All agents" is a superset: while it is on, the per-bot rows read as checked
 *  and locked (the grant resolves to a single `*` row). */
function GrantPicker({
  bots,
  selectedBots,
  allAgents,
  company,
  companyChosen,
  loading,
  onToggleBot,
  onToggleAll,
  onToggleCompany,
}: {
  bots: BotChoice[]
  selectedBots: Set<string>
  allAgents: boolean
  /** The active company, or `null` at HQ (no company tier offered). */
  company: { id: number; slug: string; display_name: string } | null
  companyChosen: boolean
  loading: boolean
  onToggleBot: (name: string) => void
  onToggleAll: () => void
  onToggleCompany: () => void
}) {
  return (
    <div className="flex flex-col gap-2">
      <span className="text-[11.5px] font-medium uppercase tracking-wide text-muted-foreground">
        Grant to
      </span>
      <div className="flex flex-col gap-0.5 rounded-xl border border-border bg-background p-1.5">
        <GrantOption
          checked={allAgents}
          onToggle={onToggleAll}
          label="All agents"
          sub="Every bot — now and future"
        />
        {company && (
          // "All agents" supersets the company, so lock this row while it is on.
          <GrantOption
            checked={allAgents || companyChosen}
            locked={allAgents}
            onToggle={onToggleCompany}
            label={`All bots in ${company.display_name}`}
            sub="This company"
            mark={<CompanyMark slug={company.slug} name={company.display_name} size={18} />}
          />
        )}
        {(bots.length > 0 || loading) && <span className="mx-2 my-0.5 h-px bg-border" />}
        {loading && bots.length === 0 ? (
          <span className="px-2.5 py-1.5 text-[12px] text-muted-foreground">Loading bots…</span>
        ) : bots.length === 0 ? (
          <span className="px-2.5 py-1.5 text-[12px] text-muted-foreground">
            No bots yet — grant to All agents.
          </span>
        ) : (
          bots.map((b) => (
            <GrantOption
              key={b.name}
              checked={allAgents || selectedBots.has(b.name)}
              locked={allAgents}
              onToggle={() => onToggleBot(b.name)}
              label={displayLabel(b)}
              sub={b.status}
            />
          ))
        )}
      </div>
    </div>
  )
}

function GrantOption({
  checked,
  locked,
  onToggle,
  label,
  sub,
  mark,
}: {
  checked: boolean
  locked?: boolean
  onToggle: () => void
  label: string
  sub?: string
  /** Optional identity glyph (e.g. a `CompanyMark`) shown before the label. */
  mark?: React.ReactNode
}) {
  return (
    <button
      type="button"
      role="checkbox"
      aria-checked={checked}
      disabled={locked}
      onClick={onToggle}
      className={cn(
        'flex items-center gap-2.5 rounded-lg px-2.5 py-2 text-left transition-colors',
        locked ? 'cursor-default' : 'hover:bg-muted',
      )}
    >
      <span
        aria-hidden
        className={cn(
          'grid size-[18px] shrink-0 place-items-center rounded-[6px] border transition-colors',
          checked
            ? 'border-primary bg-primary text-primary-foreground'
            : 'border-input bg-background',
          locked && 'opacity-70',
        )}
      >
        {checked && <Check className="size-3" strokeWidth={3} aria-hidden />}
      </span>
      {mark && <span className="shrink-0">{mark}</span>}
      <span className="flex min-w-0 flex-1 flex-col leading-tight">
        <span className="truncate text-[13px] font-medium text-foreground">{label}</span>
        {sub && <span className="truncate text-[11.5px] capitalize text-muted-foreground">{sub}</span>}
      </span>
    </button>
  )
}

export function PlainField({
  field,
  value,
  onChange,
}: {
  field: CredentialField
  value: string
  onChange: (v: string) => void
}) {
  return (
    <label className="flex flex-col gap-1.5">
      <span className="text-[12.5px] font-medium text-foreground">
        {field.title || field.key}
        {field.required && <span className="ml-1 text-muted-foreground">*</span>}
      </span>
      <input
        type="text"
        value={value}
        autoComplete="off"
        onChange={(e) => onChange(e.target.value)}
        aria-label={field.title || field.key}
        className="h-11 w-full rounded-xl border border-input bg-background px-3 text-[13px] text-foreground outline-none placeholder:text-muted-foreground focus-visible:ring-2 focus-visible:ring-ring"
      />
    </label>
  )
}

export function kindLabel(kind: string): string {
  if (kind === 'mcp_catalog') return 'Catalog'
  if (kind === 'agent_authored') return 'Agent-authored'
  if (kind === 'builtin_browser') return 'Built-in'
  return kind
}
