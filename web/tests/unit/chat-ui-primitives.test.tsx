/**
 * The chat surface's static primitives — the numbers, asserted.
 * ─────────────────────────────────────────────────────────────────────────────
 * These components are presentational, so most of their contract is class lists
 * and cannot be usefully unit-tested. What CAN drift silently, and is therefore
 * pinned here, is the handful of load-bearing numbers and rules the approved
 * render turns on:
 *
 *   · the two bubble ceilings (648 / 420) and which variant gets which,
 *   · the attention dot's SEAT, which is derived from the character's own solid
 *     — the one piece of geometry in the set,
 *   · the facepile cluster occupying exactly one mark's footprint,
 *   · "emphasis is weight + fill, never the identity hue" — the accent may only
 *     appear on a SELECTED choice, at 55% border / 8% fill,
 *   · the presence row having no mark and no dots,
 *   · a session's pigment being published as BOTH theme tiers, since a
 *     presentational component cannot know which theme it is inside.
 */
import { describe, expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'

import { characterFromSeed, VIEWBOX } from '../../src/brand/marks'
import { Bubble, BubbleCode, MessageRow } from '../../src/components/chat/ui/bubble'
import { CapturedFrameCard } from '../../src/components/chat/ui/captured-frame-card'
import { CardCode, ChoiceCard, InlineCode } from '../../src/components/chat/ui/choice-card'
import { Composer } from '../../src/components/chat/ui/composer'
import { DelegationPill } from '../../src/components/chat/ui/delegation-pill'
import { Facepile } from '../../src/components/chat/ui/facepile'
import {
  ATTENTION_DOT,
  attentionDotSeat,
  BUBBLE_MAX,
  FACEPILE,
  MARK_SIZE,
} from '../../src/components/chat/ui/metrics'
import { ReceiptGroup } from '../../src/components/chat/ui/receipt-group'
import { RosterRow } from '../../src/components/chat/ui/roster-row'
import { WorkingRow } from '../../src/components/chat/ui/working-row'

const html = renderToStaticMarkup

describe('Bubble', () => {
  test('the assistant bubble is the wide one, the user bubble the narrow one', () => {
    expect(html(<Bubble>hi</Bubble>)).toContain(`max-width:${BUBBLE_MAX.assistant}px`)
    expect(html(<Bubble variant="user">hi</Bubble>)).toContain(`max-width:${BUBBLE_MAX.user}px`)
    expect(BUBBLE_MAX.user).toBeLessThan(BUBBLE_MAX.assistant)
  })

  test('the agent bubble is a fixed warm neutral — never accent-tinted', () => {
    // The whole point of C7: identity is the mark, not the fill. A bubble that
    // took the session's colour would put an accent on a surface.
    const out = html(<Bubble>hi</Bubble>)
    expect(out).toContain('bg-bubble-agent')
    expect(out).not.toContain('--sm-accent')
  })

  test('the user bubble is inverted, edgeless and shadowless', () => {
    const out = html(<Bubble variant="user">hi</Bubble>)
    expect(out).toContain('bg-bubble-user')
    expect(out).toContain('text-bubble-user-ink')
    expect(out).toContain('border-transparent')
    expect(out).not.toContain('shadow-[var(--sm-bubble-shadow)]')
  })
})

describe('MessageRow', () => {
  test('a grouped row gives 8px of air, an ungrouped one 14px', () => {
    expect(html(<MessageRow>x</MessageRow>)).toContain('mt-3.5')
    expect(html(<MessageRow grouped>x</MessageRow>)).toContain('mt-2')
  })

  test('the gutter is a 32px slot — and the human side has none', () => {
    expect(html(<MessageRow gutter={<i />}>x</MessageRow>)).toContain('w-8')
    const me = html(
      <MessageRow me gutter={<i />}>
        x
      </MessageRow>,
    )
    expect(me).toContain('justify-end')
    expect(me).not.toContain('w-8')
  })
})

describe('attentionDotSeat', () => {
  test('sits on the silhouette, not in the corner of the box', () => {
    // 45° out along the body's own half-axes, minus half the dot. Hand-computed for
    // the sphere (rx = ry = 121) at 40px: 20 + 20·(121/131)·0.707 − 3.5.
    const sphere = characterFromSeed('anything', { silhouette: 'sphere' })
    const seat = attentionDotSeat(sphere, 40, VIEWBOX)
    const expected = 20 + 20 * (sphere.body.rx / VIEWBOX) * 0.707 - ATTENTION_DOT.size / 2
    expect(seat.left).toBeCloseTo(expected, 6)
    // Inside the box, and above the middle.
    expect(seat.left).toBeGreaterThan(20)
    expect(seat.left).toBeLessThan(40)
    expect(seat.top).toBeLessThan(20)
  })

  test('a taller silhouette pushes the dot higher — the seat really is derived', () => {
    const capsule = characterFromSeed('a', { silhouette: 'capsule' }) // ry 139
    const pebble = characterFromSeed('a', { silhouette: 'pebble' }) // ry 104
    expect(attentionDotSeat(capsule, 40, VIEWBOX).top).toBeLessThan(
      attentionDotSeat(pebble, 40, VIEWBOX).top,
    )
  })
})

describe('RosterRow', () => {
  test('is 64px tall and shows the session s own last line', () => {
    const out = html(
      <RosterRow seed="Patch" timestamp="11:02 AM" preview="euro formats parse clean now." />,
    )
    expect(out).toContain('h-16')
    expect(out).toContain('euro formats parse clean now.')
    expect(out).toContain('11:02 AM')
  })

  test('selected takes the accent row and drops the hover wash', () => {
    // A selected row that lightens under the pointer reads as a click that did
    // nothing — the mockup pins the selected background through :hover.
    const selected = html(<RosterRow seed="Patch" selected />)
    expect(selected).toContain('sm-accent-row')
    expect(selected).not.toContain('hover:bg-fill-soft')
    expect(html(<RosterRow seed="Patch" />)).toContain('hover:bg-fill-soft')
  })

  test('the attention dot lands where the silhouette is, per session', () => {
    const egg = html(<RosterRow seed="Patch" pin={{ silhouette: 'egg' }} attention />)
    const wedge = html(<RosterRow seed="Patch" pin={{ silhouette: 'wedge' }} attention />)
    expect(egg).toContain(ATTENTION_DOT.color)
    expect(egg).not.toBe(wedge)
    expect(html(<RosterRow seed="Patch" />)).not.toContain(ATTENTION_DOT.color)
  })

  test('a crew row occupies exactly one mark s footprint', () => {
    const out = html(
      <RosterRow
        seed="Render crew"
        crew={[{ seed: 'Lookout' }, { seed: 'Ledger' }, { seed: 'Patch' }]}
      />,
    )
    expect(out).toContain(`width:${FACEPILE.cluster.box}px`)
    expect(FACEPILE.cluster.box).toBe(MARK_SIZE.roster)
  })
})

describe('ReceiptGroup', () => {
  test('coalesces a run and caps the rest behind one affordance', () => {
    const rows = [
      ...Array.from({ length: 12 }, (_, i) => ({ tool: 'Read', outcome: `f${i}.rs` })),
      { tool: 'Edit', outcome: 'money.rs' },
      { tool: 'Grep', outcome: 'no matches' },
    ]
    const out = html(<ReceiptGroup rows={rows} max={2} />)
    expect(out).toContain('×12')
    expect(out).toContain('Show all 3') // 14 calls → 3 coalesced lines
    expect(out).not.toContain('no matches')
  })

  test('the running line keeps the check slot, with the slow spinner in it', () => {
    const out = html(<ReceiptGroup rows={[{ tool: 'cargo test', state: 'running' }]} />)
    expect(out).toContain('sm-spin')
    expect(out).toContain('data-state="running"')
  })

  test('the cap never hides the running line', () => {
    // The live call is always the LAST one in a turn, so a cap that just slices
    // would hide the spinner precisely when the user is watching for it.
    const out = html(
      <ReceiptGroup
        rows={[
          { tool: 'Read', outcome: 'a.rs' },
          { tool: 'Edit', outcome: 'b.rs' },
          { tool: 'Grep', outcome: 'no matches' },
          { tool: 'cargo test', state: 'running' },
        ]}
        max={2}
      />,
    )
    expect(out).toContain('sm-spin')
    expect(out).toContain('cargo test')
    expect(out).not.toContain('no matches')
    expect(out).toContain('Show all 4')
  })
})

describe('ReceiptGroup at phone width (daily-driver QA #2)', () => {
  const long = {
    tool: 'Read /home/supermux/spike-qa/notes.md',
    short: 'Read notes.md',
    outcome: '1 file · 8 lines',
  }

  test('the phone shows the condensed label; the desktop shows the full one', () => {
    expect(html(<ReceiptGroup rows={[long]} surface="phone" />)).toContain('Read notes.md')
    expect(html(<ReceiptGroup rows={[long]} surface="phone" />)).not.toContain('/home/supermux')
    expect(html(<ReceiptGroup rows={[long]} />)).toContain('/home/supermux/spike-qa/notes.md')
  })

  test('nothing in the row truncates — what does not fit wraps', () => {
    // The defect was two truncating cells fighting over 135px: `Read /home/s… →
    // 1 …`. Neither `truncate` (which is `text-overflow: ellipsis`) nor
    // `whitespace-nowrap` may come back to this row.
    const out = html(<ReceiptGroup rows={[long]} surface="phone" />)
    expect(out).not.toContain('truncate')
    const row = out.slice(out.indexOf('chat-receipt'))
    expect(row.slice(0, row.indexOf('</'))).not.toContain('whitespace-nowrap')
  })

  test('a row with more to show is a real control; one without is not', () => {
    const more = html(<ReceiptGroup rows={[long]} surface="phone" />)
    expect(more).toContain('aria-expanded="false"')
    expect(more).toContain('<button')
    // Nothing hidden → no tap target that answers with nothing.
    const plain = html(<ReceiptGroup rows={[{ tool: 'Grep parse_locale' }]} surface="phone" />)
    expect(plain).not.toContain('aria-expanded')
  })

  test('the desktop row is only a control when the OUTCOME was clamped', () => {
    expect(html(<ReceiptGroup rows={[long]} />)).not.toContain('aria-expanded')
    expect(html(<ReceiptGroup rows={[{ ...long, full: 'the whole result' }]} />)).toContain(
      'aria-expanded',
    )
  })
})

describe('the choice card\'s evidence row (daily-driver QA #11)', () => {
  test('the verbatim body sits between the question and the why line', () => {
    const out = html(
      <ChoiceCard
        question="Run it?"
        detail={<CardCode>{'curl -sS https://example.com/ -o /tmp/x.html && echo done'}</CardCode>}
        why="Bash · in supermux/spike-qa"
        options={[{ label: 'Allow once' }]}
      />,
    )
    expect(out).toContain('curl -sS https://example.com/ -o /tmp/x.html &amp;&amp; echo done')
    expect(out.indexOf('Run it?')).toBeLessThan(out.indexOf('curl -sS'))
    expect(out.indexOf('curl -sS')).toBeLessThan(out.indexOf('Bash ·'))
  })

  test('it scrolls rather than wrapping — a soft break would change the command', () => {
    const out = html(<CardCode>{'a && b'}</CardCode>)
    expect(out).toContain('whitespace-pre')
    expect(out).not.toContain('whitespace-pre-wrap')
    expect(out).toContain('overflow-auto')
    // …and it cannot push the buttons off a 390px screen.
    expect(out).toContain('max-h-[132px]')
  })

  test('a card without one is byte-identical to the card that shipped', () => {
    const plain = html(<ChoiceCard question="Run it?" options={[{ label: 'Allow once' }]} />)
    expect(plain).not.toContain('chat-dialog-body')
  })
})

describe('radii are the approved render s literals', () => {
  // This repo remaps Tailwind's named radius scale off `--radius` (sm 8 · md 10
  // · lg 12 · xl 16), so a named rung does NOT mean what stock Tailwind's does.
  // These four are the numbers the mockup states, pinned as literals.
  test('roster row 12, code block 12, inline code 8, choice card 16', () => {
    expect(html(<RosterRow seed="Patch" />)).toContain('rounded-[12px]')
    expect(html(<BubbleCode>x</BubbleCode>)).toContain('rounded-[12px]')
    expect(html(<InlineCode>x</InlineCode>)).toContain('rounded-[8px]')
    expect(html(<ChoiceCard question="q" options={[{ label: 'a' }]} />)).toContain('rounded-[16px]')
    // and the two the file already stated in full
    expect(html(<Bubble>x</Bubble>)).toContain('rounded-[18px]')
    expect(html(<CapturedFrameCard caption="c.png" />)).toContain('rounded-[14px]')
  })
})

describe('ChoiceCard', () => {
  test('emphasis is weight plus a fill — the accent never encodes an action', () => {
    const out = html(
      <ChoiceCard
        question="Run it?"
        options={[{ label: 'Allow once', primary: true }, { label: 'Not now' }]}
      />,
    )
    expect(out).toContain('bg-fill-soft-2')
    expect(out).toContain('font-semibold')
    expect(out).not.toContain('--sm-accent')
  })

  test('selection is the one place it borrows the accent — 55% edge, 8% fill', () => {
    const out = html(
      <ChoiceCard
        question="Run it?"
        options={[{ label: 'Allow once' }, { label: 'Not now' }]}
        selectedIndex={1}
      />,
    )
    expect(out).toContain('var(--sm-accent) 55%')
    expect(out).toContain('var(--sm-accent) 8%')
    expect(out).toContain('data-selected="true"')
  })

  test('the digits are the modal registry s option mapping', () => {
    const out = html(
      <ChoiceCard
        question="Run it?"
        options={[
          { label: 'Yes', kbd: '1' },
          { label: 'No', kbd: '2' },
        ]}
      />,
    )
    expect(out).toContain('<kbd')
    expect(out.match(/<kbd/g)).toHaveLength(2)
  })
})

describe('Composer', () => {
  test('58px on desktop, 52 on the phone, and a real focusable field', () => {
    const desktop = html(<Composer placeholder="Message Release Train" />)
    expect(desktop).toContain('min-h-[58px]')
    expect(desktop).toContain('<textarea')
    expect(desktop).toContain('Message Release Train')
    expect(html(<Composer placeholder="x" size="mobile" />)).toContain('min-h-[52px]')
  })

  test('the focus ring is the session accent at 22% — a state, never a fill', () => {
    const out = html(<Composer placeholder="x" />)
    expect(out).toContain('focus-within:shadow-')
    expect(out).toContain('var(--sm-accent)_22%')
  })
})

describe('DelegationPill', () => {
  test('names the recipient, and carries the recipient s pigment for both themes', () => {
    const out = html(<DelegationPill from="Release Train" to="Patch" />)
    expect(out).toContain('asking Patch…')
    expect(out).toContain('--sm-ink-accent-light')
    expect(out).toContain('--sm-ink-accent-dark')
    expect(out).toContain('sm-ink-accent')
  })
})

describe('WorkingRow', () => {
  test('the row has a face and the wave; the presence line has neither', () => {
    const row = html(<WorkingRow seed="Patch" label="Thinking…" elapsed="12s" />)
    expect(row).toContain('sm-dots')
    expect(row).toContain('sm-mark')
    expect(row).toContain('12s')

    const presence = html(<WorkingRow variant="presence" label="Typing…" />)
    expect(presence).not.toContain('sm-dots')
    expect(presence).not.toContain('sm-mark')
    // Indented to the bubble's left edge: 32px gutter + 12px gap.
    expect(presence).toContain('pl-11')
  })
})

describe('Facepile', () => {
  test('the cluster seats three members at the approved offsets', () => {
    const out = html(
      <Facepile members={[{ seed: 'Lookout' }, { seed: 'Ledger' }, { seed: 'Patch' }]} ring="#faf7f4" />,
    )
    const px = (n: number) => (n === 0 ? '0' : `${n}px`) // React drops the unit on 0
    for (const [i, [left, top]] of FACEPILE.cluster.offsets.entries()) {
      expect(out).toContain(`left:${px(left)};top:${px(top)};z-index:${i + 1}`)
    }
    expect(out).toContain('#faf7f4')
  })

  test('the cluster never grows past its footprint, however many members', () => {
    const many = Array.from({ length: 7 }, (_, i) => ({ seed: `s${i}` }))
    const out = html(<Facepile members={many} />)
    expect(out.match(/class="sm-mark"/g)).toHaveLength(FACEPILE.cluster.offsets.length)
  })

  test('the row overlaps by −24% and only the active member carries a label', () => {
    const members = [
      { seed: 'Lookout', name: 'Lookout' },
      { seed: 'Ledger', name: 'Ledger' },
    ]
    const plain = html(<Facepile members={members} variant="row" />)
    expect(plain).toContain(`margin-left:${MARK_SIZE.facepile * FACEPILE.row.overlap}px`)
    expect(plain).not.toContain('Ledger<')

    const morphed = html(<Facepile members={members} variant="row" activeIndex={1} />)
    expect(morphed).toContain('transition-[padding]')
    expect(morphed).toContain('Ledger')
  })
})

describe('CapturedFrameCard', () => {
  test('340 by default, 16:10, with the filename under it', () => {
    const out = html(<CapturedFrameCard caption="release-run.png" />)
    expect(out).toContain('width:340px')
    expect(out).toContain('padding-top:62.5%')
    expect(out).toContain('release-run.png')
  })

  test('a real capture replaces the placeholder art, and keeps an alt', () => {
    const out = html(<CapturedFrameCard caption="shot.png" src="/shot.png" />)
    expect(out).toContain('src="/shot.png"')
    expect(out).toContain('alt="shot.png"')
  })
})
