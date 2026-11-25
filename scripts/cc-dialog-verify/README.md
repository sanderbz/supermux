# cc-dialog-verify — re-verifying chat's dialog registry on a new Claude Code release

Chat answers Claude Code's permission and plan dialogs by pressing keys into the terminal. It does that
only for versions whose dialogs were captured **and** driven (`web/src/components/chat/registry/verified.ts`;
evidence in `web/tests/fixtures/tui/cc321/README.md`). Claude Code updates almost daily, so this directory
holds the rig that verifies a new release.

## Running it

```bash
scripts/cc-dialog-verify/nightly.sh            # the release channel's latest
scripts/cc-dialog-verify/nightly.sh 2.1.332    # one version
NO_PR=1 BASE=origin/<branch> …                 # testing this script: everything except commit/push/PR
```

The run writes `~/.supermux/cc-dialog-verify/<version>/report.json`, plus `run.log`, the captures, the live
frames and `compare.json`. The `status` field is one of:

- `already-verified` / `older-than-verified`: nothing to do.
- `pr-opened`: the dialogs were identical to the newest verified version and all eight live cases landed.
  A PR adds the version and its corpus. **It is a merge point for a human; nothing here merges.**
- `different`: something differed (`compare.json` shows which dialog and how), or a live case did not land
  its effect. No PR is opened. A human looks at the change, and the registry gets new entries if the
  dialog really changed (see `cc321/README.md` for how 2.1.32x was done).
- `failed`: the run could not be made (download, checksum, signature, server, tests). Nothing was
  concluded.

## What it does, and what it never touches

1. It downloads `downloads.claude.ai/claude-code-releases/<v>/darwin-arm64/claude`, then checks its SHA-256
   against the release manifest and Anthropic's code signature.
2. `testserver.sh` starts an **isolated** supermux server: its own port, data dir, HOME and token, under
   `env -i`. The release binary runs behind `fake-api.py`, a local stand-in for the Anthropic API.
   There is no model, no login and no key. The stub decides every tool call, and only inside the test
   work dir. Auto mode stays *available* (so the plan dialog matches production) but is never chosen.
3. In a throwaway worktree on `origin/main` it adds the version to `verified.ts`: the sequencer refuses a
   version that is not listed, so it has to be listed before it can be driven.
4. It captures every family with the caret on each row (Bash in three forms, Write, Edit, plan). Then it
   drives the eight live cases with the shipped `answerDialog()` (`web/scripts/cc-dialog-live.ts`) and
   checks their effects on disk.
5. `corpus.py compare`: question, rows and footer must be identical to the newest verified corpus. Only
   the values the run chose itself are normalised: the test dir, artifact numbers, the plan file name, and
   the `↑ N more lines` scroll hint.

It never touches the live server, its data, or any other session.

## Files

| file | what |
|---|---|
| `nightly.sh` | the orchestrator above |
| `testserver.sh` | starts and stops the isolated server and fake API |
| `fake-api.py` | scripted Anthropic API, with one scenario per dialog family |
| `corpus.py` | compares captures, redacts them (`<user>@<host>` → placeholder at equal width), adds a version |
| `../../web/scripts/cc-dialog-live.ts` | the live driver; every key is chosen by `answerDialog()` |
