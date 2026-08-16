# CC 2.1.233 — the FULL-SCREEN PANELS, and the two screens they must not be confused with

Claude Code **v2.1.233**, 2026-08-16. Captured while fixing daily-driver QA **#1**: a
`/status` sent from chat opened the CLI's Status panel on a pty nobody was looking at, chat
showed an idle green dot and an inviting composer, and every later message was refused with
*"The terminal has an unsent draft `/status`"* — about a terminal that had no draft at all.

## Provenance

A throwaway `claude` in a **local tmux pane, 80×30** (`tmux new-session -d -x 80 -y 30`,
cwd a scratch directory), driven with `tmux send-keys` — which is byte-for-byte what
`POST /send` does (`sessions/tmux.rs::send_text` → `send-keys -l --`). Each file is
`tmux capture-pane -p` verbatim, so the geometry, the wrapping and the trailing blank rows
are the real screen. The pane was killed and the scratch directory removed afterwards.

Fixtures are **inputs, never expectations**, and nothing that was not captured live sits
here.

| file | what it is |
|---|---|
| `50-status-modal.txt` | `/status` — the Status panel. Footer `Esc to cancel`; the only `❯` in the capture is the ECHO of the command, 20 rows up in the scrollback. |
| `51-cost-modal.txt` | `/cost` — the same shape with its own keys (`d to day · w to week`). No `❯` anywhere. |
| `52-idle-composer.txt` | the same session right after `Esc`: the live composer is back, two rows above the footer. |
| `53-running-turn.txt` | mid-turn. The composer is live AND the footer says `esc to interrupt` — the screen a naive "is there an `esc to …` hint?" rule would wreck. |

`52` is also the evidence for the composer's own separator: the live prompt is
`❯` + **U+00A0**, the scrollback echo is `❯` + an ordinary space (`50`, row 8).

## PII redaction, at equal display width

`sander.zakelijk@gmail.com` → `operator@example.com` (padded), `Welcome back Sander!` →
`Welcome back Ada!` (padded), the session UUID, the `uds:` socket path and the absolute
scratch path → same-width placeholders. Nothing else is touched; every line keeps its
column count.

## What was re-verified with these

The `PASS_THROUGH` allowlist in `src/components/chat/slash.ts`, one command at a time:

* `/status`, `/cost` — full-screen panels. **Removed** from the allowlist.
* `/review`, `/pr-comments` — **gone from the CLI**. Typing either leaves the command menu
  open with `/code-review (review)` highlighted, and the Enter `send_text` appends accepts
  THAT. Both **removed**; `pr-comments` was added to the refusing namespace.
* `/clear`, `/compact` — driven to completion, prompt left where they found it. **Kept.**
