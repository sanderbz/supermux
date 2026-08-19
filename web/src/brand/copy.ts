// Microcopy — every empty / error / confirm string in one place, in one
// voice.
//
// B5/T11.3 swept the dead keys out: `CONNECTION` (zero importers — the chat
// surface uses its own `CHAT_CONNECTION`), three `CONFIRM` entries, five
// `ERROR` entries and three `EMPTY` entries that no surface rendered while
// inlining their own strings instead. Dead copy is worse than missing copy: it
// makes this file look like more coverage than exists, and nobody reviews a
// string that is never on screen. Later milestones import from here instead of inlining strings, so the
// voice stays consistent and a single edit fixes it everywhere.
//
// VOICE: builder-to-builder. Calm, direct, lowercase-friendly, technically
// precise. We assume the reader runs agents in tmux and reads stack traces.
//   - No cheerleading interjections (the banned list lives in BRAND.md and is
//     enforced by scripts/lint-microcopy.sh).
//   - No exclamation marks. State the fact, then the next action.
//   - No marketing ("control plane", "mission control", "supercharge").
//   - Errors name what failed and what to do — not "Something went wrong".
//   - Sentence case for everything. Never UPPERCASE labels.
// See web/src/brand/BRAND.md and scripts/lint-microcopy.sh (CI gate).

export interface EmptyCopy {
  title: string
  body: string
  cta?: string
}

export interface ErrorCopy {
  title: string
  body: string
  retry?: string
}

export interface ConfirmCopy {
  title: string
  body: string
  confirm: string
  cancel: string
}

// ── Per-surface empty states ──────────────────────────────────────────────────

export const EMPTY = {
  /** Renamed from `EMPTY.board` in fase B2 T10: the issues are no longer "on a
   *  board", they are on a session and on a team. The copy was dead code before
   *  (nothing rendered it); it is adopted by `components/issues/issue-list.tsx`
   *  rather than deleted. */
  issues: {
    title: 'No issues yet',
    body: 'Issues linked to this session show up here — an agent reports onto them with /supermux-task.',
    cta: 'New issue',
  },
  scheduler: {
    title: 'No scheduled jobs',
    body: 'Schedule a job to boot an agent or send a command on a cron expression.',
    cta: 'New job',
  },
  stoppedSession: {
    title: 'This session is stopped',
    // Runtime-NEUTRAL on purpose. supermux has shipped a tmux-less native
    // runtime as the default since v0.5.0, so every session on a current
    // install reports `runtime: native` and this card was naming a mechanism
    // that is not there — the user's mental model gets one word about a thing
    // they never chose. Branching the sentence on `runtime` was the other
    // option and is worse: two strings to keep true, for a distinction that
    // changes nothing about what to do next.
    body: 'Its process is no longer running — likely after a restart. Start it again to reattach the live terminal.',
    cta: 'Start session',
  },
} satisfies Record<string, EmptyCopy>

// ── Error states ──────────────────────────────────────────────────────────────

export const ERROR = {
  sessionMissing: {
    // Same reason as `stoppedSession` above: the native runtime is the default,
    // so "tmux" named a mechanism most installs do not run.
    title: 'Session is gone',
    body: 'supermux can’t find the underlying session. Reattach, or remove it from supermux.',
    retry: 'Reattach',
  },
} satisfies Record<string, ErrorCopy>

// ── Confirm dialogs (destructive + irreversible) ───────────────────────────────

export const CONFIRM = {
  killSession: {
    title: 'Kill this session?',
    body: 'The agent stops and its terminal ends. Unsaved work in the pane is lost.',
    confirm: 'Kill session',
    cancel: 'Keep running',
  },
  deleteSession: {
    title: 'Remove from supermux?',
    body: 'This drops the session from supermux. The running terminal itself is left alone.',
    confirm: 'Remove',
    cancel: 'Cancel',
  },
  deleteSchedule: {
    title: 'Delete this job?',
    body: 'The schedule stops and won’t run again. Past runs stay in the log.',
    confirm: 'Delete',
    cancel: 'Cancel',
  },
  // B5/T5.3 — archiving a session that is still running. Hoisted out of
  // `use-session-actions.ts`, where it lived as an inline string, so the
  // archive/schedule contract sentence below can be appended from ONE place
  // and stay identical to the Archived sheet's (§15.5: "blocked things state
  // why with the same sentence everywhere").
  archiveRunningSession: {
    title: 'Archive this running session?',
    body: 'The agent stops, the terminal session ends, and the tile leaves the overview. You can restore it from the Archived sheet.',
    confirm: 'Archive',
    cancel: 'Keep running',
  },
  // mode-shift: bypass is launch-only, so switching to it RESTARTS the session.
  switchToBypass: {
    title: 'Switch to Bypass permissions?',
    body: 'Bypass mode is launch-only, so the session restarts cleanly — it resumes the same conversation. While bypassed, the agent skips every permission prompt.',
    confirm: 'Restart in Bypass',
    cancel: 'Cancel',
  },
} satisfies Record<string, ConfirmCopy>

