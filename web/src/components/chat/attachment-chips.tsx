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
 * folded into the outgoing message only at Send (`attachmentSentence`).
 *
 * TWO SHAPES, one radius system (Grok/ChatGPT/Claude parity):
 *   · image (ready or uploading) → the THUMBNAIL *is* the object: a bare 56px
 *     rounded tile carrying the picture, a circular remove disc overlaid on its
 *     top-right corner, and — because a bare thumbnail can't name itself — the
 *     filename on hover/long-press (`title`). No surrounding pill.
 *   · file / error → a pill: a glyph (or, for a failed image, its thumbnail)
 *     tile + the filename (or the error reason), with the SAME circular remove
 *     disc trailing. An error pill is red-tinted.
 * Radii echo: the pill is `rounded-2xl` (container), every tile/thumbnail is
 * `rounded-xl` — two radii, not the old three mismatched ones.
 *
 * The remove control is a real ~20px circular button with its own chrome and a
 * ≥28px touch target — never a bare floating glyph. Uploading overlays a
 * progress ring on the tile so the footprint never jumps when the bytes land.
 *
 * Purely presentational: renders nothing when the list is empty, so an unwired
 * composer is byte-identical.
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
      className="mb-2 flex flex-wrap items-center gap-2"
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
  const state = att.error ? 'error' : att.uploading ? 'uploading' : 'ready'
  // A healthy image is its own object — a bare 56px thumbnail with the remove
  // disc overlaid on its corner. A file, or any FAILED attachment, is a pill:
  // a small tile + the name (or the error reason) + a trailing remove disc.
  const bare = image && !att.error

  // The remove control — chrome + a ≥28px touch target (a 20px disc inside a
  // 28px hit box), never a bare glyph. Overlaid on the corner when the chip is a
  // bare thumbnail (a fixed dark scrim reads over any picture, either theme);
  // otherwise it trails the pill on its own fill tokens.
  const remove = (
    <button
      type="button"
      data-testid="chat-attachment-remove"
      aria-label={`Remove ${att.name}`}
      onClick={() => onDismiss(att.id)}
      className={cn(
        'grid size-7 flex-none place-items-center rounded-full',
        bare && 'absolute right-1 top-1',
      )}
    >
      <span
        className={cn(
          'grid size-5 place-items-center rounded-full',
          bare
            ? 'bg-black/60 text-white'
            : 'border-[0.5px] border-hairline bg-surface text-ink-2',
        )}
      >
        <X className="size-3.5" aria-hidden />
      </span>
    </button>
  )

  return (
    <div
      data-testid="chat-attachment-chip"
      data-state={state}
      // The bare thumbnail can't name itself — the filename rides `title`.
      title={bare ? att.name : undefined}
      className={cn(
        'flex flex-none items-center',
        !bare &&
          cn(
            'gap-2 rounded-2xl border-[0.5px] p-1.5 text-xs',
            att.error
              ? 'border-status-error/30 bg-status-error/10 text-status-error'
              : 'border-hairline bg-surface text-ink',
          ),
      )}
    >
      {/* The tile — 56px when it IS the chip, 36px inside a pill; a glyph for a
          file, the thumbnail for any image (a failed one keeps its picture). */}
      <span
        className={cn(
          'relative grid flex-none place-items-center overflow-hidden rounded-xl bg-fill-soft text-ink-2',
          bare ? 'size-14 border-[0.5px] border-hairline' : 'size-9',
        )}
      >
        {image ? (
          <img src={att.previewUrl as string} alt="" className="size-full object-cover" />
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
        {bare && remove}
      </span>

      {!bare && (
        <>
          <span className="max-w-[12rem] truncate">
            {att.error ? att.error : att.name}
          </span>
          {remove}
        </>
      )}
    </div>
  )
}

export default AttachmentChips
