/**
 * Mark geometry — character → SVG path strings.
 * ─────────────────────────────────────────────────────────────────────────────
 * Pure, DOM-free, and deliberately separate from `./character`: the character is
 * a handful of numbers you can persist and diff; this module is the (heavier)
 * renderer that turns those numbers into two kinds of outline.
 *
 *   silhouettePath(ch)  the body. Either the projected silhouette of a
 *                       superellipsoid solid, or one of the three authored 2-D
 *                       outlines. Never depends on state — the body does not
 *                       move, ever (concept contract C5).
 *   eyePath(ch, …)      one eye, drawn in face arc-length coordinates and
 *                       wrapped onto the face solid, so a blink on a cloud reads
 *                       exactly like a blink on a sphere.
 *
 * Everything is authored in a fixed viewBox of ±`VIEWBOX`, so a mark is
 * resolution-independent: only the SVG's width/height change with `size`.
 *
 * Cost: the projected bodies are the expensive part (a 5.9k-point hull for the
 * non-ellipsoidal solids), so `silhouettePath` memoises per character. Eyes are
 * cheap (~80 points) and are recomputed per animation frame.
 */
import { AUTHORED, type Character, type EyeGeometry, type Solid } from './character'

/** Half-extent of the authored coordinate system; the SVG viewBox is ±this. */
export const VIEWBOX = 131
/** Camera distance for the weak perspective. */
const FOCAL = 620
/** Radius of the face sphere the eyes are drawn on, in face arc-length units. */
const FACE_R = 120

const rad = (d: number) => (d * Math.PI) / 180

/* ── quaternions + projection ────────────────────────────────────────────── */

export type Quat = readonly [number, number, number, number]
type Vec3 = [number, number, number]

/** Z·X·Y Euler (degrees) → unit quaternion. */
export function quatFromPose(xDeg: number, yDeg: number, zDeg: number): Quat {
  const q = (ax: Vec3, an: number): Quat => {
    const s = Math.sin(an / 2)
    return [Math.cos(an / 2), ax[0] * s, ax[1] * s, ax[2] * s]
  }
  const mul = (a: Quat, b: Quat): Quat => {
    const r: [number, number, number, number] = [
      a[0] * b[0] - a[1] * b[1] - a[2] * b[2] - a[3] * b[3],
      a[0] * b[1] + a[1] * b[0] + a[2] * b[3] - a[3] * b[2],
      a[0] * b[2] - a[1] * b[3] + a[2] * b[0] + a[3] * b[1],
      a[0] * b[3] + a[1] * b[2] - a[2] * b[1] + a[3] * b[0],
    ]
    const n = Math.hypot(...r) || 1
    return [r[0] / n, r[1] / n, r[2] / n, r[3] / n]
  }
  return mul(mul(q([0, 0, 1], rad(zDeg)), q([1, 0, 0], rad(xDeg))), q([0, 1, 0], rad(yDeg)))
}

const qRot = ([w, x, y, z]: Quat, [px, py, pz]: Vec3): Vec3 => {
  const tx = 2 * (y * pz - z * py)
  const ty = 2 * (z * px - x * pz)
  const tz = 2 * (x * py - y * px)
  return [
    px + w * tx + (y * tz - z * ty),
    py + w * ty + (z * tx - x * tz),
    pz + w * tz + (x * ty - y * tx),
  ]
}

const project = ([x, y, z]: Vec3, persp: number): Vec3 => {
  const k = FOCAL / (FOCAL - z * persp)
  return [x * k, y * k, z]
}

/* ── surfaces ────────────────────────────────────────────────────────────── */

/** The point on the front of the solid that a face-space (x, y) maps to. */
function frontSample(b: Solid, x: number, y: number): Vec3 {
  const ny = Math.max(-1, Math.min(1, y / b.ry))
  const avail = Math.max(0, 1 - Math.abs(ny) ** b.n) ** (1 / b.n)
  const sx = Math.max(-b.rx * avail, Math.min(b.rx * avail, x))
  const nx = sx / b.rx
  const nz = Math.max(0, 1 - Math.abs(nx) ** b.n - Math.abs(ny) ** b.n) ** (1 / b.n)
  return [sx, ny * b.ry, b.rz * nz]
}

const surfacePoint = (b: Solid, lon: number, lat: number): Vec3 => {
  const sx = Math.cos(lat) * Math.sin(lon)
  const sy = Math.sin(lat)
  const sz = Math.cos(lat) * Math.cos(lon)
  const L = (Math.abs(sx) ** b.n + Math.abs(sy) ** b.n + Math.abs(sz) ** b.n) ** (1 / b.n) || 1
  return [(b.rx * sx) / L, (b.ry * sy) / L, (b.rz * sz) / L]
}

