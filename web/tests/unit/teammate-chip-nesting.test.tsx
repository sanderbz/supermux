/**
 * A teammate row carries TWO controls, so it cannot BE one.
 * ─────────────────────────────────────────────────────────────────────────────
 * The chip used to be a `<div role="button" tabIndex={0}>` with the "Kill &
 * remove" trash `<button>` inside it. That is axe's `nested-interactive`
 * (serious, WCAG 4.1.2): the accessibility tree is told the row is a single
 * button, and everything inside a button is presentational — so the trash is
 * announced as part of the row's name, or not at all, and a screen-reader user
 * has no way to reach it. It shipped for as long as it did because the axe gate
 * scans `/dev/*` benches and `/?mock`, and neither has a real Agent Team on the
 * roster — the production instance of the violation was structurally invisible.
 *
 * The shape that fixes it: the row is a plain container, activation lives on a
 * stretched `<button>`, and the trash is that button's SIBLING. This test pins
 * the shape rather than the styling, because the styling is free to move.
 */
import { describe, expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'

import { TeammateChip } from '../../src/components/team/teammate-chip'
import { ToastProvider } from '../../src/components/ui/toast'
import type { Team, TeamMember } from '../../src/lib/api/teams'

const member: TeamMember = {
  name: 'researcher',
  agent_id: 'researcher@squad',
  model: 'claude-opus-4',
  color: '#8b5cf6',
  tmux_pane_id: '%17',
  is_active: true,
  status: 'needs_you',
}

const team: Team = {
  team_name: 'squad',
  lead_session: 'sess-1',
  lead_supermux_session: 'lead',
  members: [member],
  tasks: [],
}

const chip = (): string => {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  })
  return renderToStaticMarkup(
    <QueryClientProvider client={qc}>
      <ToastProvider>
        <TeammateChip team={team} member={member} onFocus={() => {}} />
      </ToastProvider>
    </QueryClientProvider>,
  )
}

describe('the teammate chip has no nested interactive', () => {
  test('the ROW itself is not a control', () => {
    const html = chip()
    // The outer element only — the controls INSIDE it are of course focusable,
    // and the activation button is the roster's roving item so it legitimately
    // carries a tabindex. What must not happen is the ROW claiming to be a
    // control while containing two.
    const row = html.slice(0, html.indexOf('>') + 1)
    expect(row.startsWith('<div')).toBe(true)
    expect(row).not.toContain('role=')
    expect(row).not.toContain('tabindex=')
  })

  test('the roving item is the activation button, not the row', () => {
    const html = chip()
    // Finding 20 (one tab stop per roster row, arrows between them) and finding
    // 14 (no control inside a control) want the SAME element, and a real
    // <button> satisfies both. If the roving attributes drift back onto the
    // wrapper, the nested-interactive comes back with them.
    const withRoving = html.match(/<(\w+)[^>]*data-roving-item=/)
    expect(withRoving?.[1]).toBe('button')
  })

  test('activation is a real <button> carrying the row label', () => {
    const html = chip()
    expect(html).toContain('aria-label="Open researcher, needs you full screen"')
    // …and that label is on a <button>, not on a div wearing a role.
    const labelled = html.match(/<(\w+)[^>]*aria-label="Open researcher[^"]*"/)
    expect(labelled?.[1]).toBe('button')
  })

  test('the trash is a SIBLING of the row button, not a descendant of it', () => {
    const html = chip()
    // Both controls exist…
    expect(html).toContain('aria-label="Open researcher, needs you full screen"')
    expect(html.match(/<button/g)?.length).toBeGreaterThanOrEqual(2)
    // …and no <button> opens before another one closes, which is the only way
    // a button can contain a button in a serialized tree.
    let depth = 0
    for (const tag of html.match(/<button|<\/button>/g) ?? []) {
      depth += tag === '<button' ? 1 : -1
      expect(depth).toBeLessThanOrEqual(1)
    }
    expect(depth).toBe(0)
  })
})
