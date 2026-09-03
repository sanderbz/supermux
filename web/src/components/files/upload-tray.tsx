// The upload tray — the only surface a large upload gets, and deliberately NOT
// a modal.
//
// A 9 GB file takes minutes. A dialog that blocks the Files browser for those
// minutes would make the feature worse than the 200 MB one it replaces, so this
// is a docked, collapsible tray: bottom-right on desktop, a full-width sheet
// above the tab bar on a phone (`pb-safe`, the home-indicator lesson every
// bottom-anchored surface here has already learned). Browsing, opening files
// and navigating all continue underneath it.
//
// Every row says something true: bytes of bytes, a live speed, an ETA, and
// `Verifying…` for the window where the bytes are all in but the server is
// still hashing them — the state that stops a 10 GB file looking frozen at
// 100 %. Failures show the SERVER's sentence ("not enough free space — …"),
// never "Upload failed".

import * as React from 'react'
import {
  CheckCircle2,
  ChevronDown,
  ChevronUp,
  RotateCw,
  TriangleAlert,
  Upload,
  X,
} from 'lucide-react'

import { cn } from '@/lib/utils'
import {
  headline,
  percent,
  statusLine,
  summarize,
  uploads,
  type UploadItem,
} from '@/lib/upload/manager'

/** Subscribe to the module-singleton manager. `useSyncExternalStore` rather
 *  than a store library: the manager already IS the store, and this path must
 *  not pull a dependency onto the Files chunk. */
export function useUploads(): UploadItem[] {
  return React.useSyncExternalStore(uploads.subscribe, uploads.getSnapshot, uploads.getSnapshot)
}

/** Rows that have finished disappear on their own after this long, so the tray
 *  empties itself instead of collecting receipts. */
const FADE_MS = 6000

export function UploadTray() {
  const items = useUploads()
  const [collapsed, setCollapsed] = React.useState(false)
  const resumeInput = React.useRef<HTMLInputElement>(null)
  const [resumeKey, setResumeKey] = React.useState<string | null>(null)

  React.useEffect(() => {
    void uploads.hydrate()
  }, [])

  // Auto-dismiss the done rows. Cancelled and failed rows STAY — a failure the
  // person never saw is a failure that silently ate their file.
  React.useEffect(() => {
    const done = items.filter((i) => i.state === 'done')
    if (!done.length) return
    const timers = done.map((i) => setTimeout(() => uploads.dismiss(i.key), FADE_MS))
    return () => timers.forEach(clearTimeout)
  }, [items])

  if (!items.length) return null

  const s = summarize(items)
  const title = headline(s)

  return (
    <>
      <div
        role="region"
        aria-label="Uploads"
        data-testid="upload-tray"
        className={cn(
          'glass fixed z-40 border border-hairline shadow-lg',
          // Phone: a full-width sheet parked ABOVE the tab bar. The shell's
          // mobile tab bar is an in-flow row (min-h-14 + the safe-area pad,
          // layout.tsx), not a fixed bar, so `bottom-0` would sit on top of
          // primary navigation for the whole upload — measured in review. The
          // nav already owns the safe-area inset, so the sheet does not add it.
          // Desktop: a docked card in the corner, never wider than a third of
          // the viewport.
          'inset-x-0 bottom-[calc(3.5rem+env(safe-area-inset-bottom))] rounded-t-xl',
          'md:inset-x-auto md:bottom-4 md:right-4 md:w-96 md:rounded-xl',
        )}
      >
        <button
          type="button"
          onClick={() => setCollapsed((c) => !c)}
          aria-expanded={!collapsed}
          className="flex h-11 w-full items-center gap-2 px-3 text-left"
        >
          <Upload className="size-4 shrink-0 text-muted-foreground" />
          <span className="min-w-0 flex-1 truncate text-xs font-medium">{title}</span>
          {s.speed ? (
            <span className="shrink-0 tabular-nums text-[11px] text-muted-foreground">
              {formatRate(s.speed)}
            </span>
          ) : null}
          {collapsed ? (
            <ChevronUp className="size-4 shrink-0 text-muted-foreground" />
          ) : (
            <ChevronDown className="size-4 shrink-0 text-muted-foreground" />
          )}
        </button>

        {!collapsed && (
          <ul className="max-h-[45vh] overflow-y-auto border-t border-hairline md:max-h-80">
            {items.map((item) => (
              <UploadRow
                key={item.key}
                item={item}
                onPickResume={() => {
                  setResumeKey(item.key)
                  resumeInput.current?.click()
                }}
              />
            ))}
          </ul>
        )}
      </div>

      {/* The re-pick input for a reload-resumed upload. A browser cannot
          persist a File handle, so resuming genuinely requires the person to
          choose the same file again — and the manager refuses anything whose
          name and size don't match. */}
      <input
        ref={resumeInput}
        type="file"
        hidden
        onChange={(e) => {
          const file = e.target.files?.[0]
          if (file && resumeKey) uploads.resumeWith(resumeKey, file)
          e.target.value = ''
          setResumeKey(null)
        }}
      />
    </>
  )
}

