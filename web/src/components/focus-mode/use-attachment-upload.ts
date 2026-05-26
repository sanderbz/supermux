// useAttachmentUpload — the shared "send a file/screenshot into the session"
// engine for BOTH the mobile dock and the desktop dock/terminal pane.
//
// The flow (locked by design):
//   1. The user picks files (📎 sheet / drag-drop / clipboard paste).
//   2. We show an attachment chip per file IMMEDIATELY (uploading spinner →
//      ready with a thumbnail/name, dismissible) so the user sees what's
//      attached BEFORE anything lands in the terminal.
//   3. Bytes upload in PARALLEL to `POST /api/upload` (data dir's `uploads/`,
//      not the cwd) → each returns its ABSOLUTE saved path.
//   4. Once ALL succeed, we inject the quoted absolute path(s) (no prose, no
//      trailing Enter) via the terminal's text-send (`onSend`), so the user can
//      add their own wording and hit Enter themselves.
//
// Failures (client 5 MB image guard, network, server reject) surface as a calm
// toast and the chip flips to an error state the user can dismiss.

import * as React from 'react'

import {
  uploadForPrompt,
  buildAttachmentPrompt,
  type UploadResult,
} from '@/lib/api/files'
import { useToast } from '@/components/ui/use-toast'

/** One attachment's lifecycle row, rendered as a chip near the input/dock. */
export interface Attachment {
  id: string
  name: string
  /** True while the bytes are uploading (spinner). */
  uploading: boolean
  /** Object-URL thumbnail for images (revoked on dismiss); null for non-images. */
  previewUrl: string | null
  /** Set when the upload failed — the chip shows an error tint. */
  error?: string
}

export interface UseAttachmentUploadResult {
  /** The chips to render (uploading → ready/error), newest last. */
  attachments: Attachment[]
  /** Pick a batch of files: shows chips, uploads in parallel, injects on success. */
  handleFiles: (files: File[]) => void
  /** Dismiss one chip (revokes its thumbnail). */
  dismiss: (id: string) => void
}

let _seq = 0
function nextId(): string {
  _seq += 1
  return `att-${Date.now()}-${_seq}`
}

/**
 * @param onSend  the terminal text-send (`termRef.current?.send`) — receives the
 *                injected prompt WITHOUT a trailing Enter.
 * @param onSent  optional: called after a successful inject (e.g. focus the term
 *                so the soft keyboard stays / comes up to add context).
 */
export function useAttachmentUpload(
  onSend: (text: string) => void,
  onSent?: () => void,
): UseAttachmentUploadResult {
  const { toast } = useToast()
  const [attachments, setAttachments] = React.useState<Attachment[]>([])

  // Keep object-URLs to revoke on unmount so previews don't leak.
  const urlsRef = React.useRef<Set<string>>(new Set())
  React.useEffect(() => {
    const urls = urlsRef.current
    return () => {
      for (const u of urls) URL.revokeObjectURL(u)
    }
  }, [])

  const dismiss = React.useCallback((id: string) => {
    setAttachments((list) => {
      const target = list.find((a) => a.id === id)
      if (target?.previewUrl) {
        URL.revokeObjectURL(target.previewUrl)
        urlsRef.current.delete(target.previewUrl)
      }
      return list.filter((a) => a.id !== id)
    })
  }, [])

  const handleFiles = React.useCallback(
    (files: File[]) => {
      if (files.length === 0) return

      // 1. Optimistic chips — one per file, with an image thumbnail where we can.
      const rows: { att: Attachment; file: File }[] = files.map((file) => {
        let previewUrl: string | null = null
        if (file.type.startsWith('image/')) {
          previewUrl = URL.createObjectURL(file)
          urlsRef.current.add(previewUrl)
        }
        return {
          att: { id: nextId(), name: file.name, uploading: true, previewUrl },
          file,
        }
      })
      setAttachments((list) => [...list, ...rows.map((r) => r.att)])

      // 2. Upload all in parallel; settle so a single failure doesn't abort the
      //    rest, but we only inject when EVERY file resolved (the sentence quotes
      //    all of them at once).
      Promise.allSettled(rows.map((r) => uploadForPrompt(r.file))).then(
        (results) => {
          const ok: UploadResult[] = []
          const failed: string[] = []
          results.forEach((res, i) => {
            const { id } = rows[i].att
            if (res.status === 'fulfilled') {
              ok.push(res.value)
              setAttachments((list) =>
                list.map((a) =>
                  a.id === id ? { ...a, uploading: false } : a,
                ),
              )
            } else {
              const message =
                res.reason instanceof Error
                  ? res.reason.message
                  : 'Upload failed.'
              failed.push(message)
              setAttachments((list) =>
                list.map((a) =>
                  a.id === id
                    ? { ...a, uploading: false, error: message }
                    : a,
                ),
              )
            }
          })

          if (failed.length > 0) {
            toast({
              message:
                failed.length === 1
                  ? failed[0]
                  : `${failed.length} files couldn’t be uploaded.`,
              tone: 'error',
            })
          }

          // Inject only when nothing failed — a partial batch would quote a
          // subset and confuse the user about what's attached.
          if (ok.length > 0 && failed.length === 0) {
            onSend(buildAttachmentPrompt(ok.map((r) => r.path)))
            onSent?.()
          }
        },
      )
    },
    [onSend, onSent, toast],
  )

  return { attachments, handleFiles, dismiss }
}
