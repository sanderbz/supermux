// useStagedAttachments — the "stage, don't auto-inject" sibling of
// `useAttachmentUpload`, for the mobile compose sheet (feat/mobile-compose).
//
// The desktop dock + terminal drag/paste want files injected into the prompt the
// MOMENT they finish uploading (`useAttachmentUpload`). The compose sheet wants
// the opposite: a file is picked → it uploads in the background → it STAYS as a
// chip in the sheet, and its absolute path is only folded into the prompt when
// the user taps Send (alongside the typed text). So this hook reuses the SAME
// upload engine (`uploadForPrompt` → `POST /api/upload` → absolute path) and the
// SAME `Attachment` chip shape, but instead of calling `onSend` on success it
// remembers each ready path in the chip's `path` field. `readyPaths()` then
// returns the absolute paths of the successfully-uploaded, still-staged files so
// the sheet can build the attachment sentence on Send.
//
// Sharing the engine (not duplicating it) keeps the upload contract — 5 MB image
// guard, parallel upload, calm error toast, object-URL thumbnails, leak-free
// revoke — in ONE place; only the success disposition differs.

import * as React from 'react'

import { uploadForPrompt } from '@/lib/api/files'
import type { Attachment } from './use-attachment-upload'
import { useToast } from '@/components/ui/use-toast'

/** A staged attachment carries everything a dock `Attachment` does, plus the
 *  absolute saved path once its upload resolves (null while uploading / on
 *  error) so Send can quote it. */
export interface StagedAttachment extends Attachment {
  /** Absolute on-disk path under `<data_dir>/uploads/`, set on a successful
   *  upload; null while uploading or after a failure. */
  path: string | null
}

export interface UseStagedAttachmentsResult {
  /** The chips to render (uploading → ready/error), newest last. */
  attachments: StagedAttachment[]
  /** True while ANY staged file is still uploading — Send waits for these. */
  uploading: boolean
  /** Stage a batch of files: shows chips + uploads in parallel, keeps the paths. */
  handleFiles: (files: File[]) => void
  /** Dismiss one chip (revokes its thumbnail). */
  dismiss: (id: string) => void
  /** Absolute paths of the ready (uploaded, not-errored, not-dismissed) files,
   *  in pick order — used to build the attachment sentence on Send. */
  readyPaths: () => string[]
  /** Drop every staged chip + revoke previews (called after a successful Send). */
  reset: () => void
}

let _seq = 0
function nextId(): string {
  _seq += 1
  return `staged-${Date.now()}-${_seq}`
}

export function useStagedAttachments(): UseStagedAttachmentsResult {
  const { toast } = useToast()
  const [attachments, setAttachments] = React.useState<StagedAttachment[]>([])

  // Object-URLs to revoke on unmount so image previews don't leak.
  const urlsRef = React.useRef<Set<string>>(new Set())
  React.useEffect(() => {
    const urls = urlsRef.current
    return () => {
      for (const u of urls) URL.revokeObjectURL(u)
    }
  }, [])

  const revoke = React.useCallback((url: string | null) => {
    if (url) {
      URL.revokeObjectURL(url)
      urlsRef.current.delete(url)
    }
  }, [])

  const dismiss = React.useCallback(
    (id: string) => {
      setAttachments((list) => {
        const target = list.find((a) => a.id === id)
        revoke(target?.previewUrl ?? null)
        return list.filter((a) => a.id !== id)
      })
    },
    [revoke],
  )

  const reset = React.useCallback(() => {
    setAttachments((list) => {
      for (const a of list) revoke(a.previewUrl)
      return []
    })
  }, [revoke])

  const handleFiles = React.useCallback(
    (files: File[]) => {
      if (files.length === 0) return

      // 1. Optimistic chips — one per file, image thumbnail where we can.
      const rows: { att: StagedAttachment; file: File }[] = files.map((file) => {
        let previewUrl: string | null = null
        if (file.type.startsWith('image/')) {
          previewUrl = URL.createObjectURL(file)
          urlsRef.current.add(previewUrl)
        }
        return {
          att: {
            id: nextId(),
            name: file.name,
            uploading: true,
            previewUrl,
            path: null,
          },
          file,
        }
      })
      setAttachments((list) => [...list, ...rows.map((r) => r.att)])

      // 2. Upload each independently — a chip flips to ready (keeping its path)
      //    or error the instant ITS upload settles, so a slow file never blocks
      //    the others' chips. The path is staged, NOT injected (that's the whole
      //    difference from the desktop engine): Send quotes it later.
      rows.forEach(({ att, file }) => {
        uploadForPrompt(file)
          .then((res) => {
            setAttachments((list) =>
              list.map((a) =>
                a.id === att.id
                  ? { ...a, uploading: false, path: res.path }
                  : a,
              ),
            )
          })
          .catch((reason: unknown) => {
            const message =
              reason instanceof Error ? reason.message : 'Upload failed.'
            setAttachments((list) =>
              list.map((a) =>
                a.id === att.id
                  ? { ...a, uploading: false, error: message }
                  : a,
              ),
            )
            toast({ message, tone: 'error' })
          })
      })
    },
    [toast],
  )

  const readyPaths = React.useCallback(
    (): string[] =>
      attachments
        .filter((a) => !a.uploading && !a.error && a.path)
        .map((a) => a.path as string),
    [attachments],
  )

  const uploading = attachments.some((a) => a.uploading)

  return { attachments, uploading, handleFiles, dismiss, readyPaths, reset }
}
