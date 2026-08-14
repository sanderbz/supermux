// The modal registry's public surface (fase A4 T6).
//
// One question, asked in one place: *given what the lens sees and which Claude
// Code this session booted, what — if anything — may chat press?* Everything
// that can make the answer "nothing" is here, and each of those refusals is
// visible: it comes back as an `AttentionCause` with every option disabled,
// never as a silently missing button.
//
// The three refusals, in the order they are checked:
//   1. **no entry** — a dialog family (or a permission variant) the registry
//      does not cover → `dialog-unmapped`;
//   2. **version** — the session's BOOT-BANNER version is not one this
//      fingerprint was captured against → `registry-version-mismatch`;
//   3. **shape** — the sighted rows no longer say what the entry says they say
//      → `dialog-unmapped`. The registry's own index is not evidence that row N
//      is the option we think it is.
//
// No component imports `./claude` or `./plan` directly — T7's `use-dialog-answer`
// is the only consumer, and it comes through here.

import type { AttentionCause } from '../attention'
import type { DialogSighting, PeekLens } from '../peek-lens'

import { entryForSighting, type RegistryEntry, type RegistryOption } from './claude'

export {
  ENTRIES,
  entryById,
  entryForSighting,
  type OptionEffect,
  type RegistryEntry,
  type RegistryEscape,
  type RegistryId,
  type RegistryOption,
} from './claude'
export { keyPlan, navigationSteps } from './plan'

export interface RegistryMatch {
  /** The entry, or null when nothing on screen is one this app knows. When
   *  `degraded` is true the options are still here — so the user can READ the
   *  question chat is declining to answer — but every one of them has `actOn`
   *  false and a reason. */
  entry: RegistryEntry | null
  /** Something is on screen that this app will not act on. */
  degraded: boolean
  /** The card the surface should raise, `null` when there is nothing wrong
   *  (including the ordinary case of no dialog at all). */
  attention: AttentionCause | null
}

const NO_MATCH: RegistryMatch = { entry: null, degraded: false, attention: null }

/**
 * The session's version pin — the ONLY pin.
 *
 * It is the boot banner the session printed at launch, read by `peek-lens.ts`
 * and cached per session by `use-peek-lens.ts`. Never the CLI's own `--version`
 * flag (the literal string is kept out of this repo so T12's grep for it stays
 * empty): that reports the binary on disk, the CLI auto-updates (A0 watched
 * 2.1.227 → 2.1.231 happen mid-probe), and a RUNNING session keeps the binary
 * it booted with. A
 * pin read from disk would therefore certify a fingerprint against a version the
 * session is not running.
 *
 * `null` = the banner had already scrolled out of reach. That is a mismatch, not
 * a pass: `entryFor` degrades on it and `attentionCopy` has a distinct sentence
 * for "could not read the version at all".
 */
export function pinFor(lens: Pick<PeekLens, 'bannerVersion'>): string | null {
  const v = lens.bannerVersion?.trim()
  return v ? v : null
}

/**
 * What the surface may do about the dialog the lens is currently seeing.
 *
 * Pure and cheap — safe to call on every lens frame (T7 does exactly that, then
 * re-checks the sighting again immediately before it sends anything).
 */
export function entryFor(
  lens: Pick<PeekLens, 'dialog'>,
  pinnedVersion: string | null | undefined,
): RegistryMatch {
  const sighting = lens.dialog
  if (!sighting) return NO_MATCH

  const entry = entryForSighting(sighting)
  if (!entry) return { entry: null, degraded: true, attention: 'dialog-unmapped' }

  if (!pinnedVersion || !entry.verifiedVersions.includes(pinnedVersion)) {
    return {
      entry: disabled(
        entry,
        pinnedVersion
          ? `This session booted Claude Code ${pinnedVersion}; these options were only checked against ${entry.verifiedVersions.join(', ')}.`
          : `Chat could not read this session’s Claude Code version, and these options were only checked against ${entry.verifiedVersions.join(', ')}.`,
      ),
      degraded: true,
      attention: 'registry-version-mismatch',
    }
  }

  if (!shapeHolds(entry, sighting)) {
    return {
      entry: disabled(
        entry,
        'The options on screen are not the ones this mapping was captured against, so pressing a key here could answer a different question than the one you read.',
      ),
      degraded: true,
      attention: 'dialog-unmapped',
    }
  }

  return { entry, degraded: false, attention: null }
}

/**
 * The words to put on an option's button.
 *
 * The LIVE row wins when the sighting has it: option 2 of a Bash permission
 * names the directory it would grant (`…allow access to tmp/ from this
 * project`), and a user asked to grant something is owed the actual sentence.
 * The registry label is the fallback — for a row that scrolled off, and for the
 * bench fixtures that render a card with no capture behind it.
 */
export function optionLabel(
  option: RegistryOption,
  sighting?: DialogSighting | null,
): string {
  const sighted = sighting?.options[option.tuiIndex]?.trim()
  return sighted && option.rowPattern.test(sighted) ? sighted : option.label
}

/** Does the screen still agree with the entry? Row count AND row text — a list
 *  that gained or lost a row is the failure mode that turns "No" into "Yes, and
 *  always allow", and it is invisible if only the count is checked. */
function shapeHolds(entry: RegistryEntry, sighting: DialogSighting): boolean {
  if (sighting.options.length !== entry.options.length) return false
  return entry.options.every((o) => {
    const row = sighting.options[o.tuiIndex]
    return typeof row === 'string' && o.rowPattern.test(row.trim())
  })
}

/** The same entry with nothing act-on-able. The options survive so the card can
 *  still be read; `reason` replaces any option-specific one because this refusal
 *  outranks it — the option's own caveat is moot once the whole reading is in
 *  doubt. */
function disabled(entry: RegistryEntry, reason: string): RegistryEntry {
  return {
    ...entry,
    options: entry.options.map((o) => ({ ...o, actOn: false, disabledReason: reason })),
    escape: { ...entry.escape, actOn: false, disabledReason: reason },
  }
}
