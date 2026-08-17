// The modal registry — the data file (fase A4 T6).
//
// FIVE families now, each carrying its own evidence. This module is the list of
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
  | 'question.ask'
  | 'startup.trust'
  | 'startup.apikey'

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
  /**
   * This dialog draws BEFORE the boot banner, so the version pin cannot apply.
   *
   * The pin is normally the strongest guard in this file (`registry/index.ts`),
   * and exempting an entry from it is the sort of edit that has to justify
   * itself. The justification is structural rather than convenient: the trust
   * gate renders ABOVE the welcome box (capture:
   * `tests/fixtures/tui/startup/trust-folder.txt` has no `Claude Code vX.Y.Z`
   * line anywhere, because none has been printed yet), so `bannerVersion` is
   * necessarily null and the pin check necessarily fails. Keeping it would not
   * make anything safer — it would make the card permanently unanswerable, i.e.
   * it would reproduce exactly the wedge this entry exists to unblock.
   *
   * What replaces it is a NARROWER fingerprint: the entries below that claim the
   * exemption pin every one of their rows to an exact sentence, so a Claude Code
   * that reworded the gate degrades through `shapeHolds` instead.
   */
  pinExempt?: boolean
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

/**
 * 2.1.233 — the third live re-verification, 2026-08-16.
 *
 * Same playbook, same discipline: session `spike-233-capture` booted
 * `Claude Code v2.1.233` (`tests/fixtures/tui/cc233/00-boot-banner.txt`), every
 * family was re-captured verbatim with the caret at each row, and every entry
 * below was then DRIVEN by `answerDialog()` itself — the shipped sequencer wired
 * to `GET /peek` and `POST /keys`, so each key was chosen by this branch's code.
 * Index, per-case verdicts and the side-effect proofs:
 * `tests/fixtures/tui/cc233/README.md`.
 *
 *   permission.bash   opt 3 denied (`⎿ Interrupted`, artifact ABSENT) ·
 *                     opt 1 executed (artifact present)
 *   permission.write  opt 2 wrote the file AND flipped `⏵⏵ accept edits on`
 *   permission.edit   Esc denied (file unchanged on disk)
 *   plan.approval     opt 2 → `⏸ manual mode on`, execution resumed
 *
 * WHAT CHANGED IN 2.1.233 — one row, and it is the row nobody presses. The Bash
 * variant's option 2 is no longer one sentence: the same dialog now prints three
 * different grants depending on what the command touches (see
 * `BASH_ALWAYS_ALLOW` below). Options 1 and 3, the footer's caret dependence, all
 * three Write/Edit rows and all three plan rows are byte-identical to 2.1.232.
 */
const CC233 = '2.1.233'

/** a0 §3, Family 1: "Pinned v2.1.227, Bash variant re-verified structurally
 *  identical v2.1.231." The Bash capture therefore holds on both; the Edit
 *  capture in `tests/fixtures/tui/` is recorded at 2.1.231 and the Write one at
 *  2.1.227, so each variant pins exactly what its own bytes prove. Widening a
 *  list without a new capture is the one edit this file forbids. */
const PERMISSION_BASH_VERSIONS = ['2.1.227', '2.1.231', A4C, CC233] as const
const PERMISSION_EDIT_VERSIONS = ['2.1.231', A4C, CC233] as const
const PERMISSION_WRITE_VERSIONS = ['2.1.227', A4C, CC233] as const
/** a0 §3, Family 2 (ExitPlanMode): pinned v2.1.231. */
const PLAN_VERSIONS = ['2.1.231', A4C, CC233] as const

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

/**
 * Row 2 of the BASH permission dialog — the one row this registry deliberately
 * cannot pin to a sentence.
 *
 * On 2.1.233 the same dialog prints three different grants, chosen by what the
 * command touches. All three captured live in one session, one afternoon
 * (`tests/fixtures/tui/cc233/`, files named beside each form):
 *
 *   `Yes, and always allow access to spike-233/ from this project`
 *        — 01-bash-access-caret1.txt (`touch <file in project>`)
 *   `Yes, allow reading from etc/ from this project`
 *        — 05-bash-read-caret1.txt   (`sha256sum /etc/hostname`)
 *   `Yes, and don’t ask again for: python3 *`
 *        — 06-bash-cmdrule-caret1.txt (`python3 -c …`, with a new body line
 *          `This command requires approval` above the question)
 *
 * So the pattern is `^yes\b` and no narrower. That is a WEAKER identity claim
 * than every other row in this file, and it is the right one *for this row only*
 * because of what the claim is FOR: `rowPattern` exists so a key is never pressed
 * into a row that stopped being the option it was read as. No key is ever pressed
 * into this one (`actOn: false`, below, on all of them). What a narrow pattern
 * buys here is therefore nothing — and what it costs is the whole card: a copy
 * change on row 2 fails `shapeHolds`, which disables options 1 and 3 as well, and
 * chat goes inert on a dialog it can read perfectly well. That is exactly what
 * 2.1.233 did to the 2.1.232 pattern (`^yes, and always allow`) the moment a
 * command asked to read a file.
 *
 * The guards that actually stop a mis-answer are untouched and still exact: row 1
 * must be `Yes`, row 3 must be `No`, the count must be 3, and the sighting must
 * still carry the `bash` title. A list that gained, lost or reworded a row fails
 * on those, in `shapeHolds` and again in `continues()` mid-sequence.
 */
