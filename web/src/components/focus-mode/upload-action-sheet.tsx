// UploadActionSheet — the native-feeling action sheet behind the dock's 📎 chip.
//
// Reuses the shared `<MobileActionSheet>` Vaul shell (backdrop tap-away, drag-
// down dismiss, focus-trap, safe-area) and offers the three iOS-native pickers:
//   • Camera        — <input capture="environment" accept="image/*">
//   • Photo Library — <input accept="image/*" multiple>
//   • Files         — <input accept="*"        multiple>
//
// Each row owns a hidden file input; tapping the row clicks it. On selection we
// hand the files to `onFiles` and close — the upload + prompt-injection is driven
// by the parent's `useAttachmentUpload`.

import * as React from 'react'
import { motion } from 'framer-motion'
import { Camera, Image as ImageIcon, FolderOpen } from 'lucide-react'

import { cn } from '@/lib/utils'
import { springs } from '@/lib/springs'
import { MobileActionSheet } from './mobile-action-sheet'

export interface UploadActionSheetProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** Selected files → parent uploads them + injects the prompt. */
  onFiles: (files: File[]) => void
}

export function UploadActionSheet({
  open,
  onOpenChange,
  onFiles,
}: UploadActionSheetProps) {
  const cameraRef = React.useRef<HTMLInputElement | null>(null)
  const photosRef = React.useRef<HTMLInputElement | null>(null)
  const filesRef = React.useRef<HTMLInputElement | null>(null)

  const onPicked = React.useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const picked = Array.from(e.target.files ?? [])
      // Reset so re-picking the SAME file still fires `change`.
      e.target.value = ''
      if (picked.length) {
        onFiles(picked)
        onOpenChange(false)
      }
    },
    [onFiles, onOpenChange],
  )

  return (
    <MobileActionSheet open={open} onOpenChange={onOpenChange} title="Attach a file">
      <div className="flex flex-col gap-2 px-4 pb-4 pt-1">
        <Row
          icon={Camera}
          label="Camera"
          onClick={() => cameraRef.current?.click()}
        />
        <Row
          icon={ImageIcon}
          label="Photo library"
          onClick={() => photosRef.current?.click()}
        />
        <Row
          icon={FolderOpen}
          label="Files"
          onClick={() => filesRef.current?.click()}
        />
      </div>

      {/* Hidden native pickers — one per option (distinct accept/capture). */}
      <input
        ref={cameraRef}
        type="file"
        accept="image/*"
        capture="environment"
        className="hidden"
        onChange={onPicked}
      />
      <input
        ref={photosRef}
        type="file"
        accept="image/*"
        multiple
        className="hidden"
        onChange={onPicked}
      />
      <input
        ref={filesRef}
        type="file"
        accept="*"
        multiple
        className="hidden"
        onChange={onPicked}
      />
    </MobileActionSheet>
  )
}

function Row({
  icon: Icon,
  label,
  onClick,
}: {
  icon: typeof Camera
  label: string
  onClick: () => void
}) {
  return (
    <motion.button
      type="button"
      onClick={onClick}
      whileTap={{ scale: 0.98 }}
      transition={springs.buttonPress}
      className={cn(
        // ≥44pt row (h-14), 10px continuous corner, soft card fill — iOS-native.
        'flex h-14 items-center gap-3 rounded-[10px] bg-card px-4',
        'text-[15px] font-medium text-foreground active:bg-secondary',
      )}
    >
      <span className="flex size-9 shrink-0 items-center justify-center rounded-[10px] bg-secondary text-primary">
        <Icon className="size-5" strokeWidth={1.75} aria-hidden />
      </span>
      {label}
    </motion.button>
  )
}

export default UploadActionSheet
