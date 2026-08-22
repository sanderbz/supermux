// /dev/chat-ui — the bench for the chat surface's static primitives (fase B0,
// task 4).
//
// DEV-only + lazy + mounted outside <Layout> (mirrors /dev/marks, /dev/tiles),
// so neither the route nor its fixture can reach a production chunk and the page
// is pure design system: no nav, no header, nothing but the surface.
//
// Two halves, in both themes:
//   · THE BOARD — the approved hero mockup's Release Train screen, rebuilt out
//     of the shipped primitives. This is the parity anchor: hold it next to
//     board-light.png / board-dark.png. If a primitive drifts, this half stops
//     matching the render.
//   · THE PARTS — every primitive with the variants the board has no room for:
//     a 16-line receipt group with a live line, the working row at three
//     lengths, a selected choice card, the mobile composer, a facepile morphed
//     open, a roster row for every state.
//
// The board writes `--sm-accent` from the FOCUSED session's pigment, which is
// the whole per-session accent contract in one line: the selected roster row,
// the composer's focus ring and the choice card's selected border all recolour
// from that single property (concept contract C7).
//
// No framer-motion here on purpose. Everything on this page is either static or
// an ambient CSS loop (the dot wave, the receipt spinner, the marks' breathe);
// there is no component-level transition to source from lib/springs.ts.
import { bodyColor, characterFromSeed, SessionMark } from '@/brand/marks'
import { PAPER } from '@/brand/tokens'
import {
  ArrivalDivider,
  BackIcon,
  Bubble,
  BubbleCode,
  CapturedFrameCard,
  CAPTURED_FRAME,
  ChoiceCard,
  CodeAdd,
  CodeDel,
  Composer,
  DelegationPill,
  Facepile,
  FaceName,
  InlineCode,
  MentionChip,
  MessageRow,
  PathRef,
  ReceiptGroup,
  RosterRow,
  SystemEntity,
  SystemLine,
  PHONE,
  SystemSep,
  WorkingRow,
} from '@/components/chat/ui'

import { RendererSwitch } from '@/components/chat/renderer-switch'
import {
  BENCH_THEMES,
  BOARD_CHOICE,
  BOARD_FRAME,
  BOARD_RECEIPTS,
  BOARD_ROSTER,
  FOCUS,
  pinFor,
  PHONE_CLOCK,
  PHONE_CLOSE,
  PHONE_RECEIPTS,
  PHONE_TAIL,
  PHONE_THREAD,
  PLAN_CHOICE,
  VOLUME_RECEIPTS,
  type BenchTheme,
  type PhoneTurn,
} from './dev-chat-ui.fixture'

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

/** A labelled slab of paper to stand a primitive on. */
function Plate({
  label,
  children,
  raised = true,
  className,
}: {
  label?: string
  children: React.ReactNode
  raised?: boolean
  className?: string
}) {
  return (
    <div className="flex max-w-full flex-col gap-1.5">
      {label && <span className="text-[11px] text-ink-3">{label}</span>}
      {/* Wide demos (the 600px composer, a 744px transcript column) scroll
          inside their own plate — the page body must never scroll sideways. */}
      <div
        className={`overflow-x-auto rounded-2xl border-[0.5px] border-hairline-soft p-5 ${
          raised ? 'bg-paper-raised' : 'bg-paper'
        } ${className ?? ''}`}
      >
        {children}
      </div>
    </div>
  )
}

/* ── the board ───────────────────────────────────────────────────────────── */

