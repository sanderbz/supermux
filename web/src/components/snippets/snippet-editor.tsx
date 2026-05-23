// SnippetEditor — M18 (TECH_PLAN §M18, research/termius-ios-native-spec.md
// §"Snippet editor — in-place vs modal").
//
// A Vaul modal full-sheet for creating / editing one snippet: a title input and
// a body textarea, with Save / Cancel. Persists through the M9 `/api/snippets`
// CRUD (create when `snippet` is null, patch otherwise) via the use-commands
// mutations — which invalidate the snippet list so the panel reflects the write.
//
// Modal (not in-place) is the deliberate choice from the spec: editing wants a
// dedicated surface with a full-size body field; the *picker* is the in-place
// slide-up panel (snippet-panel.tsx). This sheet is .thickMaterial-style — a
// full-screen overlay over the composer.
//
// The form body is a keyed inner component (`EditorForm`) so it remounts fresh
// each time the sheet opens or the edit target changes — seeding the fields via
// lazy `useState` initializers rather than a setState-in-effect.
//
// VISUAL: ≥44pt controls, sentence-case labels (NO uppercase), spring press, no
// `transition: all`.

import * as React from 'react'
import { Drawer } from 'vaul'
import { motion } from 'framer-motion'

import { cn } from '@/lib/utils'
import { springs } from '@/lib/springs'
import { useCreateSnippet, usePatchSnippet } from '@/hooks/use-commands'
import type { SnippetRow } from '@/lib/api'

export interface SnippetEditorProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** Editing an existing snippet, or null to create a fresh one. */
  snippet: SnippetRow | null
}

export function SnippetEditor({ open, onOpenChange, snippet }: SnippetEditorProps) {
  return (
    <Drawer.Root open={open} onOpenChange={onOpenChange}>
      <Drawer.Portal>
        <Drawer.Overlay className="fixed inset-0 z-[70] bg-black/50" />
        <Drawer.Content
          aria-describedby={undefined}
          className={cn(
            'glass fixed inset-x-0 bottom-0 z-[70] flex max-h-[90vh] flex-col',
            'rounded-t-[10px] border-t border-border/60 pb-safe outline-none',
          )}
        >
          <div className="mx-auto mt-1.5 h-[5px] w-9 shrink-0 rounded-[2.5px] bg-muted-foreground/30" />
          <Drawer.Title className="px-4 pb-1 pt-3 text-[15px] font-semibold">
            {snippet ? 'Edit snippet' : 'New snippet'}
          </Drawer.Title>
          {/* Keyed so the form remounts (fresh seeded state) per open/target. */}
          {open && (
            <EditorForm
              key={snippet ? `edit-${snippet.id}` : 'new'}
              snippet={snippet}
              onClose={() => onOpenChange(false)}
            />
          )}
        </Drawer.Content>
      </Drawer.Portal>
    </Drawer.Root>
  )
}

/** The seeded form body — remounted via `key`, so `useState` initializers carry
 *  the snippet's values without a setState-in-effect. */
function EditorForm({
  snippet,
  onClose,
}: {
  snippet: SnippetRow | null
  onClose: () => void
}) {
  const create = useCreateSnippet()
  const patch = usePatchSnippet()

  const [title, setTitle] = React.useState(() => snippet?.title ?? '')
  const [body, setBody] = React.useState(() => snippet?.body ?? '')

  const saving = create.isPending || patch.isPending
  const canSave = title.trim().length > 0 && body.length > 0 && !saving

  const onSave = async () => {
    if (!canSave) return
    try {
      if (snippet) {
        await patch.mutateAsync({
          id: snippet.id,
          patch: { title: title.trim(), body },
        })
      } else {
        await create.mutateAsync({ title: title.trim(), body })
      }
      onClose()
    } catch {
      /* the mutation surfaces the error state; keep the sheet open to retry */
    }
  }

  return (
    <>
      <div className="min-h-0 flex-1 space-y-3 overflow-y-auto px-4 pb-2 pt-2">
        <label className="block">
          <span className="mb-1 block text-[12px] font-medium text-muted-foreground">
            Title
          </span>
          <input
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder="e.g. Continue"
            aria-label="Snippet title"
            className={cn(
              'h-11 w-full rounded-xl border border-border bg-background px-3',
              'text-base outline-none focus:ring-2 focus:ring-ring',
            )}
          />
        </label>

        <label className="block">
          <span className="mb-1 block text-[12px] font-medium text-muted-foreground">
            Body
          </span>
          <textarea
            value={body}
            onChange={(e) => setBody(e.target.value)}
            rows={5}
            placeholder="The text or /command this snippet inserts…"
            aria-label="Snippet body"
            className={cn(
              'min-h-[120px] w-full resize-y rounded-xl border border-border bg-background',
              'px-3 py-2.5 font-mono text-base md:text-[14px] leading-5 outline-none focus:ring-2 focus:ring-ring',
            )}
          />
        </label>

        {(create.isError || patch.isError) && (
          <p className="text-[12px] text-destructive">
            Couldn’t save — check the connection and try again.
          </p>
        )}
      </div>

      <div className="flex shrink-0 gap-2 px-4 pb-2 pt-2">
        <motion.button
          type="button"
          onClick={onClose}
          whileTap={{ scale: 0.97 }}
          transition={springs.buttonPress}
          className={cn(
            'h-11 flex-1 rounded-xl border border-border bg-secondary',
            'text-[15px] font-medium text-secondary-foreground',
          )}
        >
          Cancel
        </motion.button>
        <motion.button
          type="button"
          onClick={onSave}
          disabled={!canSave}
          whileTap={canSave ? { scale: 0.97 } : undefined}
          transition={springs.buttonPress}
          className={cn(
            'h-11 flex-1 rounded-xl bg-primary text-[15px] font-semibold text-primary-foreground',
            !canSave && 'opacity-40',
          )}
        >
          {saving ? 'Saving…' : 'Save'}
        </motion.button>
      </div>
    </>
  )
}

export default SnippetEditor
