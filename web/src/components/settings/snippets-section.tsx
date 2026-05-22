import * as React from 'react'
import { AnimatePresence, motion } from 'framer-motion'
import { Plus, Trash2, TriangleAlert } from 'lucide-react'

import { springs } from '@/lib/springs'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import {
  useCreateSnippet,
  useDeleteSnippet,
  useSnippets,
} from '@/hooks/use-settings'

/** Saved-command manager. Rows live inside a [`Section`] (the divide-y comes
 *  from the card), so this renders rows + an inline add form. Wired to the real
 *  `/api/snippets` CRUD with graceful loading / error / empty states. */
export function SnippetsSection() {
  const { data, isLoading, isError } = useSnippets()
  const create = useCreateSnippet()
  const del = useDeleteSnippet()
  const [label, setLabel] = React.useState('')
  const [command, setCommand] = React.useState('')

  const canAdd = label.trim() !== '' && command.trim() !== '' && !create.isPending

  function add() {
    if (!canAdd) return
    create.mutate(
      { label: label.trim(), command: command.trim() },
      {
        onSuccess: () => {
          setLabel('')
          setCommand('')
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
        {snippets.map((s) => (
          <motion.div
            key={s.id}
            layout
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={springs.smooth}
            className="flex items-center gap-3 px-4 py-2.5"
          >
            <div className="min-w-0 flex-1">
              <div className="text-[15px] leading-tight text-foreground">
                {s.label}
              </div>
              <div className="truncate font-mono text-[12px] text-muted-foreground">
                {s.command}
              </div>
            </div>
            <Button
              variant="ghost"
              size="icon"
              aria-label={`Delete ${s.label}`}
              onClick={() => del.mutate(s.id)}
              className="size-11 shrink-0 text-muted-foreground hover:text-destructive"
            >
              <Trash2 />
            </Button>
          </motion.div>
        ))}
      </AnimatePresence>

      <div className="flex flex-col gap-2 px-4 py-3 sm:flex-row sm:items-center">
        <Input
          value={label}
          onChange={(e) => setLabel(e.target.value)}
          placeholder="Label"
          aria-label="Snippet label"
          className="h-11 sm:max-w-[11rem]"
        />
        <Input
          value={command}
          onChange={(e) => setCommand(e.target.value)}
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
    </>
  )
}