function Board({ theme }: { theme: BenchTheme }) {
  const ring = PAPER[theme].paper
  const paneRing = PAPER[theme].paperRaised
  const focusPin = pinFor(FOCUS)

  return (
    <div
      data-board=""
      // 1000px tall is the approved artboard's pane height, and it is
      // load-bearing rather than cosmetic: the transcript is bottom-anchored, so
      // a shorter pane scrolls the captured frame up UNDER the 80px-blur header
      // and smears it across the bar — which is what the 880px board did. Width
      // is not load-bearing (the track is a centred 744px column), so the board
      // still flexes with the window.
      className="flex h-[1000px] w-full min-w-[1000px] overflow-hidden rounded-[24px] shadow-[var(--sm-elev)]"
    >
      {/* sidebar */}
      <div className="relative z-[2] flex w-[280px] flex-none flex-col bg-paper pt-3">
        <div className="flex flex-col gap-0.5 overflow-hidden px-2">
          {BOARD_ROSTER.map((row) => (
            <RosterRow
              key={row.name}
              seed={row.name}
              pin={pinFor(row.name)}
              timestamp={row.timestamp}
              preview={row.preview}
              state={row.state}
              attention={row.attention}
              selected={row.name === FOCUS}
              ring={ring}
              crew={
                row.crew?.map((member) => ({ seed: member, pin: pinFor(member), name: member }))
              }
            />
          ))}
        </div>
        <div className="pointer-events-none absolute inset-y-0 right-0 w-px bg-hairline" />
      </div>

      {/* conversation */}
      <div className="relative flex-1 overflow-hidden bg-paper-raised">
        <div className="absolute inset-x-0 top-0 z-[3] flex h-16 items-center gap-3 border-b-[0.5px] border-hairline bg-surface px-6 backdrop-blur-[80px] backdrop-saturate-[180%]">
          <SessionMark seed={FOCUS} pin={focusPin} size={28} state="working" label={null} />
          <span className="text-[16px] font-semibold tracking-[-0.2px] text-ink">{FOCUS}</span>
        </div>

        <div className="absolute inset-0 overflow-hidden">
          <div className="absolute bottom-0 left-1/2 w-[744px] -translate-x-1/2 pb-[90px]">
            <SystemLine>Renamed to Release Train</SystemLine>

            <MessageRow
              gutter={<SessionMark seed={FOCUS} pin={focusPin} size={28} label={null} />}
            >
              <Bubble>tagged v0.6.0 and the build is rolling. two checks left.</Bubble>
            </MessageRow>

            <MessageRow grouped>
              <Bubble>
                <CapturedFrameCard caption={BOARD_FRAME.caption}>
                  <MiniWindow />
                </CapturedFrameCard>
              </Bubble>
            </MessageRow>

            <MessageRow grouped>
              <ReceiptGroup rows={BOARD_RECEIPTS} />
            </MessageRow>

            <DelegationPill
              from={FOCUS}
              fromPin={focusPin}
              to="Patch"
              toPin={pinFor('Patch')}
              ring={paneRing}
            />

            <ArrivalDivider>
              <span>Messages from</span>
              <FaceName seed="Patch" pin={pinFor('Patch')} ring={paneRing} />
              <span>and</span>
              <FaceName seed="Quill" pin={pinFor('Quill')} ring={paneRing} />
            </ArrivalDivider>

            <MessageRow
              className="mt-4"
              gutter={<SessionMark seed={FOCUS} pin={focusPin} size={28} label={null} />}
            >
              <Bubble>
                <MentionChip seed="Patch" pin={pinFor('Patch')} /> sent over the failing job and{' '}
                <MentionChip seed="Quill" pin={pinFor('Quill')} /> tightened the notes. both folded
                into tonight&apos;s run.
              </Bubble>
            </MessageRow>

            <MessageRow me>
              <Bubble variant="user">ship it once CI is green</Bubble>
            </MessageRow>

            <SystemLine>
              Created schedule
              <SystemSep />
              <SystemEntity onClick={() => undefined}>Nightly release watch</SystemEntity>
            </SystemLine>

            <MessageRow
              gutter={
                <SessionMark seed={FOCUS} pin={focusPin} size={28} state="working" label={null} />
              }
            >
              <Bubble>one check left. then crates.io.</Bubble>
            </MessageRow>

            <ChoiceCard
              question={
                <>
                  Run <InlineCode>{BOARD_CHOICE.command}</InlineCode>
                  {BOARD_CHOICE.tail}
                </>
              }
              why={BOARD_CHOICE.why}
              options={BOARD_CHOICE.options}
            />
          </div>
        </div>

        <div className="absolute inset-x-8 bottom-[18px] z-[4]">
          <Composer placeholder={`Message ${FOCUS}`} className="mx-auto max-w-[744px]" />
        </div>
      </div>
    </div>
  )
}

