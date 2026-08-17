/**
 * The consequential confirm (B5/T9.3) — and the replacement for the last
 * `window.confirm` in the app.
 *
 * ── Why a dialog and not the armed button ───────────────────────────────────
 * T9 splits destructive actions in two:
 *
 * * **Destructive and cheap** — archiving a tile, deleting a host, removing an
 *   MCP entry. These get `<ArmedButton>`: two presses, no modal, no reading.
 * * **Destructive and consequential** — killing a team LEAD (which takes every
 *   teammate down with it) or switching to Bypass (which relaunches the
 *   session). These need the user to READ something before acting, and a
 *   two-press button gives them nothing to read.
 *
 * ── Why promise-based ───────────────────────────────────────────────────────
 * `window.confirm` is synchronous and blocking, so every call site is written
 * as `if (!confirm(...)) return`. A component-shaped dialog would force each of
 * those into a state machine — an open flag, a pending action, a callback — and
 * four hand-rolled state machines is exactly the sprawl this task exists to
 * remove. `useConfirm()` returns a promise, so a call site changes by one
 * `await` and keeps its shape.
 *
 * What it does NOT keep is `window.confirm`'s behaviour of blocking the whole
 * tab, its unstyleable OS chrome, and its inability to render more than a
 * string — which is why the consequence enumeration was impossible before.
 */
import * as React from 'react'

import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import type { ConfirmCopy } from '@/brand/copy'

/** What a consequential confirm shows: the standard copy, plus an optional
 *  enumeration of what the action touches (T7's disposition language). */
export interface ConfirmRequest extends ConfirmCopy {
  /** Bullet lines under the body — the consequences, named. */
  consequences?: readonly string[]
}

type Resolver = (ok: boolean) => void

const ConfirmContext = React.createContext<
  ((req: ConfirmRequest) => Promise<boolean>) | null
>(null)

/**
 * Ask for confirmation. Resolves `true` if the user confirmed.
 *
 * Falls back to `window.confirm` ONLY when no provider is mounted, which can
 * only happen in a test rendering a component in isolation. Silently resolving
 * `false` there would make a destructive action look broken; silently resolving
 * `true` would make it fire unasked. Neither is acceptable, so the fallback is
 * the old behaviour, and the lint gate exempts this one line by path.
 */
export function useConfirm(): (req: ConfirmRequest) => Promise<boolean> {
  const ctx = React.useContext(ConfirmContext)
  return React.useMemo(
    () =>
      ctx ??
      ((req: ConfirmRequest) =>
        Promise.resolve(
          globalThis.confirm?.(`${req.title}\n\n${req.body}`) ?? false,
        )),
    [ctx],
  )
}

/** Mount once, near the root. Renders at most one dialog at a time. */
export function ConfirmDialogProvider({
  children,
}: {
  children: React.ReactNode
}) {
  const [request, setRequest] = React.useState<ConfirmRequest | null>(null)
  const resolver = React.useRef<Resolver | null>(null)

  const confirm = React.useCallback((req: ConfirmRequest) => {
    return new Promise<boolean>((resolve) => {
      // A second ask while one is open resolves the first as CANCELLED rather
      // than dropping its promise on the floor — an un-resolved promise would
      // leave the caller's `await` hanging forever, and the caller is usually
      // holding a busy flag.
      resolver.current?.(false)
      resolver.current = resolve
      setRequest(req)
    })
  }, [])

  const settle = React.useCallback((ok: boolean) => {
    const resolve = resolver.current
    resolver.current = null
    setRequest(null)
    resolve?.(ok)
  }, [])

  return (
    <ConfirmContext.Provider value={confirm}>
      {children}
      <Dialog
        open={request !== null}
        // Escape, the scrim and the close button all route here, and all of
        // them mean "no". Defaulting a dismissal to anything else is how
        // destructive dialogs become traps.
        onOpenChange={(open) => {
          if (!open) settle(false)
        }}
      >
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>{request?.title}</DialogTitle>
            <DialogDescription>{request?.body}</DialogDescription>
          </DialogHeader>
          {request?.consequences?.length ? (
            <ul className="flex list-disc flex-col gap-1 pl-5 text-[13px] text-muted-foreground">
              {request.consequences.map((line) => (
                <li key={line}>{line}</li>
              ))}
            </ul>
          ) : null}
          <DialogFooter className="gap-2 sm:gap-2">
            <button
              type="button"
              onClick={() => settle(false)}
              className="inline-flex h-9 items-center justify-center rounded-md px-3 text-sm font-medium text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              {request?.cancel ?? 'Cancel'}
            </button>
            <button
              type="button"
              onClick={() => settle(true)}
              className="inline-flex h-9 items-center justify-center rounded-md bg-destructive px-3 text-sm font-medium text-destructive-foreground hover:bg-destructive/90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              {request?.confirm ?? 'Confirm'}
            </button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </ConfirmContext.Provider>
  )
}
