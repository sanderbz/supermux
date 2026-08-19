/**
 * Screencast frames → pixels on a canvas, and taps on that canvas → page
 * coordinates. The arithmetic of the takeover panel, kept pure.
 * ─────────────────────────────────────────────────────────────────────────────
 * WHY THE CLIENT DOES THE MAPPING. The server relays CDP's `metadata` verbatim
 * and expects page-viewport CSS pixels back (`connectors/browser/takeover.rs`).
 * It cannot do the division itself: only this side knows the canvas' CSS size
 * and how the JPEG is letterboxed inside it, and both change on every rotation,
 * split-pane drag and iOS URL-bar collapse. So the client divides and the
 * server CLAMPS — neither one trusts the other's arithmetic.
 *
 * THE THREE SPACES, in order:
 *
 *   1. **client space** — `event.clientX/Y`, viewport CSS px.
 *   2. **image space** — pixels of the JPEG, `0..naturalWidth`. The frame is
 *      capped server-side (the 512px mobile profile), so this is almost never
 *      the page's size.
 *   3. **page space** — CSS px of the page's own viewport, which is what
 *      `Input.dispatch*` takes. `metadata.deviceWidth/deviceHeight` is the box
 *      the JPEG covers in THIS space; `metadata.offsetTop` is a strip captured
 *      above the page origin (mobile emulation's top controls) that has to come
 *      back off, or every tap lands `offsetTop` px too low.
 *
 * `pageScaleFactor` is deliberately NOT applied to the point: CDP's mouse and
 * touch coordinates are in unscaled viewport CSS px, and dividing by it would
 * break every pinch-zoomed page. It is carried through for callers that need it
 * (scroll math) and asserted in the tests so the omission stays deliberate.
 *
 * DECODE IS JPEG→CANVAS, NEVER A VIDEO CODEC — that is what makes the panel
 * work on iOS Safari, where MSE/WebCodecs are absent or crippled.
 */

/** `Page.screencastFrame`'s `metadata`, as CDP sends it. All fields optional:
 *  the seed still frame (a `Page.captureScreenshot`) carries none of them. */
export interface FrameMetadata {
  offsetTop?: number
  pageScaleFactor?: number
  deviceWidth?: number
  deviceHeight?: number
  scrollOffsetX?: number
  scrollOffsetY?: number
  timestamp?: number
}

/** One relayed frame: base64 JPEG + the transform that maps taps back. */
export interface TakeoverFrame {
  data: string
  metadata: FrameMetadata
}

/** A rectangle, in whatever space the caller is working in. */
export interface Box {
  width: number
  height: number
}

/** Where the frame gets painted inside the canvas box, and at what zoom. */
export interface FrameFit {
  /** Offset of the painted image inside the box, CSS px. */
  left: number
  top: number
  /** Painted size, CSS px. */
  width: number
  height: number
  /** Painted px per image px. */
  zoom: number
}

/**
 * Fit `image` inside `box` preserving aspect (letterbox — never crop, never
 * stretch): a stretched frame would make every mapped tap wrong in one axis,
 * and a cropped one would hide part of the page the human is trying to click.
 */
export function fitFrame(box: Box, image: Box): FrameFit {
  if (
    !(box.width > 0) ||
    !(box.height > 0) ||
    !(image.width > 0) ||
    !(image.height > 0)
  ) {
    return { left: 0, top: 0, width: 0, height: 0, zoom: 0 }
  }
  const zoom = Math.min(box.width / image.width, box.height / image.height)
  const width = image.width * zoom
  const height = image.height * zoom
  return {
    left: (box.width - width) / 2,
    top: (box.height - height) / 2,
    width,
    height,
    zoom,
  }
}

/** A point in some space. */
export interface Point {
  x: number
  y: number
}

/**
 * Canvas-box point → page-viewport CSS px, or `null` when the point is on the
 * letterbox rather than on the page.
 *
 * `null` is load-bearing: clamping an off-image tap to the nearest edge would
 * silently click the page's border every time a thumb landed in the margin.
 * The caller drops it instead.
 *
 * @param local point relative to the canvas box's top-left, CSS px
 * @param box   the canvas' CSS size
 * @param image the frame's natural size
 */
export function toPagePoint(
  local: Point,
  box: Box,
  image: Box,
  metadata: FrameMetadata,
): Point | null {
  const fit = fitFrame(box, image)
  if (!(fit.zoom > 0)) return null

  const ix = (local.x - fit.left) / fit.zoom
  const iy = (local.y - fit.top) / fit.zoom
  // A half-pixel of slack at the edges: a tap on the very last row of the
  // frame is a tap on the page, not on the letterbox.
  if (ix < -0.5 || iy < -0.5 || ix > image.width + 0.5 || iy > image.height + 0.5) {
    return null
  }

  // Image px → page CSS px. Without usable metadata the frame IS the page
  // (the seed still-frame case), so the ratio is 1.
  const pageW = metadata.deviceWidth && metadata.deviceWidth > 0 ? metadata.deviceWidth : image.width
  const pageH =
    metadata.deviceHeight && metadata.deviceHeight > 0 ? metadata.deviceHeight : image.height
  const offsetTop = Number.isFinite(metadata.offsetTop) ? (metadata.offsetTop as number) : 0

  return {
    x: (ix * pageW) / image.width,
    y: (iy * pageH) / image.height - offsetTop,
  }
}

/** The `data:` URL for a relayed frame — the only form iOS Safari needs. */
export function frameSrc(data: string): string {
  return `data:image/jpeg;base64,${data}`
}

/** What `drawImage` will accept, narrowed to the two things we produce. */
export type DecodedFrame = ImageBitmap | HTMLImageElement

/** The natural size of a decoded frame, whichever kind it is. */
export function frameSize(frame: DecodedFrame): Box {
  const anyFrame = frame as { width?: number; height?: number; naturalWidth?: number; naturalHeight?: number }
  return {
    width: anyFrame.naturalWidth || anyFrame.width || 0,
    height: anyFrame.naturalHeight || anyFrame.height || 0,
  }
}

/**
 * Decode one base64 JPEG.
 *
 * `createImageBitmap` first — it decodes off the main thread, which is the
 * difference between a smooth 60 fps canvas and a janky one on a phone. It
 * needs a `Blob`, so the base64 is unpacked by hand (`fetch()` on a data URL is
 * blocked by our own CSP). Falls back to an `<img>`, which every engine we care
 * about — iOS Safari very much included — handles natively for JPEG.
 */
export async function decodeFrame(data: string): Promise<DecodedFrame> {
  if (typeof createImageBitmap === 'function' && typeof atob === 'function') {
    try {
      return await createImageBitmap(jpegBlob(data))
    } catch {
      // fall through to the <img> path — a decode failure here is a browser
      // quirk, not a reason to drop the frame.
    }
  }
  return await decodeViaImage(data)
}

/** base64 → a `image/jpeg` Blob, without a network round trip. */
export function jpegBlob(data: string): Blob {
  const binary = atob(data)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
  return new Blob([bytes], { type: 'image/jpeg' })
}

function decodeViaImage(data: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image()
    img.onload = () => resolve(img)
    img.onerror = () => reject(new Error('frame decode failed'))
    img.src = frameSrc(data)
  })
}