/* ── the phone board ─────────────────────────────────────────────────────── */

/**
 * `mobile-light.png` / `mobile-dark.png`, rebuilt out of the same primitives.
 *
 * The phone is a DIFFERENT composition, not the board at a narrow width: the
 * roster is gone, the header floats as a 60px glass card inset 12px below the
 * status bar instead of pinning to the top edge, both bubble ceilings drop, and
 * the composer takes its 52px rung. Reviewing mobile by squashing the desktop
 * board would review none of that — which is exactly what the bench did before.
 */
function PhoneBoard({ theme }: { theme: BenchTheme }) {
  const ring = PAPER[theme].paperRaised
  const focusPin = pinFor(FOCUS)

  const turn = (t: PhoneTurn, key: string) =>
    t.from === 'me' ? (
      <MessageRow key={key} me>
        <Bubble variant="user" surface="phone">
          {t.text}
        </Bubble>
      </MessageRow>
    ) : (
      <MessageRow
        key={key}
        gutter={
          <SessionMark seed={FOCUS} pin={focusPin} size={28} state={t.state} label={null} />
        }
      >
        <Bubble surface="phone">{t.text}</Bubble>
      </MessageRow>
    )

  return (
    <div
      data-phone=""
      style={{ width: PHONE.width, height: PHONE.height, borderRadius: PHONE.radius }}
      className="relative flex-none overflow-hidden bg-paper-raised shadow-[var(--sm-elev)]"
    >
      {/* status bar + notch — the phone's own chrome, above the floating head */}
      <div
        style={{ height: PHONE.topbar }}
        className="absolute inset-x-0 top-0 z-[2] bg-paper-raised"
      />
      <div className="absolute left-1/2 top-3 z-[6] h-[30px] w-[110px] -translate-x-1/2 rounded-full bg-[#0d0c0b] shadow-[0_0_0_0.5px_var(--sm-hairline)]" />
      <div className="absolute inset-x-[26px] top-5 z-[5] flex h-4 items-center justify-between text-[13px] font-semibold tracking-[-0.1px] text-ink">
        <span>{PHONE_CLOCK}</span>
        <span aria-hidden className="flex h-[9px] items-end gap-[2.5px]">
          {[4, 6, 8, 9].map((h) => (
            <i key={h} style={{ height: h }} className="block w-[3px] rounded-sm bg-ink" />
          ))}
        </span>
      </div>

      <div
        style={{
          top: PHONE.head.top,
          left: PHONE.head.inset,
          right: PHONE.head.inset,
          height: PHONE.head.height,
          borderRadius: PHONE.head.radius,
        }}
        className="absolute z-[3] flex items-center gap-3 border-[0.5px] border-hairline bg-surface pl-4 pr-3 backdrop-blur-[60px] backdrop-saturate-[180%]"
      >
        <span
          aria-hidden
          className="grid size-[34px] flex-none place-items-center rounded-full bg-fill-soft text-ink-2"
        >
          <BackIcon />
        </span>
        <SessionMark seed={FOCUS} pin={focusPin} size={28} state="working" label={null} />
        <span className="min-w-0 flex-1 truncate text-[16px] font-semibold tracking-[-0.2px] text-ink">
          {FOCUS}
        </span>
        <span className="grid size-7 flex-none place-items-center rounded-full border-[0.5px] border-hairline-soft bg-fill-soft text-[10.5px] font-semibold tracking-[0.4px] text-ink-2">
          SB
        </span>
      </div>

      <div className="absolute inset-0 overflow-hidden">
        <div
          style={{ paddingLeft: PHONE.track.inset, paddingRight: PHONE.track.inset, paddingBottom: PHONE.track.bottom }}
          className="absolute bottom-0 left-0 w-full"
        >
          {PHONE_THREAD.map((t, i) => turn(t, `head-${i}`))}

          <MessageRow grouped>
            <ReceiptGroup rows={PHONE_RECEIPTS} />
          </MessageRow>

          <MessageRow grouped>
            <Bubble surface="phone">
              <CapturedFrameCard caption={BOARD_FRAME.caption} width={CAPTURED_FRAME.width}>
                <MiniWindow />
              </CapturedFrameCard>
            </Bubble>
          </MessageRow>

          <DelegationPill
            from={FOCUS}
            fromPin={focusPin}
            to="Patch"
            toPin={pinFor('Patch')}
            ring={ring}
            size={24}
          />

          <ArrivalDivider>
            <span>Messages from</span>
            <FaceName seed="Patch" pin={pinFor('Patch')} ring={ring} />
            <span>and</span>
            <FaceName seed="Quill" pin={pinFor('Quill')} ring={ring} />
          </ArrivalDivider>

          <MessageRow
            className="mt-[14px]"
            gutter={<SessionMark seed={FOCUS} pin={focusPin} size={28} label={null} />}
          >
            <Bubble surface="phone">
              <MentionChip seed="Patch" pin={pinFor('Patch')} /> sent the failing job over and{' '}
              <MentionChip seed="Quill" pin={pinFor('Quill')} /> trimmed the notes. both folded in.
            </Bubble>
          </MessageRow>

          {PHONE_TAIL.map((t, i) => turn(t, `tail-${i}`))}

          <SystemLine>
            Created schedule
            <SystemSep />
            <SystemEntity onClick={() => undefined}>Nightly release watch</SystemEntity>
          </SystemLine>

          {PHONE_CLOSE.map((t, i) => turn(t, `close-${i}`))}
        </div>
      </div>

      <div className="absolute inset-x-[14px] bottom-[14px] z-[4]">
        <Composer size="mobile" placeholder={`Message ${FOCUS}`} />
      </div>
    </div>
  )
}