const BASH_ALWAYS_ALLOW = /^yes\b/i

/** The sentence a gate wears when this app has read it from Claude Code's own
 *  strings rather than from a capture of the dialog on a screen. */
const UNCAPTURED_GATE =
  'This gate has never been captured on a live screen, only read out of Claude Code’s own strings — so chat will not press a key into it. Note that the terminal’s own default here is “No (recommended)”: pressing Enter DECLINES the key.'

/* ── AskUserQuestion: the one family whose rows are the MODEL'S ─────────────
 *
 * Every other entry in this file pins its rows to a sentence Claude Code ships.
 * AskUserQuestion's rows are written by the model, per question — `Apple`,
 * `Pear`, `Deploy to staging first` — so a static `rowPattern` is not merely
 * unavailable here, it is the wrong shape of claim.
 *
 * WHAT THE PIN IS FOR tells us what to put in its place. `rowPattern` exists so
 * a key is never pressed into a row that stopped being the option the user read
 * (`registry/index.ts`, `shapeHolds`). For a dynamic list the equivalent claim is
 * "this row still says what it said when the card was drawn", and it is
 * derivable: the entry is BUILT FROM THE SIGHTING, and each row is pinned to its
 * own literal text. The identity checks around it are unchanged and are what do
 * the real work — `sightingKey` is the option list, `continues()` re-checks
 * every row and the row COUNT between every key, and a list that gained, lost or
 * reworded a row still aborts the sequence with the keys sent so far recorded.
 *
 * WHAT IS SAFE HERE THAT IS NOT SAFE ON A PERMISSION DIALOG: nothing hides in
 * row 2. Every row of an AskUserQuestion answers the same question with a
 * different label — there is no `and don't ask again`, no persistent grant, no
 * mode flip. The consequence of pressing the wrong one is a wrong answer the
 * user can see and correct, not a rule written into their repo.
 *
 * TWO ROWS ARE STILL REFUSED, both because nobody has captured what they do:
 *   · `N. Type something.` opens a free-text field INSIDE the dialog — a second
 *     screen this app has never seen. The composer is the verified way to send a
 *     sentence (see `question.ask`'s escape note), so the card points there.
 *   · `N. Chat about this`, the out-of-box row below the dialog's rule, is not
 *     an option at all and never reaches this function: `peek-lens.ts` cuts the
 *     list at the rule.
 *
 * LIVE SELF-TEST, 2026-08-17 — the same bar the permission entries cleared.
 *
 * Capture: `server/tests/fixtures/pty/ask-user-question.txt` (session `vx-chat`,
 * Claude Code 2.1.233). The entry was then DRIVEN on a second, freshly booted
 * session on a throwaway instance, with every key chosen by this branch's own
 * code — `readLens` → `entryFor` → `dialogCardView` → `answerDialog`, wired to
 * `GET /peek` and `POST /keys`:
 *
 *   the lens read   family `question` · header `Fruit choice` · question
 *                   "Which fruit do you want?" · rows [Apple, Banana, Cherry,
 *                   Type something.] · descriptions split off each label ·
 *                   caret 0 · freeTextIndex 3 · pin 2.1.233
 *   the card        `question.ask`, not degraded, three rows act-on, the
 *                   free-text row drawn and refused
 *   the sequence    caret on row 2 → target row 3 → sent [Down, Enter]
 *   the proof       the transcript's SIBLING `toolUseResult`:
 *                   `"answers": {"Which fruit do you want?": "Cherry"}`
 *
 * The target is deliberately never row 1: the caret starts there, so a dialog
 * that merely swallowed the Enter would also answer "Apple". Answering the row
 * the caret was NOT on is what makes the result evidence rather than a
 * coincidence, and the run above started from row 2 and landed on row 3.
 *
 * That run is also what found the caret settle in `dialog-answer.ts`: the first
 * re-peek after `Down` still showed the caret on the row it had left.
 */
