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
// xterm palette (these ARE the terminal's colours, not app chrome), kept legible
// on the OLED-true `--terminal-bg` surface the preview renders on.

import type * as React from 'react'

/** One run of text sharing a single computed style. */
export interface AnsiSegment {
  text: string
  /** Inline style; empty object = inherit (default fg, no decoration). */
  style: React.CSSProperties
}

// The standard xterm 16-colour palette (normal 0-7, bright 8-15). These are the
// real terminal colours an agent's output uses — not app design tokens — so they
// are intentionally literal here. Tuned to stay legible on a near-black surface.
const ANSI_16: readonly string[] = [
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

/** Build the xterm 256-colour palette: 0-15 base, 16-231 cube, 232-255 greys. */
function xterm256(i: number): string {
  if (i < 16) return ANSI_16[i]
  if (i < 232) {
    const n = i - 16
    const r = Math.floor(n / 36)
    const g = Math.floor((n % 36) / 6)
    const b = n % 6
    const c = (v: number) => (v === 0 ? 0 : 55 + v * 40)
    return `rgb(${c(r)}, ${c(g)}, ${c(b)})`
  }
  const v = 8 + (i - 232) * 10
  return `rgb(${v}, ${v}, ${v})`
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
  fg?: string
  bg?: string
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
    else if (p >= 30 && p <= 37) state.fg = ANSI_16[p - 30]
    else if (p === 39) state.fg = undefined
    else if (p >= 40 && p <= 47) state.bg = ANSI_16[p - 40]
    else if (p === 49) state.bg = undefined
    else if (p >= 90 && p <= 97) state.fg = ANSI_16[p - 90 + 8]
    else if (p >= 100 && p <= 107) state.bg = ANSI_16[p - 100 + 8]
    else if (p === 38 || p === 48) {
      // Extended colour: 38;5;n (256) or 38;2;r;g;b (truecolour).
      const target: 'fg' | 'bg' = p === 38 ? 'fg' : 'bg'
      const mode = params[i + 1]
      if (mode === 5 && params[i + 2] !== undefined) {
        state[target] = xterm256(params[i + 2])
        i += 2
      } else if (mode === 2 && params[i + 4] !== undefined) {
        state[target] = `rgb(${params[i + 2]}, ${params[i + 3]}, ${params[i + 4]})`
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
  if (fg) style.color = fg
  if (bg) style.backgroundColor = bg
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
    return [{ text: line, style: {} }]
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
    segments.push({ text: line.slice(cursor), style: toStyle(state) })
  }
  // Drop any non-SGR CSI noise that survived inside a segment's text.
  const cleaned = segments.map((s) => ({
    ...s,
    text: s.text.replace(CSI_RE, ''),
  }))
  const nonEmpty = cleaned.filter((s) => s.text.length > 0)
  return nonEmpty.length > 0 ? nonEmpty : [{ text: '', style: {} }]
}