/**
 * What the captured frame is a frame OF: supermux itself, three sessions deep.
 * Art for the bench — a real capture ships as `src`.
 */
function MiniWindow() {
  return (
    <div className="absolute left-[11%] top-[20%] flex w-[74%] overflow-hidden rounded-[8px] bg-[#fdfbf9] shadow-[0_22px_44px_-16px_rgba(26,12,22,0.62),0_0_0_0.5px_rgba(0,0,0,0.18)]">
      <div className="w-[33%] flex-none bg-[#f7f3ef] px-[5px] py-1.5">
        <div className="flex h-1.5 items-center gap-[3px] pb-1.5 pl-px">
          {['#ec6a5e', '#f4bf4f', '#61c554'].map((c) => (
            <i key={c} className="block size-1 rounded-full" style={{ background: c }} />
          ))}
        </div>
        {['Release Train', 'Patch', 'Quill'].map((name, i) => (
          <div
            key={name}
            className={`mt-[5px] flex items-center gap-1 rounded p-0.5 ${
              i === 0 ? 'bg-[rgba(241,95,88,0.13)]' : ''
            }`}
          >
            <SessionMark seed={name} pin={pinFor(name)} size={11} animate={false} label={null} />
            <div className="flex flex-1 flex-col gap-[2.5px]">
              <u className="block h-[3px] rounded-sm bg-[rgba(30,22,14,0.30)] no-underline" />
              <u className="block h-[3px] w-[78%] rounded-sm bg-[rgba(30,22,14,0.14)] no-underline" />
            </div>
          </div>
        ))}
      </div>
      <div className="flex flex-1 flex-col gap-[5px] px-2 py-[9px]">
        <div className="h-[13px] w-[84%] rounded-md bg-[rgba(30,22,14,0.09)]" />
        <div className="h-[13px] w-[62%] rounded-md bg-[rgba(30,22,14,0.09)]" />
        <div className="ml-auto h-[13px] w-[46%] rounded-md bg-[#241f1c]" />
        <div className="h-[13px] w-[72%] rounded-md bg-[rgba(30,22,14,0.09)]" />
      </div>
    </div>
  )
}

