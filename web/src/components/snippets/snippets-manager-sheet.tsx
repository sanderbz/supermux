// SnippetsManagerSheet — the dedicated snippets manager.
//
// One <ResponsiveSheet> (Vaul bottom-sheet on touch / right-side dialog on
// desktop) that owns the full snippet list + add/edit/delete, so the Settings
// page stays a compact "Manage snippets" row instead of an unbounded inline
// list. Mirrors the Claude-tools manager pattern (store + host + shell-level
// mount). Wired to the real `/api/snippets` CRUD via `use-commands` — the SAME
// client + `['snippets']` cache the focus snippet panel reads, so a write here
// shows in the in-session picker and vice-versa.
//
// Add/edit reuse the existing <SnippetEditor> Vaul sheet (already ≥16px inputs).

import * as React from 'react'
import { AnimatePresence, motion } from 'framer-motion'
import { ChevronRight, Pencil, Plus, Trash2, TriangleAlert } from 'lucide-react'

import { cn } from '@/lib/utils'
import { springs } from '@/lib/springs'
import { Button } from '@/components/ui/button'
import { ResponsiveSheet } from '@/components/ui/responsive-sheet'
import { SnippetEditor } from '@/components/snippets/snippet-editor'
import type { SnippetRow } from '@/lib/api'
import { useDeleteSnippet, useSnippets } from '@/hooks/use-commands'

export interface SnippetsManagerSheetProps {
  open: boolean
  onOpenChange: (open: boolean) => void
}

export function SnippetsManagerSheet({ open, onOpenChange }: SnippetsManagerSheetProps) {
  // Create/edit: the shared SnippetEditor, seeded null (new) or with the row.
  // Kept at this level (cheap state, no query) so the header "New snippet" action
  // can open it; the LIST + its `useSnippets` read live in a gated inner body.
  const [editing, setEditing] = React.useState<SnippetRow | null>(null)
  const [editorOpen, setEditorOpen] = React.useState(false)
  const openEditor = (snippet: SnippetRow | null) => {
    setEditing(snippet)
    setEditorOpen(true)
  }

  return (
    <>
      <ResponsiveSheet
        open={open}
        onOpenChange={onOpenChange}
        title="Snippets"
        description="Saved prompts and /commands you can drop into a session."
        headerActions={
          <Button asChild onClick={() => openEditor(null)} className="h-9 shrink-0 gap-1.5">
            <motion.button whileTap={{ scale: 0.96 }} transition={springs.buttonPress}>
              <Plus className="size-4" />
              New snippet
            </motion.button>
          </Button>
        }
        className="sm:max-w-lg"
      >
        {/* Gated so `useSnippets` is read ONLY while the sheet is open (mirrors
            ClaudeToolsBody) — no always-on global fetch on every route — and the
            per-row expand state resets fresh each open. */}
        {open ? <SnippetsManagerBody onEdit={openEditor} /> : null}
      </ResponsiveSheet>

      <SnippetEditor open={editorOpen} onOpenChange={setEditorOpen} snippet={editing} />
    </>
  )
}

/** The list body — mounted only while the sheet is open. */
function SnippetsManagerBody({ onEdit }: { onEdit: (snippet: SnippetRow | null) => void }) {
  const { data, isLoading, isError } = useSnippets()
  const del = useDeleteSnippet()
  const snippets = data ?? []

  // Per-row expand toggle (local, non-persisted). Multiple rows may be open.
  const [expanded, setExpanded] = React.useState<Set<number>>(new Set())
  const toggleExpanded = (id: number) =>
    setExpanded((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })

  return (
    <div className="px-2 py-2 sm:px-3">
          {isError ? (
            <div className="flex items-center gap-2.5 px-2 py-3 text-[13px] text-muted-foreground [&_svg]:size-4 [&_svg]:shrink-0">
              <TriangleAlert />
              <span>Snippets aren’t available from the server yet.</span>
            </div>
          ) : null}

          {!isError && isLoading ? (
            <div className="flex flex-col gap-2 px-2 py-3">
              {Array.from({ length: 3 }).map((_, i) => (
                <div key={i} className="h-10 animate-pulse rounded-lg bg-muted/40" />
              ))}
            </div>
          ) : null}

          {!isError && !isLoading && snippets.length === 0 ? (
            <div className="px-2 py-10 text-center text-[13px] leading-relaxed text-muted-foreground">
              No snippets yet.
              <br />
              Save a prompt or /command you reuse, then drop it into any session.
            </div>
          ) : null}

          <AnimatePresence initial={false}>
            {snippets.map((s) => {
              const isExpanded = expanded.has(s.id)
              const bodyId = `snippet-mgr-${s.id}-body`
              return (
                <motion.div
                  key={s.id}
                  layout
                  initial={{ opacity: 0 }}
                  animate={{ opacity: 1 }}
                  exit={{ opacity: 0 }}
                  transition={springs.smooth}
                  className="px-1 py-0.5"
                >
                  <div className="flex items-center gap-1">
                    <Button
                      variant="ghost"
                      size="icon"
                      aria-label={isExpanded ? `Collapse ${s.title}` : `Expand ${s.title}`}
                      aria-expanded={isExpanded}
                      aria-controls={bodyId}
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
                      onClick={() => onEdit(s)}
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
                  {/* Full body — always in the DOM (so aria-controls resolves),
                      hidden until expanded; indented under the title. */}
                  <div
                    id={bodyId}
                    role="region"
                    aria-label={`${s.title} full text`}
                    hidden={!isExpanded}
                    className="mb-1 mt-0.5 select-text whitespace-pre-wrap break-words rounded-lg bg-secondary/40 px-3 py-2 font-mono text-[12px] text-muted-foreground"
                  >
                    {s.body}
                  </div>
                </motion.div>
              )
            })}
          </AnimatePresence>
        </div>
  )
}

export default SnippetsManagerSheet
