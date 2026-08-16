/**
 * The issue read surface (fase B2 T10) — the capability the Board removal is
 * gated on.
 *
 * `IssueList` fetches through `useBoard`, which needs a QueryClient and a live
 * server, so what is asserted here is the two things that are actually B2's:
 *
 *   1. the SCOPES resolve correctly — a per-session list must be Main's cards
 *      filtered by session (the shipped `session:<name>` synthesis, not a second
 *      one), and a per-team list must be that team's own board;
 *   2. the extraction held — `AcceptanceChecklist` and `ReplyComposer` render
 *      from `components/issues/`, with no import back into
 *      `components/board/`, so T11 can delete that directory.
 *
 * The row RENDERING is asserted through `IssueRow`'s markup via the exported
 * list with a stubbed hook would be a test of the stub; instead the row's facts
 * are covered by the e2e (`issue-surface.spec.ts`), which uses real cards
 * created through the harness `api` helper.
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import { describe, expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'

import { AcceptanceChecklist } from '../../src/components/issues/acceptance-checklist'
import { ReplyComposer } from '../../src/components/issues/reply-composer'
import { decodeBoardId, sessionBoardId, ALL_BOARD_ID } from '../../src/lib/api/boards'
import { EMPTY } from '../../src/brand/copy'

const SRC = (rel: string): string =>
  readFileSync(fileURLToPath(new URL(`../../src/${rel}`, import.meta.url)), 'utf8')

describe('the two scopes', () => {
  test('a per-session list is Main’s cards filtered by that session', () => {
    const id = sessionBoardId('supermux')
    const { fetchBoardId, sessionFilter } = decodeBoardId(id)
    expect(sessionFilter).toBe('supermux')
    // The fetch hits a REAL board, not a per-session endpoint that does not
    // exist — the filter is client-side, which is what B2 reuses rather than
    // re-deriving.
    expect(fetchBoardId).not.toBe(id)
  })

  test('a session name with a colon does not corrupt the id', () => {
    const { sessionFilter } = decodeBoardId(sessionBoardId('feat:thing'))
    expect(sessionFilter).toBe('feat:thing')
  })

  test('a per-team list is a REAL board id, passed through unchanged', () => {
    const { fetchBoardId, sessionFilter } = decodeBoardId('b_team_release')
    expect(fetchBoardId).toBe('b_team_release')
    expect(sessionFilter).toBeNull()
  })

  test('the cross-board aggregate still resolves', () => {
    expect(decodeBoardId(ALL_BOARD_ID).fetchBoardId).toBe(ALL_BOARD_ID)
  })

  test('the list asks for exactly one scope', () => {
    const src = SRC('components/issues/issue-list.tsx')
    expect(src).toContain('sessionBoardId(session)')
    expect(src).toContain('boardId ?? ')
  })
})

describe('the extraction held — T11 can delete components/board/', () => {
  const ISSUE_FILES = [
    'components/issues/issue-list.tsx',
    'components/issues/issue-detail.tsx',
    'components/issues/issue-surface.tsx',
    'components/issues/acceptance-checklist.tsx',
    'components/issues/reply-composer.tsx',
  ]

  test('no file under components/issues IMPORTS from components/board', () => {
    // Doc comments may (and do) name where a component came from; what must not
    // exist is a live edge, or T11 cannot delete the directory.
    for (const rel of ISSUE_FILES) {
      const imports = [...SRC(rel).matchAll(/from\s+'([^']+)'/g)].map((m) => m[1])
      expect(imports.filter((i) => i.includes('components/board'))).toEqual([])
    }
  })

  test('the surface hosts list + detail in B1’s ShellOverlay', () => {
    const src = SRC('components/issues/issue-surface.tsx')
    expect(src).toContain('ShellOverlay')
    expect(src).toContain('variant="pane"')
    expect(src).toContain('<IssueList')
    expect(src).toContain('<IssueDetail')
  })

  test('replying to a DEAD session falls back to a durable comment', () => {
    // The capability chat structurally cannot hold, and §12.8's reason the board
    // API is not deprecated with the page.
    const src = SRC('components/issues/issue-surface.tsx')
    expect(src).toContain('commentIssue')
    expect(src).toContain('replyIssue')
  })

  test('both entry points exist — per session AND per team', () => {
    expect(SRC('components/focus-mode/session-info-panel.tsx')).toContain('IssueSurface')
    expect(SRC('components/team/team-card.tsx')).toContain('IssueSurface')
  })
})

describe('the extracted components still render', () => {
  test('AcceptanceChecklist shows progress and every item', () => {
    const html = renderToStaticMarkup(
      <AcceptanceChecklist
        issueId="T-1"
        items={[
          { id: 1, issue_id: 'T-1', body: 'unit suite green', done: 1, pos: 0 },
          { id: 2, issue_id: 'T-1', body: 'VR both themes', done: 0, pos: 1 },
        ]}
      />,
    )
    expect(html).toContain('unit suite green')
    expect(html).toContain('VR both themes')
    expect(html).toContain('Acceptance')
    // 1 of 2 done.
    expect(html).toContain('>1</span>/2')
  })

  test('an empty checklist still offers the add field', () => {
    const html = renderToStaticMarkup(<AcceptanceChecklist issueId="T-1" items={[]} />)
    expect(html).toContain('Add an acceptance item')
  })

  test('ReplyComposer is a chip until it is opened', () => {
    const issue = { id: 'T-1', session: 'supermux' } as never
    const collapsed = renderToStaticMarkup(
      <ReplyComposer
        issue={issue}
        expanded={false}
        emphasized={false}
        onRequestOpen={() => {}}
        onReply={async () => {}}
      />,
    )
    expect(collapsed).toContain('Reply to agent')
    expect(collapsed).not.toContain('<textarea')
  })

  test('an explicit placeholder wins — "comment" vs "reply" is the whole point', () => {
    const issue = { id: 'T-1', session: null } as never
    const html = renderToStaticMarkup(
      <ReplyComposer
        issue={issue}
        expanded
        emphasized={false}
        onRequestOpen={() => {}}
        onReply={async () => {}}
        placeholder="Leave a comment…"
      />,
    )
    expect(html).toContain('Leave a comment…')
  })
})

describe('the copy was adopted, not deleted', () => {
  test('EMPTY.issues replaced the dead EMPTY.board', () => {
    expect(EMPTY.issues.title).toBeTruthy()
    expect((EMPTY as Record<string, unknown>).board).toBeUndefined()
  })

  test('the empty state explains where issues come from', () => {
    expect(EMPTY.issues.body).toContain('supermux-task')
  })
})
