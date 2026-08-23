// The Installed tab — the store's "what's connected" surface (multi-account).
//
// One row PER CONNECTED ACCOUNT: a connector with two Gmail logins shows two
// rows, each naming the account it is connected as, its status, and its grant
// level. The detail sheet manages that one account — its grants (via the shared
// GrantControl, account-aware), the consumers that use it, and the reconnect /
// replace-account / disconnect / uninstall verbs.
//
// Lazy-split off `store-view` so none of it rides the cold hero path; the whole
// surface is reachable only under Bot mode on the `/store` route. Reuses the
// store's `cs-*` skin, ConnectorIcon, GrantControl, CompanyMark, ResponsiveSheet,
// PlainField + kindLabel (from connector-detail) — DRY, no forked primitives.
import * as React from 'react'
import {
  Activity,
  ArrowLeft,
  Bot,
  Building2,
  Loader2,
  Lock,
  Plug,
  Plus,
  RotateCw,
  Trash2,
  Unplug,
  Users,
} from 'lucide-react'

import { cn } from '@/lib/utils'
import {
  connectorAuthKind,
  plainFields,
  secretField,
  toolCountLabel,
  type AuthKind,
  type ConnectorAccount,
  type ConnectorCard,
  type ConnectorConsumer,
  type GrantLevel,
} from '@/lib/api/connectors'
import { useConnectorActions, useConnectorGrants } from '@/stores/connectors-store'
import { useCompanies } from '@/hooks/use-companies'
import { useArmedConfirm } from '@/hooks/use-armed-confirm'
import { CompanyMark } from '@/components/roster/company-mark'
import { ResponsiveSheet } from '@/components/ui/responsive-sheet'

import { ConnectorIcon } from './connector-icon'
import { OfficialBadge } from './connector-card'
import { GrantControl, type GrantScope } from './grant-control'
import { PlainField, kindLabel } from './connector-detail'
import { CredentialSecretField, defaultStr } from './credential-fields'

// A flat row = one (connector, account) pair. `account: null` is an installed
// connector with no connected account yet (a built-in, or an install awaiting its
// first credential) — still listed so it stays manageable / uninstallable.
interface Row {
  key: string
  card: ConnectorCard
  account: ConnectorAccount | null
}

export function InstalledPanel({ cards, q }: { cards: ConnectorCard[]; q?: string }) {
  const [open, setOpen] = React.useState<{ cardId: string; accountId: string | null } | null>(null)
  const needle = (q ?? '').trim().toLowerCase()

  const rows = React.useMemo<Row[]>(() => {
    const out: Row[] = []
    for (const card of cards) {
      const accts = card.accounts ?? []
      if (accts.length === 0) {
        out.push({ key: card.id, card, account: null })
      } else {
        for (const a of accts) out.push({ key: `${card.id}:${a.id}`, card, account: a })
      }
    }
    if (!needle) return out
    return out.filter(
      (r) =>
        r.card.display_name.toLowerCase().includes(needle) ||
        r.card.id.toLowerCase().includes(needle) ||
        (r.account?.account_label ?? '').toLowerCase().includes(needle),
    )
  }, [cards, needle])

  // Re-resolve the open target against the LIVE cards so the detail reflects a
  // grant / disconnect / replace the moment the grid cache refreshes.
  const active = React.useMemo(() => {
    if (!open) return null
    const card = cards.find((c) => c.id === open.cardId)
    if (!card) return null
    const account = open.accountId
      ? card.accounts?.find((a) => a.id === open.accountId) ?? null
      : null
    return { card, account }
  }, [open, cards])

  if (cards.length === 0) return <EmptyInstalled />

  return (
    <div className="flex flex-col gap-3">
      {rows.length === 0 ? (
        <div className="grid place-items-center rounded-2xl border border-dashed border-border py-12 text-center">
          <p className="text-[14px] font-medium text-foreground">No installed connectors match “{q}”</p>
          <p className="mt-1 text-[13px] text-muted-foreground">Try a different search.</p>
        </div>
      ) : (
        <ul className="flex flex-col divide-y divide-border overflow-hidden rounded-2xl border border-border">
          {rows.map((r) => (
            <InstalledRow
              key={r.key}
              card={r.card}
              account={r.account}
              onOpen={() => setOpen({ cardId: r.card.id, accountId: r.account?.id ?? null })}
            />
          ))}
        </ul>
      )}

      {active && (
        <ResponsiveSheet
          open
          onOpenChange={(o) => !o && setOpen(null)}
          title={active.card.display_name}
          description={
            active.account ? `Connected as ${active.account.account_label}` : 'Installed connector'
          }
        >
          <div data-grok>
            <InstalledDetail
              card={active.card}
              account={active.account}
              onClose={() => setOpen(null)}
            />
          </div>
        </ResponsiveSheet>
      )}
    </div>
  )
}

