import { useRef, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Button } from '@/components/ui/button'
import { ResponsiveSheet } from '@/components/ui/responsive-sheet'
import {
  encodeBytes,
  encodeText,
  markdown,
  skillLibrary,
  type SkillPackage,
} from '@/lib/api/skill-library'

const field =
  'w-full rounded-md border border-border bg-background px-3 py-2 text-sm'
const template = (name: string) =>
  `---\nname: ${name}\ndescription: Describe when to use this skill\n---\n\n`
export function SkillEditor({
  initial,
  id,
  close,
  saved,
  scopes,
  target,
}: {
  target: string
  scopes: Map<string, string>
  initial: SkillPackage
  id: string
  close: () => void
  saved: () => void
}) {
  const [name, setName] = useState(id)
  const [files, setFiles] = useState(initial.files)
  const [selected, select] = useState('SKILL.md')
  const [newPath, setNewPath] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const folder = useRef<HTMLInputElement>(null)
  const dirty = files !== initial.files || name !== id
  const sources = useQuery({
    queryKey: ['agent-skill-sources', target],
    queryFn: () => skillLibrary.sources(target),
    enabled: !initial.revision,
  })
  async function importInstalled(value: string) {
    if (!value) return
    setBusy(true)
    try {
      const [source, installedName] = JSON.parse(value) as [string, string]
      const draft = await skillLibrary.draft(target, source, installedName)
      setName(installedName)
      setFiles(draft.files)
      select('SKILL.md')
      setError('')
    } catch (err) {
      setError(String(err))
    } finally {
      setBusy(false)
    }
  }
  function dismiss() {
    if (!busy && (!dirty || window.confirm('Discard unsaved skill changes?')))
      close()
  }
  async function importFolder(list: FileList | null) {
    if (!list?.length) return
    setBusy(true)
    try {
      const next: Record<string, string> = Object.create(null)
      const input = Array.from(list)
      if (
        input.length > 512 ||
        input.reduce((sum, f) => sum + f.size, 0) > 1_350_000
      )
        throw Error('Choose a skill folder up to 1.3 MiB and 512 files.')
      for (const f of input) {
        const path = f.webkitRelativePath.split('/').slice(1).join('/')
        next[path] = encodeBytes(new Uint8Array(await f.arrayBuffer()))
      }
      if (!Object.hasOwn(next, 'SKILL.md'))
        throw Error('Choose the folder containing SKILL.md.')
      setFiles(next)
      const importedName = /^name:\s*['"]?([a-z0-9-]+)['"]?\s*$/m.exec(
        markdown(next, 'SKILL.md'),
      )?.[1]
      setName(importedName ?? input[0].webkitRelativePath.split('/')[0])
      select('SKILL.md')
      setError('')
    } catch (err) {
      setError(String(err))
    } finally {
      setBusy(false)
    }
  }
  async function save() {
    setBusy(true)
    try {
      await skillLibrary.save(name, {
        files: {
          ...files,
          'SKILL.md': files['SKILL.md'] ?? encodeText(template(name)),
        },
        revision: initial.revision,
      })
      saved()
    } catch (err) {
      setError(String(err))
    } finally {
      setBusy(false)
    }
  }
  function addFile() {
    const path = newPath.trim()
    if (
      !path.toLowerCase().endsWith('.md') ||
      path.split('/').some((p) => !p || p === '.' || p === '..') ||
      Object.hasOwn(files, path)
    ) {
      setError(
        'Enter a new relative Markdown path, such as references/checklist.md.',
      )
      return
    }
    setFiles({ ...files, [path]: '' })
    select(path)
    setNewPath('')
    setError('')
  }
  const paths = [...new Set(['SKILL.md', ...Object.keys(files)])].filter((p) =>
    p.toLowerCase().endsWith('.md'),
  )
  return (
    <ResponsiveSheet
      open
      onOpenChange={(open) => {
        if (!open) dismiss()
      }}
      title={id ? `Edit ${id}` : 'Add skill'}
      className="sm:max-w-3xl"
    >
      <fieldset
        disabled={busy}
        className="flex min-w-0 max-h-[76dvh] flex-col gap-3 overflow-y-auto px-4 pb-5"
      >
        {!initial.revision && (
          <div className="flex items-end gap-2">
            <label className="flex-1 text-sm">
              Skill name
              <input
                className={field}
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="release-review"
              />
            </label>
            <input
              type="file"
              aria-label="Skill folder"
              ref={(node) => {
                folder.current = node
                node?.setAttribute('webkitdirectory', '')
              }}
              multiple
              hidden
              onChange={(e) => void importFolder(e.target.files)}
            />
            <Button
              variant="outline"
              disabled={busy}
              onClick={() => folder.current?.click()}
            >
              Import folder
            </Button>
          </div>
        )}
        {!initial.revision && !!sources.data?.length && (
          <label className="text-sm">
            Import from this server
            <select
              aria-label="Import from this server"
              className={field}
              value=""
              disabled={busy}
              onChange={(e) => void importInstalled(e.target.value)}
            >
              <option value="">Choose an installed skill to copy</option>
              {sources.data.map(([source, skill]) => (
                <option
                  key={source + skill}
                  value={JSON.stringify([source, skill])}
                >
                  {skill} · {source}
                </option>
              ))}
            </select>
          </label>
        )}
        {sources.isError && (
          <p className="text-sm text-muted-foreground">
            Server skill folders could not be loaded.
          </p>
        )}
        {!!initial.grants?.length && (
          <div className="text-sm">
            <h3 className="font-medium">Assigned to</h3>
            <ul>
              {initial.grants.map(([scope, enabled]) => (
                <li key={scope}>
                  {scopes.get(scope) ?? scope}
                  {!enabled && ' (disabled)'}
                </li>
              ))}
            </ul>
          </div>
        )}
        <label className="text-sm">
          Markdown file
          <select
            aria-label="Markdown file"
            className={field}
            value={selected}
            onChange={(e) => select(e.target.value)}
          >
            {paths.map((p) => (
              <option key={p}>{p}</option>
            ))}
          </select>
        </label>
        <label className="sr-only" htmlFor="skill-markdown">
          Markdown content
        </label>
        <textarea
          id="skill-markdown"
          spellCheck={false}
          className={field + ' min-h-56 font-mono sm:min-h-80'}
          value={
            selected === 'SKILL.md' && !Object.hasOwn(files, selected)
              ? template(name)
              : markdown(files, selected)
          }
          onChange={(e) =>
            setFiles({ ...files, [selected]: encodeText(e.target.value) })
          }
        />
        <div className="flex gap-2">
          <input
            className={field}
            aria-label="New Markdown path"
            placeholder="references/checklist.md"
            value={newPath}
            onChange={(e) => setNewPath(e.target.value)}
          />
          <Button variant="outline" disabled={!newPath} onClick={addFile}>
            Add file
          </Button>
        </div>
        {selected !== 'SKILL.md' && (
          <Button
            variant="ghost"
            className="self-start"
            onClick={() => {
              const next = { ...files }
              delete next[selected]
              setFiles(next)
              select('SKILL.md')
            }}
          >
            Remove selected file
          </Button>
        )}
        {error && (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        )}
        <div className="flex justify-end gap-2">
          <Button variant="outline" onClick={dismiss}>
            Cancel
          </Button>
          <Button disabled={busy || !name} onClick={() => void save()}>
            Save skill
          </Button>
        </div>
      </fieldset>
    </ResponsiveSheet>
  )
}
