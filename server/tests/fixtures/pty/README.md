# The shared pty-state corpus

Screens Claude Code (and codex) put on the terminal that supermux has to
understand, as verbatim captures, plus one JSONL index recording what **both**
planes must say about each of them.

Read by:

| plane | reader | test |
|---|---|---|
| server | `sessions::status` + `sessions::pty_state` | `server/tests/pty_state_parity.rs` |
| web | `components/chat/peek-lens.ts` (+ the dialog registry) | `web/tests/unit/pty-state-parity.test.ts` |

Also read by `web/tests/unit/chat-registry.test.ts`, which backs the two startup
gates' registry entries with the same bytes the server plane is checked against.

## Why one corpus and not two suites

There are two independent readers of the live screen in this product and neither
can see the other's mistakes. The roster, the tiles and push consume the
server's verdict; the chat surface's cards, composer and attention card consume
the lens'. A screen taught to one and forgotten on the other compiles clean in
Rust *and* in TypeScript, and produces the worst outcome available to this app:
a roster row that says *blocked* beside a chat header that says *Idle* with a
green dot — or the reverse.

The 2026-08-17 state audit caught the version where **neither** plane knew: a
usage-limit banner rendered as an ordinary Claude speech bubble, the header said
`Idle` with a green dot and the composer stayed enabled, for a session that
could not run another turn for five hours (`05-chat-limits.png`,
`06-overview-limits.png`). The fix is only a fix if both planes keep agreeing,
so if you teach either reader a new screen, add a row here in the same commit.

## The index

`claude-states.jsonl` — one object per screen, plus a leading `_` documentation
object the readers skip.

| key | meaning |
|---|---|
| `id` | stable name, used by both tests to report failures |
| `capture` | sibling `.txt`, read verbatim |
| `live` | `true` = captured from a real session on this machine |
| `cc_version` | the binary the capture came from (live rows only) |
| `synthesized` | where the bytes came from instead (non-live rows only) |
| `provider` | for the server plane's detector; defaults to `claude` |
| `web` | what `readLens()` must report — family, question, header, rows, notice, armed |
| `server` | what `classify()` and `pty_state::read()` must report |

`web.armed` is the list of keys the screen has ARMED (catalog
`generic.armed_keys`). A row that omits it makes no claim; a row that says `[]`
is a CONTROL — every permission dialog's footer carries `ctrl+e to explain`,
which has the same shape as an arming, and a reader that confused the two would
refuse the composer's Stop for the whole life of every dialog.

A row with `live: false` **must** carry `synthesized` prose naming its source,
and the web test asserts exactly that. The registry's own rule — no option is
act-on-able without a fixture — only means something if a synthesized fixture
cannot quietly pass for a captured one.

## Provenance

