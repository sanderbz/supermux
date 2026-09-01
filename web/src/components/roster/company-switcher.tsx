/**
 * `<CompanySwitcher>` — the HQ/company scope selector, grok-native (Companies,
 * Bot Mode). It is the leftmost identity in `.gr-head` and IS the overview title
 * (the old `.gr-brand` "supermux" wordmark was dropped — the active scope name
 * leads instead): the TRIGGER is the always-visible identity chip (Slack/Notion
 * pattern — the active tenant is never hidden behind a click), showing the mark
 * (HQ = the real blue-S `<HqMark>`, a company = its `<CompanyMark>`) next to the
 * active scope's name.
 *
 * Selecting a row writes `activeCompany` in the UI store, which scopes the whole
 * roster (see `grok-roster.tsx`). `null` = HQ, the main/PA space that shows only
 * `company_id`-null bots; a number scopes to that company. There is NO mixed
 * "All" view.
 *
 * RESPONSIVE, one option list, two shells (mobile-first, DRY):
 *   • coarse pointer (touch / narrow) → the options render in the app's canonical
 *     `<ResponsiveSheet>` — the SAME Vaul drag-detent BOTTOM SHEET the create flow
 *     uses (`responsive-sheet.tsx`, forked on `(pointer: coarse)` via
 *     `use-media-query.ts`). Full-width minus inset, pinned to the bottom with
 *     safe-area padding and a grabber, scrollable, ≥44px rows — nothing can clip
 *     off the right edge the way a fixed-width anchored menu did on a phone.
 *   • fine pointer (mouse) → the compact anchored menu the roster already uses for
 *     its overflow menu (`role=menu rounded-xl border bg-popover shadow-lg`),
 *     PORTALLED to the grok shell root and placed `fixed` from the trigger's
 *     measured rect, VIEWPORT-SAFE: width capped to `min(300px, 100vw−24px)` and
 *     height to the space it has, so it can never overflow an edge — nor be
 *     clipped by the `overflow:hidden` nav rail it docks in. Keyboard nav lives
 *     here.
 *
 * The row markup is authored ONCE (`renderOptions`) and skinned per shell, so the
 * HQ cell, each company row, the "New company…" action and the footer hint are
 * byte-identical between the sheet and the menu.
 *
 * Keyboard (desktop): ⌘/Ctrl+⇧+O opens (footer hint); ⌘/Ctrl+1..9 jump to the Nth
 * company; ↑/↓ move a roving highlight, Enter activates, Escape closes and returns
 * focus to the trigger (the combobox pattern).
 *
 * The desktop menu is PORTALLED and viewport-fixed (`menuAnchor` below) — see the
 * WHY there: an `absolute` menu could never leave the nav rail it docks in.
 */
import * as React from 'react'
import { createPortal } from 'react-dom'
import { ChevronsUpDown, Globe, Plus, SlidersHorizontal, Trash2, UserPlus } from 'lucide-react'

import { useCompanies } from '@/hooks/use-companies'
import { useUI } from '@/stores/ui-store'
import { useViewer } from '@/stores/viewer-store'
import { companyForDigit } from '@/lib/companies'
import { anchoredMenuStyle } from '@/lib/anchored-menu'
import { useMediaQuery } from '@/hooks/use-media-query'
import { CompanyMark, HqMark } from '@/components/roster/company-mark'
import { CompanyPicker } from '@/components/roster/company-picker'
import { ResponsiveSheet } from '@/components/ui/responsive-sheet'

const CreateCompanySheet = React.lazy(() =>
  import('@/components/roster/create-company-sheet').then((m) => ({
    default: m.CreateCompanySheet,
  })),
)

// The onboarding wizard is lazy so none of its weight — or its DEV mock — lands
// on the cold-load hero path; the switcher trigger is the only entry graph edge.
const InviteWizardSheet = React.lazy(() =>
  import('@/components/companies/invite-wizard-sheet').then((m) => ({
    default: m.InviteWizardSheet,
  })),
)

