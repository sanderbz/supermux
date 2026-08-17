// /dev/roster — the visual bench for the roster system (fase B2, T1).
//
// DEV-only + lazy + mounted outside <Layout> (mirrors /dev/marks, /dev/tiles),
// so neither the route nor its fixture can reach a production chunk and the page
// is pure design system: no nav, no header, nothing but the roster on paper.
//
// What it is FOR: this is the surface B2 regresses against, task by task. The
// roster system has four independent channels — density, mark state, attention
// tier, theme — and B2 changes all four, so all four are on ONE page. Every VR
// sweep in this fase diffs against a shot of this route.
//
// Three deliberate rules, inherited from /dev/marks:
//   · every matrix is a STILL frame. A bench you screenshot must be
//     deterministic, and the still frame is exactly what a reduced-motion user
//     and every screenshot keep forever — if a state is not separable here, it
//     is not separable at all.
//   · both themes render on ONE page via the `[data-theme]` subtree switch, so
//     light and dark are compared side by side rather than across two shots.
//   · the coverage is data (`dev-roster.cast.ts`) and it is asserted
//     (`tests/unit/dev-roster-cast.test.tsx`), so the bench cannot quietly
//     shrink when a later task finds a matrix inconvenient.
//
// Sections landed with their tasks: T1 seated densities/states/attention/
// selection and the tile tiers, T6 filled the rollup, T7 the pinned hairline,
// T10 the issue pieces. While a section was unlanded it rendered a loud
// "pending" plate — an empty section and a missing section look identical in a
// screenshot. There are none left, and `dev-roster-cast.test.tsx` asserts that.
import * as React from 'react'

import { PAPER } from '@/brand/tokens'
import type { MarkState } from '@/brand/marks'
import { RosterRow } from '@/components/chat/ui'
import { AttentionRollup } from '@/components/roster/attention-rollup'
import { AcceptanceChecklist } from '@/components/issues/acceptance-checklist'
import { ReplyComposer } from '@/components/issues/reply-composer'
import { SessionTile } from '@/components/session-tile'
import { MOCK_TILES } from '@/components/session-tile/mock'
import { getOverviewSizeConfig } from '@/lib/overview-size'

import {
  ATTENTION_TIERS,
  BENCH_THEMES,
  DENSITY_ROLES,
  ISSUE_STATES,
  PINNED_NAMES,
  ROLLUP_COUNTS,
  ROSTER_CAST,
  ROSTER_DENSITIES,
  ROSTER_STATES,
  STATE_MODELS,
  TIER_MODELS,
  TILE_TIERS,
  type AttentionTier,
  type BenchTheme,
  type RosterDensity,
  type RosterMember,
} from './dev-roster.cast'
import { Trash2 } from 'lucide-react'

import { ArmedButton } from '@/components/ui/armed-button'
import type { ArmedConfirm } from '@/hooks/use-armed-confirm'
import {
  AutoHealToggle,
  RecoveryLadder,
} from '@/components/recovery/recovery-ladder'

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
    <section data-bench={id} data-vr={`roster-${id}`} className="flex flex-col gap-3">
      <header className="flex flex-col gap-1">
        <h2 className="text-sm font-semibold tracking-tight text-ink">{title}</h2>
        <p className="max-w-3xl text-xs leading-relaxed text-ink-2">{note}</p>
      </header>
      {children}
    </section>
  )
}

/** A titled plate — the paper a strip of rows sits on, so row chrome (hover,
 *  selection tint, hairline) is judged against the surface it ships on. */
function Plate({
  label,
  children,
  className,
}: {
  label?: string
  children: React.ReactNode
  className?: string
}) {
  return (
    <div className="flex flex-col gap-2">
      {label && <span className="text-[11px] text-ink-3">{label}</span>}
      <div
        className={
          'rounded-2xl bg-paper-raised px-2 py-2 shadow-[var(--sm-bubble-shadow)] ' +
          (className ?? '')
        }
      >
        {children}
      </div>
    </div>
  )
}

/* ── the row adapter ─────────────────────────────────────────────────────── */

/** The bench's single row unit — a thin forwarder onto the primitive, so the
 *  bench cannot accidentally become its own implementation of a row. */
function BenchRow({
  member,
  density,
  state = 'idle',
  attention,
  selected,
  preview = true,
}: {
  member: RosterMember
  density: RosterDensity
  state?: MarkState
  attention?: boolean
  selected?: boolean
  preview?: boolean
}) {
  return (
    <div data-bench-density={density} data-bench-state={state}>
      <RosterRow
        seed={member.name}
        pin={member.pin}
        density={density}
        timestamp={member.timestamp}
        preview={preview && density === 'list' ? member.preview : undefined}
        meta={
          density === 'strip' ? <span>21k tokens · ⎇ feat/exec-backoff</span> : undefined
        }
        state={state}
        attention={attention}
        selected={selected}
      />
    </div>
  )
}