function EmptyInstalled() {
  return (
    <div className="grid place-items-center rounded-2xl border border-dashed border-border py-16 text-center">
      <span className="mb-3 grid size-11 place-items-center rounded-2xl bg-muted text-muted-foreground">
        <Plug className="size-5" aria-hidden />
      </span>
      <p className="text-[14px] font-medium text-foreground">Nothing connected yet</p>
      <p className="mt-1 max-w-[34ch] text-[13px] text-muted-foreground">
        Head to Browse, connect a tool with an account, and it lands here — one row per account.
      </p>
    </div>
  )
}

// ── the row ─────────────────────────────────────────────────────────────────

function InstalledRow({
  card,
  account,
  onOpen,
}: {
  card: ConnectorCard
  account: ConnectorAccount | null
  onOpen: () => void
}) {
  const tools = toolCountLabel(card)
  return (
    <li>
      <button
        type="button"
        onClick={onOpen}
        data-vr="installed-row"
        className="group flex w-full items-center gap-3 px-3.5 py-3 text-left transition-colors hover:bg-accent/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
      >
        <ConnectorIcon card={card} size={40} />
        <span className="flex min-w-0 flex-1 flex-col">
          <span className="flex items-center gap-2">
            <span className="truncate text-[14px] font-medium text-foreground">{card.display_name}</span>
            {card.official && <OfficialBadge />}
            {tools && (
              <span className="shrink-0 text-[11.5px] tabular-nums text-muted-foreground">{tools}</span>
            )}
          </span>
          <span className="mt-0.5 truncate text-[12.5px] text-muted-foreground">
            {account ? (
              <>
                Connected as <span className="text-foreground/80">{account.account_label}</span>
                {sinceLabel(account.last_used_at) && (
                  <span className="text-muted-foreground/80"> · used {sinceLabel(account.last_used_at)}</span>
                )}
              </>
            ) : (
              <>{kindLabel(card.kind)} · not connected</>
            )}
          </span>
        </span>
        <span className="flex shrink-0 items-center gap-1.5">
          {account && <StatusChip account={account} kind={connectorAuthKind(card)} />}
          {account ? (
            <GrantLevelChip level={account.grant_level} />
          ) : (
            <span className="hidden rounded-full bg-muted px-2.5 py-1 text-[11.5px] font-medium text-muted-foreground sm:inline-flex">
              Manage
            </span>
          )}
        </span>
      </button>
    </li>
  )
}

// ── chips ───────────────────────────────────────────────────────────────────

type StatusTone = 'active' | 'warn' | 'error' | 'muted'

// The honest health mapping (Slice 3), now AUTH-LANE aware. A tested-bad account
// NEVER reads Active: `error` → Error (red), `expired` → Expired (amber). A
// secret-less account is read against the connector's real lane: a `none`
// connector needs nothing (Ready, not a fake "Needs sign-in"); an `mcp_oauth`
// connector signs in in the bot's terminal (an honest note, never a false green);
// only the paste/OAuth lanes genuinely "Need sign-in". A present secret with no
// known problem is Active.
function statusMeta(a: ConnectorAccount, kind: AuthKind): { label: string; tone: StatusTone } {
  if (a.health === 'error') return { label: 'Error', tone: 'error' }
  if (a.health === 'expired') return { label: 'Expired', tone: 'warn' }
  if (a.status === 'disconnected') return { label: 'Disconnected', tone: 'muted' }
  if (!a.has_secret) {
    if (kind === 'none') return { label: 'Ready', tone: 'active' }
    if (kind === 'mcp_oauth') return { label: 'Signs in in terminal', tone: 'muted' }
    return { label: 'Needs sign-in', tone: 'warn' }
  }
  return { label: 'Active', tone: 'active' }
}

