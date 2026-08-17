# CC 2.1.233 capture corpus — the third live re-verification

Claude Code **v2.1.233**, 2026-08-16. Throwaway session `spike-233-capture` (provider
claude, native runtime, dir `~/spike-233`), created → `POST /mode {normal}` (the host
default is `auto`, which answers dialogs before they can be read) → driven → archived +
purged; `~/spike-233` removed.

Same playbook as `../a4c/`, third run. Two halves:

1. **`*.txt` in this directory** — every family re-captured verbatim with the caret parked
   on each row, so the fingerprint and the caret-dependent footer are both on the record.
2. **`live/`** — the shipped sequencer driving the real pty. `answerDialog()` was imported
   and its `refresh` / `sendKey` wired to `GET /peek` and `POST /keys`, so **every key that
   landed in the session was chosen by `dialog-answer.ts` itself**, reading `peek-lens.ts`
   and `registry/`. `refresh` mirrors `use-peek-lens.ts`: it computes the STRICT read (what
   the shared poll frame publishes) *and* the anchored one (returned only to the sequencer)
   and records both per frame.

The harness is the a4d one with its paths repointed (session `spike-233-capture`, this
branch's modules, and the pin resolved from a real `peek?lines=10000` instead of an env
override); it lives with the run's raw output in the session scratchpad,
`…/scratchpad/cc233-live.ts`. Nothing in the repo depends on it — `live/*-sequence.json`
below is its output, and `tests/unit/chat-cc233-live.test.ts` replays these frames through
the same `answerDialog()` so the run is checkable without it.

**The version pin was NOT substituted this time.** `livePin` in every `*-sequence.json` is
`2.1.233`, read the way the app reads it — one deep `peek?lines=10000` for the boot banner,
never `claude --version`. The a4c/a4d runs had to pass `PIN=…` by hand; this one did not,
because the entries were widened first and then driven.

Same rules as the parent directory: fixtures are **inputs, never expectations**; nothing
that was not captured live may sit here without `-derived` in its name.

## Provenance and redaction

Captured with `GET /api/sessions/spike-233-capture/peek?lines=60` (plain). Each file is the
capture verbatim except:

- the driver's `###` provenance header line is stripped (metadata, not screen);
- **PII redacted at equal display width**, the same substitutions the parent README and
  `../a4c/` document: `Welcome back Sander!` → `Welcome back Ada!`, the account line →
  `operator@example.com's Organization`, the shell-echo hostname →
  `supermux@supermux-server`. Nothing else is touched.

`60-streaming-prose.txt` was captured later and separately (`GET
/api/sessions/v-claude/peek?lines=40&ansi=1` on the verify instance, 2026-08-17, mid-turn on
an ordinary prose answer), under the same two substitutions. It is the corpus's only
**non-dialog** frame, and it exists for `provisional.ts`: it pins the shipped 2.1.233
composer layout — a bare `❯ ` row between two full-width rules, **no `╭` box anywhere below
the welcome banner** — against which the provisional tail rendered zero prose lines while
the capture held thirty-five.

Widths are preserved, so the 80-col boot banner and the **52-col** frames (a second client
attached mid-run and resized the pty — the exact concurrent-client hazard a0 §3 warns
about) are the real geometry. `08-bash-access-52col-caret1.txt` is that wrap, live.

# What changed in 2.1.233

**One row: Bash permission option 2 — and it is the row nothing presses.** Everything else
is byte-identical to 2.1.232: options 1 (`Yes`) and 3 (`No`), all three Write/Edit rows, all
three plan rows, the question lines, the variant titles, and the caret-dependent footer.

The Bash dialog now prints **three different grants** in row 2, chosen by what the command
touches:

| row 2, verbatim | trigger | file |
|---|---|---|
| `Yes, and always allow access to spike-233/ from this project` | `touch <file in project>` | `01-bash-access-caret1.txt` |
| `Yes, allow reading from etc/ from this project` | `sha256sum /etc/hostname` | `05-bash-read-caret1.txt` |
| `Yes, and don’t ask again for: python3 *` | `python3 -c …` | `06-bash-cmdrule-caret1.txt` |

The third also adds a body line above the question — `This command requires approval` — and
uses a **curly** apostrophe in `don’t`.

Against the 2.1.232 pattern (`^yes, and always allow`) the second and third rows fail
`shapeHolds`, which disables options 1 and 3 as well: chat goes inert on a dialog it can
read perfectly. That is why `registry/claude.ts` now matches this row with `^yes\b` and says
why in `BASH_ALWAYS_ALLOW`.

## Option-2 semantics — answered, and still `actOn: false`