/* ── the parts ───────────────────────────────────────────────────────────── */

function Parts({ theme }: { theme: BenchTheme }) {
  const ring = PAPER[theme].paper
  const crew = ['Lookout', 'Ledger', 'Patch'].map((n) => ({ seed: n, pin: pinFor(n), name: n }))

  return (
    <div className="flex flex-col gap-12">
      <Section
        id="roster-row"
        title="RosterRow"
        note="64px row: 40px mark · name 14/500 · ticking time 12 · the session's own last line at 13. The preview IS the status line — 'one check left. then crates.io.' says more than 'active'. Selected mixes the focused session's pigment into the paper at 9% (light) / 12% (dark); hover is suppressed while selected. A team row puts three 18px members in one mark's footprint."
      >
        <Plate className="max-w-[300px]">
          <div className="flex flex-col gap-0.5">
            <RosterRow
              seed="Release Train"
              pin={pinFor('Release Train')}
              timestamp="1:47 PM"
              preview="one check left. then crates.io."
              state="working"
              selected
              ring={ring}
            />
            <RosterRow
              seed="Patch"
              pin={pinFor('Patch')}
              timestamp="11:02 AM"
              preview="Typing…"
              state="working"
              ring={ring}
            />
            <RosterRow
              seed="Quill"
              pin={pinFor('Quill')}
              timestamp="10:12 AM"
              preview="readme rewritten. shorter now."
              state="waiting"
              attention
              ring={ring}
            />
            <RosterRow
              seed="Kestrel"
              pin={pinFor('Kestrel')}
              timestamp="Yesterday"
              preview="strato box is quiet since the fix."
              state="done"
              ring={ring}
            />
            <RosterRow
              seed="Render crew"
              timestamp="Yesterday"
              preview="that flicker's gone on ios."
              crew={crew}
              ring={ring}
            />
            <RosterRow
              seed="a-session-with-a-very-long-name-that-cannot-fit"
              timestamp="Yesterday"
              preview="the name truncates; the timestamp never does — it is the one fact that must survive."
              state="stopped"
              ring={ring}
            />
          </div>
        </Plate>
      </Section>

      <Section
        id="bubble"
        title="Bubble"
        note="Radius 18, padding 11/17, 15px/1.45, tracking −0.1px. The agent bubble is a FIXED warm neutral — never accent-tinted, because identity is carried by the mark, not by the fill. The user bubble is inverted and capped at 420px so a human sentence never spans the column. Consecutive bubbles stack at 8px instead of 14px and drop the repeated mark."
      >
        <Plate>
          <div className="w-full max-w-[744px]">
            <MessageRow gutter={<SessionMark seed="Patch" pin={pinFor('Patch')} size={28} label={null} />}>
              <Bubble>
                found it in <PathRef>server/src/export/money.rs</PathRef> — we parsed with the dot as
                the decimal mark, so 1.234,56 came back as one and a bit:
                <BubbleCode>
                  <CodeDel>{'-  let cents = raw.replace(\',\', "").parse::<f64>()?;'}</CodeDel>
                  {'\n'}
                  <CodeAdd>{'+  let cents = Money::parse_locale(raw, locale)?;'}</CodeAdd>
                </BubbleCode>
              </Bubble>
            </MessageRow>
            <MessageRow grouped>
              <Bubble>branch is ready. three commits, one from each of us.</Bubble>
            </MessageRow>
            <MessageRow me>
              <Bubble variant="user">good. open the PR</Bubble>
            </MessageRow>
          </div>
        </Plate>
      </Section>

      <Section
        id="receipt-group"
        title="ReceiptGroup"
        note="Tool calls as a checklist: 13px check in the leading slot, tool at 600, a 15×12 arrow, the outcome in tabular-nums. Built for Claude's volume — consecutive repeats coalesce into 'Read ×12' and DROP the outcome (twelve files had twelve different outcomes), a cap hides the rest behind 'Show all N', and the running line keeps the same slot with a 2.4s spinner so nothing reflows when it lands."
      >
        <div className="flex flex-wrap items-start gap-6">
          <Plate label="the approved board">
            <ReceiptGroup rows={BOARD_RECEIPTS} />
          </Plate>
          <Plate label="a real turn — coalesced, capped, one line still running">
            {/* max=2 so the cap actually bites AND the live line is still on
                screen: the running row is pulled past the cap, because it is the
                one row the user is watching. */}
            <ReceiptGroup rows={VOLUME_RECEIPTS} max={2} />
          </Plate>
        </div>
      </Section>

      <Section
        id="working-row"
        title="WorkingRow"
        note="The live turn indicator: the session's face at 28px on the transcript gutter, the three-dot wave, the hook label at 13px secondary, and an elapsed clause once the turn is worth counting. VISUAL ONLY — the status flip, the label and the clock live in the renderer slice. The presence variant is the same signal one notch quieter: no mark, no dots, indented to the bubble's left edge."
      >
        <Plate>
          <div className="w-full max-w-[600px]">
            <WorkingRow seed="Release Train" pin={pinFor('Release Train')} label="Thinking…" />
            <WorkingRow
              seed="Release Train"
              pin={pinFor('Release Train')}
              label="Bash · cargo test --workspace"
              elapsed="1m 24s"
            />
            <WorkingRow
              seed="Quill"
              pin={pinFor('Quill')}
              state="waiting"
              label="waiting on you"
              elapsed="12s"
            />
            <WorkingRow variant="presence" label="Typing…" />
          </div>
        </Plate>
      </Section>

      <Section
        id="system-line"
        title="SystemLine"
        note="Centred 13px secondary, 22px of air, tracking −0.05px. Every cross-session event the app already writes to its audit log becomes a line here, and the entity is a navigation affordance: the hover pill uses negative margins that cancel its padding, so the sentence does not shift when a chip becomes interactive. In prose, a mention chip is the same mechanic with the named session's own mark and pigment — never a filled tag."
      >
        <Plate>
          <div className="w-full max-w-[600px]">
            <SystemLine>Renamed to Release Train</SystemLine>
            <SystemLine>
              Created schedule
              <SystemSep />
              <SystemEntity onClick={() => undefined}>Nightly release watch</SystemEntity>
            </SystemLine>
            <SystemLine>
              Linked board issue
              <SystemSep />
              <SystemEntity onClick={() => undefined}>euro amounts in the export</SystemEntity>
            </SystemLine>
            <SystemLine>Context compacted · 68% → 21%</SystemLine>
            <MessageRow gutter={<SessionMark seed={FOCUS} pin={pinFor(FOCUS)} size={28} label={null} />}>
              <Bubble>
                <MentionChip seed="Ledger" pin={pinFor('Ledger')} /> had the same bug in the invoice
                path and <MentionChip seed="Compass" pin={pinFor('Compass')} /> found the dead links.
                both in this branch now.
              </Bubble>
            </MessageRow>
          </div>
        </Plate>
      </Section>

      <Section
        id="delegation-pill"
        title="DelegationPill"
        note="The handoff, in flight, in the sender's transcript: a 46px glass pill with both faces at 26px, each keylined against the pane, and the label in the RECIPIENT's pigment. backdrop-filter is allowed here — §11.1 restricts it to floating chrome and forbids it on the shell, where it would turn the root into a containing block for every fixed descendant."
      >
        <Plate>
          <DelegationPill
            from={FOCUS}
            fromPin={pinFor(FOCUS)}
            to="Patch"
            toPin={pinFor('Patch')}
            ring={PAPER[theme].paperRaised}
          />
          <DelegationPill
            from="Patch"
            fromPin={pinFor('Patch')}
            to="Ledger"
            toPin={pinFor('Ledger')}
            ring={PAPER[theme].paperRaised}
          />
        </Plate>
      </Section>

      <Section
        id="choice-card"
        title="ChoiceCard"
        note="Anything the TUI shows as a numbered list. Glass card at the bubble's left edge, the ask at 15/500 with the command in mono, then the line the decision actually turns on: where it runs and what it reaches. ONE button grammar — emphasis is weight plus a soft fill, never the identity hue, because the accent is who is speaking, not what will happen. The digits are the modal registry's option mapping; selection borrows the accent at 55% border / 8% fill."
      >
        <div className="flex flex-wrap items-start gap-6">
          <Plate label="pending">
            <div className="-ml-11">
              <ChoiceCard
                question={
                  <>
                    Run <InlineCode>{BOARD_CHOICE.command}</InlineCode>
                    {BOARD_CHOICE.tail}
                  </>
                }
                why={BOARD_CHOICE.why}
                options={BOARD_CHOICE.options}
              />
            </div>
          </Plate>
          <Plate label="plan approval — digits bound to the registry, cursor on option 2">
            <div className="-ml-11">
              <ChoiceCard
                question={PLAN_CHOICE.question}
                why={PLAN_CHOICE.why}
                options={PLAN_CHOICE.options}
                selectedIndex={1}
              />
            </div>
          </Plate>
        </div>
      </Section>

      {/* The binary switch in both values × both variants, in one frame. The
          state a screenshot catches lying: a compact rail that clips. */}
      <Section
        id="switch-tri"
        title="RendererSwitch (Chat · Terminal)"
        note="A binary toggle over the ACTIVE renderer: `value` is the mounted surface and a tap pins the other. The compact rail (size=sm, labels=selected) is the phone header card's: one word for what you are looking at, a glyph for the rest."
      >
        <div className="flex flex-wrap items-start gap-8">
          <Plate label="full">
            <div className="flex flex-col items-start gap-3">
              <RendererSwitch value="chat" onChange={() => undefined} />
              <RendererSwitch value="terminal" onChange={() => undefined} />
            </div>
          </Plate>
          <Plate label="compact (phone header)">
            <div className="flex flex-col items-start gap-3">
              <RendererSwitch
                size="sm"
                labels="selected"
                value="chat"
                onChange={() => undefined}
              />
              <RendererSwitch
                size="sm"
                labels="selected"
                value="terminal"
                onChange={() => undefined}
              />
            </div>
          </Plate>
        </div>
      </Section>

      <Section
        id="composer"
        title="Composer"
        note="VISUAL SHELL — it does not submit. 58px pill (52 on the phone), glass, 0.5px hairline, and a focus ring in the focused session's pigment at 22% — the one place the accent touches a control, and only as a focus state. Click into it to see the ring. The mic is the single inverted control on the surface."
      >
        <div className="flex flex-wrap items-start gap-6">
          <Plate label="desktop">
            <Composer placeholder="Message Release Train" className="w-[600px] max-w-full" />
          </Plate>
          <Plate label="phone">
            <Composer placeholder="Message Release Train" size="mobile" className="w-[330px] max-w-full" />
          </Plate>
        </div>
      </Section>

      <Section
        id="captured-frame-card"
        title="CapturedFrameCard"
        note="The one warm, non-flat object in the column: 340px wide, 16:10, radius 14, with the filename and a 12px glyph under it. Every other surface here is flat warm neutral, so the object with depth is the thing the session is showing you. Without a src it renders this honest placeholder rather than a grey box."
      >
        <Plate>
          <div className="flex flex-wrap gap-8">
            <CapturedFrameCard caption="release-run.png" onOpen={() => undefined}>
              <MiniWindow />
            </CapturedFrameCard>
            <CapturedFrameCard caption="ios-flicker-after.png" width={266}>
              <MiniWindow />
            </CapturedFrameCard>
          </div>
        </Plate>
      </Section>

      <Section
        id="facepile"
        title="Facepile"
        note="Several sessions as one object. The cluster is a 40px crew badge — three 18px members, 1-over-2, each keylined in the page colour so adjacent pigments separate; it occupies exactly one mark's footprint, because a team is a colleague too. The row is the inline pile at −24% overlap, where the member that just changed state morphs open with its name by animating padding."
      >
        <Plate>
          <div className="flex flex-wrap items-center gap-10">
            <Facepile members={crew} ring={ring} />
            <Facepile members={crew} variant="row" ring={ring} />
            <Facepile members={crew} variant="row" ring={ring} activeIndex={1} />
            <ArrivalDivider className="mt-0">
              <span>Messages from</span>
              <FaceName seed="Patch" pin={pinFor('Patch')} ring={ring} />
              <span>and</span>
              <FaceName seed="Quill" pin={pinFor('Quill')} ring={ring} />
            </ArrivalDivider>
          </div>
        </Plate>
      </Section>
    </div>
  )
}

