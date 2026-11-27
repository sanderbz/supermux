// The `/store` route — the connector store's dedicated view (Doorway 1).
//
// Lazy-loaded under <Layout> (mirrors the settings lazy pattern). Hosts the
// reusable <StoreView> in the library scope (`grantTarget={null}`): Get / Grant…
// chips, the full catalog grid, search, categories, Featured rail. The same
// component is rendered bot-scoped in the bot-panel sheet.
import { Link, useParams, useSearchParams } from 'react-router-dom'

import { StoreView } from '@/components/store/store-view'

import { SkillLibraryView } from '@/components/skills/skill-library'

export function Store() {
  // `/store/<id>` deep-links straight onto one connector's detail — the path a
  // brokered OAuth sign-in returns to (`return_to`), so the owner lands back on
  // the sheet they left. Keyed so a fresh id remounts onto the new card.
  const { id } = useParams<{ id?: string }>()
  const [search] = useSearchParams()
  const skills = !id && search.get('tab') === 'skills'
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <nav
        aria-label="Store sections"
        className="flex gap-4 border-b px-4 py-2 text-sm font-medium"
      >
        <Link
          aria-current={!skills ? 'page' : undefined}
          to="/store"
          className={
            skills ? 'text-muted-foreground' : 'underline underline-offset-4'
          }
        >
          Connectors
        </Link>
        <Link
          aria-current={skills ? 'page' : undefined}
          to="/store?tab=skills"
          className={
            skills ? 'underline underline-offset-4' : 'text-muted-foreground'
          }
        >
          Agent skills
        </Link>
      </nav>
      {skills ? (
        <SkillLibraryView />
      ) : (
        <StoreView
          key={id ?? 'grid'}
          grantTarget={null}
          variant="page"
          initialOpenId={id}
        />
      )}
    </div>
  )
}

export default Store
