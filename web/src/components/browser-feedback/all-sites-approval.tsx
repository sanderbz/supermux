import { Loader2, ShieldAlert } from 'lucide-react'
import type { BrowserBinding, BrowserScopeApproval } from './browser-pairing'

/** The owner's explicit, red approval of an "All websites" pairing code. */
export function AllSitesApproval({ id, label, approval, pairing, onApprove, onCancel }: {
  id: string
  label?: string
  approval: BrowserScopeApproval
  pairing: boolean
  onApprove: () => void
  onCancel: () => void
}) {
  const hours = Math.round(approval.ttl_secs / 3600)
  return <div role="alertdialog" aria-labelledby={id} data-testid="browser-all-sites-approval" className="space-y-2 rounded-xl border border-status-error/30 bg-status-error/5 p-3.5">
    <p id={id} className="flex items-center gap-2 text-[12px] font-semibold text-status-error"><ShieldAlert aria-hidden className="size-4 shrink-0" />This code asks for All websites</p>
    <p className="text-[11px] leading-relaxed text-foreground">{label || 'This agent'} could open and act on <strong>any website</strong> with the logged-in accounts in that browser, for at most <strong>{hours} hours</strong>, except blocked sites (accounts, payments, banks, government, password managers and Supermux itself). Pairing started on <span className="break-all">{approval.origin}</span>.</p>
    <div className="flex flex-wrap gap-2">
      <button type="button" data-testid="browser-all-sites-approve" disabled={pairing} onClick={onApprove} className="flex min-h-11 items-center gap-1.5 rounded-xl bg-status-error px-3.5 text-[12px] font-medium text-white disabled:opacity-40">{pairing && <Loader2 aria-hidden className="size-3.5 animate-spin motion-reduce:animate-none" />}Approve all websites for {hours} hours</button>
      <button type="button" disabled={pairing} onClick={onCancel} className="min-h-11 rounded-xl px-3 text-[12px] text-muted-foreground hover:bg-fill-soft">Cancel</button>
    </div>
  </div>
}

export function AllSitesPaired({ binding, until }: { binding: BrowserBinding; until: string }) {
  return <p role="status" data-testid="browser-all-sites-paired" className="flex gap-2 rounded-lg bg-status-error/5 p-3 text-[11px] leading-relaxed text-status-error"><ShieldAlert aria-hidden className="mt-0.5 size-3.5 shrink-0" /><span className="min-w-0 break-all">Code accepted for All websites until {until} (started on {binding.origin}). Return to the extension to confirm. Disconnect below ends it at any time.</span></p>
}
