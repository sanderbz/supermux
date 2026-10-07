import * as React from 'react'
import { Check, ChevronDown, Copy, Download, Globe2, Loader2, MonitorUp, RefreshCw, Unplug } from 'lucide-react'
import { apiUrl, settingsRequest } from '../../lib/api/client'
import { csrfCookie } from '../../lib/api/auth'
import { useViewerIdentity } from '../../stores/viewer-store'
import { ResponsiveSheet } from '../ui/responsive-sheet'

export interface BrowserBinding {
  id: string
  origin: string
  session: string
  session_label?: string
  created_at?: number
}

export const supportsBrowserFeedback = (provider: string | undefined) => provider === 'claude' || provider === 'codex'

export const BROWSER_EXTENSION_DOWNLOAD = '/downloads/supermux-browser-extension.zip'
export const browserFeedbackApi = {
  pair: (session: string, code: string) => settingsRequest<BrowserBinding>(
    `/api/sessions/${encodeURIComponent(session)}/browser-pairings`,
    { method: 'POST', credentials: 'same-origin', headers: { 'x-supermux-csrf': csrfCookie() }, body: JSON.stringify({ code }) },
  ),
  list: (session: string) => settingsRequest<BrowserBinding[] | { bindings: BrowserBinding[] }>(
    `/api/sessions/${encodeURIComponent(session)}/browser-bindings`,
    { credentials: 'same-origin' },
  ),
  revoke: (session: string, id: string) => settingsRequest<void>(
    `/api/sessions/${encodeURIComponent(session)}/browser-bindings/${encodeURIComponent(id)}`,
    { method: 'DELETE', credentials: 'same-origin', headers: { 'x-supermux-csrf': csrfCookie() } },
  ),
}

function serverOrigin() {
  if (typeof window === 'undefined') return ''
  try { return new URL(window._SUPERMUX_BASE_URL || window.location.origin, window.location.href).origin }
  catch { return window.location.origin }
}

/** An inline settings section, shared by both agent panels and the chat shortcut.
 *  The server verifies the member's access to this specific session for every request. */
