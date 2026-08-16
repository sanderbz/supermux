/**
 * The promoted `<EntityPicker>` — both anchors, the row union, the icon slot
 * (fase B3 T2).
 * ─────────────────────────────────────────────────────────────────────────────
 * `chat-interactive.test.tsx` pins what the popover LOOKS like from chat's side
 * and is the proof the promotion was lossless. This pins what the PRIMITIVE
 * promises to every other consumer: that the two anchors differ in exactly one
 * way, that a row cannot be unactionable, and that navigation goes through one
 * function.
 */
import { describe, expect, test } from 'bun:test'
import * as React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'

import { EntityPickerView } from '../../src/components/ui/entity-picker'
import { resolveEntityTarget, type EntityRow } from '../../src/lib/entity'

const rows: EntityRow[] = [
  { id: 'a', kind: 'file', value: '@src/main.rs', label: 'main.rs', meta: 'src' },
  { id: 'b', kind: 'session', slug: 'patch', label: 'Patch', meta: 'patch' },
  { id: 'c', kind: 'action', run: () => {}, label: 'Toggle theme' },
]

const view = (over: Partial<React.ComponentProps<typeof EntityPickerView>> = {}) =>
  renderToStaticMarkup(
    <EntityPickerView
      rows={rows}
      activeIndex={0}
      onHover={() => {}}
      onPick={() => {}}
      {...over}
    />,
  )

describe('the two anchors differ in exactly one thing: who owns the box', () => {
  test('the token anchor floats, with its own glass and the shared shadow', () => {
    const html = view()
    expect(html).toContain('data-anchor="token"')
    expect(html).toContain('absolute inset-x-0 bottom-full')
    expect(html).toContain('bg-surface')
    // The shadow is a TOKEN, not a literal — it was duplicated in three places,
    // one of them inside a `focus-within:` compound.
    expect(html).toContain('shadow-[var(--sm-popover-shadow)]')
    expect(html).not.toContain('rgba(30,18,10')
  })

  test('the field anchor draws NO chrome — the parent already did', () => {
    const html = view({ anchor: 'field' })
    expect(html).toContain('data-anchor="field"')
    // No positioning: a `field` list inside a dialog that positioned itself
    // would fight the dialog. No border/background: a second box inside the
    // parent's reads as a menu inside a menu.
    expect(html).not.toContain('absolute')
    expect(html).not.toContain('bg-surface')
    expect(html).not.toContain('border-hairline')
  })

  test('each anchor brings its own max-height, and they are different', () => {
    // §14 specified ONE number for both. One number is wrong for one of them:
    // the token list must not cover the transcript it is being typed into, and
    // a ⌘K spotlight showing six rows is a regression. Deviation logged in
    // BRAND.md §6c.
    expect(view()).toContain('max-h-[min(280px,46vh)]')
    expect(view({ anchor: 'field' })).toContain('max-h-[min(420px,60vh)]')
    expect(view({ maxHeight: 'max-h-64' })).toContain('max-h-64')
  })

  test('everything else about a row is identical across anchors', () => {
    const strip = (h: string) => h.slice(h.indexOf('<ul'))
    const a = strip(view()).replace(/max-h-\[[^\]]+\]/, 'MAXH')
    const b = strip(view({ anchor: 'field' })).replace(/max-h-\[[^\]]+\]/, 'MAXH')
    expect(a).toBe(b)
  })
})

describe('the highlight', () => {
  test('exactly one row carries it, and it is `data-highlighted`', () => {
    const html = view({ activeIndex: 2 })
    expect((html.match(/data-highlighted/g) ?? []).length).toBe(1)
    expect((html.match(/aria-selected="true"/g) ?? []).length).toBe(1)
    // Renamed from `data-active` in T2.5. The attribute is set by RENDER, never
    // by an event handler — which is what makes keyboard and pointer agree.
    expect(html).not.toContain('data-active')
  })

  test('an index past the end highlights nothing rather than throwing', () => {
    const html = view({ activeIndex: 99 })
    expect((html.match(/data-highlighted/g) ?? []).length).toBe(0)
  })
})

