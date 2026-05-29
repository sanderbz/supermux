// A2HSInstructionsSheet — M23b (TECH_PLAN §4.9 / §10).
//
// iOS Safari has no `beforeinstallprompt` event and no install button: the only
// way to install a PWA is the manual Share → "Add to Home Screen" flow. This
// half-detent Vaul sheet teaches that flow. It is shown ONCE, on the first
// iOS-Safari load that is NOT already standalone; the dismissal is remembered in
// localStorage so it never nags.
//
// Voice + visuals follow the M28 brand: sentence case, builder-to-builder, no
// cheerleading. The two steps use the actual iOS Share + Add icons rendered
// inline (monochrome, currentColor) — no screenshot images to ship or break.

import * as React from 'react'
import { Drawer } from 'vaul'
import { motion, useReducedMotion } from 'framer-motion'
import { Share, SquarePlus, X } from 'lucide-react'

import { cn } from '@/lib/utils'
import { springs } from '@/lib/springs'
import { isIOS } from '@/lib/ios-splash'
import { isStandalone } from '@/hooks/use-standalone-mode'

const DISMISS_KEY = 'supermux-a2hs-dismissed'

/**
 * True on an iOS Safari tab that is not yet an installed PWA AND has not been
 * dismissed before. Drives whether the sheet auto-opens on boot.
 */
export function isIOSSafariNotStandalone(): boolean {
  if (!isIOS() || isStandalone()) return false
  // In-app browsers (the embedded WebViews of other apps) cannot Add to Home
  // Screen — only real Safari can. Skip the prompt there.
  const ua = navigator.userAgent
  const inAppBrowser = /(FBAN|FBAV|Instagram|Line|Twitter|GSA)/.test(ua)
  if (inAppBrowser) return false
  try {
    return localStorage.getItem(DISMISS_KEY) == null
  } catch {
    return false
  }
}

function rememberDismissed() {
  try {
    localStorage.setItem(DISMISS_KEY, String(Date.now()))
  } catch {
    /* private mode — fine, it just shows again next session */
  }
}

interface StepProps {
  index: number
  icon: React.ReactNode
  children: React.ReactNode
}

function Step({ index, icon, children }: StepProps) {
  return (
    <li className="flex items-center gap-3">
      <span
        aria-hidden
        className="flex size-7 shrink-0 items-center justify-center rounded-full bg-secondary text-[13px] font-semibold text-muted-foreground"
      >
        {index}
      </span>
      <span className="flex min-w-0 flex-1 items-center gap-2 text-[15px] leading-snug text-foreground">
        {children}
        <span
          aria-hidden
          className="flex size-8 shrink-0 items-center justify-center rounded-lg border border-border bg-card text-foreground"
        >
          {icon}
        </span>
      </span>
    </li>
  )
}

/**
 * The "Add to Home Screen" coaching sheet. Render it unconditionally near the
 * app root — it self-gates: `open` defaults to `isIOSSafariNotStandalone()`.
 */
export function A2HSInstructionsSheet() {
  const reduceMotion = useReducedMotion()
  // Decide once, lazily — `isIOSSafariNotStandalone()` reads only browser APIs
  // (navigator + localStorage), so it is safe at first render and needs no
  // effect. A non-iOS / standalone / already-dismissed load starts closed.
  const [open, setOpen] = React.useState(isIOSSafariNotStandalone)

  function handleOpenChange(next: boolean) {
    setOpen(next)
    if (!next) rememberDismissed()
  }

  // modal={false} — a MODAL Vaul/Radix drawer sets `pointer-events: none` on
  // <body> and mounts a focus-trap; iOS WebKit's transformed / backdrop-filter
  // ancestors (the focus route's translate wrapper, every `.glass` surface) turn
  // that into DEAD TAPS, so "Got it" / the X close became unclickable on iPhone.
  // Non-modal keeps the dimmed overlay but lets taps reach the buttons — the same
  // decision the focus `MobileSheet` already makes ("don't lock the rest of app").
  return (
    <Drawer.Root open={open} onOpenChange={handleOpenChange} modal={false}>
      <Drawer.Portal>
        <Drawer.Overlay className="fixed inset-0 z-[70] bg-black/40" />
        <Drawer.Content
          aria-describedby="a2hs-desc"
          className={cn(
            'glass fixed inset-x-0 bottom-0 z-[70] flex flex-col rounded-t-[10px]',
            'border-t border-border/60 pb-safe outline-none',
          )}
        >
          {/* Drag indicator — 36×5, 2.5px radius, tertiary tint (Termius #11). */}
          <div className="mx-auto mt-1.5 h-[5px] w-9 shrink-0 rounded-[2.5px] bg-muted-foreground/30" />

          <motion.div
            initial={reduceMotion ? false : { opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            transition={reduceMotion ? { duration: 0 } : springs.cardExpand}
            className="px-5 pb-6 pt-3"
          >
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <Drawer.Title className="text-[17px] font-semibold tracking-tight">
                  Install supermux on your home screen
                </Drawer.Title>
                <p
                  id="a2hs-desc"
                  className="mt-1 text-[14px] leading-snug text-muted-foreground"
                >
                  Launches full-screen, no browser chrome — the same agents,
                  one tap away.
                </p>
              </div>
              <Drawer.Close
                aria-label="Dismiss"
                className="flex size-8 shrink-0 items-center justify-center rounded-lg text-muted-foreground hover:text-foreground"
              >
                <X className="size-5" />
              </Drawer.Close>
            </div>

            <ol className="mt-5 flex flex-col gap-3">
              <Step index={1} icon={<Share className="size-4" />}>
                <span className="flex-1">
                  Tap the Share button in Safari's toolbar
                </span>
              </Step>
              <Step index={2} icon={<SquarePlus className="size-4" />}>
                <span className="flex-1">
                  Choose <span className="font-medium">Add to Home Screen</span>
                </span>
              </Step>
            </ol>

            <button
              type="button"
              onClick={() => handleOpenChange(false)}
              className="mt-6 h-11 w-full rounded-xl bg-primary text-[15px] font-semibold text-primary-foreground active:opacity-90"
            >
              Got it
            </button>
          </motion.div>
        </Drawer.Content>
      </Drawer.Portal>
    </Drawer.Root>
  )
}
