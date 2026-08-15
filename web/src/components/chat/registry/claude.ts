// The modal registry — the data file (fase A4 T6).
//
// TWO families, both live-verified, and nothing else. This module is the list of
// things the chat surface is ALLOWED to answer on the user's behalf, and it is
// deliberately a data file: every entry below is a claim about what a keystroke
// does to somebody's session, so every claim carries the evidence that earned it
// and every claim has a test (`tests/unit/chat-registry.test.ts`) reading the
// same a0 capture the claim came from.
//
// THE RULE THIS FILE EXISTS TO ENFORCE: no option is act-on-able without a
// fixture. An option A0 could not verify is still RENDERED — the user must be
// able to read the question chat is refusing to answer — but it carries a reason
// and it sends nothing. That is why `actOn` is a field rather than an absence:
// "we don't know what this does" is a thing the surface has to say out loud.
//
// Evidence: `docs/superpowers/plans/research-2026-08-13/a0-findings.md` §3
// ("Act-on families"), captures verbatim in `web/tests/fixtures/tui/` (their
// provenance, including which two are derived, is in that dir's README).
//
// Pure: no React, no network, no `lib/` imports beyond the lens' own types.

import type { DialogSighting } from '../peek-lens'

export type RegistryId =
  | 'permission.bash'
  | 'permission.edit'
  | 'permission.write'
  | 'plan.approval'

/** What choosing an option actually does to the session — the vocabulary the
 *  card's copy and T7's outcome inference share.
 *
 *  `accept`         run this one thing, keep asking next time.
 *  `accept-session` run it AND stop asking for the rest of the session (the
 *                   permission dialogs' option 2, the plan dialog's auto mode) —
 *                   a strictly larger grant, which is why it is a separate word.
 *  `deny`           do not run it (a0: verified by artifact ABSENCE).
 *  `feedback`       do not run it and let the user say what to do instead; the
 *                   sentence itself goes through the composer, not the dialog —
 *                   there is no in-dialog free-text row on 2.1.2xx (a0 §3). */
export type OptionEffect = 'accept' | 'accept-session' | 'deny' | 'feedback'

export interface RegistryOption {
  /** The card's words. Deliberately free of the dialog's DYNAMIC tokens (a0 §3
   *  "never fingerprint on": the command line, the model description, option 2's
   *  directory) — `optionLabel()` in `./index.ts` prefers the live row when the
   *  sighting has one, so the user reads the real sentence and the registry
   *  keeps a stable one. */
  label: string
  /** 0-based row the caret must reach. The key plan is computed from the caret's
   *  CURRENT position (`registry/plan.ts`), never from this number alone. */
  tuiIndex: number
  /** May a key be pressed for this option? `false` ⇒ rendered, disabled, with a
   *  reason — never hidden. */
  actOn: boolean
  disabledReason?: string
  effect: OptionEffect
  /** What the SIGHTED row must still say for this option to be believed. The
   *  registry's own index is not evidence that row N is the option we think it
   *  is: an option list that gained a row turns "No" into "Yes, and always
   *  allow". Prefix-anchored and whitespace-normalised because options wrap at
   *  52 cols and a sub-hint folds into its option (a0 §3 wrap hazard). */
  rowPattern: RegExp
}

/** Esc is an affordance, not a numbered row, so it is not in `options` — but it
 *  is still a key this app can press, so it needs the same `actOn` discipline. */
export interface RegistryEscape {
  label: string
  actOn: boolean
  disabledReason?: string
  effect: Extract<OptionEffect, 'deny' | 'feedback'>
}

export interface RegistryEntry {
  id: RegistryId
  family: DialogSighting['family']
  variant?: DialogSighting['variant']
  /** The CC versions this entry was CAPTURED against — the pin, checked against
   *  the session's BOOT BANNER (a0: a running session keeps its boot binary
   *  across a CLI auto-update; `spike-a0-perm` ran 2.1.227 while the disk had
   *  2.1.231). A session outside this list gets the entry with every option
   *  hard-disabled, never a best-effort guess. */
  verifiedVersions: readonly string[]
  /** Card options, in TUI order. */
  options: readonly RegistryOption[]
  escape: RegistryEscape
}

