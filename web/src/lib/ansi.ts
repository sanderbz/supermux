// ANSI → styled segments — the static / expanded tile preview's colour path.
//
// The live terminal (xterm) parses ANSI itself; the *static* preview renders
// `preview_lines` as plain DOM, so it needs its own small SGR parser to show the
// agent's real terminal colours instead of flat grey text. This is a deliberate
// subset: SGR (`ESC[…m`) only — colour + bold/dim/italic/underline + the xterm
// 16 / 256 / truecolour spaces. Cursor moves and other CSI sequences are dropped
// (the preview is a frozen tail, not a live screen).
//
// PRINCIPLE: no hardcoded theme hex for the *foreground* default — that tracks
// the `--terminal-fg` token via CSS. The 16 ANSI base colours use the standard
// xterm palette (these ARE the terminal's colours, not app chrome).
//
// THEME. The preview does not always render on `--terminal-bg`: the tile and
// roster previews paint agent output straight onto the CARD, which is white in
// light theme. A palette tuned for a near-black surface lands at 1.5–2.9:1
// there — the light-theme audit counted 40 low-contrast rows on the overview
// alone, and lines like "⚠ Transcript saving is off" were effectively
// invisible. So colour is emitted so that CSS, not this parser, picks the
// theme:
//
//   · the 16 base colours become `var(--ansi-N)`, whose light and dark values
//     both live in globals.css (and which the live xterm palette reads too), so
//     a theme flip re-colours already-rendered output with no re-parse;
//   · 256-colour and truecolour values cannot be tokenised — an agent may emit
//     any of 16.7M — so they are emitted as `light-dark(<darkened>, <as sent>)`
//     where the first argument is the same colour walked down the sRGB ramp
//     until it clears 4.5:1 on a bright surface. `<html>` carries
//     `color-scheme` (theme-provider.tsx), so `light-dark()` resolves; on an
//     engine too old to know the function the declaration is simply dropped and
//     the run inherits `--terminal-fg`, which is legible in both themes.

import type * as React from 'react'

/** One run of text sharing a single computed style. */
export interface AnsiSegment {
  text: string
  /** Inline style; empty object = inherit (default fg, no decoration). */
  style: React.CSSProperties
  /**
   * SGR 2 (dim) was in force for this run.
   *
   * Exposed as a FLAG and not left to be inferred from `style.opacity`, because
   * one caller reads it as meaning rather than as looks: Claude Code 2.1.232
   * draws its model-PREDICTED next prompt in the composer dim, and the peek lens
   * has to tell that ghost apart from a sentence a human typed
   * (`peek-lens.ts` `readComposerDraft`). Deriving that from a rendering
   * constant would make a styling tweak silently change what the app believes
   * is unsent text.
   */
  dim: boolean
}

// The standard xterm 16-colour palette (normal 0-7, bright 8-15), in the DARK
// tuning. These are the real terminal colours an agent's output uses — not app
// design tokens — so they are intentionally literal. They double as the
// fallback for `var(--ansi-N)`, which keeps a headless render (unit tests,
// SSR) identical to what it was before the tokens existed. The LIGHT values
// live next to them in globals.css.
export const ANSI_16: readonly string[] = [
  '#1d1d1f', // 0 black  (nudged off pure-black so it's visible on the surface)
  '#ff6b5e', // 1 red
  '#3fc66b', // 2 green
  '#e0c050', // 3 yellow
  '#5b9dff', // 4 blue
  '#c678dd', // 5 magenta
  '#56c8d8', // 6 cyan
  '#c8c8cd', // 7 white
  '#6b6b70', // 8 bright black (grey)
  '#ff8a80', // 9 bright red
  '#69d98b', // 10 bright green
  '#f0d272', // 11 bright yellow
  '#82b6ff', // 12 bright blue
  '#d99ae8', // 13 bright magenta
  '#7adfeb', // 14 bright cyan
  '#f5f5f7', // 15 bright white
]

/** One of the sixteen base colours, as a theme-resolving CSS value. */
function ansiToken(i: number): string {
  return `var(--ansi-${i}, ${ANSI_16[i]})`
}

// ── Light-surface contrast clamp ────────────────────────────────────────────
// WCAG relative luminance, and the smallest uniform scale of an sRGB triple
// that reaches a target ratio against white. Scaling all three channels keeps
// the hue: a dim orange stays orange, it just gets darker. Used for the colour
// spaces that cannot be tokenised (256-colour cube, greys, truecolour).

/** WCAG 2.x relative luminance of an sRGB triple (0-255 per channel). */
function relativeLuminance(r: number, g: number, b: number): number {
  const f = (v: number) => {
    const s = v / 255
    return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4)
  }
  return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b)
}

