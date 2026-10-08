import * as React from 'react'
import { BrowserFeedbackCard } from '@/components/browser-feedback/browser-pairing'

/** Production pairing card in an offline bench. Browser tests intercept its API
 * calls, so changing fixture companies never pairs a real website or agent. */
export default function DevBrowserPairing() {
  const [company, setCompany] = React.useState('first')
  const label = company === 'first' ? 'Research' : 'Design'
  return (
    <main className="relative z-[1] min-h-dvh bg-background p-4 text-foreground">
      <div className="mx-auto max-w-[430px] space-y-4">
        <button
          className="min-h-11 rounded-xl border border-border px-3 text-sm"
          onClick={() =>
            setCompany((value) => (value === 'first' ? 'second' : 'first'))
          }
        >
          Switch fixture company
        </button>
        <BrowserFeedbackCard
          key={company}
          session={`${company}-agent`}
          label={label}
        />
      </div>
    </main>
  )
}
