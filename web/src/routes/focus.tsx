import { useNavigate, useParams } from 'react-router-dom'
import { SquareTerminal } from 'lucide-react'

import { Page } from '@/components/page'
import { EmptyStatePlaceholder } from '@/components/empty-state'
import { useSession } from '@/hooks/use-sessions'

export function Focus() {
  const { name = '' } = useParams()
  const navigate = useNavigate()
  // Stub for now; the live xterm terminal + dock land in M13/M14/M15.
  useSession(name)

  return (
    <Page title="Focus">
      <EmptyStatePlaceholder
        icon={<SquareTerminal />}
        message={`The live terminal for "${name}" connects in a later milestone.`}
        cta={{ label: 'Back to overview', onClick: () => navigate('/') }}
      />
    </Page>
  )
}
