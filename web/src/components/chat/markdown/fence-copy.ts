/**
 * Is this fence a DIFF?
 *
 * `board-patch-focused.png` gives the one fenced block the approved design
 * contains, and it is a diff drawn in exactly two inks: the removed line in
 * tertiary, the added line at full strength — B0's `CodeDel` / `CodeAdd`. That
 * read is worth more than syntax colour here (it is the shape of the change, and
 * the surface's rule is quiet chrome, loud content), so a fence that IS a diff
 * gets it.
 *
 * The test is deliberately strict: at least two non-empty lines, every one of
 * them opening with `+`, `-` or a space, and at least one of each sign. Rust
 * that happens to start a line with a minus does not qualify, because the rest
 * of the block will not.
 */
export function diffLines(text: string): string[] | null {
  const lines = text.replace(/\n$/, '').split('\n')
  const meaningful = lines.filter((l) => l.trim() !== '')
  if (meaningful.length < 2) return null
  if (!meaningful.every((l) => /^[-+ ]/.test(l))) return null
  if (!meaningful.some((l) => l.startsWith('+')) || !meaningful.some((l) => l.startsWith('-'))) {
    return null
  }
  return lines
}

/** What the copy button puts on the clipboard for a fence. Verbatim, minus the
 *  one trailing newline the parser leaves. A diff copies as its post-change
 *  version: context and added lines with the marker column stripped, removed
 *  lines dropped. */
export function fenceCopyText(raw: string): string {
  const diff = diffLines(raw)
  if (!diff) return raw.replace(/\n$/, '')
  return diff
    .filter((l) => !l.startsWith('-'))
    .map((l) => l.slice(1))
    .join('\n')
}