export function BrowserFeedbackCard({ session, label, remote = false }: { session: string; label?: string; remote?: boolean }) {
  const viewer = useViewerIdentity()
  const allowed = viewer.kind === 'owner' || viewer.kind === 'member'
  const identity = viewer.kind === 'member' ? `member:${viewer.companyId}:${viewer.userId}` : viewer.kind
  const instance = React.useId()
  const inputId = `browser-pair-code-${instance}`
  const [code, setCode] = React.useState('')
  const [bindings, setBindings] = React.useState<BrowserBinding[]>([])
  const [loading, setLoading] = React.useState(allowed)
  const [pairing, setPairing] = React.useState(false)
  const [revoking, setRevoking] = React.useState<string | null>(null)
  const [error, setError] = React.useState('')
  const [pairedOrigin, setPairedOrigin] = React.useState('')
  const [copied, setCopied] = React.useState<'server' | 'chrome' | ''>('')
  const mounted = React.useRef(true)
  const copyTimer = React.useRef<ReturnType<typeof setTimeout> | null>(null)
  const epoch = React.useRef(0)
  const endpoint = serverOrigin()

  const load = React.useCallback(async () => {
    if (!allowed) return
    const version = epoch.current
    setLoading(true)
    try {
      const result = await browserFeedbackApi.list(session)
      if (mounted.current && epoch.current === version) setBindings(Array.isArray(result) ? result : result.bindings)
    } catch (e) {
      if (mounted.current && epoch.current === version) setError(e instanceof Error ? e.message : 'Could not load connected websites.')
    } finally { if (mounted.current && epoch.current === version) setLoading(false) }
  }, [allowed, session])

  React.useEffect(() => {
    mounted.current = true; epoch.current++
    setBindings([]); setCode(''); setPairedOrigin(''); setError(''); setPairing(false); setRevoking(null); setCopied('')
    if (allowed) void load()
    else setLoading(false)
    const refresh = (event: Event) => {
      const detail = (event as CustomEvent<{ session: string; source: string }>).detail
      if (detail?.session === session && detail.source !== instance) void load()
    }
    window.addEventListener('supermux-browser-bindings-change', refresh)
    return () => {
      mounted.current = false; epoch.current++
      if (copyTimer.current) clearTimeout(copyTimer.current)
      window.removeEventListener('supermux-browser-bindings-change', refresh)
    }
  }, [allowed, identity, instance, load, session])

  function notify() {
    window.dispatchEvent(new CustomEvent('supermux-browser-bindings-change', { detail: { session, source: instance } }))
  }

  async function pair(event: React.FormEvent) {
    event.preventDefault()
    if (!allowed || remote || !/^\d{4}$/.test(code) || pairing) return
    const version = epoch.current
    setPairing(true); setError(''); setPairedOrigin('')
    try {
      const binding = await browserFeedbackApi.pair(session, code)
      if (!mounted.current || epoch.current !== version) return
      setBindings(current => [...current.filter(item => item.id !== binding.id), binding])
      setPairedOrigin(binding.origin); setCode(''); notify()
    } catch (e) {
      if (mounted.current && epoch.current === version) setError(e instanceof Error ? e.message : 'Pairing failed. Check the code and try again.')
    } finally { if (mounted.current && epoch.current === version) setPairing(false) }
  }

  async function revoke(binding: BrowserBinding) {
    if (!allowed || revoking) return
    const version = epoch.current
    setRevoking(binding.id); setError('')
    try {
      await browserFeedbackApi.revoke(session, binding.id)
      if (mounted.current && epoch.current === version) {
        setBindings(current => current.filter(item => item.id !== binding.id))
        if (pairedOrigin === binding.origin) setPairedOrigin('')
        notify()
      }
    } catch (e) {
      if (mounted.current && epoch.current === version) setError(e instanceof Error ? e.message : 'Could not disconnect this website.')
    } finally { if (mounted.current && epoch.current === version) setRevoking(null) }
  }

  async function copyAddress(value: string, target: 'server' | 'chrome') {
    try {
      await navigator.clipboard.writeText(value)
      if (!mounted.current) return
      setCopied(target)
      if (copyTimer.current) clearTimeout(copyTimer.current)
      copyTimer.current = setTimeout(() => setCopied(''), 1800)
    } catch { setError('Could not copy the address. Select and copy it from the installation guide.') }
  }

  return <section aria-label="Feedback Chrome Extension" data-testid="browser-feedback-card" className="overflow-hidden rounded-2xl border border-border bg-card">
    <div className="space-y-3 p-4">
      <div className="flex items-start gap-3">
        <div className="grid size-10 shrink-0 place-items-center rounded-xl border border-border bg-fill-soft text-ink-2"><MonitorUp aria-hidden className="size-[18px]" /></div>
        <div className="min-w-0 flex-1"><h3 className="text-[14px] font-medium leading-5 tracking-tight text-foreground">Feedback Chrome Extension</h3><p className="mt-1 text-[12px] leading-relaxed text-muted-foreground">Point to a detail on any website. Send screenshots and notes straight to {label || 'this agent'}.</p></div>
      </div>
      <a href={apiUrl(BROWSER_EXTENSION_DOWNLOAD)} download="supermux-browser-extension.zip" data-testid="browser-extension-download" className="flex min-h-11 w-full items-center justify-center gap-2 rounded-xl border border-primary/20 bg-primary/8 px-3 text-[12px] font-medium text-primary transition-colors hover:bg-primary/12 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
        <Download aria-hidden className="size-4" />Download Chrome extension<span className="ml-1 text-[9px] font-normal tracking-wider opacity-65">ZIP · DESKTOP</span>
      </a>
      <details className="group rounded-xl border border-border bg-fill-soft/30">
        <summary className="flex min-h-11 cursor-pointer list-none items-center justify-between gap-3 px-3.5 text-[12px] font-medium text-ink-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring [&::-webkit-details-marker]:hidden">First time? Install in Chrome<ChevronDown aria-hidden className="size-3.5 shrink-0 transition-transform group-open:rotate-180 motion-reduce:transition-none" /></summary>
        <div className="space-y-3 border-t border-border px-3.5 pb-3.5 pt-3">
          <ol className="list-decimal space-y-2 pl-4 text-[11px] leading-relaxed text-muted-foreground">
            <li>Download the ZIP above and unzip it on your desktop. Pairing and connection management also work from your phone.</li>
            <li>In desktop Chrome, open <code className="select-all rounded bg-muted px-1 py-0.5 text-[10px] text-foreground">chrome://extensions</code>, enable <strong className="font-medium text-foreground">Developer mode</strong>, then choose <strong className="font-medium text-foreground">Load unpacked</strong> and select the extracted folder.<button type="button" onClick={() => void copyAddress('chrome://extensions', 'chrome')} className="mt-1 flex min-h-11 items-center gap-1.5 rounded-lg text-[10px] text-foreground focus-visible:ring-2 focus-visible:ring-ring">{copied === 'chrome' ? <Check aria-hidden className="size-3" /> : <Copy aria-hidden className="size-3" />}{copied === 'chrome' ? 'Chrome address copied' : 'Copy chrome://extensions'}</button></li>
            <li>Pin Supermux in Chrome. On the website you want to annotate, click its icon and choose <strong className="font-medium text-foreground">Connect this website to a chat</strong>. Use this server address, then enter the four-digit code below.</li>
          </ol>
          <div><p className="mb-1 text-[9px] uppercase tracking-[.12em] text-muted-foreground">Your Supermux server</p><div className="flex items-center gap-2 rounded-lg border border-border bg-background pl-2.5"><code className="min-w-0 flex-1 select-all truncate text-[10px] text-foreground" title={endpoint}>{endpoint}</code><button type="button" onClick={() => void copyAddress(endpoint, 'server')} aria-label={copied === 'server' ? 'Server address copied' : 'Copy server address'} className="grid size-11 shrink-0 place-items-center rounded-lg text-muted-foreground transition-colors hover:bg-fill-soft focus-visible:ring-2 focus-visible:ring-ring">{copied === 'server' ? <Check aria-hidden className="size-3.5" /> : <Copy aria-hidden className="size-3.5" />}</button></div></div>
          <p className="text-[10px] leading-relaxed text-muted-foreground">Each website connects to one agent. You review every screenshot before sending.</p>
        </div>
      </details>
      {remote && <p className="rounded-lg bg-fill-soft px-3 py-2.5 text-[11px] leading-relaxed text-muted-foreground">Pairing is available for agents running on this Supermux server. SSH-hosted agents aren’t supported yet.</p>}
      {allowed ? <form onSubmit={pair}>
        <label htmlFor={inputId} className="text-[11px] font-medium text-foreground">Pair this agent with a website</label>
        <p className="mb-2.5 mt-1 text-[10px] leading-relaxed text-muted-foreground">Enter the four-digit code from the extension.</p>
        <div className="flex gap-2">
          <input id={inputId} data-testid="browser-pair-code" inputMode="numeric" autoComplete="one-time-code" pattern="[0-9]{4}" maxLength={4} placeholder="0000" value={code} disabled={pairing || remote}
            onChange={event => setCode(event.target.value.replace(/\D/g, '').slice(0, 4))}
            className="h-11 min-w-0 flex-1 rounded-xl border border-border bg-background px-3 font-mono text-[20px] tracking-[.35em] text-foreground outline-none placeholder:text-muted-foreground/35 focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50" />
          <button type="submit" disabled={code.length !== 4 || pairing || remote} className="flex min-h-11 shrink-0 items-center justify-center gap-1.5 rounded-xl bg-primary px-4 text-[12px] font-medium text-primary-foreground transition-opacity disabled:opacity-40">{pairing && <Loader2 aria-hidden className="size-3.5 animate-spin motion-reduce:animate-none" />}{pairing ? 'Pairing…' : 'Pair'}</button>
        </div>
      </form> : <p className="text-[11px] leading-relaxed text-muted-foreground">{viewer.kind === 'pending' ? 'Checking your access…' : 'Sign in to pair a website with this agent.'}</p>}
      {error && <div className="rounded-lg border border-status-error/20 bg-status-error/5 p-3"><p role="alert" className="text-[11px] leading-relaxed text-status-error">{error}</p>{allowed && <button type="button" onClick={() => { setError(''); void load() }} className="mt-1 flex min-h-11 items-center gap-1.5 text-[11px] text-muted-foreground"><RefreshCw aria-hidden className="size-3" />Refresh connections</button>}</div>}
      {pairedOrigin && <p role="status" className="flex gap-2 rounded-lg bg-status-ready/10 p-3 text-[11px] leading-relaxed text-status-ready-ink"><Check aria-hidden className="mt-0.5 size-3.5 shrink-0" /><span className="min-w-0 break-all">{pairedOrigin} is connected. Return to the website to send feedback.</span></p>}
    </div>
    {allowed && <div className="border-t border-border bg-fill-soft/20 px-4 py-3">
      <div className="mb-2 flex items-center justify-between gap-2"><h4 className="text-[9px] font-medium uppercase tracking-[.12em] text-muted-foreground">Connected websites</h4><span className="text-[10px] tabular-nums text-muted-foreground">{bindings.length}</span></div>
      {loading ? <p className="flex items-center gap-2 py-2 text-[11px] text-muted-foreground"><Loader2 aria-hidden className="size-3 animate-spin motion-reduce:animate-none" />Loading connections…</p> : bindings.length ? <ul className="max-h-48 divide-y divide-border overflow-y-auto">{bindings.map(binding => <li key={binding.id} className="flex min-h-11 items-center gap-2 py-1">
        <Globe2 aria-hidden className="size-3.5 shrink-0 text-muted-foreground" /><span className="min-w-0 flex-1 truncate text-[11px] text-foreground" title={binding.origin}>{binding.origin}</span>
        <button type="button" disabled={revoking !== null} onClick={() => void revoke(binding)} title={`Disconnect ${binding.origin}`} aria-label={`Disconnect ${binding.origin}`} className="grid size-11 shrink-0 place-items-center rounded-xl text-muted-foreground transition-colors hover:bg-fill-soft hover:text-status-error focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-40">{revoking === binding.id ? <Loader2 aria-hidden className="size-3.5 animate-spin motion-reduce:animate-none" /> : <Unplug aria-hidden className="size-3.5" />}</button>
      </li>)}</ul> : <p className="py-1 text-[11px] leading-relaxed text-muted-foreground">Pair a website to bring its feedback here.</p>}
    </div>}
  </section>
}

