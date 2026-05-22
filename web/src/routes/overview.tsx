import { TerminalSquare } from 'lucide-react'

import { Page } from '@/components/page'
import { EmptyStatePlaceholder } from '@/components/empty-state'
import { useSessions } from '@/hooks/use-sessions'

export function Overview() {
  // Wired to the M10 stub (empty list). M12 swaps in the real query + SSE.
  const { sessions } = useSessions()

  return (
    <Page title="Overview">
      {sessions.length === 0 ? (
        <EmptyStatePlaceholder
          icon={<TerminalSquare />}
          message="No agents yet. Boot your first one."
          cta={{ label: 'Boot first agent' }}
        />
      ) : null}
    </Page>
  )
}
