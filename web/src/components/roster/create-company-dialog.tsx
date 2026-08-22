/**
 * The "New company…" create dialog (Bot Mode, migration 0030). Split into its
 * own module and LAZY-loaded by `<CompanySwitcher>` so the radix Dialog only
 * enters the bundle when the user actually opens it — the overview's eager
 * chunk stays lean (size-budget gate). Default export for `React.lazy`.
 */
import * as React from 'react'

import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { useCreateCompany } from '@/hooks/use-companies'
import { SessionError } from '@/lib/api'
import { homeDir, projectsDir } from '@/env'

/** Company slug rule mirrors the server (`server/src/companies/mod.rs`:
 *  `[A-Za-z0-9._-]{1,64}`). */
function toCompanySlug(raw: string): string {
  return raw
    .trim()
    .toLowerCase()
    .replace(/\s+/g, '-')
    .replace(/[^a-z0-9._-]/g, '')
    .slice(0, 64)
}

/** Where a new company's `root_dir` lands: `<projects root or $HOME>/<slug>`.
 *  The server requires an absolute path and mkdir's it. */
function deriveRootDir(slug: string): string {
  const root = (projectsDir() || homeDir()).replace(/\/+$/, '')
  return root ? `${root}/${slug}` : ''
}

export default function CreateCompanyDialog({
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

  // Reset the field each time the dialog opens fresh.
  React.useEffect(() => {
    if (open) {
      setName('')
      setError(null)
    }
  }, [open])

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

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <form onSubmit={submit}>
          <DialogHeader>
            <DialogTitle>New company</DialogTitle>
            <DialogDescription>
              A company owns a folder and a set of agents. New agents you create
              while it is selected land inside it.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3 py-4">
            <div className="space-y-1.5">
              <label htmlFor="company-name" className="text-sm font-medium">
                Name
              </label>
              <Input
                id="company-name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="Acme"
                autoFocus
                autoComplete="off"
              />
            </div>
            {slug && (
              <p className="text-xs text-muted-foreground">
                id <span className="font-mono text-foreground">{slug}</span> ·
                folder <span className="font-mono">{rootDir}</span>
              </p>
            )}
            {error && <p className="text-sm text-destructive">{error}</p>}
          </div>
          <DialogFooter>
            <Button
              type="button"
              variant="ghost"
              onClick={() => onOpenChange(false)}
              disabled={create.isPending}
            >
              Cancel
            </Button>
            <Button type="submit" disabled={!canSubmit}>
              {create.isPending ? 'Creating…' : 'Create company'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
