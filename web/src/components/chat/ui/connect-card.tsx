/**
 * The inline CONNECT card — the Grok moment, supermux-native in chat.
 * ─────────────────────────────────────────────────────────────────────────────
 * A bot's `connect(service)` tool asked for a human (the `_meta`
 * `requiresUserInteraction` marker reached the prompt). Instead of a settings
 * excursion, ONE card slides into the transcript: sign in, or paste a key once,
 * and it flips to **Added · N tools**.
 *
 * It reuses `DialogShell` (from `choice-card.tsx`) so it is visually one family
 * with the question / permission / form cards, and it hosts the SHARED
 * `<ConnectFlow>` — the exact same lane/fields/seal/test the store detail mounts,
 * so a connector renders identically in chat and in the store. The card stops
 * guessing OAuth from a brand regex and reads the connector's real `auth`
 * descriptor: Slack no longer shows a fake API-key field; an api_key card shows a
 * "Get your key →" link.
 *
 * ## The secret never touches the chat/MCP stream
 *
 * `<ConnectFlow>` POSTs straight to the vault (`POST /api/connectors/{id}/credential`,
 * write-only) — NEVER an MCP `elicitation/create`. The response is masked; nothing
 * here ever reads a stored value back.
 *
 * No `@/` alias imports (the unit runner resolves the root tsconfig, which has no
 * `paths`) — every runtime import is relative, exactly like `live-layer.tsx`.
 */
import { Suspense, lazy, useEffect, useMemo, useState } from 'react'
import { Check } from 'lucide-react'

import {
  getConnector,
  grant as apiGrant,
  putCredential,
  toolCountLabel,
  type ConnectorCard,
} from '../../../lib/api/connectors'
import type { ConnectRequestInfo } from '../../../lib/api/sessions'

import { DialogShell } from './choice-card'
import type { ConnectFlowResult } from '../../store/connect-flow'

// The shared connect renderer is a rare, on-demand surface (only when a bot's
// connect() stalls). Lazy-loaded so it stays OUT of the chat hero bundle — it
// rides its own chunk, shared with the store detail that mounts it eagerly.
const ConnectFlow = lazy(() =>
  import('../../store/connect-flow').then((m) => ({ default: m.ConnectFlow })),
)

export interface ConnectCardProps {
  request: ConnectRequestInfo
  /** The session (bot) the grant lands on — the credential auto-grants here. */
  sessionName: string
  /**
   * Deliver the OAuth sign-in (Lane A). Absent = no live OAuth lane on this
   * session (the shipped state until the server surfaces the flow); the flow falls
   * back to the key lane with a calm line rather than a dead button.
   */
  onSignIn?: (connectorId: string) => Promise<void>
  /** Dismiss ("Not now"). */
  onDismiss?: () => void
  /** Test seam: skip the network schema fetch, render against this card. */
  card?: ConnectorCard
}

