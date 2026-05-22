import { FileText } from 'lucide-react'

import { Page } from '@/components/page'
import { EmptyStatePlaceholder } from '@/components/empty-state'

export function Settings() {
  return (
    <Page title="Settings">
      <EmptyStatePlaceholder
        icon={<FileText />}
        message="No audit events yet."
      />
    </Page>
  )
}
