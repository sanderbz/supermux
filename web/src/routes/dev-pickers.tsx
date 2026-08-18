// /dev/pickers — the VR bench for the shared <EntityPicker> (fase B3 T2.8).
//
// DEV-ONLY and lazy (`App.tsx`), so it costs the shipped bundle nothing — the
// prod build strips it entirely, which is the only reason a bench this
// exhaustive is affordable under a budget with 0.21 KB of headroom.
//
// WHAT IT IS FOR. The picker's whole claim is that ONE component serves two
// anchors, nine row kinds and two surfaces. That claim is only checkable if all
// of them can be seen at once, in both themes, without a server — so this page
// renders the presentational view directly, fed by hand-written rows. It
// fetches nothing, exactly like the component it is showing.
//
//   ?surface=phone   render every panel at the phone row height
//   ?theme=dark      (the VR rig sets the class itself; this is for eyeballing)
//   ?grok=1          stamp `data-grok` on the bench so WS7's glass rules apply —
//                    the one way to review the picker's Grok skin without booting
//                    the whole shell (the real palette carries `data-grok` on its
//                    portalled Dialog; here the bench root carries it instead).

import * as React from 'react'
import { useSearchParams } from 'react-router-dom'
import {
  Archive,
  FileText,
  ServerCog,
  Sparkles,
  SquareCheck,
  TerminalSquare,
  Timer,
  Users,
} from 'lucide-react'

import { EntityPickerView } from '@/components/ui/entity-picker'
import type { EntityRow } from '@/lib/entity'
import { cn } from '@/lib/utils'

const noop = () => {}

/** One row per kind, in the union's own order — so a kind that stops rendering
 *  is visible as a gap rather than as nothing. */
const ALL_KINDS: EntityRow[] = [
  { id: 'k1', kind: 'session', slug: 'release-train', label: 'Release Train', meta: 'release-train', icon: Users },
  { id: 'k2', kind: 'file', value: '@server/src/main.rs', label: 'main.rs', meta: 'server/src', icon: FileText },
  { id: 'k3', kind: 'issue', slug: 'patch', label: 'Scrollback scrambles on resize', meta: 'patch · open', icon: SquareCheck },
  { id: 'k4', kind: 'schedule', slug: '7', label: 'Nightly release check', meta: 'every day at 03:00', icon: Timer },
  { id: 'k5', kind: 'snippet', run: noop, label: 'cargo check --all', meta: 'snippet', icon: TerminalSquare },
  { id: 'k6', kind: 'skill', value: '/brainstorming', label: '/brainstorming', meta: 'superpowers', icon: Sparkles },
  { id: 'k7', kind: 'host', slug: '2', label: 'strato', meta: 'ssh · online', icon: ServerCog },
  { id: 'k8', kind: 'command', value: '/model', label: '/model', meta: 'switch model', warn: 'opens in terminal', icon: TerminalSquare },
  { id: 'k9', kind: 'action', run: noop, label: 'View archived sessions', icon: Archive },
]

const CHAT_ROWS: EntityRow[] = [
  { id: 'c1', kind: 'file', value: '@web/src/components/chat/conversation.tsx', label: 'conversation.tsx', meta: 'web/src/components/chat' },
  { id: 'c2', kind: 'file', value: '@web/src/components/chat/composer.tsx', label: 'composer.tsx', meta: 'web/src/components/chat' },
  { id: 'c3', kind: 'session', value: '@compass', label: 'Compass', meta: 'compass' },
]

const OVERFLOW: EntityRow[] = Array.from({ length: 40 }, (_, i) => ({
  id: `o${i}`,
  kind: 'command' as const,
  value: `/command-${i}`,
  label: `/command-${String(i).padStart(2, '0')}`,
  meta: 'a description long enough to need truncating on a phone',
}))

function Panel({
  title,
  note,
  children,
}: {
  title: string
  note?: string
  children: React.ReactNode
}) {
  return (
    <section className="flex flex-col gap-2">
      <header>
        <h2 className="text-[13px] font-semibold text-ink">{title}</h2>
        {note && <p className="text-[11.5px] text-ink-2">{note}</p>}
      </header>
      {children}
    </section>
  )
}

/** The token anchor positions itself against a `relative` parent — the same
 *  contract `ComposerFrame` provides in the real surface. The box below stands
 *  in for it, at the composer's own width, so the VR shot shows the popover
 *  where it actually lands. */
function TokenStage({ grok, children }: { grok?: boolean; children: React.ReactNode }) {
  return (
    <div className="relative h-[300px] w-full max-w-[640px]">
      <div
        className={cn(
          'absolute inset-x-0 bottom-0 flex h-[58px] items-center rounded-full border-[0.5px] px-4 text-[14px] text-ink-2',
          grok
            ? 'border-[var(--sm-border)] bg-[var(--sm-raised-fill)] shadow-[var(--sm-shadow-popover)] backdrop-blur-[20px] backdrop-saturate-[160%]'
            : 'border-hairline bg-surface shadow-[var(--sm-popover-shadow)]',
        )}
      >
        compare notes with @com
      </div>
      {children}
    </div>
  )
}

