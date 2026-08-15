# TUI capture fixtures (fase A4 T2)

What `GET /api/sessions/{name}/peek` actually returns, frozen. `peek-lens.ts` is a
screen-scraper; these files are the only thing that keeps it honest, so every one of
them records **where its bytes came from**. A fixture that is not a capture says so on
this page, in its filename, or both — never silently.

| file | provenance |
|---|---|
| `perm-bash.txt` | **Captured live**, A0 probe 2026-08-13, session `spike-a0-perm`, Claude Code **v2.1.227** (banner-pinned), 80 cols. Verbatim from `a0-dialogs.md` "Family 1 / Variant A". Re-verified structurally identical on v2.1.231. |
| `perm-write.txt` | **Captured live**, same probe, Write tool ("Create file"). Verbatim from `a0-dialogs.md` "Family 1 / Variant B". |
| `perm-edit.txt` | **Captured live**, A0 probe, Edit tool, **v2.1.231**. Verbatim from `a0-dialogs.md` "Family 1 / Variant C". |
| `plan-approval.txt` | **Captured live**, A0 probe, session `spike-a0-plan`, **v2.1.231**. Verbatim from `a0-dialogs.md` "Family 2". The plan markdown between the dashed rules is A0's own elision (`(plan markdown between dashed rules)`) — the rest is byte-for-byte. |
| `perm-bash-52col-derived.txt` | **DERIVED, not captured.** A0 saw this dialog reflow at 52 cols (a concurrent terminal client resized the pty mid-probe) and recorded the *fact* — the wrapped capture itself was not kept. This file re-wraps `perm-bash.txt` at 52 cols with continuation lines aligned under the option text, which is the shape A0 describes. It exists to hold the lens to whitespace-normalised token matching; it is **not** evidence about how CC wraps. |
| `perm-bash-caret2.txt` | **DERIVED** from `perm-bash.txt` by moving the `❯` to option 3 — the caret position A0 verified after `Down`,`Down` (option 3 = "No"). Feeds T6/T7's caret-verify tests. |
| `banner.txt` | **Captured live** here, 2026-08-14, `claude` **v2.1.232** in a throwaway dir, 80×40 tmux pane, `tmux capture-pane -p`. Two lines are PII-redacted at equal display width (`Welcome back Sander!` → `Welcome back Ada!`, the account/organisation line → `operator@example.com's Organization`); the capture's final line (a weekly-usage notice) is omitted. Every other byte, and the whole box geometry, is the capture. |
| `composer-idle.txt` | Same live launch, after `/clear`. Same two redactions. Holds the **`❯` collision** A0 warns about: the echoed `❯ /clear` in scrollback sits above an *empty* composer. |
| `composer-draft.txt` | Same live session with `half a thought` typed and **not** submitted. Same two redactions. |
| `composer-draft-ansi.txt` | The same frame, ANSI-preserved (`tmux capture-pane -p -e`). Proves the lens strips SGR before matching. |

## Two facts these captures pinned that A0 did not have

1. **The composer's space is a NBSP.** The live composer line is `❯ <draft>` (U+276F,
   U+00A0), while an *echoed* prompt in scrollback is `❯ <text>` with an ordinary
   U+0020. Verified three times independently: this local 2.1.232 launch, and the live
   `/peek` of two running sessions (`ipc`, drafted; `Reisposter`, empty). The lens
   prefers the NBSP line and falls back to the last column-0 `❯` line, so a future CC
   that drops the NBSP degrades to the old rule instead of going blind.
2. **The boot banner has two shapes.** Fresh boot is
   `╭─── Claude Code v2.1.232 ───…╮` (this fixture); after `/clear` the same session
   shows the compact `▐▛███▜▌   Claude Code v2.1.224` form (seen live on `Reisposter`).
   The lens therefore anchors on the token `Claude Code v<semver>` and on neither box.

## Rules

- Fixtures are **inputs, never expectations** — no test may edit one to make itself pass.
- Anything not live-captured carries `-derived` in its filename **and** a row above.
- No option in the T6 registry is enabled without a fixture backing it (plan §T11).

## `a4c/` — the 2.1.232 live self-test

A second corpus lives in `a4c/`, with its own README: the frame-by-frame captures of a
real answer sequence driven against Claude Code **v2.1.232** (2026-08-15). It is the
evidence for the registry's 2.1.232 pin and for the two-phase fingerprint, and it is where
the caret-dependent permission footer is recorded. Same rules apply there, including the
`-derived` one.