describe('the row union', () => {
  test('the icon slot renders when a row brings one, and is silent otherwise', () => {
    const Dot = ({ className }: { className?: string }) => <svg className={className} />
    const html = view({ rows: [{ ...rows[0]!, icon: Dot }] })
    expect(html).toContain('<svg')
    expect(html).toContain('size-3.5')
    expect(html).toContain('text-ink-3')
    // Chat's rows pass none, which is what preserves today's look exactly.
    expect(view()).not.toContain('<svg')
  })

  test('a row with none of value/run/slug fails to typecheck', () => {
    // The whole point of the union: a row that cannot be acted on renders and
    // highlights identically to one that can, and does nothing on Enter. `tsc`
    // refuses it instead of a user discovering it.
    // @ts-expect-error — no `value`, no `run`, no `slug`
    const dead: EntityRow = { id: 'x', kind: 'action', label: 'does nothing' }
    expect(dead.id).toBe('x')
  })
})

describe('resolveEntityTarget is the one indirection', () => {
  test('a run row runs; the route is never consulted', () => {
    let ran = false
    const t = resolveEntityTarget({
      id: 'r', kind: 'action', label: 'go', run: () => { ran = true },
    })
    expect(t).not.toBeNull()
    if (t && 'run' in t) t.run()
    expect(ran).toBe(true)
  })

  test('a session goes to its focus route, encoded', () => {
    expect(
      resolveEntityTarget({ id: 's', kind: 'session', label: 'a', slug: 'my sess' }),
    ).toEqual({ to: '/focus/my%20sess' })
  })

  test('an ISSUE goes to the session that owns it — it has no route of its own', () => {
    // B2 removed the Board page and put issues inside session detail and the
    // team card. If that ever changes, it changes HERE, and the palette, the
    // picker and the chip renderer all follow.
    expect(
      resolveEntityTarget({ id: 'i', kind: 'issue', label: 'bug', slug: 'patch' }),
    ).toEqual({ to: '/focus/patch' })
  })

  test('schedules and hosts are Settings sections, because B1 folded them', () => {
    expect(resolveEntityTarget({ id: 'x', kind: 'schedule', label: 'nightly', slug: '7' }))
      .toEqual({ to: '/settings#schedules' })
    expect(resolveEntityTarget({ id: 'y', kind: 'host', label: 'strato', slug: '2' }))
      .toEqual({ to: '/settings#hosts' })
  })

  test('an insert row has no target — the token anchor owns that case', () => {
    expect(resolveEntityTarget(rows[0]!)).toBeNull()
  })

  test('verbs never navigate', () => {
    for (const kind of ['command', 'skill', 'snippet'] as const) {
      expect(resolveEntityTarget({ id: 'k', kind, label: 'k', slug: 'k' })).toBeNull()
    }
  })
})

describe('nothing leaks into the rendered text', () => {
  test('no source comment is rendered as content', () => {
    // This is not a hypothetical. Wrapping each row in a Fragment to hold the
    // group heading turned the `//` comment above the `<li>` from a JS comment
    // into a JSX TEXT CHILD, and every row in every picker in the app rendered
    // two lines of source above it. `toContain` assertions all stayed green —
    // they check what IS there, never what is also there — and the offline VR
    // shot is what caught it. So the guard is an absence, asserted here.
    const html = view({ headingAt: (i) => (i === 0 ? 'Sessions' : undefined) })
    expect(html).not.toContain('//')
    expect(html).not.toContain('/*')
    expect(html).not.toContain('presentation`:')
  })

  test('a heading opens its group and is not an option', () => {
    const html = view({ headingAt: (i) => (i === 0 ? 'Sessions' : undefined) })
    expect(html).toContain('Sessions')
    // Headings are `presentation`, so the arrows skip them for free and a
    // screen reader still counts three choices, not four.
    expect((html.match(/role="option"/g) ?? []).length).toBe(3)
  })
})

describe('the empty state', () => {
  test('a field anchor says what IT looked for, not what chat would have', () => {
    const html = view({ rows: [], emptyLabel: 'No match for “zzz”.' })
    expect(html).toContain('No match for “zzz”.')
  })

  test('loading outranks the empty copy — "nothing" and "not yet" differ', () => {
    expect(view({ rows: [], loading: true, emptyLabel: 'No match.' })).toContain('Looking…')
  })
})