const byName = (name: string): RosterMember =>
  ROSTER_CAST.find((m) => m.name === name) ?? ROSTER_CAST[0]

/* ── panels ──────────────────────────────────────────────────────────────── */

/** Three densities, same four colleagues — the geometry ladder. */
function DensityMatrix() {
  const sample = ROSTER_CAST.slice(0, 4)
  return (
    <div className="grid gap-6 md:grid-cols-3">
      {ROSTER_DENSITIES.map((density) => (
        <Plate key={density} label={`${density} — ${DENSITY_ROLES[density]}`}>
          {sample.map((m, i) => (
            <BenchRow key={m.name} member={m} density={density} selected={i === 1} />
          ))}
        </Plate>
      ))}
    </div>
  )
}

/** Six mark states × three densities. Still frames, one model per state so a
 *  state is never judged through a single silhouette. */
function StateMatrix() {
  return (
    <div className="grid gap-6 md:grid-cols-3">
      {ROSTER_DENSITIES.map((density) => (
        <Plate key={density} label={density}>
          {ROSTER_STATES.map((state) => (
            <BenchRow
              key={state}
              member={byName(STATE_MODELS[state])}
              density={density}
              state={state}
            />
          ))}
        </Plate>
      ))}
    </div>
  )
}

/** The three tiers plus quiet, at every density. `quiet` draws no glyph — it is
 *  here so the difference between "quiet" and "unread" is lookable-at. */
function AttentionMatrix() {
  const stateFor = (tier: AttentionTier): MarkState =>
    tier === 'needs' ? 'waiting' : tier === 'working' ? 'working' : 'idle'
  return (
    <div className="grid gap-6 md:grid-cols-3">
      {ROSTER_DENSITIES.map((density) => (
        <Plate key={density} label={density}>
          {ATTENTION_TIERS.map((tier) => (
            <div key={tier} data-bench-tier={tier}>
              <BenchRow
                member={byName(TIER_MODELS[tier])}
                density={density}
                state={stateFor(tier)}
                attention={tier === 'needs'}
              />
            </div>
          ))}
        </Plate>
      ))}
    </div>
  )
}

/** Selected vs unselected, per density — `sm-accent-row` is the only tinted
 *  chrome in the app and it is tinted with the session's OWN pigment, so it has
 *  to be checked against more than one face. */
function SelectionMatrix() {
  return (
    <div className="grid gap-6 md:grid-cols-3">
      {ROSTER_DENSITIES.map((density) => (
        <Plate key={density} label={density}>
          {ROSTER_CAST.slice(0, 3).map((m, i) => (
            <BenchRow key={m.name} member={m} density={density} selected={i === 0} />
          ))}
        </Plate>
      ))}
    </div>
  )
}

/** The tile at all four overview tiers, in the real grid geometry. */
function TileTiers() {
  return (
    <div className="flex flex-col gap-8">
      {TILE_TIERS.map((tier) => {
        const cfg = getOverviewSizeConfig(tier)
        return (
          <div key={tier} data-bench-tier={tier} className="flex flex-col gap-2">
            <span className="text-[11px] text-ink-3">
              tier {tier} — {cfg.label} · {cfg.gridColsLg} cols · {cfg.idleLines} preview lines
            </span>
            <div
              className="grid gap-2"
              style={{ gridTemplateColumns: `repeat(${Math.min(cfg.gridColsLg, 3)}, minmax(0, 1fr))` }}
            >
              {MOCK_TILES.slice(0, 3).map((t) => (
                <SessionTile key={`${tier}-${t.name}`} session={t} sizeTier={tier} />
              ))}
            </div>
          </div>
        )
      })}
    </div>
  )
}

/* ── one theme's worth of bench ──────────────────────────────────────────── */

