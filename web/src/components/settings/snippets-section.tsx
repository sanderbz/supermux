import * as React from 'react'
import { AnimatePresence, motion } from 'framer-motion'
import { ChevronRight, Pencil, Plus, Trash2, TriangleAlert } from 'lucide-react'

import { cn } from '@/lib/utils'
import { springs } from '@/lib/springs'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { SnippetEditor } from '@/components/snippets/snippet-editor'
import type { SnippetRow } from '@/lib/api'
import {
  useCreateSnippet,
  useDeleteSnippet,
  useSnippets,
} from '@/hooks/use-commands'

/** Saved-command manager. Rows live inside a [`Section`] (the divide-y comes
 *  from the card), so this renders rows + an inline add form. Wired to the real
 *  `/api/snippets` CRUD via `use-commands` — the SAME client + `['snippets']`
 *  cache the focus snippet panel uses, so a snippet created here shows in the
 *  slash-menu panel and vice-versa (one client, one cache). */
export function SnippetsSection() {
  const { data, isLoading, isError } = useSnippets()
  const create = useCreateSnippet()
  const del = useDeleteSnippet()
  const [title, setTitle] = React.useState('')
  const [body, setBody] = React.useState('')

  // Per-row expand toggle (local, non-persisted). Multiple rows may be open.
  const [expanded, setExpanded] = React.useState<Set<number>>(new Set())
  const toggleExpanded = (id: number) =>
    setExpanded((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })

  // Edit sub-sheet: the seeded SnippetEditor (reused as-is) for an existing row.
  const [editing, setEditing] = React.useState<SnippetRow | null>(null)
  const [editorOpen, setEditorOpen] = React.useState(false)

  const canAdd = title.trim() !== '' && body.trim() !== '' && !create.isPending

  function add() {
    if (!canAdd) return
    create.mutate(
      { title: title.trim(), body: body.trim() },
      {
        onSuccess: () => {
          setTitle('')
          setBody('')
        },
      },
    )
  }

  const snippets = data ?? []

  return (
    <>
      {isError ? (
        <div className="flex items-center gap-2.5 px-4 py-3 text-[13px] text-muted-foreground [&_svg]:size-4 [&_svg]:shrink-0">
          <TriangleAlert />
          <span>Snippets aren’t available from the server yet.</span>
        </div>
      ) : null}

      {!isError && isLoading ? (
        <div className="flex flex-col gap-2 px-4 py-3">
          {Array.from({ length: 2 }).map((_, i) => (
            <div key={i} className="h-4 w-40 animate-pulse rounded bg-muted/50" />
          ))}
        </div>
      ) : null}

      {!isError && !isLoading && snippets.length === 0 ? (
        <div className="px-4 py-3 text-[13px] text-muted-foreground">
          No saved commands yet. Add one below.
        </div>
      ) : null}

      <AnimatePresence initial={false}>
        {snippets.map((s) => {
          const isExpanded = expanded.has(s.id)
          return (
            <motion.div
              key={s.id}
              layout
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              transition={springs.smooth}
              className="px-4 py-2.5"
            >
              <div className="flex items-center gap-1.5">
                <Button
                  variant="ghost"
                  size="icon"
                  aria-label={isExpanded ? `Collapse ${s.title}` : `Expand ${s.title}`}
                  aria-expanded={isExpanded}
                  onClick={() => toggleExpanded(s.id)}
                  className="size-11 shrink-0 text-muted-foreground"
                >
                  <ChevronRight
                    className={cn(
                      'transition-transform duration-200',
                      isExpanded && 'rotate-90',
                    )}
                  />
                </Button>
                <div className="min-w-0 flex-1">
                  <div className="text-[15px] leading-tight text-foreground">
                    {s.title}
                  </div>
                  {!isExpanded ? (
                    <div className="truncate font-mono text-[12px] text-muted-foreground">
                      {s.body}
                    </div>
                  ) : null}
                </div>
                <Button
                  variant="ghost"
                  size="icon"
                  aria-label={`Edit ${s.title}`}
                  onClick={() => {
                    setEditing(s)
                    setEditorOpen(true)
                  }}
                  className="size-11 shrink-0 text-muted-foreground"
                >
                  <Pencil />
                </Button>
                <Button
                  variant="ghost"
                  size="icon"
                  aria-label={`Delete ${s.title}`}
                  onClick={() => del.mutate(s.id)}
                  className="size-11 shrink-0 text-muted-foreground hover:text-destructive"
                >
                  <Trash2 />
                </Button>
              </div>
              {isExpanded ? (
                <div className="mt-1 select-text whitespace-pre-wrap break-words pl-[3.125rem] pr-1 font-mono text-[12px] text-muted-foreground">
                  {s.body}
                </div>
              ) : null}
            </motion.div>
          )
        })}
      </AnimatePresence>

      <div className="flex flex-col gap-2 px-4 py-3 sm:flex-row sm:items-center">
        <Input
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          placeholder="Label"
          aria-label="Snippet label"
          className="h-11 sm:max-w-[11rem]"
        />
        <Input
          value={body}
          onChange={(e) => setBody(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') add()
          }}
          placeholder="Command"
          aria-label="Snippet command"
          className="h-11 flex-1 font-mono text-[13px]"
        />
        <Button asChild onClick={add} disabled={!canAdd} className="h-11 shrink-0 gap-1.5">
          <motion.button whileTap={{ scale: 0.96 }} transition={springs.buttonPress}>
            <Plus />
            Add
          </motion.button>
        </Button>
      </div>

      {/* Reused create/edit sheet — seeded with the row being edited. */}
      <SnippetEditor
        open={editorOpen}
        onOpenChange={setEditorOpen}
        snippet={editing}
      />
    </>
  )
}
