// DEV bench (/dev/store) — the connector store + inline connect-card, offline.
//
// No server behind it: the grid renders from the curated fallback, grant state
// is seeded, and the ConnectCard renders against a seed card. Both themes and
// the [data-grok] skin on one page so the offline Playwright rig can screenshot
// the whole surface. Not a product route.
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'

import { ToastProvider } from '@/components/ui/toast'
import { TooltipProvider } from '@/components/ui/tooltip'
import { StoreView } from '@/components/store/store-view'
import { CURATED_FALLBACK } from '@/components/store/catalog'
import { ConnectCard } from '@/components/chat/ui/connect-card'
import type { ConnectorCard } from '@/lib/api/connectors'

const BENCH_QC = new QueryClient({
  defaultOptions: { queries: { retry: false, staleTime: Infinity } },
})

const GRANTED = { bot: ['pmcp-github'], all: ['builtin-browser'] }

const OAUTH_CARD: ConnectorCard = CURATED_FALLBACK.find((c) => c.id === 'pmcp-notion')!
const KEY_CARD: ConnectorCard = CURATED_FALLBACK.find((c) => c.id === 'icloud-mail')!

function Slab({
  theme,
  grok,
}: {
  theme: 'light' | 'dark'
  grok?: boolean
}) {
  return (
    <div
      data-theme={theme}
      className={theme === 'dark' ? 'dark bg-background text-foreground' : 'bg-background text-foreground'}
    >
      <div {...(grok ? { 'data-grok': '' } : {})} className="flex flex-col gap-10 px-4 py-10">
        <header className="mx-auto w-full max-w-[1120px]">
          <h1 className="text-lg font-semibold tracking-tight text-foreground">
            Connector store — {theme}
            {grok ? ' · grok' : ''}
          </h1>
        </header>

        {/* the full library grid */}
        <div
          data-vr={`store-grid-${theme}${grok ? '-grok' : ''}`}
          className="h-[720px] overflow-hidden rounded-3xl border border-border"
        >
          <StoreView grantTarget={null} mock={CURATED_FALLBACK} mockGranted={GRANTED} />
        </div>

        {/* bot-scoped variant (rows) */}
        <div
          data-vr={`store-sheet-${theme}${grok ? '-grok' : ''}`}
          className="mx-auto h-[560px] w-full max-w-[560px] overflow-hidden rounded-3xl border border-border"
        >
          <StoreView grantTarget="Ada" mock={CURATED_FALLBACK} mockGranted={GRANTED} variant="sheet" />
        </div>

        {/* the inline connect-cards (chat surface — needs the sm token slab) */}
        <div className="mx-auto w-full max-w-[640px]">
          <h2 className="mb-3 text-sm font-medium text-foreground">Inline connect-card</h2>
          <div className="flex flex-col gap-6" data-vr={`connect-cards-${theme}${grok ? '-grok' : ''}`}>
            <ConnectCard
              request={{
                connector_id: OAUTH_CARD.id,
                display_name: OAUTH_CARD.display_name,
                tool_count: OAUTH_CARD.tool_count,
                has_oauth: true,
              }}
              sessionName="Ada"
              card={OAUTH_CARD}
            />
            <ConnectCard
              request={{
                connector_id: KEY_CARD.id,
                display_name: KEY_CARD.display_name,
                tool_count: KEY_CARD.tools.length,
                has_oauth: false,
              }}
              sessionName="Ada"
              card={KEY_CARD}
            />
          </div>
        </div>
      </div>
    </div>
  )
}

export default function DevStore() {
  return (
    <QueryClientProvider client={BENCH_QC}>
      <TooltipProvider delayDuration={200}>
        <ToastProvider>
          <div className="min-h-screen">
            <Slab theme="light" />
            <Slab theme="light" grok />
            <Slab theme="dark" />
            <Slab theme="dark" grok />
          </div>
        </ToastProvider>
      </TooltipProvider>
    </QueryClientProvider>
  )
}