/**
 * 2.1.232 — the A4c LIVE self-test, 2026-08-15.
 *
 * Widening a pin without a capture is the one edit this file forbids, so here is
 * the capture. Session `spike-a4c-dialogs` booted `Claude Code v2.1.232`
 * (`tests/fixtures/tui/a4c/00-boot-banner.txt`) and every entry below was driven
 * against it with the exact key plan `registry/plan.ts` emits, per-key, with the
 * dialog-answer discipline around it. All four are covered, all four landed the
 * effect they claim, with the side-effect proof recorded:
 *
 *   permission.bash   opt 1 executed (artifact present) · opt 3 denied
 *                     (`⎿ Interrupted`, artifact ABSENT) · Esc denied
 *   permission.write  opt 2 wrote the file AND flipped `⏵⏵ accept edits on`
 *                     — the `accept-session` claim, captured rather than
 *                     inferred for the first time
 *   permission.edit   opt 3 denied (`⎿ User rejected update`, file unchanged)
 *   plan.approval     opt 2 → `User approved Claude's plan` + `⏸ manual mode on`
 *
 * Index, per-case verdicts and the frame-by-frame sequences:
 * `tests/fixtures/tui/a4c/README.md`. The one deviation that run found — CC
 * dropping `Tab to amend` from the footer while the caret is on row 2 — is a
 * DETECTOR fact, not a registry one, and it is answered by the two-phase
 * fingerprint in `peek-lens.ts`; the rows, the plans and the effects below were
 * confirmed unchanged.
 */
const A4C = '2.1.232'

/** a0 §3, Family 1: "Pinned v2.1.227, Bash variant re-verified structurally
 *  identical v2.1.231." The Bash capture therefore holds on both; the Edit
 *  capture in `tests/fixtures/tui/` is recorded at 2.1.231 and the Write one at
 *  2.1.227, so each variant pins exactly what its own bytes prove. Widening a
 *  list without a new capture is the one edit this file forbids. */
const PERMISSION_BASH_VERSIONS = ['2.1.227', '2.1.231', A4C] as const
const PERMISSION_EDIT_VERSIONS = ['2.1.231', A4C] as const
const PERMISSION_WRITE_VERSIONS = ['2.1.227', A4C] as const
/** a0 §3, Family 2 (ExitPlanMode): pinned v2.1.231. */
const PLAN_VERSIONS = ['2.1.231', A4C] as const

/** Option 1 is the same row on all three permission variants: exactly `1. Yes`
 *  — which is also the family's own fingerprint anchor (a0 §3), so a sighting
 *  that reaches this file has already agreed with it.
 *  Verified per-option: 1 EXECUTES (artifact present after Enter). */
const PERMISSION_YES: RegistryOption = {
  label: 'Yes',
  tuiIndex: 0,
  actOn: true,
  effect: 'accept',
  rowPattern: /^yes$/i,
}

/** Verified per-option: 3 CANCELS without executing (artifact absent). */
const PERMISSION_NO: RegistryOption = {
  label: 'No',
  tuiIndex: 2,
  actOn: true,
  effect: 'deny',
  rowPattern: /^no$/i,
}

/** a0 §3: "Escape cancels → `⎿ Interrupted · What should Claude do instead?` +
 *  composer focus", and the artifact was absent afterwards. The free-text branch
 *  IS this key followed by the React composer (T7) — there is no in-dialog
 *  free-text row on 2.1.227/231. */
const PERMISSION_ESCAPE: RegistryEscape = {
  label: 'Say something instead',
  actOn: true,
  effect: 'feedback',
}

function permissionEntry(
  id: Extract<RegistryId, `permission.${string}`>,
  variant: NonNullable<DialogSighting['variant']>,
  verifiedVersions: readonly string[],
  second: RegistryOption,
): RegistryEntry {
  return {
    id,
    family: 'permission',
    variant,
    verifiedVersions,
    options: [PERMISSION_YES, second, PERMISSION_NO],
    escape: PERMISSION_ESCAPE,
  }
}

