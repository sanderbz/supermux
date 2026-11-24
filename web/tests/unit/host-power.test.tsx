/**
 * Settings › Server — restart supermux-server or this Mac (`server/src/host_power.rs`).
 *
 * What a user can be hurt by: a restart button where the host cannot do it, a
 * countdown without its Cancel, and an error that reads like a status code.
 * The password path itself (stdin to sudo, checked before the countdown, never
 * stored) is server-side and covered by the `host_power` Rust tests.
 */
import { describe, expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'

import { ServerRows } from '../../src/components/settings/server-section'
import { ToastProvider } from '../../src/components/ui/toast'
import { powerErrorText, secondsLeft, type HostPower } from '../../src/lib/api/host-power'

const YES = { supported: true }
const html = (host: HostPower) =>
  renderToStaticMarkup(
    <QueryClientProvider client={new QueryClient()}>
      <ToastProvider>
        <ServerRows host={host} />
      </ToastProvider>
    </QueryClientProvider>,
  )

describe('the Server section', () => {
  test('a supported Mac offers both restarts', () => {
    const out = html({ host_restart: YES, server_restart: YES, pending: null })
    expect(out).toContain('data-testid="restart-server"')
    expect(out).toContain('data-testid="restart-host"')
    expect(out).toContain('login password')
  })

  test('an unsupported host says why and offers no button', () => {
    const out = html({
      host_restart: { supported: false, reason: 'Restarting the machine is available on macOS only.' },
      server_restart: { supported: false, reason: 'not running under launchd or systemd' },
      pending: null,
    })
    expect(out).toContain('available on macOS only')
    expect(out).toContain('not running under launchd or systemd')
    expect(out).not.toContain('data-testid="restart-host"')
    expect(out).not.toContain('data-testid="restart-server"')
  })

  test('a pending restart shows the countdown with Cancel instead of Restart', () => {
    const at = Math.floor(Date.now() / 1000) + 20
    const out = html({ host_restart: YES, server_restart: YES, pending: { at } })
    expect(out).toMatch(/Restarting in (19|20) s\./)
    expect(out).toContain('data-testid="restart-host-cancel"')
    expect(out).not.toContain('data-testid="restart-host"')
  })
})

describe('pure helpers', () => {
  test('secondsLeft counts down in whole seconds and stops at zero', () => {
    expect(secondsLeft(100, 70_000)).toBe(30)
    expect(secondsLeft(100, 99_500)).toBe(1)
    expect(secondsLeft(100, 120_000)).toBe(0)
  })

  test('powerErrorText drops the status prefix', () => {
    expect(powerErrorText(new Error("forbidden: that password didn't work"))).toBe("That password didn't work")
    expect(powerErrorText(new Error('too many requests: try again in 15 minutes'))).toBe('Try again in 15 minutes')
    expect(powerErrorText(null)).toBe('That didn’t work.')
  })
})