a0 §3 left this open ("executes, but persistence NOT FOUND … inconclusive"). Driven to
completion here, and the answer is that one row does **two different things**:

- **`don’t ask again for: python3 *`** writes a rule to **disk**:
  `~/spike-233/.claude/settings.local.json` → `{"permissions":{"allow":["Bash(python3 *)"]}}`
  (`10-optsem-cmdrule-98-artifact.txt`). It is project-scoped and immediate — the next
  `python3` command ran with **no dialog at all**
  (`11-optsem-cmdrule-99-rule-applies.txt`). `~/.claude/settings.json` was byte-unchanged
  (md5 recorded in the same file) and `~/.claude.json` gained no permission key.
- **`always allow access to spike-233/ from this project`** writes **nothing** — the
  project settings file was byte-identical afterwards — and instead flips the whole session
  into `⏵⏵ accept edits on` (`12-optsem-access-98-artifact.txt`).

So the grant is now *known* and it is *larger than this app can describe*: `accept-session`
is the widest word the registry has, and it renders as "Allowed for this session", which for
the first form is false — that rule is still there tomorrow, in a file the user may commit.
The row stays rendered, unpressable, with that sentence as its reason.

## The frames

| file | what it is |
|---|---|
| `00-boot-banner.txt` | the pin itself: `╭─── Claude Code v2.1.233 ───╮`, from a `lines=10000` read |
| `01/02/03-bash-access-caret{1,2,3}.txt` | Bash permission, caret on each row. `02` is the frame with **no `Tab to amend`** in the footer |
| `05-bash-read-caret1.txt` | the read-access form of row 2 |
| `06-bash-cmdrule-caret1.txt`, `07-bash-cmdrule-caret2.txt` | the command-pattern form, caret on rows 1 and 2 |
| `08-bash-access-52col-caret1.txt` | the same access form wrapped at 52 cols — row 2 spans two lines and the lens folds it back |
| `10/11/12-optsem-*.txt` | the option-2 side-effect proofs above (disk rule, rule-applies, mode flip) |
| `20/21/22-write-caret{1,2,3}.txt` | Write ("Create file"), caret on each row; `21` drops `Tab to amend` |
| `30/31/32-edit-caret{1,2,3}.txt` | Edit ("Edit file"), caret on each row; `31` drops `Tab to amend` |
| `40/41/42-plan-caret{1,2,3}.txt` | ExitPlanMode, caret on each row. Footer is caret-INVARIANT here, and the plan path is now `~/.claude/plans/<slug>.md` — no `plan-` prefix, unlike a0's capture |

## `live/` — the driven matrix, 5/5 confirmed

Every line below is quoted from that case's `*-sequence.json`, which also records the
per-look strict-vs-anchored reading.

| case | target | plan the code chose | outcome | side effect |
|---|---|---|---|---|
| `case1-bash-deny` | option 3 | `[Down, Down, Enter]` | `{"ok":true,"committed":true,"effect":"deny"}` | `⎿ Interrupted · What should Claude do instead?`, artifact **absent** (`-98-artifact-absent.txt`) |
| `case3-bash-allow` | option 1 | `[Enter]` | `{"ok":true,"committed":true,"effect":"accept"}` | `case3.txt` created, mode still `⏸ manual mode on` — an `accept`, not a session grant |
| `case2-write-option2` | option 2 | `[Down, Enter]` | `{"ok":true,"committed":true,"effect":"accept-session"}` | `hello.txt` written (`hi`) **and** `⏵⏵ accept edits on` — both halves |
| `case4-plan-manual` | option 2 | `[Up, Enter]` | `{"ok":true,"committed":true,"effect":"accept"}` | `⏸ manual mode on`, execution resumed and immediately raised the Write dialog case 2 then answered |
| `case5-edit-escape` | escape | `[Escape]` | `{"ok":true,"committed":true,"effect":"feedback"}` | `edit1.txt` md5 **unchanged**, composer restored |

`case4` is the one that shows the plan is computed from the caret's *current* row rather
than a default: the caret was already on row 3, so the code chose `Up`, not `Down`.

## The two-phase fingerprint, still load-bearing

`case1-bash-deny-03-continuity.txt` is the frame that would kill the run without it — same
dialog, caret moved to row 2, footer redrawn without `Tab to amend`:

```
look 03   footerHasTabToAmend=false
          strict   → family "unknown", caret 1     (what the shared poll frame publishes)
          returned → family "permission", caret 1  (only the sequencer, only with its anchor)
```

`case2-write-option2-03-continuity.txt` is the same thing on the Write variant. Nothing
relaxed: the registry match, the version pin and `shapeHolds` all ran again on the anchored
reading.
