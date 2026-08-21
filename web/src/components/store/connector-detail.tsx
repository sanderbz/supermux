// The connector detail sheet — the store's expand: full tool list, the connect
// flow (secure credential paste OR sign-in), the grant control, and remove.
//
// This is where the store's connect actually happens: paste a key once → it is
// sealed into the vault (`POST /{id}/credential`, write-only) and, when a bot
// scope is active, granted to that bot in the same call. The secret is never
// echoed back — the field flips to a masked "Added" state.
import * as React from 'react'
import { useQuery } from '@tanstack/react-query'
import { Check, Eye, EyeOff, Loader2, Lock, Trash2 } from 'lucide-react'

import {
  ALL_AGENTS,
  connectorHasOAuth,
  plainFields,
  secretField,
  toolCountLabel,
  type ConnectorCard as Card,
  type CredentialField,
} from '@/lib/api/connectors'
import { sessionsApi, displayLabel } from '@/lib/api'
import { SESSIONS_KEY } from '@/hooks/use-sessions'
import { useConnectorActions } from '@/stores/connectors-store'
import { cn } from '@/lib/utils'

import { ConnectorIcon } from './connector-icon'
import { OfficialBadge } from './connector-card'
import { GrantControl, type GrantScope } from './grant-control'

type Phase = 'idle' | 'saving' | 'added'

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
  const plains = plainFields(card)
  const [values, setValues] = React.useState<Record<string, string>>(() =>
    Object.fromEntries(plains.map((f) => [f.key, defaultStr(f)])),
  )
  const [secretVal, setSecretVal] = React.useState('')
  const [reveal, setReveal] = React.useState(false)
  const [phase, setPhase] = React.useState<Phase>(granted ? 'added' : 'idle')
  const [restartHint, setRestartHint] = React.useState(false)
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
  // "All agents" is a superset — when it is on, the per-bot rows show as checked
  // (and locked), and the grant resolves to a single `*` row.
  const chosenTargets: string[] = allAgents ? [ALL_AGENTS] : [...selectedBots]
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
  // OAuth-capable connectors LEAD with the branded "Sign in" primary; the key
  // paste is demoted behind an "or use an API key" divider (blocker B4). There is
  // no live OAuth lane on the server yet, so tapping sign-in reveals the key lane
  // with a calm line — the same honest fallback the inline connect-card uses.
  const hasOAuth = connectorHasOAuth(card) && !!secret
  const [keyLaneOpen, setKeyLaneOpen] = React.useState(!hasOAuth)

  const needsSecret = !!secret
  const requiredMissing =
    (needsSecret && secret?.required && secretVal.trim() === '') ||
    plains.some((f) => f.required && (values[f.key] ?? '').trim() === '')

  const connect = async () => {
    setPhase('saving')
    try {
      // Install a catalog card into the local registry first (idempotent).
      if (!installed) {
        await actions.install({
          id: card.id,
          kind: card.kind,
          display_name: card.display_name,
          icon: card.icon,
          description: card.description,
          tools: card.tools,
          credentials: card.credentials,
        })
      }
      // Resolve the scope to the grant targets. In the library view that is the
      // "Grant to" selection (N bots, or the single `*` all-agents row); in a bot
      // scope it is the one target the store sheet was opened with.
      const targets = isLibrary ? chosenTargets : grantTarget ? [grantTarget] : []
      const fields: Record<string, string> = { ...values }
      if (needsSecret && secretVal.trim()) fields[secret!.key] = secretVal
      if (Object.keys(fields).length > 0) {
        // Seal the credential ONCE (attaching the first target's grant), then
        // reuse the returned `secret_ref` for the remaining bots so N grants
        // share one vault secret instead of re-sealing per bot.
        const ref = await actions.putCredential(card.id, {
          fields,
          session_name: targets[0] ?? undefined,
        })
        if (ref === null) {
          setPhase('idle')
          return
        }
        for (const t of targets.slice(1)) {
          await actions.grant(card.id, t, ref)
        }
        setRestartHint(true)
      } else if (targets.length > 0) {
        // No credential (built-in / OAuth-only) — just land the grant(s).
        let restart = false
        for (const t of targets) {
          restart = (await actions.grant(card.id, t)) || restart
        }
        setRestartHint(restart)
      }
      setSecretVal('')
      setAddedTargets(targets)
      setLocalGrant(targets.includes(ALL_AGENTS) ? 'all' : isLibrary ? null : 'bot')
      setPhase('added')
    } catch {
      setPhase('idle')
    }
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

      {/* connect / credential flow */}
      {phase === 'added' ? (
        <AddedPanel restartHint={restartHint} targets={addedTargets} bots={bots} />
      ) : (
        <div className="flex flex-col gap-3 rounded-2xl border border-border bg-card p-4">
          {/* OAuth primary — the branded sign-in, leading the trust hierarchy. */}
          {hasOAuth && !keyLaneOpen && (
            <>
              <button
                type="button"
                onClick={() => setKeyLaneOpen(true)}
                className="inline-flex h-11 w-full items-center justify-center gap-2 rounded-xl bg-primary px-4 text-[14px] font-semibold text-primary-foreground shadow-sm transition-colors hover:bg-primary/90"
              >
                Sign in with {card.display_name}
              </button>
              <div className="flex items-center gap-3 text-[11.5px] text-muted-foreground">
                <span className="h-px flex-1 bg-border" />
                or use an API key
                <span className="h-px flex-1 bg-border" />
              </div>
            </>
          )}
          {needsSecret && keyLaneOpen ? (
            <>
              {hasOAuth && (
                <p className="text-[12px] text-muted-foreground">
                  Sign-in isn’t available here yet — paste an API key instead.
                </p>
              )}
              {plains.map((f) => (
                <PlainField
                  key={f.key}
                  field={f}
                  value={values[f.key] ?? ''}
                  onChange={(v) => setValues((s) => ({ ...s, [f.key]: v }))}
                />
              ))}
              <label className="flex flex-col gap-1.5">
                <span className="text-[12.5px] font-medium text-foreground">
                  {secret!.title || 'API key'}
                  {secret!.required && <span className="ml-1 text-muted-foreground">*</span>}
                </span>
                <span className="relative flex items-center">
                  <input
                    type={reveal ? 'text' : 'password'}
                    autoComplete="off"
                    autoCorrect="off"
                    spellCheck={false}
                    value={secretVal}
                    onChange={(e) => setSecretVal(e.target.value)}
                    placeholder="Paste your key"
                    aria-label={secret!.title || 'API key'}
                    className="h-11 w-full rounded-xl border border-input bg-background px-3 pr-11 font-mono text-[13px] text-foreground outline-none placeholder:text-muted-foreground focus-visible:ring-2 focus-visible:ring-ring"
                  />
                  <button
                    type="button"
                    onClick={() => setReveal((r) => !r)}
                    aria-label={reveal ? 'Hide key' : 'Show key'}
                    className="absolute right-1.5 grid size-8 place-items-center rounded-lg text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
                  >
                    {reveal ? <EyeOff className="size-4" aria-hidden /> : <Eye className="size-4" aria-hidden />}
                  </button>
                </span>
              </label>
              <p className="flex items-center gap-1.5 text-[12px] text-muted-foreground">
                <Lock className="size-3.5 shrink-0" aria-hidden />
                Stored securely, never shown to your bot.
              </p>
            </>
          ) : !needsSecret ? (
            <>
              <p className="text-[13px] text-muted-foreground">
                No sign-in needed — {card.kind === 'builtin_browser' ? 'this is built in.' : 'grant it to a bot to use it.'}
              </p>
              {/* HOW THE TAKEOVER WORKS — the one thing about this connector that
                  is not obvious from a tool list, said once, where it is decided
                  whether to grant it. */}
              {card.kind === 'builtin_browser' && (
                <p className="text-[13px] leading-[1.45] text-muted-foreground">
                  When the bot hits a login, a 2FA prompt or a CAPTCHA it asks you
                  to take the wheel: the live page opens in your chat, you finish
                  the step on your phone, and closing it hands control straight
                  back. While you are driving, the bot cannot act on — or even
                  read — that page.
                </p>
              )}
            </>
          ) : null}

          {/* GRANT TO — the choose-who-gets-it step, library scope only. In a bot
              scope the store sheet already carries the one target, so this is
              skipped and the flow is byte-identical to before. */}
          {isLibrary && (keyLaneOpen || !needsSecret) && (
            <GrantPicker
              bots={bots}
              selectedBots={selectedBots}
              allAgents={allAgents}
              loading={sessionsQuery.isLoading && !botsOverride}
              onToggleBot={toggleBot}
              onToggleAll={() => setAllAgents((v) => !v)}
            />
          )}

          {/* The bottom CTA belongs to the key/no-secret path; during the OAuth
              lead the branded "Sign in" above is the primary, so it stands alone.
              Enabled/working: SOLID brand-blue + white label (>=4.5:1). Blocked (a
              required field still empty, or — in the library view — no grant target
              chosen yet) is a NEUTRAL muted fill — never a washed blue that could
              read as a live-but-dim CTA (blocker H2). */}
          {(keyLaneOpen || !needsSecret) && (
            <button
              type="button"
              onClick={connect}
              disabled={phase === 'saving' || requiredMissing || needChoice}
              className={cn(
                'mt-1 inline-flex h-11 items-center justify-center gap-2 rounded-xl px-4 text-[14px] font-semibold shadow-sm transition-colors',
                requiredMissing || needChoice
                  ? 'cursor-not-allowed bg-muted text-muted-foreground shadow-none'
                  : 'bg-primary text-primary-foreground hover:bg-primary/90 disabled:hover:bg-primary',
              )}
            >
              {phase === 'saving' && <Loader2 className="size-4 animate-spin" aria-hidden />}
              {needChoice
                ? `${needsSecret ? 'Connect' : 'Install'} — choose who gets it`
                : needsSecret
                  ? 'Connect'
                  : grantTarget
                    ? 'Add to this bot'
                    : 'Install'}
            </button>
          )}
        </div>
      )}

      {/* grant control (once installed) */}
      {(installed || phase === 'added') && (
        <div className="rounded-2xl border border-border bg-card p-4">
          <GrantControl
            connectorId={card.id}
            botName={botName}
            scope={localGrant}
            onGranted={(_t, restart) => {
              setLocalGrant(grantTarget === '*' ? 'all' : 'bot')
              if (restart) setRestartHint(true)
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

function AddedPanel({
  restartHint,
  targets,
  bots,
}: {
  restartHint: boolean
  targets: string[]
  bots: BotChoice[]
}) {
  // `*` (all agents) wins the phrasing; otherwise name the bots it was added to.
  const isAll = targets.includes(ALL_AGENTS)
  const named = targets.filter((t) => t !== ALL_AGENTS)
  const suffix = isAll ? ' for all agents' : named.length > 0 ? ` to ${named.join(', ')}` : ''

  // The bots we actually offer a restart for. `*` fans out to every known bot;
  // otherwise it is the named grant targets. Resolve each to its live session row
  // (for a nice label + a mid-turn guard); a target with no row still restarts by
  // slug with a plain-name button.
  const restartTargets: BotChoice[] = isAll
    ? bots
    : named.map((n) => bots.find((b) => b.name === n) ?? { name: n })

  return (
    <div className="flex flex-col gap-2 rounded-2xl border border-status-ready/30 bg-status-ready/10 p-4">
      <div className="flex items-center gap-2 text-[14px] font-semibold text-status-ready-ink">
        <span className="grid size-6 place-items-center rounded-full bg-status-ready/20">
          <Check className="size-3.5" aria-hidden />
        </span>
        Added{suffix}
      </div>
      {restartHint && (
        <p className="text-[12.5px] text-muted-foreground">
          Restart the bot to apply — grants bind at the next launch.
        </p>
      )}
      {/* Restart the granted bot(s) straight from here so the grant binds now,
          instead of leaving to hunt for the bot. One button per named bot; for the
          `*` all-agents grant, one button per known bot ("Restart all granted
          bots" fans out to each). A bot mid-turn asks for a confirm tap first. */}
      {restartTargets.length > 0 && (
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
      )}
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
  loading,
  onToggleBot,
  onToggleAll,
}: {
  bots: BotChoice[]
  selectedBots: Set<string>
  allAgents: boolean
  loading: boolean
  onToggleBot: (name: string) => void
  onToggleAll: () => void
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
}: {
  checked: boolean
  locked?: boolean
  onToggle: () => void
  label: string
  sub?: string
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
      <span className="flex min-w-0 flex-1 flex-col leading-tight">
        <span className="truncate text-[13px] font-medium text-foreground">{label}</span>
        {sub && <span className="truncate text-[11.5px] capitalize text-muted-foreground">{sub}</span>}
      </span>
    </button>
  )
}

function PlainField({
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

function defaultStr(f: CredentialField): string {
  if (f.default === undefined || f.default === null) return ''
  return typeof f.default === 'string' ? f.default : String(f.default)
}

function kindLabel(kind: string): string {
  if (kind === 'mcp_catalog') return 'Catalog'
  if (kind === 'agent_authored') return 'Agent-authored'
  if (kind === 'builtin_browser') return 'Built-in'
  return kind
}