/** Team-lead-aware variant of `killSession`. A team's teammates are tmux
 *  split-panes INSIDE the lead's `supermux-<lead>` session, so stopping the lead
 *  already ends the whole team (window + every teammate pane) — there is no
 *  separate kill. The user just isn't told that, so when the session being
 *  stopped IS a team lead we extend the confirm copy to say it plainly. Calm,
 *  factual, never alarmist — same voice as `killSession`, just team-aware.
 *  `teammateCount` is the number of teammates that go down with the lead. */
export function killTeamLeadConfirm(teammateCount: number): ConfirmCopy {
  const crew =
    teammateCount === 1 ? '1 teammate' : `${teammateCount} teammates`
  return {
    title: 'Stop this team’s lead?',
    body:
      teammateCount > 0
        ? `This is a team lead. Stopping it ends the whole team — the agent stops, the tmux session ends, and its ${crew} (split panes in the same window) stop with it. Unsaved work in those panes is lost.`
        : 'This is a team lead. The agent stops and the tmux session ends, which closes the team. Unsaved work in the pane is lost.',
    confirm: 'Stop team',
    cancel: 'Keep running',
  }
}

// ── Lifecycle contracts (B5) ──────────────────────────────────────────────────

/** The one-sentence contracts behind supermux's lifecycle verbs. Each string
 *  here has MORE THAN ONE call site by design — that is the whole point. §15.5
 *  asks that a blocked or surprising thing "state why with the same sentence
 *  everywhere", so the sentence lives here and the surfaces import it rather
 *  than each inventing its own phrasing and drifting apart.
 *
 *  `BRAND.md` §6h carries the full verb-by-verb table; these are the strings
 *  that table describes, and a change to one is a diff in both. */
export const LIFECYCLE = {
  /** B5/T5 — the archive/schedule contract, chosen at gate G4 (option a).
   *  Rendered by BOTH the archive confirm and the Archived sheet. Before B5
   *  the scheduler was archive-blind and an archived session was silently
   *  restarted by its own schedule while staying hidden from the overview;
   *  now archiving pauses the schedules and unarchiving resumes them, with
   *  nothing mutated on the schedule rows. */
  archivePausesSchedules:
    'Scheduled jobs on an archived session are paused, and start running again when you restore it.',

  /** B5/T7.3 — archive named as the undo window §15.3 asks for. It always WAS
   *  the undo; it was simply never called one, so users reached for it without
   *  knowing it was reversible (and reached past it for things that were not). */
  archiveIsTheUndo:
    'Archiving is reversible — restore a session any time from the Archived sheet.',

  /** B5/T7.2 — the single most important sentence in the delete dialog. It is
   *  first in the disposition table below and repeated here because it is the
   *  fact users are most surprised by: supermux removes its own record of a
   *  session, never your code. */
  /** B5/T6.5 — the honest description of what "duplicate" produces.
   *
   *  `duplicate` copies `worktree`/`worktree_repo` as STRINGS and creates no
   *  git worktree: the copy lands in the SOURCE'S directory. Leaving those
   *  columns to imply a worktree that does not exist is the dishonesty §15.1
   *  objects to, so the UI says where the copy actually goes — and, since
   *  B5/T6.2, that its scheduled jobs come along switched off. */
  duplicateIsATemplate:
    'The copy runs in this same directory, and starts out with this agent\u2019s settings. Its scheduled jobs are copied but switched off.',

  purgeLeavesYourFilesAlone:
    'Your working directory, git branch and worktree are never touched — on archive or on delete.',
} as const

