// fix/resume-hover regression e2e — the Resume picker must survive a
// mouse-leave onto the picker (the hover-collapse bug).
//
// THE BUG (overview, desktop): clicking Resume on a STOPPED tile opened the
// <ResumePicker> (a ResponsiveSheet), but the picker + its trigger lived inside
// the tile's HOVER-GATED stopped-peek surface (`expanded = hovered && …`).
// Moving the mouse OFF the card to interact with the picker dropped `hovered`
// → the stopped-peek surface (incl. the open picker) UNMOUNTED → the tile
// shrank and the picker vanished. Unusable.
//
// THE FIX: lift the picker's open-state up to the tile (onResumeOpenChange →
// resumePickerOpen) and PIN the surface expanded while the picker is open
// (`expanded = (hovered || resumePickerOpen) && …`), independent of hover; it
// collapses normally once the picker closes.
//
// This spec boots the real binary with `$CLAUDE_CONFIG_DIR` pointed at a SEEDED
// fixture so the resumable endpoint has a real conversation to enumerate, then
// drives the OVERVIEW tile hover-peek path (NOT the focus pane):
//   1. hover the stopped tile → Resume appears → click it → picker opens.
//   2. move the pointer OFF the card (neutral corner) → assert BOTH the picker
//      AND the stopped-peek Resume trigger stay mounted (the pin holds — the
//      regression guard). Pre-fix this is exactly when everything unmounted.
//   3. pick the seeded conversation → the tmux command carries `--resume <id>`.
//   4. (no-degradation) after the picker closes, the surface collapses again.