const TONE_CLASS: Record<StatusTone, string> = {
  active: 'bg-status-ready/12 text-status-ready-ink',
  warn: 'bg-status-active/12 text-status-active-ink',
  error: 'bg-destructive/12 text-destructive',
  muted: 'bg-muted text-muted-foreground',
}

function StatusChip({ account, kind }: { account: ConnectorAccount; kind: AuthKind }) {
  const { label, tone } = statusMeta(account, kind)
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1 rounded-full px-2.5 py-1 text-[11.5px] font-medium',
        TONE_CLASS[tone],
      )}
    >
      {tone === 'active' && <span className="size-1.5 rounded-full bg-status-ready" aria-hidden />}
      {label}
    </span>
  )
}

/** The grant-level chip: All agents · <CompanyMark> company · one bot · N agents.
 *  The company hue resolves from the live companies set by `company_id`. */
function GrantLevelChip({ level }: { level: GrantLevel }) {
  const { companies } = useCompanies()
  if (level.scope === 'none') {
    return (
      <span className="inline-flex items-center rounded-full border border-dashed border-border px-2.5 py-1 text-[11.5px] font-medium text-muted-foreground">
        Not granted
      </span>
    )
  }
  const company =
    level.scope === 'company' && level.company_id != null
      ? companies.find((c) => c.id === level.company_id) ?? null
      : null
  return (
    <span className="inline-flex items-center gap-1.5 rounded-full bg-secondary px-2.5 py-1 text-[11.5px] font-medium text-foreground">
      {level.scope === 'all' ? (
        <Users className="size-3" aria-hidden />
      ) : level.scope === 'company' ? (
        company ? (
          <CompanyMark slug={company.slug} name={company.display_name} size={14} />
        ) : (
          <Building2 className="size-3" aria-hidden />
        )
      ) : level.scope === 'bot' ? (
        <Bot className="size-3" aria-hidden />
      ) : (
        <Users className="size-3" aria-hidden />
      )}
      <span className="max-w-[14ch] truncate">{level.label}</span>
    </span>
  )
}

// ── the detail ────────────────────────────────────────────────────────────────

type DetailView = 'detail' | 'replace' | 'add'

