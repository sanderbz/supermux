// The pure half of `<CompanyInboxField>`: the query key, the status sentence and
// the tick rule. Kept apart so the component file exports only components.

import type { CompanyInbox } from '@/lib/api'
import type { Company } from '@/lib/companies'

export const companyInboxKey = (name: string) => ['company-inbox', name] as const

/** The status line under the switch, in words. */
export function inboxSummary(inbox: CompanyInbox | undefined, companies: Company[]): string {
  if (!inbox || !inbox.open) return 'Off — company bots can’t message this bot.'
  if (inbox.companies === '*') return 'Open to every company, including ones you add later.'
  const names = inbox.companies.map(
    (slug) => companies.find((c) => c.slug === slug)?.display_name || slug,
  )
  return `Open to ${names.join(', ')}.`
}

/** The slugs after ticking `slug` on or off, from an inbox that is open to a
 *  list. `null` when the change would leave no company — closing is the switch,
 *  never an empty list (the server refuses one). */
export function toggledSlugs(current: string[], slug: string): string[] | null {
  const next = current.includes(slug) ? current.filter((s) => s !== slug) : [...current, slug]
  return next.length ? next : null
}