/** Contrast ratio of an sRGB triple against pure white. */
export function contrastOnWhite(r: number, g: number, b: number): number {
  return 1.05 / (relativeLuminance(r, g, b) + 0.05)
}

/** The minimum WCAG AA ratio for text-sized output. */
export const AA_TEXT = 4.5

/**
 * Darken an sRGB triple just enough to clear `AA_TEXT` on a white surface,
 * preserving hue by scaling all three channels equally. Already-dark colours
 * are returned unchanged.
 */
export function clampToLightSurface(r: number, g: number, b: number): string {
  if (contrastOnWhite(r, g, b) >= AA_TEXT) return `rgb(${r}, ${g}, ${b})`
  let lo = 0
  let hi = 1
  for (let i = 0; i < 24; i++) {
    const mid = (lo + hi) / 2
    if (contrastOnWhite(r * mid, g * mid, b * mid) >= AA_TEXT) lo = mid
    else hi = mid
  }
  // Floor, not round: rounding can push a channel back UP across the bar the
  // search just cleared. Then walk down a step at a time in case the floor of a
  // barely-passing factor still lands short.
  let out: [number, number, number] = [
    Math.floor(r * lo),
    Math.floor(g * lo),
    Math.floor(b * lo),
  ]
  for (let i = 0; i < 8 && contrastOnWhite(...out) < AA_TEXT; i++) {
    out = [Math.max(0, out[0] - 1), Math.max(0, out[1] - 1), Math.max(0, out[2] - 1)]
  }
  return `rgb(${out[0]}, ${out[1]}, ${out[2]})`
}

/** Emit an arbitrary (untokenisable) terminal colour so BOTH themes read it:
 *  as sent on a dark surface, contrast-clamped on a light one. */
function themedColor(r: number, g: number, b: number): string {
  const asSent = `rgb(${r}, ${g}, ${b})`
  const clamped = clampToLightSurface(r, g, b)
  return clamped === asSent ? asSent : `light-dark(${clamped}, ${asSent})`
}

/** A colour exactly as the escape carried it, before any theme resolution.
 *  Kept unresolved until `toStyle` because whether a run may be re-tuned for a
 *  bright surface depends on whether it also carries a background. */
type Paint = { idx: number } | { rgb: [number, number, number] }

/** The colour as SENT — what a dark terminal surface shows. */
function verbatim(p: Paint): string {
  return 'idx' in p ? ANSI_16[p.idx] : `rgb(${p.rgb[0]}, ${p.rgb[1]}, ${p.rgb[2]})`
}

/** The colour as a value that resolves per theme (see the module header). */
function themed(p: Paint): string {
  return 'idx' in p ? ansiToken(p.idx) : themedColor(p.rgb[0], p.rgb[1], p.rgb[2])
}

/** Build the xterm 256-colour palette: 0-15 base, 16-231 cube, 232-255 greys. */
function xterm256(i: number): Paint {
  if (i < 16) return { idx: i }
  if (i < 232) {
    const n = i - 16
    const r = Math.floor(n / 36)
    const g = Math.floor((n % 36) / 6)
    const b = n % 6
    const c = (v: number) => (v === 0 ? 0 : 55 + v * 40)
    return { rgb: [c(r), c(g), c(b)] }
  }
  const v = 8 + (i - 232) * 10
  return { rgb: [v, v, v] }
}

