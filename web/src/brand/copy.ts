// Microcopy (M28) — every empty / error / confirm string in one place, in one
// voice. Later milestones import from here instead of inlining strings, so the
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
  sessions: {
    title: 'No sessions yet',
    body: 'Start one to put an agent to work. It runs in tmux and survives restarts.',
    cta: 'New session',
  },
  board: {
    title: 'No issues on the board',
    body: 'Add a task here and an agent can claim it.',
    cta: 'New issue',
  },
  files: {
    title: 'Nothing here',
    body: 'This directory is empty. Pick another path from the breadcrumb.',
  },
  scheduler: {
    title: 'No scheduled jobs',
    body: 'Schedule a job to boot an agent or send a command on a cron expression.',
    cta: 'New job',
  },
  search: {
    title: 'No matches',
    body: 'Nothing matched that filter. Try a shorter query.',
  },
  stoppedSession: {
    title: 'This session is stopped',
    body: 'Its tmux session is no longer running — likely after a restart. Start it again to reattach the live terminal.',
    cta: 'Start session',
  },
} satisfies Record<string, EmptyCopy>

// ── Error states ──────────────────────────────────────────────────────────────

export const ERROR = {
  generic: {
    title: 'That request failed',
    body: 'The server returned an error. Check the logs, then try again.',
    retry: 'Try again',
  },
  network: {
    title: 'Can’t reach the server',
    body: 'No response from amux-server. It may be restarting or off the network.',
    retry: 'Retry',
  },
  notFound: {
    title: 'Not found',
    body: 'This no longer exists. It may have been deleted or renamed.',
  },
  sessionMissing: {
    title: 'tmux session is gone',
    body: 'amux can’t find the underlying tmux session. Reattach, or remove it from amux.',
    retry: 'Reattach',
  },
  unauthorized: {
    title: 'Not authorized',
    body: 'Your token was rejected. Reopen amux from a trusted link to refresh it.',
  },
  fileTooLarge: {
    title: 'File is too large to open',
    body: 'This file exceeds the inline edit limit. Open it in the terminal instead.',
  },
} satisfies Record<string, ErrorCopy>

// ── Confirm dialogs (destructive + irreversible) ───────────────────────────────

export const CONFIRM = {
  killSession: {
    title: 'Kill this session?',
    body: 'The agent stops and the tmux session ends. Unsaved work in the pane is lost.',
    confirm: 'Kill session',
    cancel: 'Keep running',
  },
  deleteSession: {
    title: 'Remove from amux?',
    body: 'This drops the session from amux. The tmux session itself is left alone.',
    confirm: 'Remove',
    cancel: 'Cancel',
  },
  deleteIssue: {
    title: 'Delete this issue?',
    body: 'The card and its history are removed. This can’t be undone.',
    confirm: 'Delete',
    cancel: 'Cancel',
  },
  deleteSchedule: {
    title: 'Delete this job?',
    body: 'The schedule stops and won’t run again. Past runs stay in the log.',
    confirm: 'Delete',
    cancel: 'Cancel',
  },
  discardEdits: {
    title: 'Discard changes?',
    body: 'You have unsaved edits in this file. Leaving drops them.',
    confirm: 'Discard',
    cancel: 'Keep editing',
  },
  overwriteFile: {
    title: 'Overwrite this file?',
    body: 'A file with this name already exists. Saving replaces its contents.',
    confirm: 'Overwrite',
    cancel: 'Cancel',
  },
} satisfies Record<string, ConfirmCopy>

// ── Connection / status banner ────────────────────────────────────────────────

export const CONNECTION = {
  reconnecting: 'Reconnecting…',
  connected: 'Back online',
  offline: 'Offline — tap to retry',
} as const

// ── Toast presets (short, neutral confirmations) ──────────────────────────────

export const TOAST = {
  sessionStarted: 'Session started',
  sessionStopped: 'Session stopped',
  copied: 'Copied to clipboard',
  fileSaved: 'File saved',
  issueClaimed: 'Issue claimed',
  jobScheduled: 'Job scheduled',
  needsInput: 'Needs input',
} as const

// ── Onboarding / first-60-seconds (M27) ───────────────────────────────────────

export const ONBOARDING = {
  /** Returning v2 user — `{n}` is replaced with the migrated session count. */
  welcomeBack: (n: number) =>
    n === 1
      ? 'Welcome back. Your session is here.'
      : `Welcome back. Your ${n} sessions are here.`,
  welcomeBackHint: 'Take the 30-second tour of what moved.',
  tourStart: 'Take the tour',
  tourSkip: 'Skip',
  tourDone: 'Got it',
  /** 3-step tour copy — anchored to a tile, the focus button, the scheduler. */
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
      body: 'Boot agents or send commands on a cron expression. Set it once, walk away.',
    },
  ],
  /** Fresh install — the secondary demo CTA under the empty-state primary. */
  demoCta: 'Boot a demo agent',
  demoHint: 'See amux work — a code-reviewer agent runs in this directory.',
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
} as const