export function BrowserPairingButton({ session, label, compact = false, provider, remote = false }: { session: string; label?: string; compact?: boolean; provider?: string; remote?: boolean }) {
  const viewer = useViewerIdentity()
  const allowed = viewer.kind === 'owner' || viewer.kind === 'member'
  const [open, setOpen] = React.useState(false)
  if (!allowed || (provider !== undefined && !supportsBrowserFeedback(provider))) return null
  return <>
    <button type="button" onClick={() => setOpen(true)} title="Pair browser feedback with this chat" aria-label="Pair browser" aria-haspopup="dialog" data-testid="chat-pair-browser" className="flex min-h-11 min-w-11 shrink-0 items-center justify-center gap-1.5 rounded-xl px-2 text-ink-2 transition-colors hover:bg-fill-soft focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring active:opacity-70">
      <MonitorUp aria-hidden className="size-4" />{!compact && <span className="text-[11px] font-medium">Pair browser</span>}
    </button>
    {open && <ResponsiveSheet open hideHeader onOpenChange={value => { if (!value) setOpen(false) }} title="Feedback Chrome Extension" description={`Browser feedback for ${label || session}`} className="sm:max-w-[430px]">
      <div className="p-5"><BrowserFeedbackCard key={session} session={session} label={label} remote={remote} /></div>
    </ResponsiveSheet>}
  </>
}
