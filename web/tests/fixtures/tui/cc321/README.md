# CC 2.1.32x capture corpus — the fourth live re-verification

Claude Code **v2.1.321** (this directory) and **v2.1.322, v2.1.325, v2.1.326, v2.1.327, v2.1.329,
v2.1.331** (`v<NNN>/`), 2026-11-25. These are the versions production was actually running that day:
every bot on the Mac mini booted 2.1.321, and the Strato bots ran 2.1.322 to 2.1.331 (most of them
2.1.325). The registry was pinned to 2.1.227–2.1.233, so on every production bot chat drew permission
and plan dialogs with every button disabled.

## How it was captured

Same playbook as `../cc233/`: every family captured verbatim with the caret parked on each row, then
**driven** by the shipped sequencer (`answerDialog()` wired to `GET /peek` and `POST /keys`, every
key chosen by `dialog-answer.ts` reading `peek-lens.ts` and `registry/`). The pin was read off the
live boot banner (`peek?lines=10000`) in every run. It was never substituted.

What is new is the rig, because the standing rule for test agents is now a throwaway HOME, a throwaway
work dir and no real model:

- an **isolated supermux server** (own port, own data dir, own token, `env -i`) running a copy of the
  production server binary;
- the **real Claude Code binary** of each version: 2.1.321 from the mini's own install, and the others
  from Anthropic's release bucket (`downloads.claude.ai/claude-code-releases/<v>/darwin-arm64`). Each
  download was checked against the release manifest's SHA-256 and Anthropic's code signature;
- a **local fake Anthropic API** (`ANTHROPIC_BASE_URL`, dummy token) whose replies are scripted per
  scenario: `touch` inside the project, `head -1 /etc/hosts`, a `python3 -c` one-liner, a Write, a
  Read + Edit, and a plan file + `ExitPlanMode` in plan mode.

The tool calls therefore come from a script and not from a model. The dialogs do not depend on that:
Claude Code draws them itself around whatever tool call arrives, the same way it would for a model's
call.

Two settings matter, and both match production:

- **Auto mode is available** (not disabled), so the plan dialog keeps its first row,
  `Yes, and use auto mode`. Each session was started in manual mode: the boot-time question "Make auto
  mode your default permission mode?" was answered `No, keep manual mode`, and no test ever chose auto
  mode.
- **`noauto/`**: a second session per version in a work dir whose `.claude/settings.json` sets
  `permissions.disableAutoMode`. This is the shape a project with auto mode disabled sees. The
  supermux-ios test servers run this way.

## What changed since 2.1.233

| family | 2.1.233 | 2.1.32x |
|---|---|---|
| Bash, auto mode available | `Yes` / grant / `No` | `Yes` / grant / **`Yes, and switch to auto mode · auto mode handles these prompts for you`** / `No` |
| Bash, auto mode disabled | same | unchanged (three rows) |
| Write / Edit row 2 | `Yes, allow all edits during this session (shift+tab)` | `Yes, and switch to accept edits (auto-approve file edits and common file commands) for this session (shift+tab)` |
| Write outside the project | – | row 2 adds `; Yes, and always allow access to <dir> for this session` |
| Plan | three rows | **byte-identical** |

The Bash grant row (row 2) prints the same three forms as on 2.1.233 (`always allow access to …`,
`allow reading from …`, `don’t ask again for: python3 *`). Bash dialogs now also carry the body line
`Tip: auto mode handles these prompts for you — choose "switch to auto mode" below`. The lens reads
past it (`01-…`, `05-…`, `06-…`).

All seven versions drew the same rows. 2.1.329 and 2.1.331 add only a `↑ N more lines` scroll hint
inside the plan body, above the rows. One transcript line changed after the dialog, not in it: from
2.1.326 on, an approved plan logs `⏺ Approved Claude's plan` instead of `⏺ User approved Claude's plan`.
Nothing in the app reads that line.

Per version: 2.1.321 and 2.1.325 have the full set (captures with the caret on each row, `noauto/`
captures, eight live cases). 2.1.322, 2.1.326, 2.1.327, 2.1.329 and 2.1.331 (`v<NNN>/`) were run by
the same script: captures of every family with the caret on each row, and the same eight live cases.
Cases 7 and 8 ran in a session with auto mode disabled, which is the evidence for the three-row Bash
shape on those versions.

The footer still drops `Tab to amend` while the caret is off row 1 (`01-bash-access-caret2.txt`). The
strict read then does not claim the dialog, and the anchored read does, exactly as in a4c/cc233.

## The live cases (`live/`, and `v<NNN>/live/`)

Eight per version. Each has its frames (`-NN-strict` / `-NN-continuity`), the run's own log
(`-sequence.json`: live pin, entry, target, outcome, every look) and the screen 4 s later (`-99-after`).

| case | session | target | keys `answerDialog` chose | proof on disk / on screen |
|---|---|---|---|---|
| case1-bash-deny | auto | row 4 `No` | Down Down Down Enter | `⎿ Interrupted`, the `touch` artifact absent |
| case2-bash-allow | auto | row 1 `Yes` | Enter | artifact present |
| case3-write-option2 | auto | row 2 | Down Enter | file written, `⏵⏵ accept edits on` |
| case4-plan-manual | auto, plan mode | row 2 | Down Enter | `User approved Claude's plan`, `⏸ manual mode on` |
| case5-edit-escape | auto | Esc | Escape | file unchanged |
| case6-cmdrule-deny | auto | row 4 `No` | Down Down Down Enter | `⎿ Interrupted`, the `python3` artifact absent |
| case7-noauto-bash-deny | noauto | row 3 `No` | Down Down Enter | `⎿ Interrupted`, artifact absent |
| case8-write-outside-option2 | noauto | row 2 (outside-project form) | Down Enter | file written, `⏵⏵ accept edits on` |

`tests/unit/chat-cc321.test.ts` replays every case's frames through the same `answerDialog()` and
checks that it sends the same keys.

## One more screen: a Bash call from plan mode

`80-bash-in-plan-mode-autofallback.txt`: a session left in plan mode got the same `touch` as a
two-row `No` / `Yes` gate under `Auto mode can't check actions in this session, so this one needs
your approval`. That is because the fake API cannot run auto mode's server-side check. The lens does
not claim this screen, so chat draws no card for it and presses nothing. It is kept as evidence of
that refusal. It is not a mapping.

## Redaction

Each file is the capture verbatim, except that the shell-echo prompt `<user>@<host>` was replaced by
`operator@supermux-host-01` at equal width. Nothing else was touched. The paths are the throwaway
test directories (`/private/tmp/claude-501/sr1/work`, …).
