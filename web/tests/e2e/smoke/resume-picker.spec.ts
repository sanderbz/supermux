// feat-resume-picker e2e — Resume affordance on stopped sessions.
//
// Starting a stopped session always launched a CLEAN claude. The Resume action
// (beside Start + Archive) lets the user reopen a PAST Claude conversation for
// the session's working dir and resume it via `claude --resume <id>`.
//
// This spec boots the real binary with `$CLAUDE_CONFIG_DIR` pointed at a SEEDED
// fixture (`projects/<encoded-cwd>/<uuid>.jsonl`), so the resumable endpoint has
// real conversations to enumerate. It then drives the stopped-session focus
// surface on desktop (1440, chromium) AND mobile (430×932, touch context):
//   1. dir WITH conversations → Resume appears → picker lists them → pick one →
//      the tmux pane's launched command contains `claude --resume <id>` (the id
//      the user picked), proving the resume id reaches the spawn.
//   2. dir WITHOUT conversations → Resume is HIDDEN; Start is still present.
//
// A created-but-never-started session reads as `stopped`, so /focus/<name>
// renders <StoppedSession> → <StoppedSessionActions> (Start + Resume + Archive).
//
// The mobile test runs in a `hasTouch`/`isMobile` context so `matchMedia(
// '(pointer: coarse)')` matches and <ResponsiveSheet> forks to the Vaul sheet.

import { execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { expect, test, type Page } from '@playwright/test'
import { api, injectGlobals, startBackend, type Backend } from './harness'

/** Claude's project-folder encoding: every `/` and `.` → `-` (verified against
 *  the real `~/.claude/projects` layout). */
function encodeDir(abs: string): string {
  return abs.replace(/[/.]/g, '-')
}

/** Seed a fake Claude transcript for `workDir` under `claudeDir`. Returns the
 *  conversation id (the filename UUID = the `claude --resume <id>` arg). */
function seedConversation(
  claudeDir: string,
  workDir: string,
  id: string,
  aiTitle: string,
): void {
  // Claude records the symlink-resolved cwd; mirror that so the encoding matches
  // what the server computes via canonicalize().
  const resolved = realpathSync(workDir)
  const proj = join(claudeDir, 'projects', encodeDir(resolved))
  mkdirSync(proj, { recursive: true })
  const lines = [
    JSON.stringify({ type: 'ai-title', aiTitle, sessionId: id }),
    JSON.stringify({
      type: 'user',
      message: { role: 'user', content: 'do the thing' },
      isSidechain: false,
    }),
    JSON.stringify({
      type: 'assistant',
      message: { role: 'assistant', content: 'on it' },
    }),
  ]
  writeFileSync(join(proj, `${id}.jsonl`), lines.join('\n') + '\n')
}

/** Capture the tmux pane content for a session and check for a needle. The
 *  launch builder echoes `claude --resume <id>` into the pane when tmux runs the
 *  shell line. */
function paneContains(sessionName: string, needle: string): boolean {
  try {
    const out = execFileSync(
      'tmux',
      ['capture-pane', '-p', '-t', `supermux-${sessionName}`],
      { encoding: 'utf8' },
    )
    return out.includes(needle)
  } catch {
    return false
  }
}

const CONV_ID = 'abcdef01-2345-6789-abcd-ef0123456789'
const AI_TITLE = 'Refactor the parser'

interface Fixture {
  backend: Backend
  claudeDir: string
  workDir: string
  prevClaudeCfg: string | undefined
}

/** Boot the backend with `$CLAUDE_CONFIG_DIR` pointed at a freshly-seeded
 *  fixture for a real working dir. */
async function setup(): Promise<Fixture> {
  const prevClaudeCfg = process.env.CLAUDE_CONFIG_DIR
  const claudeDir = mkdtempSync(join(tmpdir(), 'supermux-resume-cfg-'))
  const workDir = mkdtempSync(join(tmpdir(), 'supermux-resume-work-'))
  seedConversation(claudeDir, workDir, CONV_ID, AI_TITLE)
  process.env.CLAUDE_CONFIG_DIR = claudeDir
  const backend = await startBackend()
  return { backend, claudeDir, workDir, prevClaudeCfg }
}

async function teardown(fx: Fixture | undefined): Promise<void> {
  if (!fx) return
  await fx.backend?.dispose()
  if (fx.prevClaudeCfg === undefined) delete process.env.CLAUDE_CONFIG_DIR
  else process.env.CLAUDE_CONFIG_DIR = fx.prevClaudeCfg
  try {
    rmSync(fx.claudeDir, { recursive: true, force: true })
    rmSync(fx.workDir, { recursive: true, force: true })
  } catch {
    /* best-effort */
  }
}

/** Drive: create stopped session in the seeded dir → open Resume → pick the
 *  conversation → assert the tmux command carries `--resume <CONV_ID>`. */
async function runResumeFlow(
  page: Page,
  fx: Fixture,
  name: string,
  pickerTestId: string | null,
): Promise<void> {
  await page.addInitScript(injectGlobals(fx.backend.token))
  const A = api(fx.backend)
  const created = await A.createSession({
    name,
    provider: 'claude',
    dir: fx.workDir, // the seeded dir → has a resumable conversation
  })
  expect(created.status, 'create claude session').toBe(201)

  // A created-but-unstarted session reads as `stopped` → StoppedSession.
  await page.goto(`${fx.backend.baseUrl}/focus/${name}`)

  // `exact` so we don't also match the tile card's "<name> — Stopped" aria-label.
  const resume = page.getByRole('button', { name: 'Resume', exact: true })
  await expect(resume).toBeVisible({ timeout: 15_000 })
  await resume.click()

  // The picker lists the seeded conversation by its ai-title.
  const scope = pickerTestId ? page.getByTestId(pickerTestId) : page
  if (pickerTestId) await expect(page.getByTestId(pickerTestId)).toBeVisible()
  else await expect(page.getByText('Resume a conversation')).toBeVisible()
  const row = scope.getByRole('button', { name: new RegExp(AI_TITLE) })
  await expect(row).toBeVisible()
  await row.click()

  // The launched tmux command carries the picked conversation id.
  await expect
    .poll(() => paneContains(name, `--resume ${CONV_ID}`), {
      timeout: 20_000,
      message: 'tmux pane should show `claude --resume <id>`',
    })
    .toBe(true)
}

test.describe('resume picker — desktop (chromium)', () => {
  let fx: Fixture
  test.beforeEach(async () => {
    fx = await setup()
  })
  test.afterEach(async () => {
    await teardown(fx)
  })

  test('Resume lists conversations and resumes with --resume <id>', async ({
    page,
  }) => {
    test.setTimeout(60_000)
    await page.setViewportSize({ width: 1440, height: 900 })
    // Desktop fork → shadcn side Sheet (no responsive-sheet testid).
    await runResumeFlow(page, fx, 'resume-desktop', null)
  })

  test('Resume is hidden when the dir has no conversations', async ({ page }) => {
    test.setTimeout(45_000)
    await page.setViewportSize({ width: 1440, height: 900 })
    await page.addInitScript(injectGlobals(fx.backend.token))

    const A = api(fx.backend)
    // A dir with NO seeded transcripts → resumable returns [] → Resume hidden.
    const created = await A.createSession({
      name: 'resume-none',
      provider: 'claude',
      dir: '/tmp/supermux-no-convos-here',
    })
    expect(created.status).toBe(201)

    await page.goto(`${fx.backend.baseUrl}/focus/resume-none`)

    // Start is present (fresh launch always available)…
    await expect(
      page.getByRole('button', { name: 'Start session' }),
    ).toBeVisible({ timeout: 15_000 })
    // …but Resume must NOT render (no empty picker). `exact` so the tile card's
    // "resume-none — Stopped" aria-label doesn't false-positive.
    await expect(
      page.getByRole('button', { name: 'Resume', exact: true }),
    ).toHaveCount(0)
  })
})

test.describe('resume picker — mobile (touch / Vaul sheet)', () => {
  // Touch context → `matchMedia('(pointer: coarse)')` matches → ResponsiveSheet
  // forks to the Vaul drag-detent bottom sheet (data-testid responsive-sheet).
  test.use({
    viewport: { width: 430, height: 932 },
    hasTouch: true,
    isMobile: true,
  })

  let fx: Fixture
  test.beforeEach(async () => {
    fx = await setup()
  })
  test.afterEach(async () => {
    await teardown(fx)
  })

  test('Resume works via the Vaul bottom sheet', async ({ page }) => {
    test.setTimeout(60_000)
    await runResumeFlow(page, fx, 'resume-mobile', 'responsive-sheet')
  })
})
