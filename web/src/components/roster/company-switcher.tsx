/**
 * `<CompanySwitcher>` — the HQ/company scope selector, grok-native (Companies,
 * Bot Mode). It lives leftmost in `.gr-head`, right after the `.gr-brand`
 * wordmark: a scope reads as "above" the sort/density/search controls, and the
 * TRIGGER *is* the always-visible identity chip (Slack/Notion pattern — the
 * active tenant is never hidden behind a click).
 *
 * Selecting a row writes `activeCompany` in the UI store, which scopes the whole
 * roster (see `grok-roster.tsx`). `null` = HQ, the main/PA space that shows only
 * `company_id`-null bots; a number scopes to that company. There is NO mixed
 * "All" view.
 *
 * GROK-NATIVE, not shadcn. The popover is the raw-Tailwind anchored menu the
 * roster already uses for its team-overflow menu (`role=menu absolute z-30
 * rounded-xl border bg-popover shadow-lg`), so it costs the CSS budget nothing;
 * the trigger is a `.gr-search`/`.gr-seg`-family hairline chip; the create flow
 * is a `<ResponsiveSheet>` (lazy). No shadcn Popover/Dialog anywhere here.
 *
 * Keyboard: ⌘/Ctrl+⇧+O opens (footer hint); ⌘/Ctrl+1..9 jump to the Nth company;
 * ↑/↓ move a roving highlight, Enter activates, Escape closes and returns focus
 * to the trigger (the combobox pattern).
 */
import * as React from 'react'
import { Check, ChevronsUpDown, Plus } from 'lucide-react'

import { useCompanies } from '@/hooks/use-companies'
import { useUI } from '@/stores/ui-store'
import { companyForDigit } from '@/lib/companies'
import { CompanyMark } from '@/components/roster/company-mark'

const CreateCompanySheet = React.lazy(() =>
  import('@/components/roster/create-company-sheet').then((m) => ({
    default: m.CreateCompanySheet,
  })),
)

/** Whether a keyboard event is the ⌘/Ctrl modifier (mac vs the rest). */
function isCmdOrCtrl(e: KeyboardEvent | React.KeyboardEvent): boolean {
  return e.metaKey || e.ctrlKey
}

