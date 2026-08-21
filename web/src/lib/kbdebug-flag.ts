// KBDEBUG — the flag-gated iOS-composer runtime probe (dev/device only).
//
// The offline screenshot rig cannot render the real iOS soft keyboard, so the
// black-bar / composer-pinning behaviour can only be observed on a real device.
// This flag turns on a READ-ONLY overlay (components/dev/kbdebug-overlay.tsx)
// that dumps the live visualViewport + CSS-var + composer-ancestor state so a
// single on-device screenshot is self-explanatory.
//
// ZERO-RISK CONTRACT — the overlay must be completely inert for normal users:
//   · gated on an explicit opt-in (URL `?kbdebug=1` OR `localStorage.kbdebug`),
//     read ONCE at shell mount — absent ⇒ the overlay never mounts and does no
//     work (no listeners, no measurement, no timers).
//   · code-split: the overlay component is a `React.lazy` dynamic import, so its
//     code lands in its OWN chunk and never enters the entry/main bundle a
//     normal cold load pays for.
//
// Pure decision function, read once at mount — never a live subscription.

/** Read the kbdebug opt-in ONCE. True iff `?kbdebug=1` is in the URL query OR
 *  `localStorage.kbdebug === '1'`. Fully guarded: any absent/throwing global
 *  (SSR, privacy-mode storage) yields `false` — the inert default. */
export function kbdebugFlagOn(): boolean {
  if (typeof window === 'undefined') return false
  try {
    if (new URLSearchParams(window.location.search).get('kbdebug') === '1') {
      return true
    }
  } catch {
    // malformed search string — fall through to storage
  }
  try {
    if (window.localStorage.getItem('kbdebug') === '1') return true
  } catch {
    // storage blocked (Safari private mode / disabled) — treat as off
  }
  return false
}