/** The field anchor's parent owns the box. This is the shape the ⌘K dialog and
 *  a Vaul sheet both provide. */
function FieldStage({ grok, children }: { grok?: boolean; children: React.ReactNode }) {
  return (
    <div
      className={cn(
        'w-full max-w-[640px] overflow-hidden border-[0.5px]',
        grok
          ? 'rounded-[12px] border-[var(--sm-border)] bg-[var(--sm-raised-fill)] shadow-[var(--sm-shadow-popover)] backdrop-blur-[20px] backdrop-saturate-[160%]'
          : 'rounded-xl border-hairline bg-surface shadow-[var(--sm-popover-shadow)]',
      )}
    >
      <div
        className={cn(
          'px-4 py-3 text-[14px] text-ink-2',
          grok ? 'border-b border-[var(--sm-border)]' : 'border-b border-hairline',
        )}
      >
        Jump to a session or run a /command
      </div>
      {children}
    </div>
  )
}

export default function DevPickers() {
  const [params] = useSearchParams()
  const surface = params.get('surface') === 'phone' ? 'phone' : 'desktop'
  const grok = params.get('grok') === '1'

  return (
    <main
      data-grok={grok ? '' : undefined}
      className={cn('min-h-dvh p-6', grok ? 'bg-[var(--sm-bg-chrome)]' : 'bg-paper')}
    >
      <h1 className="mb-1 text-[15px] font-semibold text-ink">
        /dev/pickers — the shared EntityPicker
      </h1>
      <p className="mb-6 text-[12px] text-ink-2">
        surface: <code>{surface}</code> · both anchors × nine kinds × the states
        that only show up when a list is empty, loading or long.
      </p>

      {/* `grid-cols-1` is load-bearing on the phone, not cosmetic: without an
          explicit base column the single implicit track is `auto` = max-content,
          so the 40-row card sized to the FULL untruncated description (~456px)
          and overflowed a 390px viewport — the row's own `truncate` fired
          correctly but its ellipsis landed off-screen and the viewport clipped
          the text flush to the edge. `minmax(0,1fr)` caps the track at the
          container so the description truncates visibly, with the list's gutter
          intact. In production the picker sits in a width-bounded composer
          popover / sheet, so only the bench needed this. */}
      <div className="grid grid-cols-1 gap-10 lg:grid-cols-2">
        <Panel
          title="Token anchor — up from an @ / token"
          note="Draws its own glass and shadow; floats over the transcript."
        >
          <TokenStage grok={grok}>
            <EntityPickerView
              anchor="token"
              surface={surface}
              rows={CHAT_ROWS}
              activeIndex={0}
              emptyLabel="Nothing to mention here yet"
              onHover={noop}
              onPick={noop}
            />
          </TokenStage>
        </Panel>

        <Panel
          title="Field anchor — inside a box the parent drew"
          note="No positioning, no border of its own."
        >
          <FieldStage grok={grok}>
            <EntityPickerView
              anchor="field"
              surface={surface}
              rows={ALL_KINDS}
              activeIndex={2}
              onHover={noop}
              onPick={noop}
            />
          </FieldStage>
        </Panel>

        <Panel title="All nine kinds, with icons" note="The union, in its own order.">
          <FieldStage grok={grok}>
            <EntityPickerView
              anchor="field"
              surface={surface}
              rows={ALL_KINDS}
              activeIndex={0}
              maxHeight="max-h-none"
              onHover={noop}
              onPick={noop}
            />
          </FieldStage>
        </Panel>

        <Panel
          title="Overflow — 40 rows"
          note="Proves the scroll box, and that the highlight fill stays inset when it scrolls."
        >
          <FieldStage grok={grok}>
            <EntityPickerView
              anchor="field"
              surface={surface}
              rows={OVERFLOW}
              activeIndex={6}
              onHover={noop}
              onPick={noop}
            />
          </FieldStage>
        </Panel>

        <Panel title="Empty — the trigger was just typed" note="No bare quotation marks.">
          <FieldStage grok={grok}>
            <EntityPickerView
              anchor="field"
              surface={surface}
              rows={[]}
              activeIndex={0}
              emptyLabel="Nothing to mention here yet"
              onHover={noop}
              onPick={noop}
            />
          </FieldStage>
        </Panel>

        <Panel title="Empty — a query that matched nothing, and loading">
          <div className="flex flex-col gap-3">
            <FieldStage grok={grok}>
              <EntityPickerView
                anchor="field"
                surface={surface}
                rows={[]}
                activeIndex={0}
                emptyLabel="No command matches “zzz”"
                onHover={noop}
                onPick={noop}
              />
            </FieldStage>
            <FieldStage grok={grok}>
              <EntityPickerView
                anchor="field"
                surface={surface}
                rows={[]}
                activeIndex={0}
                loading
                onHover={noop}
                onPick={noop}
              />
            </FieldStage>
          </div>
        </Panel>
      </div>
    </main>
  )
}
