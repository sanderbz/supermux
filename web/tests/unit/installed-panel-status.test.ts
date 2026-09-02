/**
 * The Installed tab's status chips + the store detail's grant preselection for
 * the supermux-brokered OAuth lane (design §4.2 / §4.3 / §7.4).
 *   · `statusMeta`: `mcp_oauth && !has_secret` is "Needs sign-in" (was the
 *     terminal note); a `none` lane is Ready.
 *   · `noAccountMeta`: an installed row with `accounts: []` STILL gets a chip.
 *   · `preselectGrant`: a brokered card never opens on a disabled "Choose who
 *     gets it first" — the referring bot, else the active company, else All bots.
 */
import { describe, expect, test } from 'bun:test'

import { noAccountMeta, statusMeta } from '../../src/components/store/installed-panel'
import { preselectGrant, referringBot } from '../../src/components/store/connector-detail'
import type { ConnectorAccount } from '../../src/lib/api/connectors'

const account = (over: Partial<ConnectorAccount> = {}): ConnectorAccount => ({
  id: 'a1',
  account_label: 'owner@test',
  status: 'active',
  has_secret: true,
  last_used_at: 0,
  health: null,
  grant_level: { scope: 'bot', label: 'folderwijzer', count: 1 },
  ...over,
})

describe('statusMeta', () => {
  test('mcp_oauth without a sealed token reads "Needs sign-in"', () => {
    expect(statusMeta(account({ has_secret: false }), 'mcp_oauth')).toEqual({ label: 'Needs sign-in', tone: 'warn' })
    expect(statusMeta(account({ has_secret: false }), 'api_key')).toEqual({ label: 'Needs sign-in', tone: 'warn' })
    expect(statusMeta(account({ has_secret: false }), 'none')).toEqual({ label: 'Ready', tone: 'active' })
  })
  test('a tested-bad account never reads Active', () => {
    expect(statusMeta(account({ health: 'expired' }), 'mcp_oauth').tone).toBe('warn')
    expect(statusMeta(account({ health: 'error' }), 'mcp_oauth').tone).toBe('error')
    expect(statusMeta(account({ status: 'disconnected' }), 'mcp_oauth').label).toBe('Disconnected')
    expect(statusMeta(account(), 'mcp_oauth')).toEqual({ label: 'Active', tone: 'active' })
  })
  test('a row with no account still carries a chip', () => {
    expect(noAccountMeta('mcp_oauth')).toEqual({ label: 'Needs sign-in', tone: 'warn' })
    expect(noAccountMeta('none')).toEqual({ label: 'Ready', tone: 'active' })
  })
})

describe('preselectGrant', () => {
  const bots = [{ name: 'folderwijzer' }, { name: 'other' }]
  test('the referring bot wins', () => {
    expect(preselectGrant({ isLibrary: true, isMcpOauth: true, activeCompany: 3, referrer: 'folderwijzer', bots })).toEqual({ allAgents: false, companyChosen: false, bots: ['folderwijzer'] })
  })
  test('else the active company, else All bots for a brokered card', () => {
    expect(preselectGrant({ isLibrary: true, isMcpOauth: true, activeCompany: 3, referrer: null, bots })).toEqual({ allAgents: false, companyChosen: true, bots: [] })
    expect(preselectGrant({ isLibrary: true, isMcpOauth: true, activeCompany: null, referrer: null, bots })).toEqual({ allAgents: true, companyChosen: false, bots: [] })
  })
  test('other lanes keep the deliberate empty default; a bot scope preselects nothing', () => {
    expect(preselectGrant({ isLibrary: true, isMcpOauth: false, activeCompany: null, referrer: null, bots })).toEqual({ allAgents: false, companyChosen: false, bots: [] })
    expect(preselectGrant({ isLibrary: false, isMcpOauth: true, activeCompany: null, referrer: 'folderwijzer', bots })).toEqual({ allAgents: false, companyChosen: false, bots: [] })
  })
  test('an unknown referrer is ignored', () => {
    expect(preselectGrant({ isLibrary: true, isMcpOauth: true, activeCompany: null, referrer: 'ghost', bots }).allAgents).toBe(true)
  })
  test('referringBot reads the focus and team routes', () => {
    expect(referringBot('/focus/folderwijzer')).toBe('folderwijzer')
    expect(referringBot('/focus/folder%20wijzer?x=1')).toBe('folder wijzer')
    expect(referringBot('/team/acme/bot-a')).toBe('bot-a')
    expect(referringBot('/store')).toBeNull()
    expect(referringBot(null)).toBeNull()
  })
})