function BenchPanel({ theme }: { theme: BenchTheme }) {
  const ring = PAPER[theme].paper
  return (
    <div
      data-theme={theme}
      data-bench-theme={theme}
      style={{ ['--sm-bench-ring' as string]: ring }}
      // `[data-theme]` flips the B0 paper ladder, but the app's own shadcn
      // tokens (`bg-card`, `--border`, …) hang off the `.dark` CLASS — and this
      // bench renders BOTH kinds of surface: paper-ladder rows and the shipped
      // SessionTile. Without the class the dark panel draws white tiles on dark
      // paper, which is a bench bug that reads as a design bug.
      className={theme === 'dark' ? 'dark bg-paper text-ink' : 'bg-paper text-ink'}
    >
      <div className="mx-auto flex w-full max-w-6xl flex-col gap-12 px-6 py-12">
        <header className="flex flex-col gap-2">
          <h1 className="text-xl font-semibold tracking-tight text-ink">
            The roster — {theme}
          </h1>
          <p className="max-w-3xl text-xs leading-relaxed text-ink-2">
            One presentational row at three densities, six mark states, three attention tiers, and
            the tile at four overview tiers — the whole of what fase B2 moves. Both themes are on
            this page; this half is the{' '}
            <strong className="font-medium text-ink">{theme}</strong> subtree. Every matrix is a
            still frame.
          </p>
        </header>

        <Section
          id="densities"
          title="Three densities, one component"
          note="RosterRow is the single most-repeated object in the product, and B2 makes it the only one: the overview list row, the focus strip's compact tile and every picker row become the same component at a different density. list h64/mark 40 with the preview line · strip h48/mark 28 · picker h40/mark 24 and deliberately STATIC — a timestamp that ticks under the keyboard cursor is a bug, not a feature."
        >
          <DensityMatrix />
        </Section>

        <Section
          id="states"
          title="Six states × three densities"
          note="B0's contract C5: the silhouette is never ringed, notched or overpainted — state lives in the eyes and only in the eyes. That contract was proved at 40px on /dev/marks; here it has to survive at 24px in a picker row. Read each column top to bottom: idle open · working narrowed and slanted · waiting rounded · done squinted · stopped shut to a lid line · failed the one mirrored tilt."
        >
          <StateMatrix />
        </Section>

        <Section
          id="attention"
          title="Attention tiers"
          note="needs · unread · working · quiet, in that precedence. The needs-you dot is the ONLY glyph seated on the silhouette (7px, on the character's own shoulder). quiet renders no glyph at all and is on the bench precisely so the difference between quiet and unread is something you can look at."
        >
          <AttentionMatrix />
        </Section>

        <Section
          id="selection"
          title="Selection"
          note="sm-accent-row — the focused session's own pigment mixed into the paper at 9% (light) / 12% (dark). The only tinted chrome in the app, so it is checked against three different pigments, and hover is suppressed while selected."
        >
          <SelectionMatrix />
        </Section>

        <Section
          id="pinned-hairline"
          title="The pinned block"
          note={`A 0.5px separator after the pinned rows and no "Pinned" text header — the boundary is visible, the label is not needed. Renders nothing when there are no pins and nothing when everything is pinned. Benched with ${PINNED_NAMES.length} pinned of ${ROSTER_CAST.length}.`}
        >
          <Plate label={`${PINNED_NAMES.length} pinned of ${ROSTER_CAST.length}`}>
            {ROSTER_CAST.slice(0, 6).map((m, i) => {
              const pinned = PINNED_NAMES.includes(m.name)
              const boundary =
                !pinned && PINNED_NAMES.includes(ROSTER_CAST[i - 1]?.name ?? '')
              return (
                <React.Fragment key={m.name}>
                  {boundary && (
                    <div
                      aria-hidden
                      data-vr="pinned-hairline"
                      className="my-0.5 h-px bg-hairline"
                    />
                  )}
                  <BenchRow member={m} density="list" />
                </React.Fragment>
              )
            })}
          </Plate>
        </Section>

        <Section
          id="tiles"
          title="The tile at four density tiers"
          note="The overview's other surface. B2 replaces the bare status dot with the session's mark (no ring — C5) and gates the tile's facts on the fact ladder, so all four tiers are here to prove no tier drops a fact it used to show."
        >
          <TileTiers />
        </Section>

        <Section
          id="rollup"
          title="The attention rollup"
          note={`"needs you: N" on B0's facepile, in the overview header. N=${ROLLUP_COUNTS.join(' · N=')} — 0 must render NOTHING (no empty chrome) and 9 must collapse to three marks and a +6.`}
        >
          <div className="flex flex-col gap-4">
            {ROLLUP_COUNTS.map((n) => (
              <div key={n} data-bench-rollup={n} className="flex items-center gap-3">
                <span className="w-10 shrink-0 text-[11px] tabular-nums text-ink-3">N={n}</span>
                <div className="min-h-6">
                  <AttentionRollup
                    sessions={ROSTER_CAST.slice(0, n).map((m, i) => ({
                      name: m.name,
                      status: 'waiting' as const,
                      activity_at: 1_800_000_000_000 - (n - i) * 60_000,
                    }))}
                  />
                </div>
              </div>
            ))}
          </div>
        </Section>

        <Section
          id="issues"
          title="The issue surface"
          note={`Per-session and per-team issue lists in ${ISSUE_STATES.join(' / ')} — the capability that has to exist before the Board page can be deleted.`}
        >
          {/* The LIST is server-backed (`useBoard`), so the bench shows the two
              pure pieces it is made of instead of faking a query: the acceptance
              checklist the agent ticks over SSE, and the composer that turns
              into a durable comment when the session is gone. The list's own
              states are covered by `issue-surface.spec.ts` against a real
              server. */}
          <Plate label="acceptance — the agent ticks these live">
            <div className="px-2 pb-2">
              <AcceptanceChecklist
                issueId="T-42"
                items={[
                  { id: 1, issue_id: 'T-42', body: 'unit suite green', done: 1, pos: 0 },
                  { id: 2, issue_id: 'T-42', body: 'VR in both themes', done: 1, pos: 1 },
                  {
                    id: 3,
                    issue_id: 'T-42',
                    body: 'perf budget under the ratchet',
                    done: 0,
                    pos: 2,
                  },
                ]}
              />
            </div>
          </Plate>
          <Plate label="reply — a comment when the session is gone">
            <div className="px-2 pb-2">
              <ReplyComposer
                issue={{ id: 'T-42', session: null } as never}
                expanded
                emphasized={false}
                onRequestOpen={() => {}}
                onReply={async () => {}}
                placeholder="Leave a comment for the record…"
              />
            </div>
          </Plate>
        </Section>

        {/* ── B5/T13.3 ─────────────────────────────────────────────────────
            Bench states for the two mechanisms B5 introduces that have a
            LOOK: the armed confirm (T9) and the recovery ladder (T8). Both
            are states you otherwise have to break something to reach — a
            terminal has to die before the ladder renders, and the armed
            state disarms itself after 4 s — so without a bench they can only
            be reviewed live, in the one situation where nobody wants to be
            fiddling with CSS. */}
        <Section
          id="armed-confirm"
          title="The armed confirm — both halves"
          note="One idiom replacing three (B5/T9). Resting reads as the action; armed reads as the CONSEQUENCE, with Cancel first so a mis-click has somewhere safe to land. The armed half is the whole point of benching this: it lives for four seconds, so it is otherwise near-impossible to look at properly."
        >
          <ArmedConfirmMatrix />
        </Section>

        <Section
          id="recovery-ladder"
          title="The recovery ladder"
          note="Ordered by what each rung PRESERVES, least-destructive first — never by how drastic the verb sounds. Every row states both halves; the destroys sentence is never softened, because it is the one that prevents regret. The blocked row shows a rung that cannot help this session type, saying why rather than offering a button whose only answer is 'unsupported'."
        >
          <RecoveryLadderMatrix />
        </Section>
      </div>
    </div>
  )
}