/** B5/T7.2 — what each destructive verb actually disposes of, as DATA.
 *
 *  R3 is that this dialog "becomes a lie the moment the handler changes": the
 *  most surprising facts live in copy, not in code. The mitigation is that the
 *  disposition is asserted from both ends — `server/tests/delete_disposition.rs`
 *  asserts the behaviour, and `web/tests/unit/delete-honesty.test.tsx` asserts
 *  that every row here reaches the screen. A handler change that forgets the
 *  copy fails CI on one side or the other.
 *
 *  Ordered most-surprising-first, which is also least-destructive-sounding
 *  first — the two happen to agree here. */
export const PURGE_DISPOSITION = [
  {
    thing: 'Working directory, branch, worktree',
    archive: 'Untouched',
    purge: 'Untouched',
  },
  { thing: 'The session in supermux', archive: 'Hidden, restorable', purge: 'Deleted' },
  {
    thing: 'Conversation, tracked files, share links',
    archive: 'Kept',
    purge: 'Deleted',
  },
  { thing: 'Scheduled jobs', archive: 'Paused', purge: 'Stopped for good' },
  { thing: 'Past schedule runs', archive: 'Kept', purge: 'Kept in the log' },
  { thing: 'Scrollback', archive: 'Saved to a file', purge: 'Deleted' },
] as const satisfies readonly {
  thing: string
  archive: string
  purge: string
}[]

/** B5/T8 — the recovery ladder's vocabulary.
 *
 *  Every rung is named by WHAT IT PRESERVES, not by its mechanism. "Restart"
 *  and "Reset" mean nothing to someone deciding under pressure whether they are
 *  about to lose a conversation; "keeps your scrollback" and "clears the
 *  conversation" do. The `destroys` half is never softened — it is the sentence
 *  that prevents regret, and hiding it would make the ladder a trap.
 *
 *  Blocked rungs state WHY with the same sentence in both places they appear
 *  (§15.5): the inline affordance on a dead tile, and the canonical list in
 *  Settings. `BRAND.md` §6h carries the full table. */
export const RECOVERY = {
  recover: {
    label: 'Recover terminal',
    preserves: 'Keeps your scrollback and conversation.',
    destroys: 'Nothing else changes.',
  },
  restart: {
    label: 'Restart session',
    preserves: 'Keeps the conversation, worktree and scheduled jobs.',
    destroys: 'The live terminal and anything only on screen are lost.',
  },
  reset: {
    label: 'Reset session',
    preserves: 'Keeps the working directory, worktree, scheduled jobs and settings.',
    destroys: 'The conversation, scrollback and activity are cleared.',
  },
  /** One string, two call sites — the inline action and the Settings list. */
  recoverBlocked:
    'Recovering in place works on local sessions running the built-in terminal. Restart works everywhere.',
  /** Shown when the server answered but named no reason — should not happen. */
  outcomeFallback: 'Nothing to recover.',
  restartDone: 'Session restarted.',
  resetDone: 'Session reset. Start it to begin a fresh conversation.',
  failed: 'That did not work.',
  /** The automatic layer, which had no UI at all before B5. */
  autoHealLabel: 'Recover a terminal that dies on its own',
  autoHealHint:
    'When a session\u2019s terminal dies unexpectedly, bring it back automatically. Retries are rate-limited, and a session you stopped yourself is never restarted.',
} as const

// ── Connection / status banner ────────────────────────────────────────────────

/**
 * Subagents, said out loud (fase A6 T4.1).
 *
 * The chat surface does not render subagent turns — that is a decision (a
 * subagent voice would be a new chat primitive, and the vocabulary is closed),
 * not an oversight. What A6 would not accept is the state it found: during a
 * five-way `Task` fan-out the surface showed a spinner and a bare `· N
 * subagents` and nothing else, while the terminal showed the work — with no
 * statement anywhere that the content was deliberately elsewhere.
 *
 * A count is not a statement. This is.
 */
export const SUBAGENTS = {
  /** Appended to the working row's clause when a fan-out is running. */
  elsewhere: 'their work shows in the terminal',
} as const

