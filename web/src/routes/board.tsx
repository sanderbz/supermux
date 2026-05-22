import { ClipboardList } from 'lucide-react'

import { Page } from '@/components/page'
import { EmptyStatePlaceholder } from '@/components/empty-state'
import { useBoard } from '@/hooks/use-board'

export function Board() {
  const { issues } = useBoard()

  return (
    <Page title="Board">
      {issues.length === 0 ? (
        <EmptyStatePlaceholder
          icon={<ClipboardList />}
          message="Your board is clear."
          cta={{ label: 'Add an issue' }}
        />
      ) : null}
    </Page>
  )
}