// The destructive delete flow is lazy for the same reason — its type-to-confirm
// sheet and the `useSessions` bot-count it reads never touch the cold-load path;
// the danger row is the only entry edge, opened at most once per delete.
const DeleteCompanySheet = React.lazy(() =>
  import('@/components/roster/delete-company-sheet').then((m) => ({
    default: m.DeleteCompanySheet,
  })),
)
const CompanySettingsSheet = React.lazy(() =>
  import('@/components/roster/company-settings-sheet').then((m) => ({
    default: m.CompanySettingsSheet,
  })),
)

/** Whether a keyboard event is the ⌘/Ctrl modifier (mac vs the rest). */
function isCmdOrCtrl(e: KeyboardEvent | React.KeyboardEvent): boolean {
  return e.metaKey || e.ctrlKey
}

/** A stable empty attention set so the default prop is referentially constant. */
const EMPTY_ATTENTION: ReadonlySet<number | null> = new Set()

/** The ⌘⇧O open-shortcut hint, shared verbatim between the menu footer and the
 *  sheet footer slot so the two shells read identically. */
function OpenHint() {
  return (
    <div className="flex items-center justify-end text-[11.5px] text-muted-foreground">
      <kbd className="tabular-nums">⌘⇧O</kbd>
      <span className="ml-1.5">to open</span>
    </div>
  )
}

