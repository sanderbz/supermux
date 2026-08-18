// The `/store` route — the connector store's dedicated view (Doorway 1).
//
// Lazy-loaded under <Layout> (mirrors the settings lazy pattern). Hosts the
// reusable <StoreView> in the library scope (`grantTarget={null}`): Get / Grant…
// chips, the full catalog grid, search, categories, Featured rail. The same
// component is rendered bot-scoped in the bot-panel sheet.
import { StoreView } from '@/components/store/store-view'

export function Store() {
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <StoreView grantTarget={null} variant="page" />
    </div>
  )
}

export default Store
