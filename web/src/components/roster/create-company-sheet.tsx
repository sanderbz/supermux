/**
 * `<CreateCompanySheet>` — the "New company…" create flow, grok-native
 * (Companies, Bot Mode). Uses the app's canonical detail shell `<ResponsiveSheet>`
 * (Vaul drag-detent bottom-sheet on coarse pointers · shadcn `side="right"` on
 * desktop) rather than a bare centered Dialog, so create feels like part of one
 * system with the other companies panels.
 *
 * One primary Name field with a LIVE `<CompanyMark>` preview to its left that
 * recolours on the first keystroke — because the hue is `characterFromSeed(slug)`
 * the founder watches their company's pigment resolve as they type (the mark
 * carries `grok-identity`, so the hue *settles* over 0.6s rather than flickering
 * per keystroke). Name → slug → folder are derived live and shown mono below;
 * a 409 shows the "id is taken" message inline. On success: close,
 * `setActiveCompany(newId)`, and the roster re-deals into the fresh company.
 *
 * Copy + the slug/folder derivation are verbatim from the shipped shadcn dialog
 * (`toCompanySlug` / `deriveRootDir` / the 409 line) — a pure presentation lift.
 */
import * as React from 'react'

import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { ResponsiveSheet } from '@/components/ui/responsive-sheet'
import { useCreateCompany } from '@/hooks/use-companies'
import { SessionError } from '@/lib/api'
import { homeDir, projectsDir } from '@/env'
import { CompanyMark } from '@/components/roster/company-mark'

/** Company slug rule mirrors the server (`server/src/companies/mod.rs`:
 *  `[A-Za-z0-9._-]{1,64}`). */
export function toCompanySlug(raw: string): string {
  return raw
    .trim()
    .toLowerCase()
    .replace(/\s+/g, '-')
    .replace(/[^a-z0-9._-]/g, '')
    .slice(0, 64)
}

/** PREVIEW of where a new company's folder lands:
 *  `<projects root or $HOME>/companies/<slug>`. This mirrors what the SERVER
 *  now derives authoritatively (`server/src/companies/mod.rs` → `companies_root()`
 *  = `<projects_root>/companies`, joined with the slug). The client value is only
 *  a hint — the server ignores any supplied `root_dir` and derives its own — so
 *  the success state reads the RETURNED `company.root_dir`, not this preview. */
export function deriveRootDir(slug: string): string {
  const root = (projectsDir() || homeDir()).replace(/\/+$/, '')
  return root ? `${root}/companies/${slug}` : ''
}

export function CreateCompanySheet({
  open,
  onOpenChange,
  onCreated,
}: {
  open: boolean
  onOpenChange: (v: boolean) => void
  onCreated: (id: number) => void
}) {
  const [name, setName] = React.useState('')
  const [error, setError] = React.useState<string | null>(null)
  const create = useCreateCompany()

  const slug = toCompanySlug(name)
  const rootDir = slug ? deriveRootDir(slug) : ''
  const canSubmit = slug.length > 0 && rootDir.length > 0 && !create.isPending

  // Reset the field each time the sheet opens fresh. Done on the open TRANSITION
  // during render (the "adjust state when a prop changes" pattern) rather than in
  // an effect — same result, one fewer commit, and no react-hooks/set-state-in-effect.
  const [wasOpen, setWasOpen] = React.useState(open)
  if (open !== wasOpen) {
    setWasOpen(open)
    if (open) {
      setName('')
      setError(null)
    }
  }

  const submit = async (e?: React.FormEvent) => {
    e?.preventDefault()
    if (!canSubmit) return
    setError(null)
    try {
      const company = await create.mutateAsync({
        slug,
        display_name: name.trim(),
        root_dir: rootDir,
      })
      onCreated(company.id)
    } catch (err) {
      if (err instanceof SessionError && err.status === 409) {
        setError(`The id “${slug}” is taken — pick another name.`)
      } else if (err instanceof SessionError && err.status === 0) {
        setError('Can’t reach supermux-server. Check it’s running, then try again.')
      } else {
        setError(err instanceof Error ? err.message : 'Could not create the company.')
      }
    }
  }

  // The preview seed: the live slug (identity hue source) with a stable fallback
  // so an empty field still shows a neutral placeholder tile, not a broken one.
  const previewSlug = slug || 'new'
  const previewName = name.trim() || 'New'

  return (
    <ResponsiveSheet
      open={open}
      onOpenChange={onOpenChange}
      title="Start a company"
      description="A shared space for a team of teammates."
      footer={
        <div className="flex items-center justify-end gap-2">
          <Button
            type="button"
            variant="ghost"
            onClick={() => onOpenChange(false)}
            disabled={create.isPending}
          >
            Cancel
          </Button>
          <Button
            type="submit"
            form="create-company-form"
            disabled={!canSubmit}
            style={{
              // Fallbacks: the sheet portals to `document.body` outside
              // `[data-grok]`, where a bare `var(--sm-accent-fill)` resolves to
              // nothing and the primary CTA loses its accent fill.
              background: 'var(--sm-accent-fill, #006ceb)',
              color: 'var(--gr-onaccent, #fff)',
            }}
          >
            {create.isPending ? 'Starting…' : 'Start company'}
          </Button>
        </div>
      }
    >
      <form id="create-company-form" onSubmit={submit} className="px-5 py-5">
        <div className="flex items-start gap-3">
          {/* Live identity preview — recolours on the first keystroke, settling
              over `grok-identity` (0.6s). */}
          <CompanyMark
            slug={previewSlug}
            name={previewName}
            size={44}
            className="grok-identity mt-6"
          />
          <div className="min-w-0 flex-1 space-y-1.5">
            <label
              htmlFor="company-name"
              className="text-sm font-medium text-foreground"
            >
              Name
            </label>
            <Input
              id="company-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Acme"
              autoComplete="off"
            />
            {/* NO autoFocus — same iOS-PWA Vaul "keyboard-during-slide-in →
                half-cropped sheet" race the hire sheet's goal field dodges; users
                tap to focus. And NO folder-path leak — the server derives the dir
                authoritatively (the client `root_dir` is ignored), so the absolute
                path is both nerdy and possibly wrong. A faint `id <slug>` is all
                the founder needs. */}
            {slug && (
              <p className="pt-1 text-xs text-muted-foreground">
                id <span className="font-mono text-foreground">{slug}</span>
              </p>
            )}
            {error && <p className="pt-1 text-sm text-destructive">{error}</p>}
          </div>
        </div>
      </form>
    </ResponsiveSheet>
  )
}

export default CreateCompanySheet
