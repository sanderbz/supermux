/**
 * Which tool receipts earn a captured-frame card (fase A3 T3).
 * ─────────────────────────────────────────────────────────────────────────────
 * `CapturedFrameCard` is the ONE object with depth in an otherwise flat warm
 * surface — the thing the session is showing you. That is exactly why the
 * detector below is conservative to the point of being boring: a false positive
 * costs ~250px of shadowed card in the middle of somebody's turn, while a false
 * negative costs nothing at all (the file is still named, in full, on its
 * receipt line).
 *
 * The material it reads is the server's receipt label, `<Tool> <most salient
 * input>` (`server/src/sessions/recall.rs::tool_line`) plus the tool result. So
 * the gate is: a tool that can plausibly produce or look at an image (`Read`,
 * `Write`, or anything screenshot-shaped), naming a path whose LAST extension is
 * an image extension.
 *
 * Pure and dependency-free (local imports only), like everything else in the
 * chat renderer's shaping layer: `bun test` resolves it directly, with no path
 * aliases. Turning a path into a URL is deliberately NOT here — `filesApi` lives
 * behind `@/env` and would drag the whole API client into a unit test. The
 * component receives a `rawUrl` injector instead (see `transcript-item.tsx`).
 */
import { stripEmojiPrefix, type ReceiptLine } from './entries'

/** What one receipt line is showing, if anything. */
export interface CapturedFrame {
  /** The filename under the frame. */
  caption: string
  /** The absolute path, when there is one — the only case that can be fetched.
   *  A relative path renders B0's honest warm placeholder instead. */
  path?: string
}

/**
 * How many previews one receipt group may render.
 *
 * A twelve-image read run is a real thing Claude does; twelve cards would be
 * ~3000px of scroll for a single group. This is a PREVIEW cap, not a data cap —
 * every one of those twelve files is still listed, by name, as a receipt line.
 */
export const FRAMES_PER_GROUP = 3

/** The extensions the design is willing to put in a frame. */
const IMAGE_EXT = /\.(?:png|jpe?g|webp|gif)$/i

/** Trailing prose punctuation, so `…/shot.png,` is still a path. */
const TRAILING = /[),.;:!?]+$/

/**
 * The tools whose label may name an image.
 *
 * `Bash ls *.png` is deliberately NOT one of them: a glob that mentions images
 * has not produced one. The `screenshot` escape hatch covers the case where the
 * tool is a shell command whose whole purpose is a capture.
 */
function isFrameTool(label: string): boolean {
  const head = label.split(/\s+/, 1)[0] ?? ''
  return head === 'Read' || head === 'Write' || /screenshot/i.test(label)
}

function basename(path: string): string {
  return path.slice(path.lastIndexOf('/') + 1)
}

/**
 * The first token in `text` that is an image path.
 *
 * The extension must be the LAST one (`chart.png.bak` is a backup, not a chart)
 * and the file must have a stem (`/tmp/.png` is not a picture).
 */
function imagePathIn(text: string | undefined): string | undefined {
  if (!text) return undefined
  for (const raw of text.split(/[\s"'`<>]+/)) {
    const token = raw.replace(TRAILING, '')
    if (!IMAGE_EXT.test(token)) continue
    const stem = basename(token).replace(IMAGE_EXT, '')
    if (stem.length > 0) return token
  }
  return undefined
}

/**
 * One receipt line → the frame it earns, or `null`.
 *
 * A FAILED call earns nothing: `ok === false` means the tool did not produce
 * what its label says it would, and a card claiming otherwise would be the one
 * thing this surface must never be — confidently wrong.
 */
export function frameFor(line: ReceiptLine): CapturedFrame | null {
  if (line.ok === false) return null
  const label = stripEmojiPrefix(line.label ?? '')
  if (!isFrameTool(label)) return null
  const path = imagePathIn(label) ?? imagePathIn(line.result)
  if (!path) return null
  return path.startsWith('/')
    ? { caption: basename(path), path }
    : { caption: basename(path) }
}

/** Every frame a receipt group is willing to preview, in transcript order. */
export function framesIn(
  lines: readonly ReceiptLine[],
  max: number = FRAMES_PER_GROUP,
): CapturedFrame[] {
  const out: CapturedFrame[] = []
  for (const line of lines) {
    if (out.length >= max) break
    const frame = frameFor(line)
    if (frame) out.push(frame)
  }
  return out
}
