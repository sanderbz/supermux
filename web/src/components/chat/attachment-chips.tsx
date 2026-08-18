/**
 * The composer's attachment chip row (feat/grok-mode composer upgrade).
 * ─────────────────────────────────────────────────────────────────────────────
 * The chips are the truth; the field stays clean prose. Staged attachments
 * (`useStagedAttachments`) render here as a wrapping row ABOVE the pill, inside
 * `ComposerFrame` next to the refusal banner and the `@`/`/` picker — the same
 * above-pill stack, so the block reads as part of the one composer unit and the
 * rounded-full pill never has to clip its own corners around a thumbnail.
 *
 * The quoted `<data_dir>/uploads/…` path is NEVER shown in the field: it is
 * folded into the outgoing message only at Send (`attachmentSentence`). Each
 * chip is one of four states the staged hook drives:
 *   · image   → a rounded thumbnail (`previewUrl` object-URL)
 *   · file    → a glyph tile + the filename (a bare thumbnail can't tell files
 *               apart, so non-images always show the name — Grok's own rule)
 *   · uploading → a spinner overlay on the tile (`uploading: true`)
 *   · error   → a red-tinted chip carrying the reason (`error`)
 * Every chip carries a `×` that calls `dismiss(id)` (which revokes the object
 * URL). Purely presentational: renders nothing when the list is empty, so an
 * unwired composer is byte-identical.
 */
import { FileText, X } from 'lucide-react'

import { cn } from '../../lib/utils'

import type { StagedAttachment } from '../focus-mode/use-staged-attachments'

export interface AttachmentChipsProps {
  attachments: StagedAttachment[]
  onDismiss: (id: string) => void
}

export function AttachmentChips({ attachments, onDismiss }: AttachmentChipsProps) {
  if (attachments.length === 0) return null
  return (
    <div
      data-testid="chat-attachment-chips"
      className="mb-2 flex flex-wrap gap-2"
    >
      {attachments.map((att) => (
        <Chip key={att.id} att={att} onDismiss={onDismiss} />
      ))}
    </div>
  )
}

function Chip({
  att,
  onDismiss,
}: {
  att: StagedAttachment
  onDismiss: (id: string) => void
}) {
  const image = att.previewUrl != null
  return (
    <div
      data-testid="chat-attachment-chip"
      data-state={att.error ? 'error' : att.uploading ? 'uploading' : 'ready'}
      className={cn(
        'group relative flex items-center gap-2 rounded-xl border-[0.5px] py-1.5 pl-1.5 pr-2',
        'text-[12.5px] tracking-[-0.05px]',
        att.error
          ? 'border-status-error/30 bg-status-error/10 text-status-error'
          : 'border-hairline bg-surface text-ink',
      )}
    >
      {/* The tile — image thumbnail or a file glyph. The uploading spinner
          overlays it so the chip's footprint never jumps when the bytes land. */}
      <span className="relative grid size-8 flex-none place-items-center overflow-hidden rounded-lg bg-fill-soft text-ink-2">
        {image ? (
          <img
            src={att.previewUrl as string}
            alt=""
            className="size-full object-cover"
          />
        ) : (
          <FileText className="size-4" strokeWidth={1.75} aria-hidden />
        )}
        {att.uploading && (
          <span className="absolute inset-0 grid place-items-center bg-surface/60">
            <span
              className="size-4 animate-spin rounded-full border-2 border-ink-3 border-t-transparent"
              aria-hidden
            />
          </span>
        )}
      </span>

      {/* Non-images always show the filename; images show it only if there is
          an error to explain, otherwise the thumbnail carries them. */}
      {(!image || att.error) && (
        <span className="max-w-[12rem] truncate">
          {att.error ? att.error : att.name}
        </span>
      )}

      <button
        type="button"
        data-testid="chat-attachment-remove"
        aria-label={`Remove ${att.name}`}
        onClick={() => onDismiss(att.id)}
        className={cn(
          'grid size-5 flex-none place-items-center rounded-full',
          'text-ink-3 hover:text-ink active:bg-fill-soft',
        )}
      >
        <X className="size-3.5" strokeWidth={2} aria-hidden />
      </button>
    </div>
  )
}

export default AttachmentChips
