// iOS PWA splash-screen generator.
//
// iOS Safari does not read the manifest `background_color` for the launch
// screen of a home-screen PWA — it needs a per-device <link rel="apple-touch-
// startup-image"> PNG matched by a media query. This script renders one PNG per
// supported iPhone size: a #0a0a0a field (identical to globals.css --background
// and the manifest background_color, so there is NO flash of a wrong color)
// with the amber app icon centered.
//
// Run: `node scripts/build-splash.mjs` (needs `rsvg-convert` on PATH).
// Output: web/public/splash/apple-splash-<w>-<h>.png. Re-run after the icon
// changes; the generated files are committed (the build does not regenerate).
//
// The device list + media queries are mirrored in src/lib/ios-splash.ts so the
// runtime <link> tags and the rendered files never drift.

import { execFileSync } from 'node:child_process'
import { mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const publicDir = join(here, '..', 'public')
const outDir = join(publicDir, 'splash')

// Portrait device pixel sizes (width × height) covering iPhone SE → 16 Pro Max,
// including the notch (12/13/14) and Dynamic Island (14 Pro/15/16) families.
// Both orientations are emitted so a landscape launch is also covered.
const DEVICES = [
  [1290, 2796], // iPhone 16 Pro Max / 15 Pro Max / 14 Pro Max
  [1179, 2556], // iPhone 16 Pro / 16 / 15 Pro / 15 / 14 Pro
  [1170, 2532], // iPhone 14 / 13 / 13 Pro / 12 / 12 Pro
  [1284, 2778], // iPhone 14 Plus / 13 Pro Max / 12 Pro Max
  [1080, 2340], // iPhone 13 mini / 12 mini
  [828, 1792], // iPhone 11 / XR
  [750, 1334], // iPhone SE (2nd/3rd gen) / 8
]

const BG = '#0a0a0a'
const AMBER = '#f6ae31'

// One splash SVG: dark field + centered icon mark (chevron + cursor block),
// sized to ~22% of the shorter edge so it reads on every device.
function splashSvg(w, h) {
  const cx = w / 2
  const cy = h / 2
  const mark = Math.round(Math.min(w, h) * 0.22)
  const half = mark / 2
  // Icon path coordinates are the icon.svg geometry, scaled into `mark`.
  const s = mark / 512
  const px = (x) => cx - half + x * s
  const py = (y) => cy - half + y * s
  const stroke = Math.round(44 * s)
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">
  <rect width="${w}" height="${h}" fill="${BG}"/>
  <path d="M${px(148)} ${py(176)} L${px(260)} ${py(256)} L${px(148)} ${py(336)}"
        fill="none" stroke="${AMBER}" stroke-width="${stroke}"
        stroke-linecap="round" stroke-linejoin="round"/>
  <rect x="${px(278)}" y="${py(300)}" width="${86 * s}" height="${40 * s}" rx="${8 * s}" fill="${AMBER}"/>
</svg>`
}

rmSync(outDir, { recursive: true, force: true })
mkdirSync(outDir, { recursive: true })

for (const [w, h] of DEVICES) {
  for (const [pw, ph] of [
    [w, h],
    [h, w],
  ]) {
    const name = `apple-splash-${pw}-${ph}.png`
    const tmp = join(outDir, `.${name}.svg`)
    writeFileSync(tmp, splashSvg(pw, ph))
    execFileSync('rsvg-convert', ['-w', String(pw), '-h', String(ph), '-o', join(outDir, name), tmp])
    rmSync(tmp)
    console.log(`splash → ${name}`)
  }
}
console.log(`done — ${DEVICES.length * 2} splash images in public/splash/`)
