// The `/store` route — the connector store's dedicated view (Doorway 1).
//
// Lazy-loaded under <Layout> (mirrors the settings lazy pattern). Hosts the
// reusable <StoreView> in the library scope (`grantTarget={null}`): Get / Grant…
// chips, the full catalog grid, search, categories, Featured rail. The same
// component is rendered bot-scoped in the bot-panel sheet.
import { useParams } from 'react-router-dom'

import { StoreView } from '@/components/store/store-view'

export function Store() {
  // `/store/<id>` deep-links straight onto one connector's detail — the path a
  // brokered OAuth sign-in returns to (`return_to`), so the owner lands back on
  // the sheet they left. Keyed so a fresh id remounts onto the new card.
  const { id } = useParams<{ id?: string }>()
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <StoreView key={id ?? 'grid'} grantTarget={null} variant="page" initialOpenId={id} />
    </div>
  )
}

export default Store
