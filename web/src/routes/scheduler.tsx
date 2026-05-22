import { AlarmClockPlus } from 'lucide-react'

import { Page } from '@/components/page'
import { EmptyStatePlaceholder } from '@/components/empty-state'

export function Scheduler() {
  return (
    <Page title="Scheduler">
      <EmptyStatePlaceholder
        icon={<AlarmClockPlus />}
        message="Nothing scheduled. amux can boot agents, send commands, or run shell jobs on a timer."
        cta={{ label: 'New schedule' }}
      />
    </Page>
  )
}