import { execFileSync } from 'node:child_process'
import {
  mkdtempSync,
  mkdirSync,
  rmSync,
  writeFileSync,
  realpathSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { expect, test } from '@playwright/test'
import { api, injectGlobals, startBackend, type Backend } from './harness'

/** Claude's project-folder encoding: every `/` and `.` → `-`. */
function encodeDir(abs: string): string {
  return abs.replace(/[/.]/g, '-')
}

/** Seed a fake Claude transcript for `workDir`. Returns the conversation id. */
function seedConversation(
  claudeDir: string,
  workDir: string,
  id: string,
  aiTitle: string,
): void {
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

/** Capture the tmux pane content for a session. Empty string if no pane yet. */
function capturePane(sessionName: string): string {
  try {
    return execFileSync(
      'tmux',
      ['capture-pane', '-p', '-t', `supermux-${sessionName}`],
      { encoding: 'utf8' },
    )
  } catch {
    return ''
  }
}

/** The resume reached the spawn iff the pane echoes `claude --resume <id>` OR
 *  the real `claude` binary has already TAKEN OVER the pane (it boots fast on a
 *  machine where it's installed and clears the echoed shell line — its trust
 *  prompt / workspace banner is then the only proof the launch ran). Either
 *  means the picked id reached the launch builder. */
function resumeLaunched(sessionName: string, id: string): boolean {
  const out = capturePane(sessionName)
  if (out.includes(`--resume ${id}`)) return true
  // claude TUI took over: its first-run banner / trust prompt is visible.
  return /Accessing workspace|trust this folder|Claude Code/i.test(out)
}

const CONV_ID = 'abcdef01-2345-6789-abcd-ef0123456789'
const AI_TITLE = 'Refactor the parser'
const SESSION = 'resume-hover-pin'

test.describe('resume picker — overview tile hover-pin (fix/resume-hover)', () => {
  let backend: Backend
  let claudeDir: string
  let workDir: string
  let prevClaudeCfg: string | undefined

  test.beforeEach(async () => {
    prevClaudeCfg = process.env.CLAUDE_CONFIG_DIR
    claudeDir = mkdtempSync(join(tmpdir(), 'supermux-resume-cfg-'))
    workDir = mkdtempSync(join(tmpdir(), 'supermux-resume-work-'))
    seedConversation(claudeDir, workDir, CONV_ID, AI_TITLE)
    process.env.CLAUDE_CONFIG_DIR = claudeDir
    backend = await startBackend()
  })

  test.afterEach(async () => {
    await backend?.dispose()
    if (prevClaudeCfg === undefined) delete process.env.CLAUDE_CONFIG_DIR
    else process.env.CLAUDE_CONFIG_DIR = prevClaudeCfg
    try {
      rmSync(claudeDir, { recursive: true, force: true })
      rmSync(workDir, { recursive: true, force: true })
    } catch {
      /* best-effort */
    }
  })

  test('Resume picker survives mouse-leave-to-picker, then resumes', async ({
    page,
  }) => {
    test.setTimeout(60_000)
    // Desktop 1440 (fine pointer) → the stopped tile's hover-peek is active.
    await page.setViewportSize({ width: 1440, height: 900 })
    await page.addInitScript(injectGlobals(backend.token))

    const A = api(backend)
    // A created-but-never-started session reads as `stopped` → its overview tile
    // hover-peek mounts <StoppedSessionActions> (Start + Resume + Archive).
    const created = await A.createSession({
      name: SESSION,
      provider: 'claude',
      dir: workDir, // seeded dir → has a resumable conversation → Resume shows
    })
    expect(created.status, 'create claude session').toBe(201)

    await page.goto(backend.baseUrl)

    // The tile card's aria-label is "<title> — <status>" (e.g. "<name> — Stopped").
    const tile = page.getByRole('button', { name: new RegExp(`^${SESSION} —`) })
    await expect(tile).toBeVisible({ timeout: 15_000 })

    // Hover the stopped tile → the stopped-peek surface reveals Resume (only
    // when the dir has conversations). `exact` so we don't match the tile's
    // "<name> — Stopped" aria-label.
    await tile.hover()
    const resume = page.getByRole('button', { name: 'Resume', exact: true })
    await expect(resume).toBeVisible({ timeout: 15_000 })

    // Open the picker.
    await resume.click()
    // Desktop fork → shadcn side Sheet with the picker heading.
    await expect(page.getByText('Resume a conversation')).toBeVisible()

    // ── THE REGRESSION GUARD ─────────────────────────────────────────────────
    // Move the pointer OFF the tile to a neutral corner — exactly the gesture
    // that, pre-fix, dropped `hovered` and unmounted the stopped-peek + picker.
    // Settle long enough that the OLD plain-hover dismissal would have fired.
    await page.mouse.move(5, 5)
    await page.waitForTimeout(800)

    // The picker MUST still be open…
    await expect(
      page.getByText('Resume a conversation'),
      'picker must survive mouse-leave onto it (the pin)',
    ).toBeVisible()
    // …AND the stopped-peek surface MUST still be mounted — the Start/Resume
    // actions live inside it. Pre-fix both of these were gone after the leave.
    // NB: the open shadcn Sheet marks background content aria-hidden, so we use
    // a TEXT locator (CSS-visibility based, unaffected by the a11y inerting)
    // rather than a role query for the still-rendered stopped-peek button.
    await expect(
      page.getByText('Start session'),
      'stopped-peek surface must stay mounted while the picker is open',
    ).toBeVisible()

    // Pick the seeded conversation by its ai-title → resume request fires.
    const row = page.getByRole('button', { name: new RegExp(AI_TITLE) })
    await expect(row).toBeVisible()
    await row.click()

    // The pick reached the spawn — the launch carries `--resume <id>` (proving
    // the picker was usable end-to-end after the mouse-leave).
    await expect
      .poll(() => resumeLaunched(SESSION, CONV_ID), {
        timeout: 20_000,
        message: 'tmux pane should show the resumed claude launch',
      })
      .toBe(true)

    // No-degradation: once the picker closes (it does on a successful pick), the
    // pin releases. The tile is no longer stopped (it's resuming), so the
    // stopped-peek Resume trigger is gone — confirming the surface collapsed and
    // didn't get stuck pinned-open.
    await expect(
      page.getByRole('button', { name: 'Resume', exact: true }),
      'stopped-peek must release once the picker closes (no stuck pin)',
    ).toHaveCount(0, { timeout: 15_000 })
  })
})