function UploadRow({ item, onPickResume }: { item: UploadItem; onPickResume: () => void }) {
  const pct = percent(item.offset, item.size)
  const failed = item.state === 'failed'
  const done = item.state === 'done'
  const active =
    item.state === 'uploading' || item.state === 'queued' || item.state === 'initializing'

  return (
    <li className="flex items-start gap-2 border-b border-hairline px-3 py-2 last:border-b-0">
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-1.5">
          {done && <CheckCircle2 className="size-3.5 shrink-0 text-emerald-500" />}
          {failed && <TriangleAlert className="size-3.5 shrink-0 text-destructive" />}
          <span className="min-w-0 flex-1 truncate text-xs font-medium">{item.name}</span>
        </div>
        <p
          className={cn(
            'mt-0.5 truncate text-[11px] tabular-nums',
            failed ? 'text-destructive' : 'text-muted-foreground',
          )}
        >
          {statusLine(item)}
        </p>
        {(active || item.state === 'verifying') && (
          <div
            className="mt-1.5 h-1 overflow-hidden rounded-full bg-muted"
            role="progressbar"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={Math.round(pct)}
            aria-label={`${item.name} upload progress`}
          >
            <div
              className={cn(
                'h-full rounded-full bg-primary transition-[width] duration-300',
                // At 100 % with the server still hashing, a pulse says "working"
                // where a full static bar would say "stuck".
                item.state === 'verifying' && 'animate-pulse',
              )}
              style={{ width: `${item.state === 'verifying' ? 100 : pct}%` }}
            />
          </div>
        )}
      </div>

      <div className="flex shrink-0 items-center gap-0.5">
        {item.state === 'resumable' && (
          <button
            type="button"
            onClick={onPickResume}
            aria-label={`Resume ${item.name}`}
            className="flex size-8 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
          >
            <RotateCw className="size-3.5" />
          </button>
        )}
        {failed && (
          <button
            type="button"
            onClick={() => uploads.retry(item.key)}
            aria-label={`Retry ${item.name}`}
            className="flex size-8 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
          >
            <RotateCw className="size-3.5" />
          </button>
        )}
        <button
          type="button"
          onClick={() => (active || item.state === 'verifying' ? uploads.cancel(item.key) : uploads.dismiss(item.key))}
          aria-label={
            active || item.state === 'verifying' ? `Cancel ${item.name}` : `Dismiss ${item.name}`
          }
          className="flex size-8 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
        >
          <X className="size-3.5" />
        </button>
      </div>
    </li>
  )
}

function formatRate(bytesPerSec: number): string {
  const units = ['B', 'KB', 'MB', 'GB']
  let v = bytesPerSec
  let i = 0
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024
    i += 1
  }
  return `${v.toFixed(v >= 100 || i === 0 ? 0 : 1)} ${units[i]}/s`
}