const ASK_QUESTION_VERSIONS = ['2.1.233'] as const

/** The free-text hatch — a row this app renders and refuses. */
const FREE_TEXT_ROW = /^type something\.?$/i

/** A literal row, as a prefix-anchored pattern. Whitespace-normalised on both
 *  sides, because the sighting's rows already are. */
function literalRow(text: string): RegExp {
  return new RegExp(`^${text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'i')
}

function questionEntry(sighting: DialogSighting): RegistryEntry | null {
  // A question with one row is not a choice, and a sighting whose rows scrolled
  // out is not one this app can key into.
  if (sighting.options.length < 2) return null
  return {
    id: 'question.ask',
    family: 'question',
    verifiedVersions: ASK_QUESTION_VERSIONS,
    options: sighting.options.map((label, i) => {
      const free = FREE_TEXT_ROW.test(label)
      return {
        label,
        tuiIndex: i,
        actOn: !free,
        disabledReason: free
          ? 'This row opens a text field inside the dialog, which chat has never captured. Type the answer in the composer instead — Claude Code matches it against the option labels.'
          : undefined,
        // Answering a question grants nothing and changes no mode: it is the
        // narrowest effect this vocabulary has.
        effect: 'accept' as const,
        rowPattern: literalRow(label),
      }
    }),
    escape: {
      label: 'Say something instead',
      // Esc on an AskUserQuestion has never been captured. The footer says
      // `Esc to cancel`, and what a cancelled tool call does to the turn is
      // precisely the thing nobody has watched — so the card renders it,
      // disabled, and names the affordance that IS verified.
      actOn: false,
      disabledReason:
        'What Esc does to an open question has never been captured. Type in the composer instead: Claude Code matches free text against the option labels.',
      effect: 'feedback',
    },
  }
}

/* ── the startup gates ───────────────────────────────────────────────────── */

/**
 * The workspace trust gate — the startup wedge, and the one place in this file
 * where a card is the ONLY affordance a user has.
 *
 * Everything else in this registry has a fallback: the transcript renders the
 * conversation, the roster shows a status, the terminal is one tap away. This
 * dialog blocks before the first transcript line exists, so a session sitting on
 * it reads as `Starting` and then `Idle` with a green dot, forever, on every
 * surface (catalog `perm.trust_folder`).
 *
 * Capture: `tests/fixtures/tui/startup/trust-folder.txt`, verbatim from the
 * production spool `~/.supermux/native/spike-a0-trust/out.raw` — the raw bytes
 * carry the pre-accept frame (`❯ 1. Yes, I trust this folder` / `2. No, exit`)
 * before the accept repaint overwrites it.
 *
 * ESC IS NOT MAPPED, and that is a finding rather than caution: a second Esc
 * EXITS THE PROCESS (catalog: "NEVER auto-send Esc — a second Esc exits"), and
 * issue #75649 records the session hanging on Esc right after this dialog.
 * `2. No, exit` is the row that says no, and it says what it does.
 */
const TRUST_ENTRY: RegistryEntry = {
  id: 'startup.trust',
  family: 'startup',
  variant: 'trust',
  // Pinned to the capture's own binary. The exemption below is what makes the
  // card answerable at all — see `pinExempt`.
  verifiedVersions: ['2.1.227', '2.1.231', '2.1.232', '2.1.233'],
  pinExempt: true,
  options: [
    {
      label: 'Yes, I trust this folder',
      tuiIndex: 0,
      // Verified by side effect: this is the row the production spool's own
      // accept frame confirms (`Yes, I trust this folder ✔` drawn in green,
      // then the welcome box). It grants exactly what the dialog's body
      // enumerates, which the card shows verbatim.
      actOn: true,
      effect: 'accept',
      rowPattern: /^yes, i trust this folder$/i,
    },
    {
      label: 'No, exit',
      tuiIndex: 1,
      // Honest about the consequence: this row does not decline and continue,
      // it ENDS the session. That is Claude Code's own wording and this app
      // does not soften it.
      actOn: true,
      effect: 'deny',
      rowPattern: /^no, exit$/i,
    },
  ],
  escape: {
    label: 'Answer in the terminal',
    actOn: false,
    disabledReason:
      'Esc here is how this dialog is known to wedge a session (a second Esc exits Claude Code outright), so chat never sends it. “No, exit” is the captured way to decline.',
    effect: 'deny',
  },
}

/**
 * The custom-API-key gate — FINGERPRINTED, DELIBERATELY UNANSWERABLE.
 *
 * There is no local capture of this dialog: the catalog carries it from a
 * binary-strings sweep (`sweep2:apikey.approval_prompt`), and its fixture is
 * marked `synthesized: true` for that reason. So it gets the treatment this
 * file's rule prescribes — rendered, readable, and pressing nothing.
 *
 * It earns an entry anyway rather than falling to `dialog-unmapped`, because the
 * two things the card can say without a capture are the two things that matter:
 * WHICH gate this is (a session that looks hung is actually asking about a key),
 * and that the focus DEFAULTS TO `No (recommended)` — so a user who reaches for
 * the terminal and taps Enter declines the key they meant to approve.
 */
const APIKEY_ENTRY: RegistryEntry = {
  id: 'startup.apikey',
  family: 'startup',
  variant: 'apikey',
  verifiedVersions: [],
  pinExempt: true,
  options: [
    {
      label: 'Yes',
      tuiIndex: 0,
      actOn: false,
      disabledReason: UNCAPTURED_GATE,
      effect: 'accept',
      rowPattern: /^yes\b/i,
    },
    {
      label: 'No (recommended)',
      tuiIndex: 1,
      actOn: false,
      disabledReason: UNCAPTURED_GATE,
      effect: 'deny',
      rowPattern: /^no\b/i,
    },
  ],
  escape: {
    label: 'Answer in the terminal',
    actOn: false,
    disabledReason: UNCAPTURED_GATE,
    effect: 'deny',
  },
}

export const ENTRIES: readonly RegistryEntry[] = [
  permissionEntry('permission.bash', 'bash', PERMISSION_BASH_VERSIONS, {
    // The fallback words only — the live row wins in `optionLabel()`, and on
    // 2.1.233 the live row is the ONLY honest description of this grant (see
    // `BASH_ALWAYS_ALLOW`). Everything variable stays out of the label: the
    // directory, the command pattern, the verb.
    label: 'Yes, and don’t ask again',
    tuiIndex: 1,
    // STILL false, and now for a stronger reason than a0's "persistence NOT
    // FOUND". 2.1.233 was driven end to end (`cc233/README.md` §option-2
    // semantics) and the answer is that this ONE row does TWO different things:
    //
    //   `don’t ask again for: python3 *` → writes `"Bash(python3 *)"` into
    //      <project>/.claude/settings.local.json `permissions.allow`
    //      (cc233/10-optsem-cmdrule-98-artifact.txt) — a rule on DISK, in the
    //      user's repo, that outlives the session and the next `python3` command
    //      ran with no prompt at all (11-optsem-cmdrule-99-rule-applies.txt);
    //   `always allow access to <dir>/` → writes NOTHING, and instead flips the
    //      whole session into `⏵⏵ accept edits on`
    //      (cc233/12-optsem-access-98-artifact.txt).
    //
    // Neither is what this file's vocabulary can say. `accept-session` — the
    // widest word it has — would render as “Allowed for this session”
    // (`resolutionLine`), which for the first form is simply false: the grant is
    // still there tomorrow, in a file the user may well commit. Chat does not get
    // to describe a persistent grant as a temporary one, so chat does not press
    // this row.
    actOn: false,
    disabledReason:
      'This row grants more than one thing on 2.1.233 — for a command pattern it writes a permanent rule into this project’s .claude/settings.local.json, for a directory it switches the whole session to auto-accept. Chat has no honest way to say which, so choose it in the terminal if you mean it.',
    effect: 'accept-session',
    rowPattern: BASH_ALWAYS_ALLOW,
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

  TRUST_ENTRY,
  APIKEY_ENTRY,
]

/** family (+variant) → the entry that covers it, or null.
 *
 *  A permission sighting with NO variant (the title scrolled out of the 60-line
 *  window) resolves to nothing on purpose: the three variants differ in what
 *  option 2 grants, so "some permission dialog" is not enough to press a key
 *  into. The caller raises `dialog-unmapped` and shows the capture instead.
 *
 *  `question` is the one family whose entry is DERIVED rather than looked up —
 *  its rows are the model's, not Claude Code's (see `questionEntry`). */
export function entryForSighting(sighting: DialogSighting): RegistryEntry | null {
  if (sighting.family === 'question') return questionEntry(sighting)
  return (
    ENTRIES.find(
      (e) => e.family === sighting.family && e.variant === sighting.variant,
    ) ?? null
  )
}

export function entryById(id: RegistryId): RegistryEntry | null {
  return ENTRIES.find((e) => e.id === id) ?? null
}