/**
 * The chat data plane's four words, and no surface may invent a fifth
 * (fase A6 T2.6). The same vocabulary is the type in
 * `components/chat/connection.ts`, and the contract is written out in
 * `BRAND.md` §6f.
 *
 * `live` has no copy on purpose: the healthy state is silence. A chip that
 * says "Live" on every screen is wallpaper within a day, and then the day it
 * says something else nobody reads it.
 */
export const CHAT_CONNECTION = {
  reconnecting: { label: 'Reconnecting…', why: 'Reconnecting' },
  stale: { label: 'Not up to date', why: 'No update for a while' },
  offline: { label: 'Offline', why: 'The live connection gave up — tap to try again' },
} as const

/** The half of the sentence that is the same in all three, said once. It is
 *  also the half that matters most: the server's contract is that the
 *  transcript STAYS, and a user who is not told that reads a stale transcript
 *  as a current one. */
export const CHAT_CONNECTION_STAYS = '. What is on screen stays, but it is not up to date.'

// ── Toast presets (short, neutral confirmations) ──────────────────────────────

export const TOAST = {
  sessionStarted: 'Session started',
  sessionStopped: 'Session stopped',
  copied: 'Copied to clipboard',
  fileSaved: 'File saved',
  issueStarted: 'Agent started',
  jobScheduled: 'Job scheduled',
  needsInput: 'Needs input',
} as const

// ── Onboarding / first-60-seconds ─────────────────────────────────────────────

export const ONBOARDING = {
  /** Returning v2 user — `{n}` is replaced with the migrated session count. */
  welcomeBack: (n: number) =>
    n === 1
      ? 'Welcome back. Your session is here.'
      : `Welcome back. Your ${n} sessions are here.`,
  /** Grok/bot-mode twin of `welcomeBack`. Same message, the roster's noun
   *  ("bots") — so the banner never says "sessions" while the header beside it
   *  reads "N bots · M need you". Base app (grok off) keeps `welcomeBack`. */
  welcomeBackBots: (n: number) =>
    n === 1
      ? 'Welcome back. Your bot is here.'
      : `Welcome back. Your ${n} bots are here.`,
  welcomeBackHint: 'Take the 30-second tour of what moved.',
  tourStart: 'Take the tour',
  tourSkip: 'Skip',
  tourDone: 'Got it',
  /** 4-step tour copy — anchored to a tile, the focus button, Settings (where
   *  schedules now live), then the create menu. */
  tour: [
    {
      title: 'Peek without leaving',
      body: 'Hover a tile to grow its live terminal preview. Read what an agent is doing at a glance.',
    },
    {
      title: 'Focus on one agent',
      body: 'Tap a tile to take over its terminal. Every keystroke goes straight to tmux.',
    },
    {
      title: 'Schedule the routine',
      body: 'Schedules live in Settings now — boot agents or send commands on a cron expression. Set it once, walk away.',
    },
    {
      title: 'Start another agent',
      body: 'Use New session to pick Claude or Codex, choose a directory, and boot another tmux-backed workspace.',
    },
  ],
  /** Fresh install — the secondary demo CTA under the empty-state primary. */
  demoCta: 'Boot a demo agent',
  demoHint: 'See supermux work — a code-reviewer agent runs in this directory.',
  demoBooting: 'Booting demo…',
  /** Settings → Onboarding. */
  replayLabel: 'Run the 30-second demo',
  replayHint: 'Clear the demo session and replay the first-run experience.',
  replayAction: 'Replay',
} as const

// ── Misc chrome ───────────────────────────────────────────────────────────────

export const MISC = {
  /** Tile pill shown when a session is blocked on the user. */
  needsInputPill: 'Needs input',
  /** Loading placeholder. */
  loading: 'Loading…',
  /** Settings → Appearance toggle for the audio cue. */
  soundsToggleLabel: 'Sound cue when an agent needs input',
  soundsToggleHint: 'Plays a short tone on transition to “needs input”. Off by default.',
  /** New-session sheet subtitle. Lives here rather than inline in the sheet so
   *  it is covered by the same voice rules as everything else — it used to read
   *  "Boot an agent in tmux. It survives restarts.", naming a runtime that has
   *  not been the default since v0.5.0. What the sentence is FOR is that the
   *  agent outlives the browser tab, which is true on either runtime. */
  newSessionSubtitle: 'Boot an agent. It keeps running after you close the tab.',
} as const
