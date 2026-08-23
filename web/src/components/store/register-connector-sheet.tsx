// "Register connector" — the owner's one-tap review + admin install for a
// manifest a bot AUTHORED (§3–§4 of the design).
//
// A connector DEFINITION is GLOBAL, so registration stays owner/admin-gated
// server-side (`POST /api/connectors` is `require_admin`). The bot can author a
// manifest and self-test its MCP server, but it holds a hook token, not the
// dashboard bearer — so it hands the manifest to the owner, who reviews it here
// and taps Register. The dashboard (already holding the bearer) makes the admin
// call. No bot ever mints a global connector; secrets never ride the manifest
// (only `${VAR}` placeholders + the credential SCHEMA).
//
// v1 surface: the owner loads the manifest the bot produced (paste / it prints
// the JSON in chat), reviews the parsed card, taps Register, then optionally
// grants it to the active company (`@company:<id>`) in the same flow. The fuller
// "bot raises a Register card in chat automatically" wire (a `register_request`
// per-session live-state) is a noted follow-up — it needs server work and must
// not weaken the admin gate.
import * as React from 'react'
import { BadgeCheck, Check, Loader2 } from 'lucide-react'

import {
  companyGrantKey,
  grant,
  upsertConnector,
  type CredentialField,
  type Manifest,
} from '@/lib/api/connectors'
import { useUI } from '@/stores/ui-store'
import { useCompanies } from '@/hooks/use-companies'
import { ResponsiveSheet } from '@/components/ui/responsive-sheet'

/** Parse + shallow-validate the pasted manifest JSON. Returns the manifest or a
 *  human error string — never throws, so a half-typed paste never crashes the UI. */
export function parseManifest(text: string): { manifest: Manifest } | { error: string } {
  const trimmed = text.trim()
  if (!trimmed) return { error: '' }
  let value: unknown
  try {
    value = JSON.parse(trimmed)
  } catch {
    return { error: "That isn't valid JSON yet." }
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return { error: 'A manifest is a JSON object.' }
  }
  const obj = value as Record<string, unknown>
  const id = obj.id
  if (typeof id !== 'string' || id.trim() === '') {
    return { error: 'The manifest needs a non-empty "id".' }
  }
  return { manifest: obj as unknown as Manifest }
}

type Phase = 'edit' | 'registering' | 'registered' | 'granting' | 'granted' | 'error'

