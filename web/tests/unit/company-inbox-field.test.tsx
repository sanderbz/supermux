/**
 * `<CompanyInboxField>` — the Setup-tab switch that lets ONE HQ bot take
 * `/supermux-message` from company bots (server: `company_inbox`).
 *
 * What a user can be hurt by: the switch showing for someone who may not use it
 * (a company member), a company bot looking openable, the status line saying
 * anything other than what the server holds, and a list that can be ticked down
 * to nobody. The write path is the server's: it refuses an empty list, a company
 * bot and a non-owner, and audits every change (`sessions::company_inbox`).
 */
import { describe, expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'

import { CompanyInboxView } from '../../src/components/roster/company-inbox-field'
import {
  companyInboxKey,
  inboxSummary,
  toggledSlugs,
} from '../../src/components/roster/company-inbox-model'
import { ToastProvider } from '../../src/components/ui/toast'
import { COMPANIES_KEY } from '../../src/hooks/use-companies'
import type { ApiSession, CompanyInbox } from '../../src/lib/api/sessions'
import type { Company } from '../../src/lib/companies'

const COMPANIES: Company[] = [
  { id: 1, slug: 'erecentrum-nl', display_name: 'Erecentrum', root_dir: '/c/e', archived: 0 },
  { id: 2, slug: 'mtbway', display_name: 'MTB Way', root_dir: '/c/m', archived: 0 },
]

const hq = { name: 'max', company_id: null } as unknown as ApiSession
const companyBot = { name: 'erecentrum', company_id: 1 } as unknown as ApiSession

function html(session: ApiSession, inbox?: CompanyInbox, owner = true): string {
  const qc = new QueryClient()
  qc.setQueryData(COMPANIES_KEY, COMPANIES)
  if (inbox) qc.setQueryData(companyInboxKey(session.name), inbox)
  return renderToStaticMarkup(
    <QueryClientProvider client={qc}>
      <ToastProvider>
        <CompanyInboxView name={session.name} session={session} owner={owner} />
      </ToastProvider>
    </QueryClientProvider>,
  )
}

describe('who sees it', () => {
  test('a company member never sees the switch', () => {
    expect(html(hq, { session: 'max', open: false, companies: [] }, false)).not.toContain('company-inbox')
  })

  test('on a company bot it is off, disabled, and says why', () => {
    const out = html(companyBot)
    expect(out).toContain('Messages from companies')
    expect(out).toContain('Only HQ bots have this')
    expect(out).toMatch(/role="switch"[^>]*aria-checked="false"[^>]*disabled/)
  })
})

describe('an HQ bot shows the server’s state', () => {
  test('closed is the default: switch off, no company list', () => {
    const out = html(hq, { session: 'max', open: false, companies: [] })
    expect(out).toContain('Off — company bots can’t message this bot.')
    expect(out).toMatch(/role="switch"[^>]*aria-checked="false"/)
    expect(out).not.toContain('company-inbox-list')
  })

  test('open to all companies', () => {
    const out = html(hq, { session: 'max', open: true, companies: '*' })
    expect(out).toMatch(/role="switch"[^>]*aria-checked="true"/)
    expect(out).toContain('Open to every company')
    expect(out).not.toContain('company-inbox-list')
  })

  test('open to a list: ticked boxes, and the last one cannot be unticked', () => {
    const out = html(hq, { session: 'max', open: true, companies: ['erecentrum-nl'] })
    expect(out).toContain('Open to Erecentrum.')
    expect(out).toContain('company-inbox-list')
    // The only ticked company is disabled: closing is the switch, never an empty list.
    expect(out).toMatch(/<input(?=[^>]*checked="")(?=[^>]*disabled="")[^>]*\/>Erecentrum/)
    expect(out).toMatch(/<input(?![^>]*disabled)[^>]*\/>MTB Way/)
    expect(out).toContain('MTB Way')
  })
})

describe('pure helpers', () => {
  test('inboxSummary names companies by display name, falling back to the slug', () => {
    expect(inboxSummary(undefined, COMPANIES)).toContain('Off')
    expect(inboxSummary({ session: 'm', open: true, companies: ['mtbway', 'gone'] }, COMPANIES)).toBe(
      'Open to MTB Way, gone.',
    )
  })

  test('toggledSlugs adds, removes, and refuses to empty the list', () => {
    expect(toggledSlugs(['a'], 'b')).toEqual(['a', 'b'])
    expect(toggledSlugs(['a', 'b'], 'a')).toEqual(['b'])
    expect(toggledSlugs(['a'], 'a')).toBeNull()
  })
})
