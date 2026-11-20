import type { ApiSession } from '@/lib/api'
import { supportsManagedSkills } from '@/lib/api/skill-library'
import { useCatalog } from '@/hooks/use-agent-skills'
import { lazy, Suspense, useState } from 'react'
import { ResponsiveSheet } from '@/components/ui/responsive-sheet'
import { RestartToApply } from '@/components/roster/restart-to-apply'

const Library = lazy(() =>
  import('./skill-library').then((m) => ({ default: m.SkillLibraryView })),
)

export function BotSkills({
  name,
  session,
}: {
  name: string
  session: ApiSession | null
}) {
  const [open, setOpen] = useState(false)
  const supported = supportsManagedSkills(session)
  const query = useCatalog(name, supported)
  if (!supported) return null
  const granted = Object.keys(query.data?.effective ?? {}).sort()
  return (
    <section className="space-y-2">
      <div className="flex items-center justify-between gap-2">
        <h3 className="text-sm font-semibold">Agent skills</h3>
        <button
          type="button"
          className="text-sm text-primary underline"
          onClick={() => setOpen(true)}
        >
          Manage skills
        </button>
      </div>
      <p className="text-xs text-muted-foreground">
        {query.isError
          ? 'Skills unavailable.'
          : query.isPending
            ? 'Loading skills…'
            : granted.join(', ') || 'No managed skills assigned.'}
      </p>
      {query.data?.pending && <RestartToApply name={name} />}
      {open && (
        <ResponsiveSheet
          open
          onOpenChange={setOpen}
          title={'Agent skills for ' + name}
          className="sm:max-w-2xl"
        >
          <Suspense fallback={<p className="p-4">Loading skills…</p>}>
            <Library bot={name} />
          </Suspense>
        </ResponsiveSheet>
      )}
    </section>
  )
}