export function CompanySwitcher({
  /** The set of company ids (with `null` = HQ) that currently have at least one
   *  bot needing attention, from the roster's own needs-you rollup. A dot shows
   *  on each row in the set. Defaults to empty so a bench can render it bare. */
  attention = EMPTY_ATTENTION,
  /** Trigger shape. `'chip'` (default) is the labelled `.gr-company` pill.
   *  `'circle'` is the compact ringed scope MARK that docks in the nav (mobile
   *  bottom-bar right, desktop rail bottom — the WHOOP "profile in the corner"
   *  slot), so the scope leaves every page header. Both open the SAME picker. */
  variant = 'chip',
  /** Register the global ⌘⇧O / ⌘1-9 shortcuts. TRUE on exactly one mounted
   *  instance — otherwise every mounted switcher toggles its own picker open on
   *  ⌘⇧O (the mobile dock's bottom sheet is body-portaled, so a `display:none`
   *  wrapper would NOT hide it). The desktop rail owns the keyboard; the mobile
   *  dock passes `false`. */
  shortcuts = true,
}: {
  attention?: ReadonlySet<number | null>
  variant?: 'chip' | 'circle'
  shortcuts?: boolean
} = {}) {
  const { companies } = useCompanies()
  const activeCompany = useUI((s) => s.activeCompany)
  const setActiveCompany = useUI((s) => s.setActiveCompany)
  // OWNER BUG #4 — a scoped member has no scope to SWITCH. Their `/api/companies`
  // is fenced to exactly one row server-side, there is no HQ for them, and every
  // action this menu carries (invite a teammate, company settings, delete, start
  // a company) is owner/admin-only and 404s for them anyway. So they get the
  // identity, not the control: a static chip. Read here, above every other hook,
  // so hook order is identical on both branches.
  const isMember = useViewer((s) => s.viewer.kind === 'member')

  // Fork on input modality — the SAME `(pointer: coarse)` signal
  // `<ResponsiveSheet>` / the tile hover-fork use. Coarse → bottom sheet; fine →
  // the anchored menu (keyboard nav + roving highlight live here).
  const isMobile = useMediaQuery('(pointer: coarse)')

  const [open, setOpen] = React.useState(false)
  const [createOpen, setCreateOpen] = React.useState(false)
  // ONE wizard sheet, two doors: "Invite a teammate" opens it in `invite` mode
  // (which adapts — loader, then either the invite panel or the stepper), and
  // "External access…" opens the SAME sheet in `settings` mode, where the steps
  // are editable sections for changing the domain, the Google app or the agent
  // email later. `null` = closed.
  const [wizardMode, setWizardMode] = React.useState<'invite' | 'settings' | null>(null)
  const [deleteOpen, setDeleteOpen] = React.useState(false)
  const [settingsOpen, setSettingsOpen] = React.useState(false)
  // The roving highlight index into the flat option list (0 = HQ, then each
  // company, then the New-company action last). −1 = nothing highlighted yet.
  // Only used by the desktop menu; the touch sheet ignores it.
  const [cursor, setCursor] = React.useState(-1)
  // The trigger's viewport rect + the node the menu portals into, both captured
  // from the OPEN event (and re-captured on resize/scroll while open) — never
  // read off the ref during render, which `react-hooks/refs` rightly forbids.
  // They drive the desktop menu's FIXED placement; see the WHY on `menuStyle`.
  const [anchor, setAnchor] = React.useState<DOMRect | null>(null)
  const [portalHost, setPortalHost] = React.useState<HTMLElement | null>(null)

  const triggerRef = React.useRef<HTMLButtonElement>(null)
  const menuRef = React.useRef<HTMLDivElement>(null)
  // Stable id so the combobox trigger can `aria-controls` its popup (required for
  // role="combobox"); the menu it names is rendered only while open, which is a
  // valid controls target.
  const menuId = React.useId()

  const active = companies.find((c) => c.id === activeCompany) ?? null

  // The flat option order the arrow keys walk: HQ, companies…, New company.
  const optionCount = 1 + companies.length + 1
  const newCompanyIndex = optionCount - 1

  // Measure the trigger and pick the portal host in one go. The host is the grok
  // SHELL ROOT, not `<body>`: the menu's own `.gr-cmenu` rules (and everything
  // else it inherits) are `[data-grok]`-scoped, so portalling past that marker
  // would strip the skin off the menu.
  const measureFrom = React.useCallback((el: HTMLElement | null) => {
    setAnchor(el ? el.getBoundingClientRect() : null)
    setPortalHost(
      el ? ((el.closest('[data-grok-root]') as HTMLElement | null) ?? document.body) : null,
    )
  }, [])

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
    // `!isMember`: a member has exactly one scope, the setters are sealed by the
    // member lock, and ⌘1 means "go to HQ" — so the whole shortcut set is a
    // no-op that would still swallow the browser's own ⌘1..9. Don't register it.
    if (!shortcuts || isMember) return
    const onKey = (e: KeyboardEvent) => {
      if (!isCmdOrCtrl(e)) return
      // Open — ⌘/Ctrl+Shift+O (KeyO is layout-stable).
      if (e.shiftKey && (e.code === 'KeyO' || e.key.toLowerCase() === 'o')) {
        e.preventDefault()
        // The keyboard opens the menu too, so it must anchor it as well.
        measureFrom(triggerRef.current)
        setOpen((v) => !v)
        return
      }
      // Jump-to-Nth — ⌘/Ctrl+1..9, only without Shift (Shift+digit is a symbol).
      // ⌘1 is ALWAYS HQ (so HQ has a shortcut of its own); companies start at ⌘2,
      // so ⌘2 → the first company, ⌘3 → the second, and so on.
      if (!e.shiftKey && !e.altKey && /^[1-9]$/.test(e.key)) {
        const digit = Number(e.key)
        if (digit === 1) {
          e.preventDefault()
          setActiveCompany(null)
          setOpen(false)
          return
        }
        const c = companyForDigit(companies, digit - 1)
        if (c) {
          e.preventDefault()
          setActiveCompany(c.id)
          setOpen(false)
        }
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [companies, isMember, measureFrom, setActiveCompany, shortcuts])

  // Seat the highlight on the active row whenever the list opens (both shells).
  // Done on the open TRANSITION during render (the "adjust state when a prop
  // changes" pattern) rather than in an effect — so it never re-seats mid-nav
  // when the company list changes under an open menu, and never trips
  // react-hooks/set-state-in-effect.
  const [seatedOpen, setSeatedOpen] = React.useState(open)
  if (open !== seatedOpen) {
    setSeatedOpen(open)
    if (open) {
      setCursor(active ? companies.findIndex((c) => c.id === active.id) + 1 : 0)
    }
  }

  // Keep the fixed menu glued to its trigger while it is open — the window can
  // resize and an ancestor can scroll under it. Only listeners here (no setState
  // in the effect body), so the measurement stays a real event response.
  React.useEffect(() => {
    if (!open || isMobile) return
    const remeasure = () => measureFrom(triggerRef.current)
    window.addEventListener('resize', remeasure)
    window.addEventListener('scroll', remeasure, true)
    return () => {
      window.removeEventListener('resize', remeasure)
      window.removeEventListener('scroll', remeasure, true)
    }
  }, [open, isMobile, measureFrom])

  // ── Desktop only: dismiss on outside-click, focus the menu on open ───────────
  // The touch sheet is a Vaul modal — it owns its own backdrop-tap / drag-away
  // dismiss, and a document mousedown listener here would fight it (the sheet is
  // body-portaled, so a tap inside it is "outside" the trigger and would close
  // it instantly). So this only runs for the anchored menu.
  React.useEffect(() => {
    if (!open || isMobile) return
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
  }, [open, isMobile])

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

  // Focus the menu when it opens so arrow keys land without a click (desktop).
  React.useEffect(() => {
    if (open && !isMobile) menuRef.current?.focus()
  }, [open, isMobile])

  const label = active ? active.display_name : 'HQ'

  // ── One option list, skinned per shell ──────────────────────────────────────
  // `menu` = the compact desktop rows (13px, hover highlight, ⌘N hints, roving
  // cursor). `sheet` = the touch rows (≥44px tap target, 15px, tap-feedback, no
  // keyboard affordances). Authored once so the two shells never drift.
  const renderOptions = (variant: 'menu' | 'sheet') => {
    const sheet = variant === 'sheet'
    const rowBase =
      'flex w-full items-center rounded-lg text-left transition-colors focus-visible:outline-none'
    const rowSkin = sheet
      ? 'min-h-[44px] gap-3 px-3.5 py-2.5 text-[15px] active:bg-accent/60'
      : 'gap-2.5 px-3 py-2 text-[13px] hover:bg-accent/50'
    const hl = (on: boolean) => (!sheet && on ? 'bg-accent/50' : '')
    const markSize = sheet ? 28 : 24

    return (
      <>
        {/* HQ row + company rows + marks — the shared `<CompanyPicker>` list.
            The switcher keeps its roving cursor, ⌘1..9 hints, attention dots and
            the active check by feeding them in; the move sheet reuses the SAME
            list without any of that. */}
        <CompanyPicker
          variant={variant}
          companies={companies}
          onPick={select}
          activeId={activeCompany}
          attention={attention}
          cursor={cursor}
          onCursor={setCursor}
          showShortcutHints
        />

        {companies.length > 0 && (
          <div className="my-1 h-px bg-border" role="separator" />
        )}

        {/* Invite to the ACTIVE company — the onboarding-wizard entry point
            (owner dashboard only; the endpoints are owner/admin-only). Shown only
            when a company is in scope, since it invites into THAT company. */}
        {active && (
          <button
            type="button"
            role="menuitem"
            className={`${rowBase} ${rowSkin} text-foreground`}
            onMouseEnter={() => !sheet && setCursor(-1)}
            onClick={() => {
              setOpen(false)
              setWizardMode('invite')
            }}
          >
            <span
              className="grid place-items-center"
              aria-hidden
              style={{ width: markSize, height: markSize, flex: 'none' }}
            >
              <UserPlus size={sheet ? 18 : 15} />
            </span>
            Invite a teammate
          </button>
        )}

        {/* New company — always-pinned bottom action, lower emphasis */}
        <button
          type="button"
          role="menuitem"
          data-hl={cursor === newCompanyIndex || undefined}
          className={`${rowBase} ${rowSkin} text-muted-foreground ${hl(
            cursor === newCompanyIndex,
          )}`}
          onMouseEnter={() => !sheet && setCursor(newCompanyIndex)}
          onClick={() => {
            setOpen(false)
            setCreateOpen(true)
          }}
        >
          <span
            className="grid place-items-center"
            aria-hidden
            style={{ width: markSize, height: markSize, flex: 'none' }}
          >
            <Plus size={sheet ? 18 : 15} />
          </span>
          Start a company…
        </button>

        {/* Delete the ACTIVE company — a LOW-emphasis danger action (destructive
            ink on a plain row, never a filled button), separated from the safe
            actions and pinned last. Owner/admin-only server-side; a scoped
            member gets the hide-existence 404, so this row never fires for them.
            Shown only when a company is in scope, since it deletes THAT company.
            Tapping only OPENS the type-to-confirm sheet — the destroy itself is
            gated behind typing the company name. */}
        {active && (
          <>
            <div className="my-1 h-px bg-border" role="separator" />
            {/* Company settings — logo, name, accent, and (later) the shared
                brief. A safe action, so it sits above the delete danger zone. */}
            <button
              type="button"
              role="menuitem"
              className={`${rowBase} ${rowSkin}`}
              onMouseEnter={() => !sheet && setCursor(-1)}
              onClick={() => {
                setOpen(false)
                setSettingsOpen(true)
              }}
            >
              <span
                className="grid place-items-center"
                aria-hidden
                style={{ width: markSize, height: markSize, flex: 'none' }}
              >
                <SlidersHorizontal size={sheet ? 18 : 15} />
              </span>
              Company settings…
            </button>
            {/* External access — the domain, the Google login and the agent email,
                AFTER they are set up. The invite row used to be the only way back
                into the wizard, which meant an owner with a finished setup had to
                walk an onboarding stepper to change a subdomain. */}
            <button
              type="button"
              role="menuitem"
              data-vr="external-access-entry"
              className={`${rowBase} ${rowSkin}`}
              onMouseEnter={() => !sheet && setCursor(-1)}
              onClick={() => {
                setOpen(false)
                setWizardMode('settings')
              }}
            >
              <span
                className="grid place-items-center"
                aria-hidden
                style={{ width: markSize, height: markSize, flex: 'none' }}
              >
                <Globe size={sheet ? 18 : 15} />
              </span>
              External access…
            </button>
            <button
              type="button"
              role="menuitem"
              className={`${rowBase} ${rowSkin} text-destructive hover:bg-destructive/10 active:bg-destructive/10`}
              onMouseEnter={() => !sheet && setCursor(-1)}
              onClick={() => {
                setOpen(false)
                setDeleteOpen(true)
              }}
            >
              <span
                className="grid place-items-center"
                aria-hidden
                style={{ width: markSize, height: markSize, flex: 'none' }}
              >
                <Trash2 size={sheet ? 18 : 15} />
              </span>
              Delete this company…
            </button>
          </>
        )}
      </>
    )
  }

  // ── Desktop placement: PORTALLED, and FIXED to the trigger's viewport rect ──
  // WHY (owner bug, shipped in v0.6.0 when the scope circle moved into the nav):
  // the desktop rail this circle docks in is `overflow: hidden` at ≥768px — the
  // floating window's rounded left corners, `[data-grok] [data-shell-rail]` in
  // grok-mode.css — AND it carries `z-index: 1`, the SAME layer as the content
  // column, which is later in the DOM. So the old `absolute … left-full z-30`
  // menu was doubly doomed: clipped away by the 64px rail box, and painted under
  // the roster even where it survived. It opened correctly (aria-expanded
  // flipped, all rows rendered, hit-testing landed on a roster row) but nothing
  // was ever visible — the desktop company switcher read as dead. An anchored
  // menu can only escape a clipping, same-layer ancestor by leaving it, so it
  // portals to the grok shell root (which keeps the `[data-grok]` style scoping
  // the menu's own `.gr-cmenu` rules need) and is placed from the measured rect.
  //
  // Width keeps the old collision-safe cap `min(300px, 100vw−24px)`; the added
  // max-height keeps a long company list inside the viewport instead of running
  // off the top edge, since the circle's menu opens UPWARD. The math itself is
  // pure and pinned in `lib/anchored-menu.ts`.
  const menuStyle = React.useMemo<React.CSSProperties | null>(() => {
    const box = anchoredMenuStyle(
      anchor,
      { width: window.innerWidth, height: window.innerHeight },
      // The circle docks at the rail's bottom-left, so it opens up-and-right;
      // the chip keeps the classic drop under itself.
      { side: variant === 'circle' ? 'side' : 'below', gap: variant === 'circle' ? 8 : 6 },
    )
    if (!box) return null
    return {
      ...box,
      overflowY: 'auto',
      // The pop grows from the corner it hinges on (the `.gr-cmenu` default is
      // `top left`, which is the chip's hinge, not the upward circle's).
      transformOrigin: variant === 'circle' ? 'bottom left' : 'top left',
    }
  }, [anchor, variant])

  const desktopMenu =
    open && !isMobile && menuStyle ? (
      <div
        ref={menuRef}
        id={menuId}
        role="menu"
        tabIndex={-1}
        aria-label="Companies"
        onKeyDown={onMenuKey}
        style={menuStyle}
        className="gr-cmenu fixed z-[70] flex flex-col gap-0.5 rounded-xl border border-border bg-popover p-1.5 shadow-lg outline-none"
      >
        {renderOptions('menu')}

        {/* footer — the open shortcut hint */}
        <div className="mt-0.5 px-3 pb-0.5 pt-1">
          <OpenHint />
        </div>
      </div>
    ) : null

  // ── THE MEMBER CHIP (owner bug #4) ─────────────────────────────────────────
  // Identity without control: the same mark + name the trigger shows, in a
  // non-interactive element. No menu, no HQ row, no "Start a company…", no
  // invite / settings / delete. Placed AFTER every hook above so the hook order
  // is byte-identical on both branches (rules-of-hooks), and it reuses the exact
  // `.gr-scope-circle` / `.gr-company` classes so the skin needs no new rules —
  // the `:active`/`:hover` affordances simply never fire on a span.
  if (isMember) {
    // NEVER the `label` fallback: that is the string "HQ", the one scope a
    // member must never be shown. Until their (single, fenced) company row
    // arrives, the chip is the same empty ringed circle the lazy trigger holds
    // the slot with.
    const memberLabel = active?.display_name ?? ''
    const mark = active ? (
      <CompanyMark
        slug={active.slug}
        name={active.display_name}
        size={variant === 'circle' ? 26 : 22}
        className="grok-identity"
        logo={active}
      />
    ) : null
    return variant === 'circle' ? (
      <span
        className="gr-scope-circle"
        data-static=""
        aria-label={memberLabel ? `Company: ${memberLabel}` : undefined}
        title={memberLabel || undefined}
      >
        {mark}
      </span>
    ) : (
      <span
        className="gr-company"
        data-static=""
        aria-label={memberLabel ? `Company: ${memberLabel}` : undefined}
      >
        {mark}
        <span className="gr-company-lbl">{memberLabel}</span>
      </span>
    )
  }

  return (
    <>
      <div className="relative">
        {variant === 'circle' ? (
          <button
            ref={triggerRef}
            type="button"
            className="gr-scope-circle"
            role="combobox"
            aria-haspopup="menu"
            aria-expanded={open}
            aria-controls={menuId}
            aria-label={`Company scope: ${label}`}
            title={`Scope — ${label}`}
            onClick={(e) => {
              measureFrom(e.currentTarget)
              setOpen((v) => !v)
            }}
          >
            {active ? (
              <CompanyMark
                slug={active.slug}
                name={active.display_name}
                size={26}
                className="grok-identity"
                logo={active}
              />
            ) : (
              <HqMark size={26} />
            )}
          </button>
        ) : (
          <button
            ref={triggerRef}
            type="button"
            className="gr-company"
            role="combobox"
            aria-haspopup="menu"
            aria-expanded={open}
            aria-controls={menuId}
            aria-label="Company scope"
            onClick={(e) => {
              measureFrom(e.currentTarget)
              setOpen((v) => !v)
            }}
          >
            {active ? (
              <CompanyMark
                slug={active.slug}
                name={active.display_name}
                size={22}
                className="grok-identity"
                logo={active}
              />
            ) : (
              <HqMark size={22} />
            )}
            <span className="gr-company-lbl">{label}</span>
            <ChevronsUpDown size={15} className="gr-company-cv" aria-hidden />
          </button>
        )}

        {/* DESKTOP (fine pointer): the compact anchored menu, PORTALLED out of the
            nav and viewport-FIXED. The `circle` trigger docks at the rail's
            BOTTOM-LEFT, so its menu opens UP-and-RIGHT (bottom-aligned, to the
            side) instead of downward off the screen edge; the chip keeps the
            under-the-trigger drop. */}
        {desktopMenu && portalHost && createPortal(desktopMenu, portalHost)}
      </div>

      {/* MOBILE (coarse pointer): the SAME `<ResponsiveSheet>` bottom sheet the
          create flow uses — full width, grabber, safe-area padding, scrollable,
          every row fully visible. No hand-rolled drawer. */}
      {isMobile && (
        <ResponsiveSheet
          open={open}
          onOpenChange={setOpen}
          title="Companies"
          description="Switch which org the roster is scoped to"
          footer={<OpenHint />}
        >
          <div
            role="menu"
            aria-label="Companies"
            className="flex flex-col gap-0.5 px-2 py-2"
          >
            {renderOptions('sheet')}
          </div>
        </ResponsiveSheet>
      )}

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

      {wizardMode && active && (
        <React.Suspense fallback={null}>
          <InviteWizardSheet
            open
            mode={wizardMode}
            onOpenChange={(v) => !v && setWizardMode(null)}
            company={{ id: active.id, slug: active.slug, display_name: active.display_name }}
          />
        </React.Suspense>
      )}

      {deleteOpen && active && (
        <React.Suspense fallback={null}>
          <DeleteCompanySheet
            open={deleteOpen}
            onOpenChange={setDeleteOpen}
            company={{ id: active.id, slug: active.slug, display_name: active.display_name }}
            onDeleted={() => {
              // The row is gone — leave its now-dead scope for HQ immediately
              // (a lingering id would fail open to HQ on the next refetch anyway;
              // this makes the switch instant). The sheet decides whether to
              // then close itself or hold open on its honest warnings view.
              setActiveCompany(null)
            }}
          />
        </React.Suspense>
      )}

      {settingsOpen && active && (
        <React.Suspense fallback={null}>
          <CompanySettingsSheet open={settingsOpen} onOpenChange={setSettingsOpen} company={active} />
        </React.Suspense>
      )}
    </>
  )
}

/**
 * `<ScopeTitle>` — the READ-ONLY scope identity for a page header (the overview
 * leads with it). It shows the active scope's mark + name exactly as the switcher
 * chip did, but it is NOT a control: switching now lives in the nav scope circle
 * (`<CompanySwitcher variant="circle">`), so the page just REFLECTS the active
 * scope while the nav OWNS the switch. Presentational — no picker, no state.
 */
export function ScopeTitle() {
  const { companies } = useCompanies()
  const activeCompany = useUI((s) => s.activeCompany)
  const isMember = useViewer((s) => s.viewer.kind === 'member')
  const active = companies.find((c) => c.id === activeCompany) ?? null
  // A member has no HQ. Until their (single, fenced) company row lands, the
  // title is empty rather than the one scope name they must never be shown —
  // the roster header is on screen from the first frame, so the fallback string
  // is not a detail.
  const hq = !active && !isMember
  return (
    <span className="gr-scope-title">
      {active ? (
        <CompanyMark
          slug={active.slug}
          name={active.display_name}
          size={24}
          className="grok-identity"
          logo={active}
        />
      ) : hq ? (
        <HqMark size={24} />
      ) : null}
      <span className="gr-scope-title-lbl">
        {active ? active.display_name : hq ? 'HQ' : ''}
      </span>
    </span>
  )
}