| capture | source | CC version |
|---|---|---|
| `ask-user-question.txt` | LIVE `GET /peek` of session `vx-chat` on the verify rig (127.0.0.1:8831), 2026-08-17. The welcome box's two identity lines (`Welcome back <name>!`, `<email>'s Organization`) are replaced with neutral text; nothing else is touched, and neither line is read by any fingerprint. | 2.1.233 |
| `ask-user-question-answered.txt` | LIVE, from the self-test run below: the collapsed `● User answered Claude's questions:` form, with the answer this branch's own sequencer chose. Trimmed to the tail. | 2.1.233 |
| `trust-folder.txt` | LIVE, production spool `~/.supermux/native/spike-a0-trust/out.raw`. Reconstructed from the raw bytes' **pre-accept** frame (`\x1b[38;2;177;185;249m❯\x1b[4G…1.…Yes,…I…trust…this…folder`) — a straight VT replay renders the accept repaint over it, which is why the plain spool does not show the rows. Note what it does NOT contain: a `Claude Code vX.Y.Z` banner. This gate draws **above** the welcome box, which is why its registry entry is pin-exempt. | 2.1.227 |
| `limit-weekly.txt` | LIVE, production spool `~/.supermux/native/ipc/out.raw.crashed` (a scheduled-task session that hit the weekly bucket). The prompt text is shortened; the banner, its subline and everything below are verbatim. | 2.1.227 |
| `limit-used-pct.txt` | LIVE, production spools `spike-a0-fixtures` / `spike-a0-latency`. The `You've used 77% …` footer is ellipsized by Claude Code itself at the terminal width — that ellipsis is in the bytes, not in this file. | 2.1.227 |
| `idle.txt` | LIVE shape, trimmed — the negative control. A completion marker, a composer and a mode line, and no plane may read anything into it. | 2.1.233 |
| `api-key.txt` | SYNTHESIZED from the catalog's verbatim bundle strings (`auth.apikey_approval_prompt`). Laid out in the shape every other startup gate uses. Nothing in it is act-on-able. | — |
| `first-run-onboarding.txt` | SYNTHESIZED from the wizard's verbatim strings (`auth.first_run_onboarding`). Its rows have never been captured, so the lens reads `family: 'unknown'` and only the WEDGE is acted on. | — |
| `codex-hooks-review.txt` | SYNTHESIZED from codex's `tui/src/startup_hooks_review.rs` strings. Deliberately carries **no caret glyph**: nobody has captured how codex draws the selector here, and inventing one would be a fingerprint written against a screen that does not exist. | — |
| `limit-session-5h.txt`, `limit-approaching.txt` | SYNTHESIZED from the bundle's own templates — the sibling branches of two shapes whose other branch was captured live. | — |
| `session-paused-overage.txt` | SYNTHESIZED from the catalog's `limit.overage_consent_dialog`: the verbatim title (`Session paused`) and the choice between usage credits and a model switch, with the two rows laid out from the dialog's own result enum `['consent','switch_default','cancelled']` (cancel is Esc, not a row). Nobody has photographed this dialog — which is why `registry/claude.ts`'s `paused.overage_consent` presses nothing, and why one of its rows would spend money. | — |
| `session-paused-refusal.txt` | SYNTHESIZED from `err.refusal_fallback_dialog` — the safeguards paragraph, `Switch to {fallbackModel}`, `Edit prompt and retry with {originalModel}`, result enum `['retry_fallback','edit_prompt','cancelled']`. Its payload's `retractedMessageUuids` half lives on the transcript plane (`fixtures/chat`, row *a refusal fallback retracts the messages it already streamed*). | — |
| `stream-stalled.txt` | SYNTHESIZED from `err.stream_stalled` — the `stalled` retry kind's banner under CC's running-turn spinner. The only row in this corpus whose verdict is **active**: the request went out, the stream never started, and the turn resumes by itself. | — |
| `safeguards-refusal.txt` | SYNTHESIZED from `err.safeguards_refusal` — CC's own refusal renderer, with the composer back under it. Deliberately **not** blocked on the server plane: the session can take another turn, and the dead-turn fact belongs to the transcript (`agent_error.rs` class `refusal`). | — |
| `armed-esc-clear.txt`, `armed-ctrl-c-exit.txt` | SYNTHESIZED from `generic.armed_keys`' four verbatims (`Esc again to clear`, `Ctrl+Y to paste deleted text`, `Press {key} again to exit`, `Press {key} again to stop background agents`). Ordinary screens — nothing blocked, nothing waiting — which is the point: an ARMED screen is where an automated Esc or Ctrl-C does something nobody asked for. | — |

## The AskUserQuestion self-test

`ask-user-question.txt` proves what the lens READS. What it cannot prove is what
a keypress DOES, and the registry's rule is that no option is act-on-able without
that. So the entry was driven live on 2026-08-17, on a freshly booted session on a
throwaway instance, with every key chosen by the shipped code (`readLens` →
`entryFor` → `dialogCardView` → `answerDialog`, wired to `GET /peek` and
`POST /keys`):

    caret on row 2 → target row 3 → sent ["Down", "Enter"] → ok
    transcript sibling: "answers": {"Which fruit do you want?": "Cherry"}

The target is deliberately never row 1. The caret starts there, so a dialog that
merely swallowed the Enter would also answer "Apple"; answering the row the caret
was NOT on is what makes the result evidence. `ask-user-question-answered.txt` is
the pty frame that run left behind.

That run is also what found the caret settle in `dialog-answer.ts`: the first
re-peek after `Down` still showed the caret on the row it had left, and the old
read aborted with "something else is typing into this session" about a session
nothing else was touching.

The research bundle these were drawn from (raw pty byte segments, the binary
string sweeps and the 45-state verification matrix) is not checked in; it lives
with the audit that produced it.

## What the corpus deliberately does not do

* **No ANSI.** Both readers strip SGR before matching, every fingerprint here is
  token-based, and a colour has never been a matcher in either plane. Keeping
  the escapes would make the files unreadable in review for no assertion gained.
  (The one reading that *does* need the SGR channel — telling a typed composer
  draft from Claude Code's dim predicted one — has its own fixtures in
  `web/tests/fixtures/tui/composer-draft-ansi.txt`.)
* **No hooks, no clock.** Every row is classified with a fresh detector, an empty
  turn state and a neutral heartbeat, so the capture alone decides. A held prior
  status would mask a non-matching input and give a false pass.