export function CompanySwitcher() {
  const { companies } = useCompanies()
  const activeCompany = useUI((s) => s.activeCompany)
  const setActiveCompany = useUI((s) => s.setActiveCompany)

  const [open, setOpen] = React.useState(false)
  const [createOpen, setCreateOpen] = React.useState(false)
  // The roving highlight index into the flat option list (0 = HQ, then each
  // company, then the New-company action last). −1 = nothing highlighted yet.
  const [cursor, setCursor] = React.useState(-1)

  const triggerRef = React.useRef<HTMLButtonElement>(null)
  const menuRef = React.useRef<HTMLDivElement>(null)

  const active = companies.find((c) => c.id === activeCompany) ?? null

  // The flat option order the arrow keys walk: HQ, companies…, New company.
  const optionCount = 1 + companies.length + 1
  const newCompanyIndex = optionCount - 1

  const select = React.useCallback(
    (id: number | null) => {
      setActiveCompany(id)
      setOpen(false)
    },
    [setActiveCompany],
  )

  const activateIndex = React.useCallback(
    (i: number) => {
      if (i <= 0) {
        select(null) // HQ
      } else if (i === newCompanyIndex) {
        setOpen(false)
        setCreateOpen(true)
      } else {
        const c = companies[i - 1]
        if (c) select(c.id)
      }
    },
    [companies, newCompanyIndex, select],
  )

  // ── Global shortcuts: ⌘/Ctrl+⇧+O opens; ⌘/Ctrl+1..9 jumps to the Nth ─────────
  React.useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!isCmdOrCtrl(e)) return
      // Open — ⌘/Ctrl+Shift+O (KeyO is layout-stable).
      if (e.shiftKey && (e.code === 'KeyO' || e.key.toLowerCase() === 'o')) {
        e.preventDefault()
        setOpen((v) => !v)
        return
      }
      // Jump-to-Nth — ⌘/Ctrl+1..9, only without Shift (Shift+digit is a symbol).
      if (!e.shiftKey && !e.altKey && /^[1-9]$/.test(e.key)) {
        const c = companyForDigit(companies, Number(e.key))
        if (c) {
          e.preventDefault()
          setActiveCompany(c.id)
          setOpen(false)
        }
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [companies, setActiveCompany])

  // ── Dismiss on outside-click / Escape; focus returns to the trigger ──────────
  React.useEffect(() => {
    if (!open) return
    // Seat the highlight on the active row when the menu opens.
    setCursor(active ? companies.findIndex((c) => c.id === active.id) + 1 : 0)
    const onDoc = (e: MouseEvent) => {
      if (
        !menuRef.current?.contains(e.target as Node) &&
        !triggerRef.current?.contains(e.target as Node)
      ) {
        setOpen(false)
      }
    }
    document.addEventListener('mousedown', onDoc)
    return () => document.removeEventListener('mousedown', onDoc)
  }, [open, active, companies])

  const onMenuKey = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') {
      e.preventDefault()
      setOpen(false)
      triggerRef.current?.focus()
    } else if (e.key === 'ArrowDown') {
      e.preventDefault()
      setCursor((c) => Math.min(optionCount - 1, c + 1))
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      setCursor((c) => Math.max(0, c - 1))
    } else if (e.key === 'Home') {
      e.preventDefault()
      setCursor(0)
    } else if (e.key === 'End') {
      e.preventDefault()
      setCursor(optionCount - 1)
    } else if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault()
      activateIndex(cursor < 0 ? 0 : cursor)
    }
  }

  // Focus the menu when it opens so arrow keys land without a click.
  React.useEffect(() => {
    if (open) menuRef.current?.focus()
  }, [open])

  const label = active ? active.display_name : 'HQ'

  // Shared row idiom (copied from the team-overflow menu — grok's raw pattern).
  const rowCls =
    'flex w-full items-center gap-2.5 rounded-lg px-3 py-2 text-left text-[13px] transition-colors hover:bg-accent/50 focus-visible:outline-none'

  return (
    <>
      <div className="relative">
        <button
          ref={triggerRef}
          type="button"
          className="gr-company"
          role="combobox"
          aria-haspopup="menu"
          aria-expanded={open}
          aria-label="Company scope"
          onClick={() => setOpen((v) => !v)}
        >
          {active ? (
            <CompanyMark
              slug={active.slug}
              name={active.display_name}
              size={22}
              className="grok-identity"
            />
          ) : (
            <span className="gr-spark" aria-hidden />
          )}
          <span className="gr-company-lbl">{label}</span>
          <ChevronsUpDown size={15} className="gr-company-cv" aria-hidden />
        </button>

        {open && (
          <div
            ref={menuRef}
            role="menu"
            tabIndex={-1}
            aria-label="Companies"
            onKeyDown={onMenuKey}
            className="gr-cmenu absolute left-0 top-full z-30 mt-1.5 flex w-[300px] flex-col gap-0.5 rounded-xl border border-border bg-popover p-1.5 shadow-lg outline-none"
          >
            {/* HQ — pinned top, its own cell (the "above all companies" home). */}
            <button
              type="button"
              role="menuitemradio"
              aria-checked={activeCompany === null}
              data-hl={cursor === 0 || undefined}
              className={`${rowCls} ${cursor === 0 ? 'bg-accent/50' : ''}`}
              onMouseEnter={() => setCursor(0)}
              onClick={() => select(null)}
            >
              <span
                className="gr-spark"
                aria-hidden
                style={{ width: 24, height: 24, borderRadius: 10, flex: 'none' }}
              />
              <span className="flex min-w-0 flex-col">
                <span className="font-semibold text-foreground">HQ</span>
                <span className="text-[11.5px] text-muted-foreground">
                  PA · tech-admin · sees everything
                </span>
              </span>
              {activeCompany === null && (
                <Check
                  size={15}
                  className="ml-auto"
                  style={{ color: 'var(--sm-accent)' }}
                  aria-hidden
                />
              )}
            </button>

            <div className="my-1 h-px bg-border" role="separator" />

            {/* companies — CompanyMark + name + a faint id meta + active check */}
            {companies.map((c, i) => {
              const idx = i + 1
              const on = activeCompany === c.id
              return (
                <button
                  key={c.id}
                  type="button"
                  role="menuitemradio"
                  aria-checked={on}
                  data-hl={cursor === idx || undefined}
                  className={`${rowCls} ${cursor === idx ? 'bg-accent/50' : ''}`}
                  onMouseEnter={() => setCursor(idx)}
                  onClick={() => select(c.id)}
                >
                  <CompanyMark slug={c.slug} name={c.display_name} size={24} />
                  <span className="flex min-w-0 flex-col">
                    <span className="truncate font-semibold text-foreground">
                      {c.display_name}
                    </span>
                    <span className="truncate text-[12px] text-muted-foreground">
                      {c.slug}
                    </span>
                  </span>
                  <span className="ml-auto flex items-center gap-2">
                    {i < 9 && (
                      <kbd className="hidden text-[11px] tabular-nums text-muted-foreground sm:inline">
                        ⌘{i + 1}
                      </kbd>
                    )}
                    {on && (
                      <Check size={15} style={{ color: 'var(--sm-accent)' }} aria-hidden />
                    )}
                  </span>
                </button>
              )
            })}

            {companies.length > 0 && (
              <div className="my-1 h-px bg-border" role="separator" />
            )}

            {/* New company — always-pinned bottom action, lower emphasis */}
            <button
              type="button"
              role="menuitem"
              data-hl={cursor === newCompanyIndex || undefined}
              className={`${rowCls} text-muted-foreground ${
                cursor === newCompanyIndex ? 'bg-accent/50' : ''
              }`}
              onMouseEnter={() => setCursor(newCompanyIndex)}
              onClick={() => {
                setOpen(false)
                setCreateOpen(true)
              }}
            >
              <span className="grid size-6 place-items-center" aria-hidden>
                <Plus size={15} />
              </span>
              New company…
            </button>

            {/* footer — the open shortcut hint */}
            <div className="mt-0.5 flex items-center justify-end px-3 pb-0.5 pt-1 text-[11.5px] text-muted-foreground">
              <kbd className="tabular-nums">⌘⇧O</kbd>
              <span className="ml-1.5">to open</span>
            </div>
          </div>
        )}
      </div>

      {createOpen && (
        <React.Suspense fallback={null}>
          <CreateCompanySheet
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
