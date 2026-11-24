// Settings › Server — restart supermux-server, or this whole Mac, from the app.
//
// Owner/admin only (the routes are too; a member never sees the section). The
// Mac restart asks for the Mac's login password once per restart: it is sent
// in that one request and handed to `sudo` on the server's stdin, checked at
// once, then the Mac restarts after a 30-second countdown that every open app
// can cancel (`HostPowerBanner`). Nothing here keeps the password: the field is
// cleared when the dialog closes, whatever happened.

import * as React from 'react'
import { useQueryClient } from '@tanstack/react-query'

import { Section, Row } from '@/components/settings/primitives'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { useConfirm } from '@/components/ui/confirm-dialog'
import { useToast } from '@/components/ui/use-toast'
import { useIsOwnerPlane } from '@/stores/viewer-store'
import { HOST_POWER_KEY, useHostPower, useNow } from '@/hooks/use-host-power'
import { hostPowerApi, powerErrorText, secondsLeft, type HostPower } from '@/lib/api/host-power'

export function ServerSection() {
  const owner = useIsOwnerPlane()
  const power = useHostPower(owner)
  if (!owner || !power.data) return null
  return <ServerRows host={power.data} />
}

export function ServerRows({ host }: { host: HostPower }) {
  const qc = useQueryClient()
  const confirm = useConfirm()
  const { toast } = useToast()
  const [restartingServer, setRestartingServer] = React.useState(false)
  const [askOpen, setAskOpen] = React.useState(false)
  const now = useNow(host.pending != null)

  async function restartServer() {
    const ok = await confirm({
      title: 'Restart supermux-server?',
      body: 'Your agents keep running. The app is offline for a few seconds and reconnects by itself.',
      confirm: 'Restart server',
      cancel: 'Cancel',
    })
    if (!ok) return
    setRestartingServer(true)
    try {
      await hostPowerApi.restartServer()
      toast({ message: 'Restarting supermux-server…' })
    } catch (e) {
      toast({ message: powerErrorText(e), tone: 'error' })
    } finally {
      setRestartingServer(false)
    }
  }

  async function cancel() {
    try {
      qc.setQueryData(HOST_POWER_KEY, await hostPowerApi.cancel())
    } catch (e) {
      toast({ message: powerErrorText(e), tone: 'error' })
    }
  }

  const pending = host.pending
  return (
    <Section title="Server" footnote="Only you see this. Every restart is recorded in the audit log.">
      <Row
        label="Restart supermux-server"
        hint={
          host.server_restart.supported
            ? 'Agents keep running; the app reconnects in a few seconds.'
            : host.server_restart.reason
        }
        control={
          host.server_restart.supported ? (
            <Button
              variant="secondary"
              size="sm"
              disabled={restartingServer}
              onClick={() => void restartServer()}
              data-testid="restart-server"
            >
              Restart
            </Button>
          ) : null
        }
      />
      <Row
        label="Restart this Mac"
        hint={
          !host.host_restart.supported
            ? host.host_restart.reason
            : pending
              ? `Restarting in ${secondsLeft(pending.at, now)} s.`
              : 'Asks for this Mac’s login password, then restarts after 30 seconds — you can still cancel. Agents come back after login.'
        }
        control={
          !host.host_restart.supported ? null : pending ? (
            <Button variant="secondary" size="sm" onClick={() => void cancel()} data-testid="restart-host-cancel">
              Cancel
            </Button>
          ) : (
            <Button variant="destructive" size="sm" onClick={() => setAskOpen(true)} data-testid="restart-host">
              Restart…
            </Button>
          )
        }
      />
      <PasswordDialog open={askOpen} onOpenChange={setAskOpen} />
    </Section>
  )
}

function PasswordDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (o: boolean) => void }) {
  const qc = useQueryClient()
  const [password, setPassword] = React.useState('')
  const [error, setError] = React.useState<string | null>(null)
  const [busy, setBusy] = React.useState(false)

  // The field never outlives the dialog: every way out clears it.
  function close(next: boolean) {
    if (!next) {
      setPassword('')
      setError(null)
    }
    onOpenChange(next)
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    if (!password || busy) return
    setBusy(true)
    setError(null)
    try {
      qc.setQueryData(HOST_POWER_KEY, await hostPowerApi.restartHost(password))
      close(false)
    } catch (err) {
      setError(powerErrorText(err))
    } finally {
      setPassword('')
      setBusy(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={close}>
      <DialogContent>
        <form onSubmit={(e) => void submit(e)} className="flex flex-col gap-4">
          <DialogHeader>
            <DialogTitle>Restart this Mac?</DialogTitle>
            <DialogDescription>
              Every app on it closes and running agents stop until the Mac is back and logged in. Enter
              the Mac’s login password; it goes only to sudo for this restart and is not stored. You get
              30 seconds to cancel.
            </DialogDescription>
          </DialogHeader>
          <Input
            type="password"
            autoComplete="current-password"
            aria-label="Mac login password"
            placeholder="Mac login password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            data-testid="restart-host-password"
          />
          {error && (
            <p role="alert" className="text-[13px] text-destructive">
              {error}
            </p>
          )}
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={() => close(false)}>
              Cancel
            </Button>
            <Button type="submit" variant="destructive" disabled={!password || busy} data-testid="restart-host-confirm">
              {busy ? 'Checking…' : 'Restart in 30 s'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
