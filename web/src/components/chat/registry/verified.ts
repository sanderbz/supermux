// The Claude Code versions the CURRENT dialog shapes were captured AND driven
// on — one list, so a new version is one line here plus its corpus directory.
//
// Each entry must have its own corpus under `web/tests/fixtures/tui/cc321/`
// (2.1.321 at the root, every other version in `v<patch>/`): a boot banner that
// pins it, the captures, and eight live cases that `answerDialog()` drove. The
// tests (`chat-cc321.test.ts`) fail for a version that is listed without one,
// so this list cannot be widened on a promise.
//
// `tools/cc-dialog-verify/nightly.sh` appends here when a new release drew
// exactly the same dialogs; a human still merges that PR (one merge point per
// version).

export const CC_VERIFIED_CURRENT = [
  '2.1.321',
  '2.1.322',
  '2.1.325',
  '2.1.326',
  '2.1.327',
  '2.1.329',
  '2.1.331',
] as const

/** The corpus directory of a listed version, relative to `fixtures/tui/cc321/`. */
export function corpusDirFor(version: string): string {
  if (version === '2.1.321') return '.'
  return version.startsWith('2.1.') ? `v${version.slice(4)}` : `v${version}`
}
