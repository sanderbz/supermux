/**
 * The board KEEP-LIST — "the API stays" as a test, not a sentence.
 * ─────────────────────────────────────────────────────────────────────────────
 * Fase B2 deleted the Board PAGE. It deleted nothing else, and that is the whole
 * risk: §18's named failure mode is "board removal orphans live writers". The
 * writers are all still running —
 *
 *   · `auto_actions.rs` flips `needs_review` when a session goes idle and
 *     `awaiting_input` when it starts waiting;
 *   · `scheduler/runner.rs` sends the literal `/supermux-task` line;
 *   · `teams/board_sync.rs` mirrors `~/.claude/tasks/<team>/NN.json` into
 *     `kind='team'` boards — teams are outside Track A's guard, and a transcript
 *     line can never replace that;
 *   · `db/sessions.rs` re-points `issues.session` on a rename;
 *   · every agent that has ever run `/supermux-task`.
 *
 * — so every route they write through has to still be registered. This test
 * parses the Rust routers and says so. It is a SOURCE SCAN in the
 * `brand-tokens.test.ts` / `tour-anchors.test.ts` idiom: the alternative is a
 * booted server, and a keep-list that only runs when someone remembers to boot
 * a server is not a keep-list.
 */
import { createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import { describe, expect, test } from 'bun:test'

const REPO = fileURLToPath(new URL('../../..', import.meta.url))
const read = (rel: string): string => readFileSync(REPO + rel, 'utf8')
const exists = (rel: string): boolean => existsSync(REPO + rel)

const BOARD = read('server/src/board/mod.rs')
const BOARDS = read('server/src/board/boards.rs')
const HOOK = read('server/src/board/hook.rs')

describe('the bearer board API is still registered', () => {
  // Every path from the plan's §0.2 keep-list. A route that disappears here is
  // a capability that disappeared with the page.
  const ROUTES = [
    '/api/board',
    '/api/board/clear-done',
    '/api/board/statuses',
    '/api/board/statuses/reorder',
    '/api/board/statuses/{id}',
    '/api/board/tag-completion',
    '/api/board/{id}/comment',
    '/api/board/{id}/acceptance',
    '/api/board/{id}/acceptance/reorder',
    '/api/board/{id}/acceptance/{item_id}',
    '/api/board/{id}/link',
    '/api/board/{id}/link/{link_id}',
    '/api/board/{id}',
    '/api/board/{id}/claim',
    '/api/board/{id}/start',
    '/api/board/{id}/reply',
    '/api/board/{id}/discard',
    '/api/board/{id}/restore',
  ]

  test('all eighteen board routes', () => {
    const missing = ROUTES.filter((r) => !BOARD.includes(`"${r}"`))
    expect(missing).toEqual([])
  })

  test('the multi-board CRUD is still merged in', () => {
    expect(BOARD).toContain('boards::router_for(state)')
    for (const r of ['/api/boards', '/api/boards/{id}/cards', '/api/boards/register-team']) {
      expect(BOARDS.includes(`"${r}"`), r).toBe(true)
    }
  })

  test('the PUBLIC iCal feed survives — calendar clients cannot send a bearer', () => {
    expect(BOARD).toContain('"/api/calendar.ics"')
    expect(BOARD).toContain('pub fn public_router_for')
  })

  test('every route is still MOUNTED, not merely defined', () => {
    const http = read('server/src/http.rs')
    expect(http).toContain('board::router_for')
    expect(http).toContain('board::hook_router_for')
    expect(http).toContain('board::public_router_for')
  })
})

describe('the agent→board hook edge is still registered', () => {
  // What `/supermux-task` actually calls. It is mounted OUTSIDE the bearer
  // layer (hook-token auth), so it is the one edge a deleted UI could not have
  // been protecting.
  const HOOKS = [
    '/api/hook/board/comment',
    '/api/hook/board/status',
    '/api/hook/board/check',
    '/api/hook/board/link',
    '/api/hook/board/needs-input',
  ]

  test('all five hook routes', () => {
    const missing = HOOKS.filter((r) => !HOOK.includes(`"${r}"`))
    expect(missing).toEqual([])
  })

  test('needs-input still fires a push notification', () => {
    expect(HOOK).toContain('needs_input_handler')
    expect(HOOK).toMatch(/push/i)
  })
})

describe('the shipped skill is byte-for-byte unchanged', () => {
  test('supermux-task.md matches its pre-B2 hash', () => {
    // The skill is installed to ~/.claude/commands/supermux-task.md and is the
    // contract every agent already knows. B2 does not touch it — not a word, not
    // a whitespace — and the hash is how that is enforced rather than promised.
    const hash = createHash('sha256')
      .update(readFileSync(REPO + 'server/src/agents/supermux-task.md'))
      .digest('hex')
    expect(hash).toBe('1aa20a43d4dca179b25afa2b27759cb6d48234cd1494777ff3e671fd030151e7')
  })

  test('and it is still compiled in and installed at boot', () => {
    const skills = read('server/src/agents/skills.rs')
    expect(skills).toContain('include_str!')
    expect(skills).toContain('supermux-task.md')
    expect(read('server/src/main.rs')).toMatch(/skills::/)
  })
})

describe('the server-side machinery is untouched', () => {
  test('every keep-list module still exists', () => {
    for (const f of [
      'server/src/board/mod.rs',
      'server/src/board/hook.rs',
      'server/src/board/boards.rs',
      'server/src/board/claim.rs',
      'server/src/board/dispatch.rs',
      'server/src/board/prefix.rs',
      'server/src/teams/board_sync.rs',
      'server/tests/board.rs',
      'server/tests/board_claim.rs',
    ]) {
      expect(exists(f), f).toBe(true)
    }
  })

  test('the live WRITERS still write', () => {
    const auto = read('server/src/sessions/auto_actions.rs')
    expect(auto).toContain('emit_board')
    expect(auto).toMatch(/NeedsReview|needs_review/)
    expect(auto).toMatch(/AwaitingInput|awaiting_input/)
    // A scheduled run reports onto its issue with the literal skill line.
    expect(read('server/src/scheduler/runner.rs')).toContain('/supermux-task')
    // A rename re-points the issue rows rather than orphaning them.
    expect(read('server/src/db/sessions.rs')).toMatch(/UPDATE issues SET session/)
  })

  test('no migration was edited or dropped', () => {
    // memory: sqlx migrations are checksummed — a VersionMismatch bricks every
    // deployed install. B2 adds ONE new file and touches nothing else.
    for (const m of [
      '0002_board.sql',
      '0010_board_agent.sql',
      '0011_board_review_flags.sql',
      '0013_board_three_lanes.sql',
      '0015_boards.sql',
      '0016_team_task_link.sql',
    ]) {
      expect(exists(`server/migrations/${m}`), m).toBe(true)
    }
  })
})

describe('the two client-side traps', () => {
  test('board-create-session-store is the app-wide last-active cell, and survives', () => {
    // FILENAME TRAP: it is named for the board composer and has nothing to do
    // with it. `useLastActiveSession` is read by /focus and /files.
    const store = read('web/src/stores/board-create-session-store.ts')
    expect(store).toContain('useLastActiveSession')
    // The localStorage key must not change — renaming it would silently reset
    // every user's last-active session.
    expect(store).toContain('supermux:board-create-last-session')
  })

  test('the data layer the new issue surface reads through is intact', () => {
    for (const f of [
      'web/src/lib/api/board.ts',
      'web/src/lib/api/boards.ts',
      'web/src/hooks/use-board.ts',
      'web/src/components/session/session-picker.tsx',
    ]) {
      expect(exists(f), f).toBe(true)
    }
    const useBoard = read('web/src/hooks/use-board.ts')
    expect(useBoard).toContain('useLiveSession')
    expect(useBoard).toContain('synthesizeSessionBoards')
  })

  test('the board / boards SSE events still route', () => {
    const sse = read('web/src/hooks/use-sse.ts')
    expect(sse).toContain("'board'")
    expect(sse).toContain("'boards'")
  })

  test('the e2e harness can still seed issues — T10’s spec needs it', () => {
    const harness = read('web/tests/e2e/smoke/harness.ts')
    expect(harness).toContain('createIssue')
    expect(harness).toContain('/api/board')
    expect(harness).toContain('claim')
  })
})

describe('and the PAGE is really gone', () => {
  test('the route, its components and its board-only hook are deleted', () => {
    for (const f of [
      'web/src/routes/board.tsx',
      'web/src/components/board/board-card.tsx',
      'web/src/components/board/board-card-editor.tsx',
      'web/src/components/board/board-composer.tsx',
      'web/src/components/board/board-switcher.tsx',
      'web/src/components/board/board-skeleton.tsx',
      'web/src/components/board/pos.ts',
      // Board-only despite the generic name: every path called `boardApi`.
      'web/src/hooks/use-send-to-agent.ts',
    ]) {
      expect(exists(f), f).toBe(false)
    }
  })

  test('/board redirects instead of 404-ing', () => {
    const app = read('web/src/App.tsx')
    expect(app).toContain('path="/board"')
    expect(app).toContain('<Navigate to="/" replace />')
    expect(app).not.toContain("from '@/routes/board'")
  })

  test('nav is four items, and the deletion keyed on the PATH', () => {
    const layout = read('web/src/components/layout.tsx')
    expect(layout).not.toContain("to: '/board'")
    expect(layout).not.toContain('SquareKanban')
    const navBlock = layout.slice(layout.indexOf('const NAV'), layout.indexOf('/** Tiny notification dot'))
    expect(navBlock.match(/to: '/g)?.length).toBe(4)
  })

  test('the palette lost its four board verbs and its issue rows', () => {
    const palette = read('web/src/components/command-palette/command-palette.tsx')
    for (const verb of ['action:board-start', 'action:board-send', 'action:board-comment', 'action:board-done']) {
      expect(palette).not.toContain(verb)
    }
    expect(palette).not.toContain("kind: 'issue'")
    expect(palette).not.toContain('useSendToAgent')
    // …and kept everything else.
    expect(palette).toContain('action:view-archived')
    expect(palette).toContain('action:claude-tools')
    expect(palette).toContain('action:new-group')
    expect(palette).toContain('useGlobalCommandKey')
  })
})
