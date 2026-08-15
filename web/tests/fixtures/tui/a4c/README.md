# A4c capture corpus — the LIVE self-test of the answer path

Claude Code **v2.1.232**, 2026-08-15. Throwaway session `spike-a4c-dialogs` (provider
claude, native runtime), created → driven → archived + purged. Every key went in through
`POST /api/sessions/{name}/keys` using the exact plan `registry/plan.ts` emits, one key at
a time, with the `dialog-answer.ts` discipline around it: verify-before-send → re-peek and
caret check between each nav key → commit → two dismissal looks 300 ms apart.

These files are the evidence behind two shipped decisions:

1. **the 2.1.232 pin** (`registry/claude.ts`) — all four entries driven end to end, each
   with its side-effect proof;
2. **the two-phase fingerprint** (`peek-lens.ts`) — the caret-dependent footer that made
   options 2 and 3 of every permission dialog unanswerable.

Same rules as the parent directory: fixtures are **inputs, never expectations**; nothing
that was not captured live may sit here without `-derived` in its name **and** a row below.

## Provenance and redaction

Captured with `GET /api/sessions/spike-a4c-dialogs/peek?lines=60` (plain) against the live
supermux; the two `*-ansi.txt` files come from the sessions-list `preview_ansi` channel
(last 20 ANSI lines), because the deployed server answered `?ansi=1` byte-identically to
plain. Each file is the capture verbatim except:

- the driver's `###` provenance header line is stripped (it is metadata, not screen);
- **PII redacted at equal display width**, the same two substitutions the parent README
  documents: `Welcome back Sander!` → `Welcome back Ada!`, and the account line →
  `operator@example.com's Organization`. The shell-echo hostname is likewise
  `supermux@supermux-server`. Nothing else is touched — the box geometry, the dialogs, the
  footers and the option rows are the bytes the terminal drew.

## The frames

| file | what it is |
|---|---|
| `00-boot-banner.txt` | the pin itself: `╭─── Claude Code v2.1.232 ───╮`, from a `lines=10000` read |
| `00b-unknown-family-auto-mode-nag.txt` | CC's "Set up auto mode for your environment?" modal — an unfixtured dialog the lens reads as `family: unknown`, i.e. the refusal-first path working live |
| `00c-cleared.txt` | the composer **ghost**: a model-predicted next prompt sitting at the prompt after `/clear`, indistinguishable from a typed draft in plain text |
| `case1-bash-deny-{1-before,2-after-Down1,3-after-Down2,4-dismiss1}.txt` | Bash permission answered `3 · deny` with `[Down, Down, Enter]`. Live outcome: `⎿ Interrupted · What should Claude do instead?`, artifact **absent** |
| `case2-bash-allow-{1-before,2-dismiss1}.txt` | Bash permission answered `1 · allow` with `[Enter]`. Live outcome: `⎿ Done`, artifact present |
| `case3-write-option2-{1-before,2-after-Down1,3-dismiss1}.txt` | Write ("Create file") answered `2` with `[Down, Enter]`. Live outcome: file written **and** `⏵⏵ accept edits on` — the `accept-session` effect, captured rather than inferred |
| `case4-plan-manual-{1-before,2-after-Down1,3-dismiss1}.txt` | ExitPlanMode answered `2 · manually approve` with `[Down, Enter]`. Live outcome: `User approved Claude's plan` + `⏸ manual mode on` |
| `case4b-edit-deny-{1-before,2-after-Down1,3-after-Down2,4-dismiss1}.txt` | the Edit permission that followed, answered `3 · deny`. Live outcome: `⎿ User rejected update`, file unchanged |
| `case5-escape-{1-before,2-dismiss1}.txt` | Escape on a Bash permission. Live outcome: `⎿ Interrupted`, empty composer, artifact absent |
| `composer-ghost-ansi.txt` | the ghost **with its SGR intact** — `ESC[0m❯ ESC[0;2m<predicted prompt>ESC[0m`. The dim run is the whole draft |
| `composer-empty-ansi.txt` | the same shape with a genuinely empty prompt — `ESC[0m❯ ESC[0m` — the negative control |

## The derived two

| file | derivation |
|---|---|
| `read-shaped-no-amend-derived.txt` | **DERIVED** from `case1-bash-deny-1-before.txt`: the title, the body, the question and option 2 rewritten as a Read prompt, and the footer reduced to ` Esc to cancel`. A0 documented that Read/WebFetch/MCP prompts print no `Tab to amend` (there is nothing to amend) but no such prompt was captured on 2.1.232. It exists to hold the SIGHTING to its strict footer: this file must read `family: unknown`, anchor or no anchor. |
| `case1-bash-deny-2-mutated-rows-derived.txt` | **DERIVED** from `case1-bash-deny-2-after-Down1.txt` by rewriting row 3 from `No` to `Yes, and always allow all Bash commands in this project` — the exact failure the option-list check exists for. Nothing else changes, so a continuity check that passes this file has stopped checking the rows. |

## What the footer does (the blocker these captures found)

On **all three** permission variants, `Tab to amend` is printed only while the caret is
NOT on row 2:

```
case1 -1-before   (caret row 1):  Esc to cancel · Tab to amend · ctrl+e to explain
case1 -2-after-Down1 (caret row 2): Esc to cancel · ctrl+e to explain
case1 -3-after-Down2 (caret row 3): Esc to cancel · Tab to amend · ctrl+e to explain
```

`readFamily` requires that token, so a strict re-read of the middle frame degrades to
`family: unknown` and the sequencer aborted after one `Down` — leaving the caret parked on
the most permissive row with the card disabled. The plan dialog is unaffected: its
fingerprint lives in its own body.

The fix is not to relax the sighting (that token is what keeps Read/WebFetch/MCP prompts
out of the act-on families) but to split it: strict on the way in, caret-invariant between
the keys of an answer already in flight. `peek-lens.ts`, beside `DialogContinuity`.
