// M23b — iOS PWA launch-splash <link> injection (TECH_PLAN §4.9 / §10).
//
// iOS Safari ignores the manifest `background_color` for the launch screen of a
// home-screen PWA: it requires per-device `<link rel="apple-touch-startup-image">`
// tags, each gated by a device-specific media query. There are ~14 of them, so
// rather than bloat index.html we inject them once at runtime — only when the
// app is actually running on iOS (a no-op everywhere else).
//
// The PNGs are pre-rendered by scripts/build-splash.mjs into public/splash/ and
// share the EXACT #0a0a0a field of globals.css `--background`, so the splash →
// first-frame-paint transition has no flash of a wrong color (M23b acceptance).
// The device table here MUST stay in sync with that script's DEVICES list.

interface SplashDevice {
  /** Logical (CSS) width in points. */
  w: number
  /** Logical (CSS) height in points. */
  h: number
  /** devicePixelRatio the device reports. */
  ratio: number
}

// Logical size + DPR for each iPhone family. The pixel filename is w*ratio ×
// h*ratio, matching scripts/build-splash.mjs output.
const DEVICES: SplashDevice[] = [
  { w: 430, h: 932, ratio: 3 }, // 16/15/14 Pro Max — 1290×2796
  { w: 393, h: 852, ratio: 3 }, // 16/16 Pro/15/15 Pro/14 Pro — 1179×2556
  { w: 390, h: 844, ratio: 3 }, // 14/13/13 Pro/12/12 Pro — 1170×2532
  { w: 428, h: 926, ratio: 3 }, // 14 Plus/13 Pro Max/12 Pro Max — 1284×2778
  { w: 360, h: 780, ratio: 3 }, // 13 mini/12 mini — 1080×2340
  { w: 414, h: 896, ratio: 2 }, // 11/XR — 828×1792
  { w: 375, h: 667, ratio: 2 }, // SE 2/3, 8 — 750×1334
]

/** True on iOS / iPadOS Safari (incl. iPad masquerading as desktop Safari). */
export function isIOS(): boolean {
  if (typeof navigator === 'undefined') return false
  const ua = navigator.userAgent
  const iOSDevice = /iPad|iPhone|iPod/.test(ua)
  // iPadOS 13+ reports a Mac UA; disambiguate by touch support.
  const iPadOS = navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1
  return iOSDevice || iPadOS
}

/**
 * Inject the per-device `apple-touch-startup-image` links into <head>. Safe to
 * call once at boot — a no-op off-iOS and idempotent (guards on a marker attr).
 */
export function injectIOSSplashLinks(): void {
  if (typeof document === 'undefined' || !isIOS()) return
  if (document.head.querySelector('link[data-ios-splash]')) return

  const base = import.meta.env.BASE_URL.replace(/\/$/, '')
  for (const { w, h, ratio } of DEVICES) {
    for (const portrait of [true, false]) {
      const cssW = portrait ? w : h
      const cssH = portrait ? h : w
      const pxW = Math.round(cssW * ratio)
      const pxH = Math.round(cssH * ratio)
      const link = document.createElement('link')
      link.rel = 'apple-touch-startup-image'
      link.setAttribute('data-ios-splash', '')
      link.media =
        `(device-width: ${cssW}px) and (device-height: ${cssH}px) ` +
        `and (-webkit-device-pixel-ratio: ${ratio}) ` +
        `and (orientation: ${portrait ? 'portrait' : 'landscape'})`
      link.href = `${base}/splash/apple-splash-${pxW}-${pxH}.png`
      document.head.appendChild(link)
    }
  }
}
