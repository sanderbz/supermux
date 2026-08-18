// /dev/marks — the visual bench for the session marks (fase B0, task 3).
//
// DEV-only + lazy + mounted outside <Layout> (mirrors /dev/tiles, /dev/teams),
// so neither the route nor its fixture can reach a production chunk and the page
// is pure design system: no nav, no header, nothing but faces on paper.
//
// What it is FOR: this is the surface task 4 screenshots, and the surface every
// later phase regresses against. Everything the character engine can express is
// on this one page — the whole cast at 18/28/40, both themes, all six states,
// the full 63-token matrix, the pigment ladder, and a live strip that actually
// blinks and breathes so ambient life can be watched rather than argued about.
//
// Two deliberate rules:
//   · every matrix is a STILL frame (`animate={false}`). A bench you screenshot
//     must be deterministic, and the still frame is exactly what a reduced-motion
//     user and every screenshot keep forever — if a state is not separable here,
//     it is not separable at all.
//   · both themes are rendered on ONE page via the `[data-theme]` subtree switch
//     (see globals.css), so light and dark are compared side by side instead of
//     across two toggles and two screenshots.
//
// No framer-motion here on purpose: the marks' two motions are the shared rAF
// eye loop (marks/ticker.ts) and the CSS breathe (globals.css). There is no
// component-level transition to source from lib/springs.ts.
import {
  accentInk,
  bodyColor,
  HUE_SLOTS,
  SessionMark,
  SILHOUETTES,
  type MarkState,
} from '@/brand/marks'
import { PAPER } from '@/brand/tokens'

import {
  BENCH_THEMES,
  CAST,
  LIVE_STATES,
  MARK_SIZE_ROLES,
  MARK_SIZES,
  MARK_STATES,
  REFERENCE_STATE,
  REFERENCE_STRIP,
  ROSTER,
  type BenchTheme,
  type CastMember,
  type MarkSize,
} from './dev-marks.cast'

/* ── page furniture ──────────────────────────────────────────────────────── */

function Section({
  id,
  title,
  note,
  children,
}: {
  id: string
  title: string
  note: string
  children: React.ReactNode
}) {
  return (
    <section data-bench={id} className="flex flex-col gap-3">
      <header className="flex flex-col gap-1">
        <h2 className="text-sm font-semibold tracking-tight text-ink">{title}</h2>
        <p className="max-w-3xl text-xs leading-relaxed text-ink-2">{note}</p>
      </header>
      {children}
    </section>
  )
}

/** A face plus its name — the unit every strip on this page is made of. */
function Portrait({
  member,
  size,
  state = 'idle',
  animate = false,
  sub,
}: {
  member: CastMember
  size: number
  state?: MarkState
  animate?: boolean
  /** Second caption line (the live strip's state). Kept off the name's line so
   *  the cell stays 80px and a nine-up row never wraps. */
  sub?: string
}) {
  // The cell is exactly as wide as its caption is allowed to be, so a centred
  // caption can never spill onto its neighbour — or, in the first column, off the
  // panel — and every column of a strip lines up.
  return (
    <div className="flex w-20 flex-col items-center gap-1.5">
      <SessionMark
        seed={member.name}
        pin={member.pin}
        size={size}
        state={state}
        animate={animate}
        label={null}
      />
      <span className="w-full truncate text-center text-[10px] leading-none text-ink-3">
        {member.name}
      </span>
      {sub && (
        <span className="w-full truncate text-center text-[10px] leading-none text-ink-3/70">
          {sub}
        </span>
      )}
    </div>
  )
}

/* ── panels ──────────────────────────────────────────────────────────────── */

/** The seven approved characters, pinned — the parity anchor for the render. */
function ReferenceStrip() {
  return (
    <div className="flex flex-wrap items-end gap-x-8 gap-y-5 rounded-2xl bg-paper-raised px-6 py-5 shadow-[var(--sm-bubble-shadow)]">
      {REFERENCE_STRIP.map((m) => (
        <Portrait key={m.name} member={m} size={40} state={REFERENCE_STATE[m.name]} />
      ))}
    </div>
  )
}

/** The full cast at one rung of the ladder. */
function CastRow({ size }: { size: MarkSize }) {
  return (
    <div data-bench-size={size} className="flex flex-col gap-2">
      <div className="flex items-baseline gap-2">
        <span className="text-xs font-medium tabular-nums text-ink">{size}px</span>
        <span className="text-[11px] text-ink-3">{MARK_SIZE_ROLES[size]}</span>
      </div>
      <div className="flex flex-wrap items-end gap-x-6 gap-y-4">
        {CAST.map((m) => (
          <Portrait key={m.name} member={m} size={size} />
        ))}
      </div>
    </div>
  )
}

