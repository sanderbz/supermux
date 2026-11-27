import { useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { BookOpen, Plus, Search } from 'lucide-react'
import { useSearchParams } from 'react-router-dom'
import { Button } from '@/components/ui/button'
import { RestartToApply } from '@/components/roster/restart-to-apply'
import { useCompanies } from '@/hooks/use-companies'
import { useSessions } from '@/hooks/use-sessions'
import { companyGrantKey } from '@/lib/api/connectors'
import {
  skillLibrary,
  supportsManagedSkills,
  type SkillPackage,
} from '@/lib/api/skill-library'
import { useUI } from '@/stores/ui-store'
import { useViewerIdentity } from '@/stores/viewer-store'
import { useCatalog } from '@/hooks/use-agent-skills'
import { SkillEditor } from './skill-editor'

export function SkillLibraryView({ bot }: { bot?: string }) {
  const viewer = useViewerIdentity()
  const activeCompany = useUI((s) => s.activeCompany)
  const { companies } = useCompanies()
  const { sessions } = useSessions()
  const [params, setParams] = useSearchParams()
  const defaultCompany =
    viewer.kind === 'member' ? viewer.companyId : activeCompany
  const target =
    bot ||
    params.get('target') ||
    (defaultCompany != null ? companyGrantKey(defaultCompany) : '*')
  const query = useCatalog(target)
  const cache = useQueryClient()
  const [search, setSearch] = useState('')
  const [editor, setEditor] = useState<{
    name: string
    pkg: SkillPackage
  } | null>(null)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const data = query.data
  const options = new Map<string, string>()
  if (viewer.kind === 'owner') options.set('*', 'All agents')
  for (const c of companies) options.set(companyGrantKey(c.id), c.display_name)
  for (const s of sessions) {
    if (supportsManagedSkills(s))
      options.set(
        s.name,
        (s.display_name || s.name) +
          ' · ' +
          (s.provider === 'claude' ? 'Claude' : 'Codex'),
      )
  }
  const refresh = () => cache.invalidateQueries({ queryKey: ['agent-skills'] })
  async function act(action: () => Promise<unknown>) {
    setBusy(true)
    setError('')
    try {
      await action()
      await refresh()
    } catch (e) {
      setError(String(e))
    } finally {
      setBusy(false)
    }
  }
  const cards = data?.skills.filter((card) =>
    (card.name + ' ' + card.description)
      .toLowerCase()
      .includes(search.trim().toLowerCase()),
  )
  return (
    <main className="min-h-0 flex-1 overflow-y-auto">
      <div className="mx-auto flex w-full max-w-5xl flex-col gap-5 px-4 py-6 sm:px-7">
        <header className="flex flex-wrap items-center justify-between gap-3">
          {!bot && (
            <div>
              <h1 className="text-2xl font-semibold tracking-tight">
                Agent skills
              </h1>
              <p className="mt-1 text-sm text-muted-foreground">
                Manage the instructions available to your Claude and Codex
                agents.
              </p>
            </div>
          )}
          {data?.can_edit && (
            <Button onClick={() => setEditor({ name: '', pkg: { files: {} } })}>
              <Plus aria-hidden />
              Add skill
            </Button>
          )}
        </header>
        <div className="flex flex-wrap items-end gap-3">
          <label className="min-w-40 flex-1 text-sm font-medium">
            Search skills
            <span className="mt-1 flex items-center gap-2 rounded-lg border bg-background px-3">
              <Search className="size-4 text-muted-foreground" aria-hidden />
              <input
                className="h-10 min-w-0 flex-1 bg-transparent"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Name or description"
              />
            </span>
          </label>
          {!bot && (
            <label className="min-w-40 text-sm font-medium">
              Grant scope
              <select
                className="mt-1 block h-10 w-full rounded-lg border bg-background px-2"
                aria-label="Grant scope"
                value={target}
                onChange={(e) => {
                  setError('')
                  setParams({ tab: 'skills', target: e.target.value })
                }}
              >
                {Array.from(options, ([value, label]) => (
                  <option key={value} value={value}>
                    {label}
                  </option>
                ))}
              </select>
            </label>
          )}
        </div>
        {data?.pending && (
          <div className="flex flex-wrap items-center gap-3 text-sm">
            Skill changes take effect at the next agent start.{' '}
            <RestartToApply name={target} />
          </div>
        )}
        {(error || query.isError) && (
          <p role="alert" className="text-sm text-destructive">
            {error || String(query.error)}
          </p>
        )}
        {query.isPending && <p role="status">Loading skills…</p>}
        {cards?.length === 0 && (
          <p className="rounded-xl border border-dashed p-8 text-center text-sm text-muted-foreground">
            {search ? 'No skills match your search.' : 'No skills installed.'}
          </p>
        )}
        <ul className="grid items-start gap-3 lg:grid-cols-2">
          {cards?.map((card) => {
            const own = data?.grants.find(
              ([name, scope]) => name === card.name && scope === target,
            )
            const source = data?.effective[card.name]
            return (
              <li
                key={card.name}
                className="flex flex-col gap-3 rounded-xl border bg-card p-4"
              >
                <div className="flex items-start gap-3">
                  <BookOpen
                    aria-hidden
                    className="mt-0.5 size-5 shrink-0 text-muted-foreground"
                  />
                  <div>
                    <h2 className="break-all font-semibold">{card.name}</h2>
                    <p className="mt-1 whitespace-pre-wrap break-words text-sm text-muted-foreground">
                      {card.description}
                    </p>
                  </div>
                </div>
                <p className="text-xs text-muted-foreground">
                  {source
                    ? 'Granted via ' +
                      (options.get(source) ??
                        (source === '*' ? 'All agents' : source))
                    : own
                      ? 'Grant disabled'
                      : 'Available to grant'}
                </p>
                <div className="flex flex-wrap gap-2">
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={busy}
                    onClick={() =>
                      void act(() =>
                        skillLibrary.grant(card.name, target, !own?.[2]),
                      )
                    }
                  >
                    {own
                      ? own[2]
                        ? 'Disable grant'
                        : 'Enable grant'
                      : 'Grant'}
                  </Button>
                  {own && (
                    <Button
                      size="sm"
                      variant="ghost"
                      disabled={busy}
                      onClick={() =>
                        void act(() => skillLibrary.revoke(card.name, target))
                      }
                    >
                      Revoke
                    </Button>
                  )}
                  {data?.can_edit && (
                    <>
                      <Button
                        size="sm"
                        variant="ghost"
                        disabled={busy}
                        onClick={() =>
                          void act(async () =>
                            setEditor({
                              name: card.name,
                              pkg: await skillLibrary.get(card.name),
                            }),
                          )
                        }
                      >
                        Edit files
                      </Button>
                      <Button
                        size="sm"
                        variant="ghost"
                        disabled={busy}
                        onClick={() => {
                          if (
                            window.confirm(
                              'Uninstall ' +
                                card.name +
                                ' and revoke all its grants?',
                            )
                          )
                            void act(() => skillLibrary.remove(card))
                        }}
                      >
                        Uninstall
                      </Button>
                    </>
                  )}
                </div>
              </li>
            )
          })}
        </ul>
      </div>
      {editor && (
        <SkillEditor
          target={target}
          scopes={options}
          id={editor.name}
          initial={editor.pkg}
          close={() => setEditor(null)}
          saved={() => {
            setEditor(null)
            void refresh()
          }}
        />
      )}
    </main>
  )
}
