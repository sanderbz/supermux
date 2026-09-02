/**
 * <OauthConnectButton> — the ONE "Sign in with {name}" button for a
 * supermux-brokered remote MCP (`mcp_oauth`), rendered identically on the three
 * surfaces (store detail, chat Connect card, bot Tools tab).
 *
 * It starts the flow (`POST /oauth/start`), keeps the pending key in THIS tab's
 * `sessionStorage`, refuses a non-`https:` authorize URL, and hands the tab to
 * the provider with a top-level `location.assign` (same tab — on the iOS PWA a
 * popup would open Safari and strand the session). The boot-time return handler
 * (`oauth-return.tsx`) finishes the sign-in.
 *
 * No `@/` alias imports: this sits on the chat `ConnectCard`'s import chain
 * (via `connect-flow.tsx`), whose unit runner resolves the root tsconfig.
 */
import * as React from 'react'
import { Loader2 } from 'lucide-react'

import { startMcpOauth } from '../../lib/api/oauth'
import type { ConnectorCard } from '../../lib/api/connectors'
import { beginSignIn, browserPendingStore, type BeginDeps } from '../../lib/oauth-pending'
import { cn } from '../../lib/utils'
import { ToastContext } from '../ui/use-toast'

export interface OauthConnectButtonProps {
  card: ConnectorCard
  /** The grant target: a bot slug, `*`, or `@company:<id>`. */
  target: string
  /** Where the provider sends the owner back (a same-origin path). */
  returnTo: string
  /** Chat chrome (pill) vs the store's full-width primary. */
  chat?: boolean
  disabled?: boolean
  /** Override the label (default "Sign in with {name}"). */
  label?: string
  className?: string
  /** Test seam: replace the network + navigation. */
  deps?: Partial<BeginDeps>
}

export function OauthConnectButton({
  card,
  target,
  returnTo,
  chat,
  disabled,
  label,
  className,
  deps,
}: OauthConnectButtonProps) {
  // Nullable on purpose: the chat Connect card can mount this outside a
  // ToastProvider (and the SSR unit runner has none) — a refusal then still
  // clears the pending key, it just has nowhere to say so.
  const toastApi = React.useContext(ToastContext)
  const [busy, setBusy] = React.useState(false)

  const onClick = async () => {
    if (busy || disabled) return
    setBusy(true)
    const d: BeginDeps = {
      start: deps?.start ?? startMcpOauth,
      store: deps?.store === undefined ? browserPendingStore() : deps.store,
      assign: deps?.assign ?? ((url) => window.location.assign(url)),
      toast: deps?.toast ?? ((message) => toastApi?.toast({ message, tone: 'error', duration: 4000 })),
    }
    const handedOver = await beginSignIn(d, card.id, target, returnTo)
    // A successful hop unloads this document; only a refusal comes back here.
    if (!handedOver) setBusy(false)
  }

  return (
    <button
      type="button"
      onClick={() => void onClick()}
      disabled={disabled || busy}
      data-vr="connect-oauth"
      aria-label={label ?? `Sign in with ${card.display_name}`}
      className={cn(
        chat
          ? 'inline-flex h-[38px] w-full items-center justify-center gap-2 rounded-full bg-fill-soft-2 px-[15px] text-[13.6px] font-semibold text-ink sm-t-morph hover:bg-fill-soft disabled:opacity-60'
          : 'inline-flex h-11 w-full items-center justify-center gap-2 rounded-xl bg-primary px-4 text-[14px] font-semibold text-primary-foreground shadow-sm transition-colors hover:bg-primary/90 disabled:opacity-60',
        className,
      )}
      style={
        chat
          ? { borderColor: 'color-mix(in oklab, var(--sm-accent) 40%, transparent)', borderWidth: '0.5px' }
          : undefined
      }
    >
      {busy && <Loader2 className="size-4 animate-spin" aria-hidden />}
      {busy ? 'Opening sign-in…' : (label ?? `Sign in with ${card.display_name}`)}
    </button>
  )
}