// SGR matcher: ESC[ … m. Captured group = the `;`-separated parameter list.
// The literal ESC (\x1b) control char IS the thing we match — that's the whole
// point of an ANSI parser — so the no-control-regex lint is suppressed here.
// eslint-disable-next-line no-control-regex
const SGR_RE = /\x1b\[([0-9;]*)m/g
// Any other CSI sequence (cursor moves, erase, …) — stripped, not styled.
// eslint-disable-next-line no-control-regex
const CSI_RE = /\x1b\[[0-9;?]*[ -/]*[@-~]/g

interface SgrState {
  fg?: Paint
  bg?: Paint
  bold: boolean
  dim: boolean
  italic: boolean
  underline: boolean
  inverse: boolean
}

const FRESH: SgrState = {
  bold: false,
  dim: false,
  italic: false,
  underline: false,
  inverse: false,
}

/** Apply one SGR parameter list to `state`, mutating it in place. */
function applySgr(state: SgrState, params: number[]): void {
  for (let i = 0; i < params.length; i++) {
    const p = params[i]
    if (p === 0) {
      Object.assign(state, FRESH, { fg: undefined, bg: undefined })
    } else if (p === 1) state.bold = true
    else if (p === 2) state.dim = true
    else if (p === 3) state.italic = true
    else if (p === 4) state.underline = true
    else if (p === 7) state.inverse = true
    else if (p === 22) state.bold = state.dim = false
    else if (p === 23) state.italic = false
    else if (p === 24) state.underline = false
    else if (p === 27) state.inverse = false
    else if (p >= 30 && p <= 37) state.fg = { idx: p - 30 }
    else if (p === 39) state.fg = undefined
    else if (p >= 40 && p <= 47) state.bg = { idx: p - 40 }
    else if (p === 49) state.bg = undefined
    else if (p >= 90 && p <= 97) state.fg = { idx: p - 90 + 8 }
    else if (p >= 100 && p <= 107) state.bg = { idx: p - 100 + 8 }
    else if (p === 38 || p === 48) {
      // Extended colour: 38;5;n (256) or 38;2;r;g;b (truecolour).
      const target: 'fg' | 'bg' = p === 38 ? 'fg' : 'bg'
      const mode = params[i + 1]
      if (mode === 5 && params[i + 2] !== undefined) {
        state[target] = xterm256(params[i + 2])
        i += 2
      } else if (mode === 2 && params[i + 4] !== undefined) {
        state[target] = { rgb: [params[i + 2], params[i + 3], params[i + 4]] }
        i += 4
      }
    }
  }
}

/** Snapshot the current SGR state as an inline style. */
function toStyle(state: SgrState): React.CSSProperties {
  const style: React.CSSProperties = {}
  const fg = state.inverse ? state.bg : state.fg
  const bg = state.inverse ? state.fg : state.bg
  if (bg) {
    // A run that carries its OWN background was authored as a pair (`\e[44;97m`
    // — white on blue). Re-tuning half of that pair for a bright surface would
    // put dark ink on a dark fill, so a painted run is emitted exactly as sent
    // in both themes; it brings its own contrast with it.
    if (fg) style.color = verbatim(fg)
    style.backgroundColor = verbatim(bg)
  } else if (fg) {
    style.color = themed(fg)
  }
  if (state.bold) style.fontWeight = 600
  if (state.dim) style.opacity = 0.6
  if (state.italic) style.fontStyle = 'italic'
  if (state.underline) style.textDecoration = 'underline'
  return style
}

/** True when a string is worth ANSI-parsing (carries at least one ESC). */
export function hasAnsi(line: string): boolean {
  return line.includes('\x1b')
}

/**
 * Parse one line of (possibly ANSI-coloured) terminal output into styled runs.
 * Plain lines return a single inherit-styled segment, so the caller can render
 * uniformly. SGR state does NOT carry across lines — each line is a self-
 * contained tail row (the preview is anchored to the bottom and may drop the
 * line that opened a colour run).
 */
export function parseAnsiLine(line: string): AnsiSegment[] {
  if (!hasAnsi(line)) {
    return [{ text: line, style: {}, dim: false }]
  }
  const segments: AnsiSegment[] = []
  const state: SgrState = { ...FRESH }
  let cursor = 0
  SGR_RE.lastIndex = 0
  let m: RegExpExecArray | null
  while ((m = SGR_RE.exec(line)) !== null) {
    if (m.index > cursor) {
      segments.push({
        text: line.slice(cursor, m.index),
        style: toStyle(state),
        dim: state.dim,
      })
    }
    const params = m[1]
      .split(';')
      .map((s) => (s === '' ? 0 : Number.parseInt(s, 10)))
      .filter((n) => !Number.isNaN(n))
    applySgr(state, params.length ? params : [0])
    cursor = m.index + m[0].length
  }
  if (cursor < line.length) {
    segments.push({ text: line.slice(cursor), style: toStyle(state), dim: state.dim })
  }
  // Drop any non-SGR CSI noise that survived inside a segment's text.
  const cleaned = segments.map((s) => ({
    ...s,
    text: s.text.replace(CSI_RE, ''),
  }))
  const nonEmpty = cleaned.filter((s) => s.text.length > 0)
  return nonEmpty.length > 0 ? nonEmpty : [{ text: '', style: {}, dim: false }]
}

/** One line of pty capture as its plain text — ANSI/CSI stripped, styled runs
 *  flattened. The lens plane's common projection when only the characters
 *  matter (fingerprint matching, blank-row scans), shared so the two lens files
 *  cannot drift. */
export function plain(line: string): string {
  return parseAnsiLine(line)
    .map((s) => s.text)
    .join('')
}

/** The index of the last capture row with a printable glyph on it, or −1 when
 *  every row is blank. A bottom-up scan — the lens plane anchors to the tail,
 *  so the last content row is where a dialog/login window ends. Shared by the
 *  peek and login lenses so the two cannot drift. */
export function lastContentLine(lines: readonly string[]): number {
  for (let i = lines.length - 1; i >= 0; i--) {
    if (lines[i].trim()) return i
  }
  return -1
}