export function RegisterConnectorSheet({
  open,
  onOpenChange,
  initialManifest,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** Offline bench / deep-link: seed the textarea with a manifest to review. */
  initialManifest?: string
}) {
  const activeCompany = useUI((s) => s.activeCompany)
  const { companies } = useCompanies()
  const company = activeCompany !== null ? companies.find((c) => c.id === activeCompany) ?? null : null

  // Seeded at MOUNT; the parent remounts (a `key` nonce bumped on open) to re-seed
  // — the lint-clean alternative to a reset-on-open effect.
  const [raw, setRaw] = React.useState(initialManifest ?? '')
  const [phase, setPhase] = React.useState<Phase>('edit')
  const [errorText, setErrorText] = React.useState('')
  const [registeredId, setRegisteredId] = React.useState<string | null>(null)

  const parsed = React.useMemo(() => parseManifest(raw), [raw])
  const manifest = 'manifest' in parsed ? parsed.manifest : null
  const parseError = 'error' in parsed ? parsed.error : ''

  const register = async () => {
    if (!manifest) return
    setPhase('registering')
    setErrorText('')
    try {
      // The admin install (owner-driven; the dashboard holds the bearer). Appears
      // in the store live on the next `GET /api/connectors` — no restart.
      const id = await upsertConnector(manifest)
      setRegisteredId(id)
      setPhase('registered')
    } catch (e) {
      setErrorText(e instanceof Error ? e.message : 'Registration failed.')
      setPhase('error')
    }
  }

  const grantToCompany = async () => {
    if (!registeredId || !company) return
    setPhase('granting')
    setErrorText('')
    try {
      await grant(registeredId, { session_name: companyGrantKey(company.id) })
      setPhase('granted')
    } catch (e) {
      setErrorText(e instanceof Error ? e.message : 'Grant failed.')
      setPhase('error')
    }
  }

  const done = phase === 'registered' || phase === 'granting' || phase === 'granted'
  const name = manifest?.display_name?.trim() || manifest?.id || 'connector'
  const tools = manifest?.tools?.length ?? 0
  const creds: CredentialField[] = manifest?.credentials ?? []

  return (
    <ResponsiveSheet
      open={open}
      onOpenChange={onOpenChange}
      title="Register connector"
      description="Review the manifest a bot built, then install it into your store."
      className="sm:max-w-md"
    >
      <div className="flex flex-col gap-5 px-5 py-5" data-vr="register-connector-sheet">
        {!done && (
          <label className="flex flex-col gap-1.5">
            <span className="text-[12.5px] font-medium text-foreground">
              Manifest <span className="text-muted-foreground">(the JSON the bot produced)</span>
            </span>
            <textarea
              value={raw}
              rows={8}
              spellCheck={false}
              onChange={(e) => setRaw(e.target.value)}
              placeholder={'{\n  "id": "linear",\n  "display_name": "Linear",\n  "credentials": [ … ],\n  "emit": { … }\n}'}
              aria-label="Connector manifest JSON"
              data-vr="register-connector-input"
              className="w-full resize-y rounded-xl border border-input bg-background px-3 py-2.5 font-mono text-[12px] leading-relaxed text-foreground outline-none placeholder:text-muted-foreground focus-visible:ring-2 focus-visible:ring-ring"
            />
            {parseError && <span className="text-[12px] text-destructive">{parseError}</span>}
          </label>
        )}

        {/* review card — the parsed manifest at a glance */}
        {manifest && (
          <div className="rounded-2xl border border-border bg-card p-4" data-vr="register-connector-preview">
            <div className="flex items-center gap-2">
              <BadgeCheck className="size-4 text-primary" aria-hidden />
              <span className="text-[15px] font-semibold text-foreground">{name}</span>
            </div>
            <div className="mt-1 flex flex-wrap items-center gap-2 text-[12px] text-muted-foreground">
              <span className="font-mono">{manifest.id}</span>
              <span>·</span>
              <span>{tools} tools</span>
              <span>·</span>
              <span>{creds.length} credential{creds.length === 1 ? '' : 's'}</span>
            </div>
            {manifest.description && (
              <p className="mt-2 text-[13px] leading-snug text-foreground/85">{manifest.description}</p>
            )}
            {creds.length > 0 && (
              <ul className="mt-3 flex flex-wrap gap-1.5">
                {creds.map((c) => (
                  <li
                    key={c.key}
                    className="inline-flex items-center rounded-full bg-muted px-2 py-0.5 font-mono text-[11px] text-foreground/75"
                  >
                    {c.key}
                    {c.sensitive && <span className="ml-1 text-muted-foreground" title="Secret — vault-only">🔒</span>}
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}

        {phase === 'granted' ? (
          <div className="flex items-center gap-2 rounded-xl bg-status-ready/15 px-3 py-2.5 text-[13px] font-medium text-status-ready-ink">
            <Check className="size-4" aria-hidden />
            Registered{company ? ` and granted to ${company.display_name}` : ''} — it's live in the store.
          </div>
        ) : done ? (
          <div className="flex flex-col gap-2">
            <div className="flex items-center gap-2 rounded-xl bg-status-ready/15 px-3 py-2.5 text-[13px] font-medium text-status-ready-ink">
              <Check className="size-4" aria-hidden />
              Registered — it's live in the store.
            </div>
            {company && (
              <button
                type="button"
                onClick={() => void grantToCompany()}
                disabled={phase === 'granting'}
                data-vr="register-connector-grant"
                className="inline-flex h-11 w-full items-center justify-center gap-2 rounded-xl border border-border bg-card px-4 text-[14px] font-semibold text-foreground transition-colors hover:bg-muted disabled:opacity-60"
              >
                {phase === 'granting' && <Loader2 className="size-4 animate-spin" aria-hidden />}
                {phase === 'granting' ? 'Granting…' : `Grant to ${company.display_name}`}
              </button>
            )}
            <button
              type="button"
              onClick={() => onOpenChange(false)}
              className="inline-flex h-10 items-center justify-center text-[13px] font-medium text-muted-foreground hover:text-foreground"
            >
              Done
            </button>
          </div>
        ) : (
          <button
            type="button"
            onClick={() => void register()}
            disabled={!manifest || phase === 'registering'}
            data-vr="register-connector-submit"
            className="inline-flex h-11 w-full items-center justify-center gap-2 rounded-xl bg-primary px-4 text-[14px] font-semibold text-primary-foreground shadow-sm transition-colors hover:bg-primary/90 disabled:opacity-60"
          >
            {phase === 'registering' && <Loader2 className="size-4 animate-spin" aria-hidden />}
            {phase === 'registering' ? 'Registering…' : manifest ? `Register ${name}` : 'Register'}
          </button>
        )}

        {phase === 'error' && errorText && (
          <span className="text-[12px] text-destructive">{errorText}</span>
        )}

        <p className="text-[11.5px] leading-relaxed text-muted-foreground">
          A connector definition is global, so only you (the owner) can register it — a bot prepares the
          manifest and asks; you approve here. Secrets are never in the manifest; each account is collected
          write-only into the vault from the connector's Connect card.
        </p>
      </div>
    </ResponsiveSheet>
  )
}
