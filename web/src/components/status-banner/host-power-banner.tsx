// The app-wide "this Mac restarts in N s · Cancel" bar. Mounted once at shell
// level next to the reconnect banner, owner-only (the SSE frame and the route
// are owner-only too), so a restart confirmed on the phone can be called off
// from any open app until the countdown runs out.

import * as React from 'react'
import { Power } from 'lucide-react'

import { useIsOwnerPlane } from '@/stores/viewer-store'
import { HOST_POWER_KEY, useHostPower, useNow } from '@/hooks/use-host-power'
import { hostPowerApi, powerErrorText, secondsLeft } from '@/lib/api/host-power'
import { useQueryClient } from '@tanstack/react-query'
import { useToast } from '@/components/ui/use-toast'

export function HostPowerBanner() {
  const owner = useIsOwnerPlane()
  const power = useHostPower(owner)
  const pending = owner ? power.data?.pending ?? null : null
  const now = useNow(pending != null)
  const qc = useQueryClient()
  const { toast } = useToast()
  const [busy, setBusy] = React.useState(false)
  if (!pending) return null
  const left = secondsLeft(pending.at, now)

  async function cancel() {
    setBusy(true)
    try {
      qc.setQueryData(HOST_POWER_KEY, await hostPowerApi.cancel())
      toast({ message: 'Restart cancelled.' })
    } catch (e) {
      toast({ message: powerErrorText(e), tone: 'error' })
    } finally {
      setBusy(false)
    }
  }

  return (
    <div
      role="status"
      data-testid="host-power-banner"
      className="flex items-center justify-center gap-3 border-b border-border bg-status-active/12 px-4 py-2 text-[13px] font-semibold text-foreground"
    >
      <Power className="size-4 shrink-0" aria-hidden />
      <span>
        {left > 0 ? `This Mac restarts in ${left} s` : 'Restarting this Mac… the app reconnects when it is back.'}
      </span>
      {left > 0 && (
        <button
          type="button"
          onClick={() => void cancel()}
          disabled={busy}
          className="-my-2 flex h-11 items-center rounded-full px-3 text-[13px] font-semibold text-primary disabled:opacity-50"
        >
          Cancel
        </button>
      )}
    </div>
  )
}
