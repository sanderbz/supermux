import { FolderOpen } from 'lucide-react'

import { Page } from '@/components/page'
import { EmptyStatePlaceholder } from '@/components/empty-state'

export function Files() {
  return (
    <Page title="Files">
      <EmptyStatePlaceholder
        icon={<FolderOpen />}
        message="Nothing here."
        cta={{ label: 'Go up' }}
      />
    </Page>
  )
}
