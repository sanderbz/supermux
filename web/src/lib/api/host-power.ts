// Restart this Mac, or supermux-server, from the app (`server/src/host_power.rs`).
// Owner/admin only. The Mac's login password goes in the body of ONE request,
// straight to `sudo` on the server's stdin; it is never stored here either.

import { settingsRequest } from './client'

export interface PowerSupport {
  supported: boolean
  /** Why not, in a sentence, when `supported` is false. */
  reason?: string
}

export interface HostPower {
  host_restart: PowerSupport
  server_restart: PowerSupport
  /** A confirmed Mac restart counting down: `at` is unix seconds. */
  pending: { at: number } | null
}

export const hostPowerApi = {
  get: (): Promise<HostPower> => settingsRequest('/api/host/power'),
  /** Checks the password at once (a typo is a 403 here, before any countdown),
   *  then the Mac restarts after 30 s unless cancelled. */
  restartHost: (password: string): Promise<HostPower> =>
    settingsRequest('/api/host/restart', { method: 'POST', body: JSON.stringify({ password }) }),
  cancel: (): Promise<HostPower> => settingsRequest('/api/host/restart/cancel', { method: 'POST' }),
  restartServer: (): Promise<{ restarting: boolean }> =>
    settingsRequest('/api/host/restart-server', { method: 'POST' }),
}

/** A server error, minus the status prefix the API puts in front
 *  (`forbidden: that password didn't work` → `That password didn't work`). */
export function powerErrorText(e: unknown): string {
  const raw = e instanceof Error ? e.message : String(e ?? '')
  const msg = raw.replace(/^(forbidden|bad request|conflict|too many requests|not found): /i, '')
  return msg ? msg[0].toUpperCase() + msg.slice(1) : 'That didn’t work.'
}

/** Whole seconds until `at` (unix seconds), never negative. */
export function secondsLeft(at: number, nowMs: number): number {
  return Math.max(0, Math.ceil(at - nowMs / 1000))
}
