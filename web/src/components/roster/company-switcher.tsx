/**
 * `<CompanySwitcher>` — the overview header's company scope selector (Bot Mode,
 * migration 0030). A compact dropdown: "All companies" + each live company, plus
 * a "New company…" action that opens a small create dialog. Selecting a company
 * sets `activeCompany` in the UI store, which scopes the whole app (roster, team
 * cards, the new-agent default) — see `routes/overview.tsx`.
 *
 * Visual language matches `<DisplayControls>`: a ghost `<Button>` trigger in a
 * `<Popover>`, a check-marked option list. "All companies" is the omniscient
 * default; a main/PA bot (`company_id == null`) shows in it and only it.
 *
 * The create dialog is LAZY-loaded (radix Dialog stays out of the overview's
 * eager chunk until "New company…" is clicked — size-budget gate).
 */
import * as React from 'react'
import { Check, Plus } from 'lucide-react'

import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { useCompanies } from '@/hooks/use-companies'
import { useUI } from '@/stores/ui-store'

const CreateCompanyDialog = React.lazy(() => import('./create-company-dialog'))

export function CompanySwitcher() {
  const { companies } = useCompanies()
  const activeCompany = useUI((s) => s.activeCompany)
  const setActiveCompany = useUI((s) => s.setActiveCompany)
  const [open, setOpen] = React.useState(false)
  const [createOpen, setCreateOpen] = React.useState(false)

  const active = companies.find((c) => c.id === activeCompany) ?? null
  const label = active ? active.display_name : 'All companies'

  return (
    <>
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <Button
            variant="outline"
            size="sm"
            role="combobox"
            aria-expanded={open}
            aria-label="Company scope"
            className="h-9 min-w-[9rem] max-w-[14rem] justify-between gap-2 font-normal"
          >
            <span className="truncate">{label}</span>
            {/* Inline caret (no lucide import — keeps the eager overview chunk
                under the hero-path size gate). */}
            <svg
              viewBox="0 0 16 16"
              className="size-4 shrink-0 text-muted-foreground"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.5"
              strokeLinecap="round"
              strokeLinejoin="round"
              aria-hidden
            >
              <path d="M5 6.5 8 3.5l3 3M5 9.5l3 3 3-3" />
            </svg>
          </Button>
        </PopoverTrigger>
        <PopoverContent align="start" className="w-56 p-1">
          <ul className="max-h-72 overflow-y-auto" role="listbox" aria-label="Companies">
            <OptionRow
              label="All companies"
              selected={activeCompany === null}
              onSelect={() => {
                setActiveCompany(null)
                setOpen(false)
              }}
            />
            {companies.map((c) => (
              <OptionRow
                key={c.id}
                label={c.display_name}
                selected={activeCompany === c.id}
                onSelect={() => {
                  setActiveCompany(c.id)
                  setOpen(false)
                }}
              />
            ))}
          </ul>
          <div className="mt-1 border-t border-border pt-1">
            <button
              type="button"
              onClick={() => {
                setOpen(false)
                setCreateOpen(true)
              }}
              className="flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-sm text-muted-foreground hover:bg-accent hover:text-accent-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              <Plus className="size-4" aria-hidden />
              New company…
            </button>
          </div>
        </PopoverContent>
      </Popover>

      {createOpen && (
        <React.Suspense fallback={null}>
          <CreateCompanyDialog
            open={createOpen}
            onOpenChange={setCreateOpen}
            onCreated={(id) => {
              setActiveCompany(id)
              setCreateOpen(false)
            }}
          />
        </React.Suspense>
      )}
    </>
  )
}

function OptionRow({
  label,
  selected,
  onSelect,
}: {
  label: string
  selected: boolean
  onSelect: () => void
}) {
  return (
    <li>
      <button
        type="button"
        role="option"
        aria-selected={selected}
        onClick={onSelect}
        className={cn(
          'flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-left text-sm hover:bg-accent hover:text-accent-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
          selected && 'font-medium',
        )}
      >
        <Check className={cn('size-4 shrink-0', selected ? 'opacity-100' : 'opacity-0')} aria-hidden />
        <span className="truncate">{label}</span>
      </button>
    </li>
  )
}