function InstalledDetail({
  card,
  account,
  onClose,
}: {
  card: ConnectorCard
  account: ConnectorAccount | null
  onClose: () => void
}) {
  const actions = useConnectorActions()
  const consumersQ = useConnectorGrants(card.id)
  const consumers = consumersQ.data ?? []
  const accountConsumers = account
    ? consumers.filter((c) => c.account_ref === account.id)
    : consumers
  const [view, setView] = React.useState<DetailView>('detail')
  const [note, setNote] = React.useState<string | null>(null)
  const [reconnecting, setReconnecting] = React.useState(false)
  const [testing, setTesting] = React.useState(false)
  const [testNote, setTestNote] = React.useState<{ message: string; tone: 'ok' | 'bad' | 'muted' } | null>(null)

  const scope: GrantScope = account
    ? levelToScope(account.grant_level)
    : consumersToScope(consumers)

  const disconnect = useArmedConfirm({
    onConfirm: () => {
      if (!account) return
      void actions.disconnect(card.id, account.id).then((restart) => {
        setNote(restart ? 'Bots reload this account at their next restart.' : null)
      })
    },
  })
  const uninstall = useArmedConfirm({
    onConfirm: () => {
      void actions.remove(card.id).then(() => onClose())
    },
  })

  const reconnect = async () => {
    if (!account || reconnecting) return
    setReconnecting(true)
    try {
      const restart = await actions.reconnect(card.id, account.id)
      setNote(restart ? 'Bots reload this account at their next restart.' : null)
    } finally {
      setReconnecting(false)
    }
  }

  const runTest = async () => {
    if (!account || testing) return
    setTesting(true)
    setTestNote(null)
    try {
      const r = await actions.testConnection(card.id, account.id)
      const tone = !r.testable ? 'muted' : r.health === 'ok' ? 'ok' : 'bad'
      setTestNote({ message: r.message, tone })
    } catch {
      /* toast surfaced by the mutation */
    } finally {
      setTesting(false)
    }
  }

  if (view !== 'detail') {
    return (
      <div className="flex flex-col gap-4 px-5 py-5">
        <button
          type="button"
          onClick={() => setView('detail')}
          className="inline-flex items-center gap-1.5 self-start rounded-lg px-2 py-1.5 text-[13px] font-medium text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
        >
          <ArrowLeft className="size-4" aria-hidden />
          Back
        </button>
        <div className="flex items-center gap-2">
          <ConnectorIcon card={card} size={32} />
          <h3 className="text-[15px] font-semibold text-foreground">
            {view === 'add' ? 'Add another account' : `Replace ${account?.account_label ?? 'account'}`}
          </h3>
        </div>
        <p className="text-[13px] leading-relaxed text-muted-foreground">
          {view === 'add'
            ? 'Connect a second account to this connector — a new key mints a new account with its own grants.'
            : 'Paste a fresh key to rotate this account’s credential. Every grant it feeds stays wired.'}
        </p>
        <AccountConnectForm
          card={card}
          accountRef={view === 'replace' ? account?.id : undefined}
          defaultLabel={view === 'replace' ? account?.account_label : undefined}
          submitLabel={view === 'replace' ? 'Replace credential' : 'Add account'}
          onDone={() => setView('detail')}
        />
      </div>
    )
  }

  const tools = toolCountLabel(card)
  const authKind = connectorAuthKind(card)
  const st = account ? statusMeta(account, authKind) : null

  return (
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
          <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-[12.5px] text-muted-foreground">
            {account ? (
              <span className="text-foreground/85">
                Connected as <span className="font-medium text-foreground">{account.account_label}</span>
              </span>
            ) : (
              <span>Not connected</span>
            )}
            {st && <span className={cn('rounded-full px-2 py-0.5 text-[11px] font-medium', TONE_CLASS[st.tone])}>{st.label}</span>}
            {tools && <span className="font-medium">{tools}</span>}
            <span className="capitalize">{kindLabel(card.kind)}</span>
          </div>
        </div>
      </div>

      {card.description && (
        <p className="text-[14px] leading-relaxed text-foreground/90">{card.description}</p>
      )}

      {/* account block — identity, freshness, health, the lifecycle verbs */}
      {account && (
        <div className="flex flex-col gap-3 rounded-2xl border border-border bg-card p-4">
          <div className="flex items-start justify-between gap-3">
            <div className="flex min-w-0 flex-col">
              <span className="text-[13px] font-semibold text-foreground">Account</span>
              <span className="truncate text-[12.5px] text-muted-foreground">
                {account.account_label} · {usedAgo(account.last_used_at)}
              </span>
              <span className="truncate text-[11.5px] text-muted-foreground">{checkedLabel(account)}</span>
            </div>
            <StatusChip account={account} kind={authKind} />
          </div>
          {/* the honest health error (persists across renders until re-tested) */}
          {account.last_error && (account.health === 'error' || account.health === 'expired') && (
            <p className="text-[12px] leading-relaxed text-destructive">{account.last_error}</p>
          )}
          <div className="flex flex-wrap gap-2">
            <VerbButton onClick={runTest} busy={testing} icon={<Activity className="size-3.5" aria-hidden />}>
              {testing ? 'Testing…' : 'Test connection'}
            </VerbButton>
            {(account.status === 'disconnected' || !account.has_secret) && (
              <VerbButton onClick={reconnect} busy={reconnecting} icon={<RotateCw className="size-3.5" aria-hidden />}>
                Reconnect
              </VerbButton>
            )}
            <VerbButton onClick={() => setView('replace')} icon={<RotateCw className="size-3.5" aria-hidden />}>
              Replace account
            </VerbButton>
            <VerbButton
              onClick={disconnect.press}
              tone={disconnect.armed ? 'danger' : 'default'}
              icon={<Unplug className="size-3.5" aria-hidden />}
            >
              {disconnect.armed ? 'Disconnect — sure?' : 'Disconnect'}
            </VerbButton>
          </div>
          {disconnect.armed && (
            <p className="text-[12px] text-muted-foreground">
              Revokes every grant this account feeds. The sealed key is kept for a one-tap reconnect.
            </p>
          )}
          {testNote && (
            <p
              className={cn(
                'text-[12px] leading-relaxed',
                testNote.tone === 'ok'
                  ? 'text-status-ready-ink'
                  : testNote.tone === 'bad'
                    ? 'text-destructive'
                    : 'text-muted-foreground',
              )}
            >
              {testNote.message}
            </p>
          )}
          {note && <p className="text-[12px] text-status-active-ink">{note}</p>}
        </div>
      )}

      {/* grants (access matrix) — account-aware when an account is in scope */}
      <div className="rounded-2xl border border-border bg-card p-4">
        <GrantControl
          connectorId={card.id}
          botName={null}
          scope={scope}
          accountRef={account?.id ?? undefined}
          onGranted={(_t, restart) =>
            setNote(restart ? 'Bots pick up the grant at their next restart.' : null)
          }
          onRevoked={() => setNote(null)}
        />
      </div>

      {/* consumers / blast-radius */}
      <div className="flex flex-col gap-2">
        <h3 className="text-[13px] font-semibold text-foreground">
          Used by{account ? ` ${account.account_label}` : ''}
        </h3>
        <ConsumerList consumers={accountConsumers} loading={consumersQ.isLoading} showAccount={!account} />
      </div>

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

      {/* add account + danger zone */}
      <div className="flex flex-wrap items-center justify-between gap-3 border-t border-border pt-4">
        <button
          type="button"
          onClick={() => setView('add')}
          className="inline-flex min-h-9 items-center gap-1.5 rounded-[10px] bg-primary px-3 text-[12.5px] font-semibold text-primary-foreground shadow-sm transition-colors hover:bg-primary/90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          <Plus className="size-3.5" aria-hidden />
          Add account
        </button>
        <button
          type="button"
          onClick={uninstall.press}
          className={cn(
            'inline-flex min-h-9 items-center gap-1.5 rounded-lg px-2.5 text-[12.5px] font-medium transition-colors',
            uninstall.armed
              ? 'bg-destructive text-destructive-foreground hover:bg-destructive/90'
              : 'text-destructive hover:bg-destructive/10',
          )}
        >
          <Trash2 className="size-3.5" aria-hidden />
          {uninstall.armed ? 'Uninstall — removes all accounts' : 'Uninstall'}
        </button>
      </div>
    </div>
  )
}

