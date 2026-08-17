/**
 * T7.2 — the delete dialog is honest, and stays honest.
 *
 * R3 of the B5 plan: "the delete dialog becomes a lie the moment the handler
 * changes". The facts users are most surprised by — that supermux never
 * touches your working directory, git branch or worktree, and that purge is
 * the only irreversible verb — live in copy, not in code, so nothing about a
 * handler change forces the copy to keep up.
 *
 * The mitigation is a pincer. `server/tests/delete_disposition.rs` asserts the
 * BEHAVIOUR (no schedule survives its session; archive only pauses; a refused
 * purge disposes of nothing). This file asserts the DISCLOSURE: that every row
 * of `PURGE_DISPOSITION` actually reaches the screen. Adding a row to the table
 * without rendering it fails here; changing what a verb does without updating
 * the table fails there.
 */
import { describe, expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'

import { DispositionTable } from '../../src/components/archived/archived-sheet'
import { LIFECYCLE, PURGE_DISPOSITION } from '../../src/brand/copy'

const html = renderToStaticMarkup(<DispositionTable />)

// `renderToStaticMarkup` HTML-escapes text, and the copy is written with
// typographic apostrophes and em dashes. Compare on decoded text, not markup.
const decode = (s: string): string =>
  s
    .replace(/&(?:amp|#38);/g, '&')
    .replace(/&(?:lt|#60);/g, '<')
    .replace(/&(?:gt|#62);/g, '>')
    .replace(/&(?:quot|#34);/g, '"')
    .replace(/&#x27;|&#39;/g, "'")
    .replace(/&#x2F;/g, '/')

const text = decode(html)

describe('the purge disposition is fully disclosed', () => {
  test('every row of the table reaches the DOM', () => {
    // Not a count check — a content check. A count would pass if a row were
    // renamed to something the handler no longer does.
    for (const row of PURGE_DISPOSITION) {
      expect(text).toContain(row.thing)
      expect(text).toContain(row.purge)
    }
  })

  test('the table is not empty, so a broken map cannot pass vacuously', () => {
    expect(PURGE_DISPOSITION.length).toBeGreaterThanOrEqual(5)
  })

  test('the most surprising fact leads: your files are never touched', () => {
    // This is the single most important sentence in the dialog (T7.2). It is
    // asserted separately from the loop because its position matters: it is
    // what stops a user from believing "delete forever" reaches their repo.
    expect(text).toContain(LIFECYCLE.purgeLeavesYourFilesAlone)
    expect(PURGE_DISPOSITION[0]!.thing).toContain('Working directory')
    expect(PURGE_DISPOSITION[0]!.archive).toBe('Untouched')
    expect(PURGE_DISPOSITION[0]!.purge).toBe('Untouched')
  })

  test('archive and purge disagree somewhere — otherwise the table says nothing', () => {
    const differs = PURGE_DISPOSITION.filter((r) => r.archive !== r.purge)
    expect(differs.length).toBeGreaterThan(0)
  })
})

describe('the lifecycle contracts are stated, not implied', () => {
  test('archive is named as the undo window', () => {
    // §15.3 asks for an "undo window". Archive always WAS one; it was simply
    // never called one, which is why users reached past it.
    expect(LIFECYCLE.archiveIsTheUndo.toLowerCase()).toContain('reversible')
    expect(LIFECYCLE.archiveIsTheUndo).toContain('Archived sheet')
  })

  test('the archive/schedule contract names both halves', () => {
    // T5's contract: paused on archive, resumed on restore. Both halves have
    // to be in the sentence or it reads as "your jobs are gone".
    const s = LIFECYCLE.archivePausesSchedules.toLowerCase()
    expect(s).toContain('paused')
    expect(s).toContain('restore')
  })
})