/* ── outline plumbing ────────────────────────────────────────────────────── */

type Pt = [number, number]

/** Andrew's monotone chain. */
function hull(pts: readonly Vec3[]): Pt[] {
  const s = [...pts].sort((a, b) => a[0] - b[0] || a[1] - b[1])
  const cross = (o: Vec3, p: Vec3, q: Vec3) =>
    (p[0] - o[0]) * (q[1] - o[1]) - (p[1] - o[1]) * (q[0] - o[0])
  const half = (src: Vec3[]) => {
    const r: Vec3[] = []
    for (const p of src) {
      while (r.length >= 2 && cross(r[r.length - 2], r[r.length - 1], p) <= 0) r.pop()
      r.push(p)
    }
    return r
  }
  return [...half(s).slice(0, -1), ...half([...s].reverse()).slice(0, -1)].map(
    (p) => [p[0], p[1]] as Pt,
  )
}

/** Resample a closed polyline so no segment is longer than `max`. */
function densify(pts: readonly Pt[], max = 5): Pt[] {
  return pts.flatMap((p, i) => {
    const q = pts[(i + 1) % pts.length]
    const steps = Math.max(1, Math.ceil(Math.hypot(q[0] - p[0], q[1] - p[1]) / max))
    return Array.from(
      { length: steps },
      (_, k): Pt => [p[0] + ((q[0] - p[0]) * k) / steps, p[1] + ((q[1] - p[1]) * k) / steps],
    )
  })
}

/** Catmull-Rom → cubic Bézier, closed. This is what makes every body pillowy. */
function smoothClosed(pts: readonly Pt[]): string {
  if (pts.length < 3) return ''
  const at = (i: number) => pts[(i + pts.length) % pts.length]
  const f = (v: number) => v.toFixed(2)
  return (
    `M${f(pts[0][0])} ${f(pts[0][1])}` +
    pts
      .map((p, i) => {
        const pr = at(i - 1)
        const nx = at(i + 1)
        const an = at(i + 2)
        return (
          `C${f(p[0] + (nx[0] - pr[0]) / 6)} ${f(p[1] + (nx[1] - pr[1]) / 6)}` +
          ` ${f(nx[0] - (an[0] - p[0]) / 6)} ${f(nx[1] - (an[1] - p[1]) / 6)}` +
          ` ${f(nx[0])} ${f(nx[1])}`
        )
      })
      .join('') +
    'Z'
  )
}

/** Exact silhouette of a rotated ellipsoid under perspective (n ≈ 2 only). */
function ellipsoidSilhouette(b: Solid, q: Quat, persp: number): string | null {
  const f = persp > 1e-4 ? FOCAL / persp : 1e9
  const qInv: Quat = [q[0], -q[1], -q[2], -q[3]]
  const C = qRot(qInv, [0, 0, f])
  const c: Vec3 = [C[0] / b.rx, C[1] / b.ry, C[2] / b.rz]
  const cl = Math.hypot(...c)
  if (cl <= 1.0001) return null
  const ch: Vec3 = [c[0] / cl, c[1] / cl, c[2] / cl]
  const d = 1 / cl
  const r = Math.sqrt(1 - d * d)
  const helper: Vec3 = Math.abs(ch[0]) < 0.9 ? [1, 0, 0] : [0, 1, 0]
  const cross = (a: Vec3, b2: Vec3): Vec3 => [
    a[1] * b2[2] - a[2] * b2[1],
    a[2] * b2[0] - a[0] * b2[2],
    a[0] * b2[1] - a[1] * b2[0],
  ]
  const u = ((v: Vec3): Vec3 => {
    const l = Math.hypot(...v) || 1
    return [v[0] / l, v[1] / l, v[2] / l]
  })(cross(ch, helper))
  const v = cross(ch, u)
  const pts: Pt[] = []
  for (let i = 0; i < 128; i++) {
    const t = (i / 128) * Math.PI * 2
    const y: Vec3 = [
      ch[0] * d + (u[0] * Math.cos(t) + v[0] * Math.sin(t)) * r,
      ch[1] * d + (u[1] * Math.cos(t) + v[1] * Math.sin(t)) * r,
      ch[2] * d + (u[2] * Math.cos(t) + v[2] * Math.sin(t)) * r,
    ]
    const p = project(qRot(q, [y[0] * b.rx, y[1] * b.ry, y[2] * b.rz]), persp)
    pts.push([p[0], p[1]])
  }
  return smoothClosed(pts)
}

