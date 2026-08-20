// "Reload to update" — the shell affordance for adopting a freshly deployed
// bundle.
//
// Renders nothing until a new app shell is WAITING (see `lib/sw-update.ts`).
// When one is, and the app was not idle enough to adopt it silently, this shows
// a single glass pill, bottom-center, with a one-tap Reload that ACTUALLY works:
// it calls `adopt()`, which posts SKIP_WAITING to the waiting worker and reloads
// the page onto the new bundle. The pill is not dismissable and does not
// auto-hide — it is the honest, resolvable end of the update: one tap adopts the
// new version, the reload lands, nothing is waiting any more, and the pill is
// gone. (The composer's drafts persist to sessionStorage, so even this tap loses
// no typed text; the idle-guard already kept us from reloading unprompted while
// the user was mid-message.)
//
// Mounted once in `App`, next to <PushBridge/>. Styled with utility classes (not
// inline-style objects) so its weight lands in the shared CSS the app already
// ships, not the JS budget.

import { useSyncExternalStore } from 'react'

import { adopt, getSWUpdateWaiting, subscribeSWUpdate } from '@/lib/sw-update'

export function SWUpdatePrompt() {
  const waiting = useSyncExternalStore(
    subscribeSWUpdate,
    getSWUpdateWaiting,
    // Server snapshot: never waiting during SSR / first paint.
    () => false,
  )

  if (!waiting) return null

  return (
    <div
      role="status"
      aria-live="polite"
      className="pointer-events-none fixed inset-x-0 bottom-[calc(env(safe-area-inset-bottom)+16px)] z-[9998] flex justify-center"
    >
      <div className="glass pointer-events-auto flex h-10 max-w-[min(92vw,420px)] items-center gap-2.5 rounded-full border border-white/10 pl-4 pr-1.5 text-[13px] font-semibold text-white shadow-[0_8px_28px_-10px_rgba(0,0,0,0.55)]">
        <span
          aria-hidden
          className="size-2 shrink-0 rounded-full bg-status-active shadow-[0_0_8px_hsl(var(--status-active))]"
        />
        <span className="truncate">A new version is ready</span>
        <button
          type="button"
          onClick={() => adopt()}
          className="-my-0.5 flex min-h-11 shrink-0 items-center"
        >
          <span className="flex h-[30px] items-center rounded-[15px] bg-white/15 px-3.5 text-[13px] font-semibold text-white">
            Reload to update
          </span>
        </button>
      </div>
    </div>
  )
}