/** Resting and armed, side by side — the armed half cannot otherwise be held
 *  still long enough to review. */
function ArmedConfirmMatrix() {
  const resting: ArmedConfirm = {
    armed: false,
    press: () => {},
    cancel: () => {},
  }
  const armed: ArmedConfirm = { armed: true, press: () => {}, cancel: () => {} }
  return (
    <div className="flex flex-wrap items-start gap-8">
      <Plate label="resting — the action">
        <div className="p-3">
          <ArmedButton
            confirm={resting}
            label="Delete host"
            confirmLabel="Delete"
            icon={<Trash2 className="size-3.5" aria-hidden />}
          />
        </div>
      </Plate>
      <Plate label="armed — the consequence, 4s">
        <div className="p-3">
          <ArmedButton
            confirm={armed}
            label="Delete host"
            confirmLabel="Delete host"
          />
        </div>
      </Plate>
      <Plate label="armed — bulk verb">
        <div className="p-3">
          <ArmedButton
            confirm={armed}
            label="Delete all"
            confirmLabel="Delete 12"
          />
        </div>
      </Plate>
    </div>
  )
}

/** The canonical ladder, in both of its shapes: a session that CAN be
 *  recovered in place, and one that cannot (so the first rung is blocked). */
function RecoveryLadderMatrix() {
  return (
    <div className="flex flex-col gap-6">
      <Plate label="native + local — every rung available">
        <div className="p-3">
          <RecoveryLadder session={{ runtime: 'native', host_id: null }} />
        </div>
      </Plate>
      <Plate label="tmux — recover blocked, and says why">
        <div className="p-3">
          <RecoveryLadder session={{ runtime: 'tmux', host_id: null }} />
        </div>
      </Plate>
      <Plate label="auto-recovery toggle — the pref that had no UI">
        <div className="p-3">
          <AutoHealToggle enabled onChange={() => {}} />
        </div>
      </Plate>
    </div>
  )
}

export default function DevRoster() {
  return (
    <div className="min-h-dvh bg-paper" data-vr="dev-roster">
      {BENCH_THEMES.map((theme) => (
        <BenchPanel key={theme} theme={theme} />
      ))}
    </div>
  )
}