/** Projected outline of a superellipsoid solid. */
function solidPath(b: Solid, q: Quat, persp: number): string {
  if (Math.abs(b.n - 2) < 0.02) {
    const e = ellipsoidSilhouette(b, q, persp)
    if (e) return e
  }
  const pts: Vec3[] = []
  for (let i = 0; i < 49; i++) {
    const lat = -Math.PI / 2 + (i / 48) * Math.PI
    for (let j = 0; j < 121; j++) {
      const lon = -Math.PI + (j / 120) * Math.PI * 2
      pts.push(project(qRot(q, surfacePoint(b, lon, lat)), persp))
    }
  }
  return smoothClosed(densify(hull(pts), 4))
}

/* ── authored outlines ───────────────────────────────────────────────────── */

/**
 * Exact boundary of a union of discs, swept radially. Every disc contains the
 * origin, so the union is star-shaped and the sweep cannot miss a lobe.
 */
function cloudPts(lobes: readonly (readonly [number, number, number])[], spin: number): Pt[] {
  const out: Pt[] = []
  for (let i = 0; i < 168; i++) {
    const t = (i / 168) * Math.PI * 2 + spin
    const ux = Math.cos(t)
    const uy = Math.sin(t)
    let best = 0
    for (const [cx, cy, rr] of lobes) {
      const b = cx * ux + cy * uy
      const c = cx * cx + cy * cy - rr * rr
      const disc = b * b - c
      if (disc <= 0) continue
      best = Math.max(best, b + Math.sqrt(disc))
    }
    out.push([ux * best, uy * best])
  }
  return out
}

/** Polygon with circular corner fillets of radius `r`. */
function roundedPoly(verts: readonly Pt[], r: number): Pt[] {
  const out: Pt[] = []
  const n = verts.length
  for (let i = 0; i < n; i++) {
    const p = verts[i]
    const a = verts[(i - 1 + n) % n]
    const b = verts[(i + 1) % n]
    const v1: Pt = [a[0] - p[0], a[1] - p[1]]
    const v2: Pt = [b[0] - p[0], b[1] - p[1]]
    const l1 = Math.hypot(...v1) || 1
    const l2 = Math.hypot(...v2) || 1
    const u1: Pt = [v1[0] / l1, v1[1] / l1]
    const u2: Pt = [v2[0] / l2, v2[1] / l2]
    const ang = Math.acos(Math.max(-1, Math.min(1, u1[0] * u2[0] + u1[1] * u2[1])))
    const tan = r / Math.tan(ang / 2)
    const t = Math.min(tan, l1 * 0.48, l2 * 0.48)
    const p1: Pt = [p[0] + u1[0] * t, p[1] + u1[1] * t]
    const p2: Pt = [p[0] + u2[0] * t, p[1] + u2[1] * t]
    const bis: Pt = [u1[0] + u2[0], u1[1] + u2[1]]
    const bl = Math.hypot(...bis) || 1
    const dist = t / Math.cos(ang / 2 > 1.5 ? 1.5 : ang / 2) || t
    const c: Pt = [p[0] + (bis[0] / bl) * Math.abs(dist), p[1] + (bis[1] / bl) * Math.abs(dist)]
    const a0 = Math.atan2(p1[1] - c[1], p1[0] - c[0])
    const a1 = Math.atan2(p2[1] - c[1], p2[0] - c[0])
    let d = a1 - a0
    while (d > Math.PI) d -= 2 * Math.PI
    while (d < -Math.PI) d += 2 * Math.PI
    const rr = Math.hypot(p1[0] - c[0], p1[1] - c[1])
    const steps = 9
    for (let k = 0; k <= steps; k++) {
      const an = a0 + (d * k) / steps
      out.push([c[0] + Math.cos(an) * rr, c[1] + Math.sin(an) * rr])
    }
  }
  return out
}

/** The three authored outlines, in authored coordinates. */
const AUTHORED_OUTLINE: Record<keyof typeof AUTHORED, () => Pt[]> = {
  cloud: () =>
    cloudPts(
      [
        [-60, 4, 70],
        [2, -36, 76],
        [62, 8, 68],
        [-26, 48, 58],
        [30, 50, 58],
      ],
      0.12,
    ),
  wedge: () =>
    roundedPoly(
      [
        [2, -118],
        [118, 90],
        [-114, 94],
      ],
      32,
    ),
  rhombus: () =>
    roundedPoly(
      [
        [0, -128],
        [124, 2],
        [0, 124],
        [-122, -2],
      ],
      30,
    ),
}