export const ENTRIES: readonly RegistryEntry[] = [
  permissionEntry('permission.bash', 'bash', PERMISSION_BASH_VERSIONS, {
    // Live row: `2. Yes, and always allow access to <dir>/ from this project`.
    // The directory is dynamic (a0 §3 "option-2 dir token = parent dir of the
    // target"), so it is not in the label and not in the pattern.
    label: 'Yes, and always allow this kind of command',
    tuiIndex: 1,
    // a0 §3, verbatim: "Bash option 2 ('always allow'): executes, but
    // persistence NOT FOUND (no rule in ~/.claude.json, no
    // .claude/settings.local.json, ~/.claude/settings.json unchanged; a later
    // subdir command re-prompted — inconclusive) and its side-effect rounds were
    // contaminated by a concurrent client." A grant whose SCOPE is unknown is
    // exactly the one no app should hand out on a user's behalf.
    actOn: false,
    disabledReason:
      'What “always allow” persists here is unverified — A0 found no rule written to disk and a later command in the same project asked again. Choose it in the terminal if you mean it.',
    effect: 'accept-session',
    rowPattern: /^yes, and always allow\b/i,
  }),

  permissionEntry('permission.edit', 'edit', PERMISSION_EDIT_VERSIONS, {
    // Live row: `2. Yes, allow all edits during this session` + the folded
    // sub-hint `(shift+tab)`.
    label: 'Yes, allow all edits during this session',
    tuiIndex: 1,
    // a0 §3, verbatim: "BTab acts as option 2 on Edit/Write dialogs (file
    // written + `⏵⏵ accept edits on` — verified)." The effect of this row is
    // known because A0 triggered it and watched both halves land, which is the
    // bar Bash option 2 did not clear.
    actOn: true,
    effect: 'accept-session',
    rowPattern: /^yes, allow all edits during this session\b/i,
  }),

  permissionEntry('permission.write', 'write', PERMISSION_WRITE_VERSIONS, {
    // The Write ("Create file") variant carries the identical row — captured
    // verbatim in `perm-write.txt`, same BTab verification as Edit.
    label: 'Yes, allow all edits during this session',
    tuiIndex: 1,
    actOn: true,
    effect: 'accept-session',
    rowPattern: /^yes, allow all edits during this session\b/i,
  }),

  {
    id: 'plan.approval',
    family: 'plan',
    verifiedVersions: PLAN_VERSIONS,
    // The REAL 2.1.231 labels — NOT the master plan's "auto-accept / manual /
    // keep planning" phrasing, which a0 §3 corrected against the capture.
    options: [
      {
        label: 'Yes, and use auto mode',
        tuiIndex: 0,
        // a0 §3: "1 → `⏵⏵ auto mode on`, execution with NO permission dialogs."
        // Accept-session, not accept: it also grants everything that follows.
        actOn: true,
        effect: 'accept-session',
        rowPattern: /^yes, and use auto mode$/i,
      },
      {
        label: 'Yes, manually approve edits',
        tuiIndex: 1,
        // a0 §3: "2 → `⏸ manual mode on`, execution immediately raises Edit
        // permission dialogs" — which the permission entries above then cover.
        actOn: true,
        effect: 'accept',
        rowPattern: /^yes, manually approve edits$/i,
      },
      {
        label: 'Tell Claude what to change',
        tuiIndex: 2,
        // a0 §3: "3 → dismissed, plan re-boxed in scrollback, STILL `⏸ plan
        // mode on`, feedback via normal composer (verified round-trip: dialog
        // re-presented)." The sub-hint `shift+tab to approve with this feedback`
        // folds into this row in the capture; the pattern is prefix-anchored.
        actOn: true,
        effect: 'feedback',
        rowPattern: /^tell claude what to change\b/i,
      },
    ],
    escape: {
      label: 'Say something instead',
      // a0 §3, verbatim: "Esc: UNVERIFIED (skipped for interference risk;
      // expected ≈ option 3) — A4 self-test must capture it before the registry
      // maps it." T11 is that self-test; until its capture lands as a fixture
      // this stays off, and option 3 is the verified way to say the same thing.
      actOn: false,
      disabledReason:
        'Esc has never been captured on a plan dialog, so what it does here is a guess. “Tell Claude what to change” is the verified way to send feedback.',
      effect: 'feedback',
    },
  },
]

/** family (+variant) → the entry that covers it, or null.
 *
 *  A permission sighting with NO variant (the title scrolled out of the 60-line
 *  window) resolves to nothing on purpose: the three variants differ in what
 *  option 2 grants, so "some permission dialog" is not enough to press a key
 *  into. The caller raises `dialog-unmapped` and shows the capture instead. */
export function entryForSighting(sighting: DialogSighting): RegistryEntry | null {
  return (
    ENTRIES.find(
      (e) => e.family === sighting.family && e.variant === sighting.variant,
    ) ?? null
  )
}

export function entryById(id: RegistryId): RegistryEntry | null {
  return ENTRIES.find((e) => e.id === id) ?? null
}