/* ── one theme's worth of bench ──────────────────────────────────────────── */

function BenchPanel({ theme }: { theme: BenchTheme }) {
  // The shell's one property write, at page scope: every accent surface below —
  // the selected roster row, the composer's focus ring, a selected choice —
  // derives from the FOCUSED session's pigment (concept contract C7). In the app
  // this lands on the shell element when you enter a session.
  const accent = bodyColor(characterFromSeed(FOCUS, pinFor(FOCUS)).hue)
  return (
    <div
      data-theme={theme}
      data-bench-theme={theme}
      style={{ '--sm-accent': accent } as React.CSSProperties}
      className="bg-paper text-ink"
    >
      <div className="mx-auto flex w-full max-w-6xl flex-col gap-12 px-6 py-12">
        <header className="flex flex-col gap-2">
          <h1 className="text-xl font-semibold tracking-tight text-ink">
            Chat surface — {theme}
          </h1>
          <p className="max-w-3xl text-xs leading-relaxed text-ink-2">
            The static primitives of the approved design system (
            <code className="rounded bg-code-bg px-1 py-0.5">src/components/chat/ui/</code>), on the
            B0 warm-paper ladder. Both themes are on this page; this half is the{' '}
            <strong className="font-medium text-ink">{theme}</strong> subtree. The board below is the
            hero mockup&apos;s Release Train screen rebuilt out of these components — hold it next to{' '}
            <code className="rounded bg-code-bg px-1 py-0.5">board-{theme}.png</code>.
          </p>
        </header>

        <Section
          id="board"
          title="The board"
          note="Every primitive, in the composition they were designed for, with the focused session's pigment written once as --sm-accent: the selected roster row, the composer's focus ring and a selected choice all recolour from that one property."
        >
          {/* The board is a 1440-class desktop screen. On a narrow window it gets
              its own scroller — the -mx-6/px-6 pair cancels the page gutter, so
              the board still starts on the page's left edge and its elevation
              shadow keeps its room. */}
          <div className="-mx-6 overflow-x-auto px-6 py-2">
            <Board theme={theme} />
          </div>
        </Section>

        <Section
          id="phone"
          title="The board, on the phone"
          note="mobile-light.png / mobile-dark.png — the same session, later. Not the desktop board at a narrow width: the roster is gone, the header floats as a 60px glass card inset 12px under the status bar rather than pinning to the top edge, both bubble ceilings drop to 266/250, the delegation pill's faces drop to 24 and the composer takes its 52px rung. Every one of those is a decision the approved render made, so reviewing mobile by squashing the desktop board reviews none of them."
        >
          <div className="-mx-6 overflow-x-auto px-6 py-2">
            <PhoneBoard theme={theme} />
          </div>
        </Section>

        <Parts theme={theme} />
      </div>
    </div>
  )
}

export default function DevChatUi() {
  return (
    <div className="min-h-dvh bg-paper">
      {BENCH_THEMES.map((theme) => (
        <BenchPanel key={theme} theme={theme} />
      ))}
    </div>
  )
}