/* ── the two public emitters ─────────────────────────────────────────────── */

/** Memo key: a character is a pure function of (seed, pin), and so is its body. */
const bodyKey = (ch: Character) =>
  `${ch.silhouette}|${ch.body.rx.toFixed(3)},${ch.body.ry.toFixed(3)},${ch.body.rz.toFixed(3)},${ch.body.n}` +
  `|${ch.pose.x.toFixed(3)},${ch.pose.y.toFixed(3)},${ch.pose.z.toFixed(3)},${ch.pose.persp}`

const bodyCache = new Map<string, string>()
/** Bounded so a long-lived tab with a churning roster cannot grow it forever. */
const BODY_CACHE_MAX = 256

/** The character's quaternion — cheap, but shared by body and both eyes. */
export const poseQuat = (ch: Character): Quat => quatFromPose(ch.pose.x, ch.pose.y, ch.pose.z)

/**
 * The body outline. Memoised: the hull-based solids cost ~6k projections and the
 * result never changes for a given character (state lives in the eyes only).
 */
export function silhouettePath(ch: Character): string {
  const key = bodyKey(ch)
  const hit = bodyCache.get(key)
  if (hit !== undefined) return hit
  const path = ch.authored
    ? smoothClosed(densify(AUTHORED_OUTLINE[ch.silhouette as keyof typeof AUTHORED](), 4))
    : solidPath(ch.body, poseQuat(ch), ch.pose.persp)
  if (bodyCache.size >= BODY_CACHE_MAX) bodyCache.delete(bodyCache.keys().next().value!)
  bodyCache.set(key, path)
  return path
}

/** A rounded capsule outline, sampled as points (w × h, fully rounded ends). */
function roundedRect(w: number, h: number): Pt[] {
  const hw = w / 2
  const hh = h / 2
  const r = Math.min(hw, hh)
  const pts: Pt[] = []
  const line = (a: Pt, b: Pt) => {
    const n = Math.max(2, Math.ceil(Math.hypot(b[0] - a[0], b[1] - a[1]) / 2.2))
    for (let i = 0; i < n; i++) {
      const t = i / n
      pts.push([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t])
    }
  }
  const arc = (cx: number, cy: number, a0: number) => {
    for (let i = 0; i < 12; i++) {
      const a = a0 + (i / 12) * (Math.PI / 2)
      pts.push([cx + Math.cos(a) * r, cy + Math.sin(a) * r])
    }
  }
  line([-hw + r, -hh], [hw - r, -hh])
  arc(hw - r, -hh + r, -Math.PI / 2)
  line([hw, -hh + r], [hw, hh - r])
  arc(hw - r, hh - r, 0)
  line([hw - r, hh], [-hw + r, hh])
  arc(-hw + r, hh - r, Math.PI / 2)
  line([-hw, hh - r], [-hw, -hh + r])
  arc(-hw + r, -hh + r, Math.PI)
  return pts
}

/** Face arc-length → the flat coordinates used to sample the front of the solid. */
const faceCoords = (x: number, y: number): Pt => [
  FACE_R * Math.cos(y / FACE_R) * Math.sin(x / FACE_R),
  FACE_R * Math.sin(y / FACE_R),
]

/**
 * One eye, wrapped onto the face solid.
 *
 * `side` is −1 (left) or +1 (right); `blink` ∈ [0,1] scales the height down to a
 * 5-unit lid line, which is what makes a closed eye a line and not a dot.
 */
export function eyePath(
  ch: Character,
  q: Quat,
  e: EyeGeometry,
  side: -1 | 1,
  blink: number,
): string {
  const left = side < 0
  const w = left ? e.wL : e.wR
  const h = 5 + ((left ? e.hL : e.hR) - 5) * blink
  const cx0 = (side * e.spacing) / 2 + (left ? e.pxL : e.pxR)
  const cy0 = (left ? e.pyL : e.pyR) + ch.faceDY
  const a = rad(left ? e.angleL : e.angleR)
  const cos = Math.cos(a)
  const sin = Math.sin(a)
  const f = (v: number) => v.toFixed(2)
  let d = ''
  const pts = roundedRect(w, h)
  for (let i = 0; i < pts.length; i++) {
    const [lx, ly] = pts[i]
    const [fx, fy] = faceCoords(cx0 + (lx * cos - ly * sin), cy0 + (lx * sin + ly * cos))
    const p = project(qRot(q, frontSample(ch.body, fx, fy)), ch.pose.persp)
    d += `${i === 0 ? 'M' : 'L'}${f(p[0])} ${f(p[1])}`
  }
  return d + 'Z'
}