export function ConnectCard({
  request,
  sessionName,
  onSignIn,
  onDismiss,
  card: seedCard,
}: ConnectCardProps) {
  const [card, setCard] = useState<ConnectorCard | null>(seedCard ?? null)
  const [fetchFailed, setFetchFailed] = useState(false)
  const [added, setAdded] = useState<ConnectFlowResult | null>(null)

  // Pull the credential SCHEMA + the auth descriptor (never a value). The server's
  // get_one now falls back to the catalog mirror, so an UN-installed card resolves
  // its real lane instead of 404-ing; on a hard failure we degrade to a single
  // generic API-key field so the card still works.
  useEffect(() => {
    if (seedCard) return
    let live = true
    getConnector(request.connector_id)
      .then((c) => live && setCard(c))
      .catch(() => {
        if (live) setFetchFailed(true)
      })
    return () => {
      live = false
    }
  }, [request.connector_id, seedCard])

  const name = request.display_name ?? card?.display_name ?? request.connector_id

  // The card to render against: the fetched one, or — only once the fetch has
  // FAILED — a generic single-key fallback (never a wrong lane mid-load).
  const effectiveCard: ConnectorCard | null = useMemo(() => {
    if (card) return card
    if (!fetchFailed) return null
    return {
      id: request.connector_id,
      kind: 'mcp_catalog',
      display_name: name,
      icon: '',
      description: '',
      tools: [],
      credentials: [{ key: 'API_KEY', title: 'API key', sensitive: true, required: true }],
      auth: { kind: 'api_key' },
      source: 'catalog',
    }
  }, [card, fetchFailed, request.connector_id, name])

  const toolsLine = useMemo(() => {
    if (card) return toolCountLabel(card)
    const n = request.tool_count
    return typeof n === 'number' ? (n === 1 ? '1 tool' : `${n} tools`) : ''
  }, [card, request.tool_count])

  const seal = async ({ fields }: { fields: Record<string, string> }): Promise<ConnectFlowResult> => {
    // No credential to seal (a `none` or `mcp_oauth` connector — the latter signs
    // in in the bot's terminal). Just land the grant so the connector is available;
    // the vault write path rejects an empty field-map, so never call it here.
    if (Object.keys(fields).length === 0) {
      const r = await apiGrant(request.connector_id, { session_name: sessionName })
      return { restartHint: !!r.restartHint, accountRef: null, accountLabel: null }
    }
    const res = await putCredential(request.connector_id, {
      fields,
      session_name: sessionName,
    })
    // Belt-and-braces: land the grant even on a server build that predates the
    // credential-write's inline grant.
    if (!res.secret_ref) {
      await apiGrant(request.connector_id, { session_name: sessionName })
    }
    return {
      restartHint: true,
      accountRef: res.account_ref ?? null,
      accountLabel: res.account_label ?? null,
    }
  }

  // ONE <ConnectFlow> instance is mounted the whole time (never remounted on
  // "added"), so its internal seal result — the account label + the test leg —
  // survives. Only the DialogShell's question swaps to the "Added" confirmation.
  return (
    <div data-testid="chat-connect-card" data-phase={added ? 'added' : 'proposed'}>
      <DialogShell
        eyebrow={<>Connector · {name}</>}
        question={
          added ? (
            <span className="inline-flex items-center gap-2">
              <CheckMark />
              Added{toolsLine ? ` · ${toolsLine}` : ''}
            </span>
          ) : (
            <>Connect {name}</>
          )
        }
        why={
          added
            ? added.restartHint
              ? 'Restart the bot to apply — grants bind at the next launch.'
              : undefined
            : `Your bot asked to use ${name}${toolsLine ? ` · ${toolsLine}` : ''}.`
        }
      >
        {effectiveCard ? (
          <Suspense fallback={<p className="mt-[11px] text-[12.6px] text-ink-3">Loading {name}…</p>}>
            <ConnectFlow
              card={effectiveCard}
              variant="chat"
              // The bot's own company is resolved server-side from
              // `sessions.company_id`, so only the session rides here. When the
              // card is an OAuth-device lane, ConnectFlow runs the built-in device
              // sub-flow (code panel + poll) and auto-grants to THIS bot.
              deviceTarget={{ session: sessionName }}
              onSignIn={onSignIn}
              onDismiss={onDismiss}
              onSubmit={seal}
              onDone={(r) => setAdded(r)}
            />
          </Suspense>
        ) : (
          <p className="mt-[11px] text-[12.6px] text-ink-3">Loading {name}…</p>
        )}
      </DialogShell>
    </div>
  )
}

function CheckMark() {
  return (
    <span
      aria-hidden
      className="grid size-[18px] place-items-center rounded-full text-white"
      style={{ background: 'color-mix(in oklab, var(--sm-accent) 78%, black 6%)' }}
    >
      <Check className="size-3" />
    </span>
  )
}