/** Six states × the whole cast, at one size. Still frames. */
function StateMatrix({ size }: { size: MarkSize }) {
  return (
    <div data-bench-size={size} className="overflow-x-auto">
      <table className="w-full min-w-[540px] border-collapse text-left">
        <thead>
          <tr>
            <th className="w-28 pb-2 text-[11px] font-medium tabular-nums text-ink">{size}px</th>
            {CAST.map((m) => (
              <th
                key={m.name}
                className="max-w-24 pb-2 text-center text-[10px] font-normal text-ink-3"
                title={m.name}
              >
                <span className="block truncate">{m.name}</span>
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {MARK_STATES.map((state) => (
            <tr key={state} data-bench-state={state} className="border-t-[0.5px] border-hairline">
              <th scope="row" className="py-2.5 pr-4 text-xs font-medium text-ink-2">
                {state}
              </th>
              {CAST.map((m) => (
                <td key={m.name} className="py-2.5">
                  <SessionMark
                    seed={m.name}
                    pin={m.pin}
                    size={size}
                    state={state}
                    animate={false}
                    label={null}
                    className="mx-auto"
                  />
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

/** All 63 identity tokens: 9 silhouettes × 7 pigments. */
function TokenMatrix() {
  return (
    <div className="overflow-x-auto">
      <table className="border-collapse text-left">
        <thead>
          <tr>
            <th className="w-20 pb-2 text-[10px] font-normal text-ink-3">shape · hue</th>
            {HUE_SLOTS.map((hue) => (
              <th
                key={hue}
                className="px-2 pb-2 text-center text-[10px] font-normal tabular-nums text-ink-3"
              >
                {hue}°
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {SILHOUETTES.map((silhouette) => (
            <tr key={silhouette} className="border-t-[0.5px] border-hairline">
              <th scope="row" className="py-1.5 pr-3 text-[11px] font-medium text-ink-2">
                {silhouette}
              </th>
              {HUE_SLOTS.map((hue) => (
                <td key={hue} className="px-2 py-1.5 text-center">
                  <SessionMark
                    // A distinct seed per cell, so the eyes differ too: the grid
                    // shows 63 *characters*, not one character recoloured.
                    seed={`${silhouette}-${hue}`}
                    pin={{ silhouette, hue }}
                    size={28}
                    animate={false}
                    label={null}
                    className="mx-auto"
                  />
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

/** Body pigment vs. its text-capable tier, per theme. */
function PigmentLadder({ theme }: { theme: BenchTheme }) {
  const dark = theme === 'dark'
  return (
    <div className="flex flex-wrap gap-x-8 gap-y-4">
      {HUE_SLOTS.map((hue) => {
        const body = bodyColor(hue)
        const ink = accentInk(hue, dark)
        return (
          <div key={hue} className="flex items-center gap-2.5">
            <span
              aria-hidden
              className="size-7 rounded-lg"
              style={{ backgroundColor: body }}
            />
            <div className="flex flex-col leading-tight">
              <span className="text-[11px] font-medium tabular-nums text-ink">{hue}°</span>
              <span className="text-[10px] tabular-nums text-ink-3">{body}</span>
              <span className="text-[11px] font-medium" style={{ color: ink }}>
                @mention
              </span>
            </div>
          </div>
        )
      })}
    </div>
  )
}

/** Overlapping 18px marks with a page-coloured keyline — the facepile read. */
function Facepile({ theme }: { theme: BenchTheme }) {
  const ring = PAPER[theme].paper
  return (
    <div className="flex items-center gap-4">
      {[3, 5].map((n) => (
        <div key={n} className="flex items-center">
          {CAST.slice(0, n).map((m, i) => (
            <SessionMark
              key={m.name}
              seed={m.name}
              pin={m.pin}
              size={18}
              animate={false}
              label={null}
              ring={ring}
              className={i === 0 ? undefined : '-ml-1'}
            />
          ))}
        </div>
      ))}
    </div>
  )
}

/** The one animated surface: blink · micro-saccade · breathe, live. */
function LiveStrip({ size }: { size: MarkSize }) {
  return (
    <div data-bench-size={size} className="flex flex-col gap-2">
      <div className="flex items-baseline gap-2">
        <span className="text-xs font-medium tabular-nums text-ink">{size}px</span>
        <span className="text-[11px] text-ink-3">{MARK_SIZE_ROLES[size]}</span>
      </div>
      <div className="flex flex-wrap items-end gap-x-6 gap-y-4">
        {CAST.map((m, i) => {
          const state = LIVE_STATES[i % LIVE_STATES.length]
          return (
            <Portrait
              key={m.name}
              member={m}
              size={size}
              state={state}
              animate
              sub={state}
            />
          )
        })}
      </div>
    </div>
  )
}

/* ── one theme's worth of bench ──────────────────────────────────────────── */

function BenchPanel({ theme }: { theme: BenchTheme }) {
  return (
    <div data-theme={theme} data-bench-theme={theme} className="bg-paper text-ink">
      <div className="mx-auto flex w-full max-w-6xl flex-col gap-12 px-6 py-12">
        <header className="flex flex-col gap-2">
          <h1 className="text-xl font-semibold tracking-tight text-ink">
            Session marks — {theme}
          </h1>
          <p className="max-w-3xl text-xs leading-relaxed text-ink-2">
            The procedural character engine (<code className="rounded bg-code-bg px-1 py-0.5">
              src/brand/marks/
            </code>
            ) on the B0 warm-paper ladder. Both themes are on this page; this half is the{' '}
            <strong className="font-medium text-ink">{theme}</strong> subtree. Every matrix below
            is a still frame — the only animated section is the live strip at the bottom. With
            Reduce Motion on, that strip renders the identical faces, permanently open and still.
          </p>
        </header>

        <Section
          id="reference"
          title="Reference strip"
          note="The seven characters of the approved avatar-strip@2x.png, pinned to the silhouette, pigment, gaze and idle tilt they wear there, and POSED in the state they wear there (working · working · waiting · idle · idle · done · done) — the strip is the roster, not seven idle faces. Everything not pinned — eye size, spacing, seat, asymmetry, jitter, blink phase — still comes from the seed, so these are the real characters, not drawings of them. Parity anchor: this row and the approved render must be the same seven faces."
        >
          <ReferenceStrip />
        </Section>

        <Section
          id="ladder"
          title="The cast, on the size ladder"
          note="The same nine characters every section of this page uses: the approved seven at their approved pins, plus blob and pebble — the two silhouettes the strip has no room for. The geometry is unitless, so the same face is drawn at every rung; what changes is what survives. 18px is the size the design has to win at."
        >
          <div className="flex flex-col gap-7">
            {MARK_SIZES.map((size) => (
              <CastRow key={size} size={size} />
            ))}
          </div>
        </Section>

        <Section
          id="states"
          title="Six states × the cast × the ladder"
          note="State lives in the eyes and only in the eyes — the silhouette is byte-identical down every column. Read each column top to bottom: idle open · working narrowed and slanted · waiting rounded and levelled · done squinted · stopped shut to a lid line · failed the one mirrored tilt. All still frames, so every state must be separable with zero motion."
        >
          <div className="flex flex-col gap-8">
            {MARK_SIZES.map((size) => (
              <StateMatrix key={size} size={size} />
            ))}
          </div>
        </Section>

        <Section
          id="tokens"
          title="All 63 identity tokens"
          note="9 silhouettes × 7 pigments — the entire dedupe space, one distinct seed per cell so the eyes differ too. A roster of ≤ 63 sessions never repeats a pair."
        >
          <TokenMatrix />
        </Section>

        <Section
          id="pigments"
          title="Pigments and their text tier"
          note="The flat body fill (left) and accentInk(hue, dark) — the darkened/lifted tier used wherever a session's colour has to work as type: mention chips, provenance names, hover underlines. The body colour is theme-independent; the text tier is not."
        >
          <PigmentLadder theme={theme} />
        </Section>

        <Section
          id="roster"
          title="A 14-session roster, deduped"
          note="What a real sidebar of faces reads like — the thing no single mark can show. Names are deduped as one unit, in creation order."
        >
          <div className="flex flex-wrap items-end gap-x-6 gap-y-4">
            {ROSTER.map((m) => (
              <Portrait key={m.name} member={m} size={28} />
            ))}
          </div>
        </Section>

        <Section
          id="facepile"
          title="Facepile keyline"
          note="18px marks overlapped, each stroked with a 2 CSS px ring in the page colour so crew members separate. The ring is painted under the fill and stays 2px at any size."
        >
          <Facepile theme={theme} />
        </Section>

        <Section
          id="live"
          title="Live — blink · micro-saccade · breathe"
          note="The only animated section. Per-seed blink periods (4.6 / 2.6 / 3.1 s for idle / working / waiting, detuned per seed) mean the row never blinks in unison; waiting also micro-saccades; every face breathes on a 5.4 s loop with its own phase. done, stopped and failed are absent by design — nothing is running, so nothing breathes."
        >
          <div className="flex flex-col gap-7">
            {MARK_SIZES.map((size) => (
              <LiveStrip key={size} size={size} />
            ))}
          </div>
        </Section>
      </div>
    </div>
  )
}

export default function DevMarks() {
  return (
    <div className="min-h-dvh bg-paper">
      {BENCH_THEMES.map((theme) => (
        <BenchPanel key={theme} theme={theme} />
      ))}
    </div>
  )
}