function VerbButton({
  onClick,
  busy,
  icon,
  tone = 'default',
  children,
}: {
  onClick: () => void
  busy?: boolean
  icon: React.ReactNode
  tone?: 'default' | 'danger'
  children: React.ReactNode
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={busy}
      className={cn(
        'inline-flex min-h-9 items-center gap-1.5 rounded-lg px-3 text-[12.5px] font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-60',
        tone === 'danger'
          ? 'bg-destructive text-destructive-foreground hover:bg-destructive/90'
          : 'bg-foreground/[0.06] text-foreground hover:bg-foreground/10',
      )}
    >
      {busy ? <Loader2 className="size-3.5 animate-spin" aria-hidden /> : icon}
      {children}
    </button>
  )
}

function ConsumerList({
  consumers,
  loading,
  showAccount,
}: {
  consumers: ConnectorConsumer[]
  loading: boolean
  showAccount: boolean
}) {
  const { companies } = useCompanies()
  if (loading && consumers.length === 0) {
    return (
      <div className="flex items-center gap-2 rounded-xl border border-border bg-card px-4 py-3 text-[13px] text-muted-foreground">
        <Loader2 className="size-4 animate-spin" aria-hidden />
        Loading…
      </div>
    )
  }
  if (consumers.length === 0) {
    return (
      <div className="rounded-xl border border-dashed border-border bg-muted/30 px-4 py-3 text-[12.5px] text-muted-foreground">
        No agents use this yet. Grant it above to put it to work.
      </div>
    )
  }
  return (
    <ul className="flex flex-col divide-y divide-border overflow-hidden rounded-2xl border border-border">
      {consumers.map((c, i) => {
        const company =
          c.scope === 'company' && c.company_id != null
            ? companies.find((co) => co.id === c.company_id) ?? null
            : null
        return (
          <li key={`${c.scope}:${c.session_name ?? c.company_id ?? 'all'}:${i}`} className="flex items-center gap-2.5 px-3.5 py-2.5">
            <span className="grid size-6 shrink-0 place-items-center text-muted-foreground">
              {c.scope === 'all' ? (
                <Users className="size-4" aria-hidden />
              ) : c.scope === 'company' ? (
                company ? (
                  <CompanyMark slug={company.slug} name={company.display_name} size={20} />
                ) : (
                  <Building2 className="size-4" aria-hidden />
                )
              ) : (
                <Bot className="size-4" aria-hidden />
              )}
            </span>
            <span className="flex min-w-0 flex-1 flex-col leading-tight">
              <span className="truncate text-[13px] font-medium text-foreground">{c.label}</span>
              {showAccount && c.account_label && (
                <span className="truncate text-[11.5px] text-muted-foreground">{c.account_label}</span>
              )}
            </span>
            {!c.enabled && (
              <span className="shrink-0 rounded-full bg-muted px-2 py-0.5 text-[11px] font-medium text-muted-foreground">
                Disabled
              </span>
            )}
          </li>
        )
      })}
    </ul>
  )
}

// ── add / replace credential form ─────────────────────────────────────────────

function AccountConnectForm({
  card,
  accountRef,
  defaultLabel,
  submitLabel,
  onDone,
}: {
  card: ConnectorCard
  accountRef?: string
  defaultLabel?: string
  submitLabel: string
  onDone: () => void
}) {
  const actions = useConnectorActions()
  const plains = plainFields(card)
  const secret = secretField(card)
  // When the connector carries a non-secret identity field (e.g. ICLOUD_EMAIL),
  // its value doubles as the account label server-side — no separate name input.
  const idField = card.credentials?.find((f) => f.identity && !f.sensitive)
  const [values, setValues] = React.useState<Record<string, string>>(() =>
    Object.fromEntries(plains.map((f) => [f.key, defaultStr(f)])),
  )
  const [label, setLabel] = React.useState(defaultLabel ?? '')
  const [secretVal, setSecretVal] = React.useState('')
  const [reveal, setReveal] = React.useState(false)
  const [saving, setSaving] = React.useState(false)

  const requiredMissing =
    (secret?.required && secretVal.trim() === '') ||
    plains.some((f) => f.required && (values[f.key] ?? '').trim() === '') ||
    // Adding a labelled connector needs a name to key the account by; a replace
    // keeps the old label if the field is left blank.
    (!idField && !accountRef && label.trim() === '')

  const submit = async () => {
    if (saving || requiredMissing) return
    setSaving(true)
    try {
      const fields: Record<string, string> = { ...values }
      if (secret && secretVal.trim()) fields[secret.key] = secretVal
      await actions.putCredential(card.id, {
        fields,
        account_label: label.trim() || undefined,
        account_ref: accountRef,
      })
      onDone()
    } catch {
      /* toast surfaced by the mutation */
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="flex flex-col gap-3 rounded-2xl border border-border bg-card p-4">
      {!idField && (
        <label className="flex flex-col gap-1.5">
          <span className="text-[12.5px] font-medium text-foreground">
            Account name{!accountRef && <span className="ml-1 text-muted-foreground">*</span>}
          </span>
          <input
            type="text"
            value={label}
            autoComplete="off"
            onChange={(e) => setLabel(e.target.value)}
            placeholder="e.g. you@example.com"
            aria-label="Account name"
            className="h-11 w-full rounded-xl border border-input bg-background px-3 text-[13px] text-foreground outline-none placeholder:text-muted-foreground focus-visible:ring-2 focus-visible:ring-ring"
          />
        </label>
      )}
      {plains.map((f) => (
        <PlainField
          key={f.key}
          field={f}
          value={values[f.key] ?? ''}
          onChange={(v) => setValues((s) => ({ ...s, [f.key]: v }))}
        />
      ))}
      {secret && (
        <CredentialSecretField
          field={secret}
          value={secretVal}
          reveal={reveal}
          onReveal={() => setReveal((r) => !r)}
          onChange={setSecretVal}
        />
      )}
      <p className="flex items-center gap-1.5 text-[12px] text-muted-foreground">
        <Lock className="size-3.5 shrink-0" aria-hidden />
        Stored securely, never shown to your bot.
      </p>
      <button
        type="button"
        onClick={submit}
        disabled={saving || requiredMissing}
        className={cn(
          'mt-1 inline-flex h-11 items-center justify-center gap-2 rounded-xl px-4 text-[14px] font-semibold shadow-sm transition-colors',
          requiredMissing
            ? 'cursor-not-allowed bg-muted text-muted-foreground shadow-none'
            : 'bg-primary text-primary-foreground hover:bg-primary/90',
        )}
      >
        {saving && <Loader2 className="size-4 animate-spin" aria-hidden />}
        {saving ? 'Saving…' : submitLabel}
      </button>
    </div>
  )
}

// ── pure helpers ──────────────────────────────────────────────────────────────

function levelToScope(level: GrantLevel): GrantScope {
  if (level.scope === 'all') return 'all'
  if (level.scope === 'company') return 'company'
  if (level.scope === 'bot') return 'bot'
  return null
}

/** Derive a segmented-control scope for a connector-level row (no account) from
 *  its consumers: all-agents wins; else a single same-company set reads company;
 *  else nothing is pre-selected. */
function consumersToScope(consumers: ConnectorConsumer[]): GrantScope {
  if (consumers.some((c) => c.scope === 'all')) return 'all'
  if (consumers.length > 0 && consumers.every((c) => c.scope === 'company')) {
    const first = consumers[0].company_id
    if (consumers.every((c) => c.company_id === first)) return 'company'
  }
  return null
}

/** "3m ago" / "just now" / null (never) from an epoch-seconds stamp — the shared
 *  relative-time atom behind the used/checked labels. */
function sinceLabel(ts: number): string | null {
  if (!ts || ts <= 0) return null
  const secs = Math.max(0, Math.floor(Date.now() / 1000 - ts))
  if (secs < 45) return 'just now'
  const mins = Math.floor(secs / 60)
  if (mins < 60) return `${mins}m ago`
  const hrs = Math.floor(mins / 60)
  if (hrs < 24) return `${hrs}h ago`
  const days = Math.floor(hrs / 24)
  if (days < 30) return `${days}d ago`
  const months = Math.floor(days / 30)
  if (months < 12) return `${months}mo ago`
  return `${Math.floor(months / 12)}y ago`
}

/** "Used 3m ago" / "Never used" from an epoch-seconds stamp. */
function usedAgo(ts: number): string {
  const s = sinceLabel(ts)
  return s ? `Used ${s}` : 'Never used'
}

/** The health-check freshness line: "Checked 3m ago — verified/expired/failed" once
 *  probed, else an honest "Not tested yet" (never implies a green it didn't earn). */
function checkedLabel(a: ConnectorAccount): string {
  const s = sinceLabel(a.last_checked_at ?? 0)
  if (!s) return 'Not tested yet'
  const verdict =
    a.health === 'ok'
      ? 'verified'
      : a.health === 'expired'
        ? 'expired'
        : a.health === 'error'
          ? 'failed'
          : 'checked'
  return `Checked ${s} — ${verdict}`
}
