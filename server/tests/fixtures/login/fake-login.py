#!/usr/bin/env python3
"""A fake OAuth provider on a real pty — the regression harness for the whole flow.

It prints the captured Claude Code `/login` dialog verbatim (the same strings the
corpus beside this file holds) UNDER the agent's own chrome (see `BANNER` — the
banner and the `❯ /login` composer line the live capture carries above the
panel), waits on a MASKED field the way the real one
does, rejects a code with no `#` exactly once with the CLI's own rejection line,
and on a good code prints `Logged in as …` / `Login successful. Press Enter to
continue…` and then waits for the Enter that — in the real CLI — is what writes
`hasCompletedOnboarding`.

It is deliberately a real pty program rather than a mock:

* the field is put in RAW mode and echoes `*` per byte, so the capture the lens
  reads is shaped like the real one AND the credential genuinely never reaches
  the terminal's output — which is what makes the "no code in the spool"
  assertion in `tests/login_flow_e2e.rs` mean something;
* the code arrives as ONE bracketed-paste burst, so the harness proves the `c`
  trap is avoided end to end (a char-at-a-time writer would deliver a lone `c`
  first, and the real CLI clears the field on that);
* it writes what it received to `$FAKE_LOGIN_RESULT` so the test asserts on the
  bytes that actually crossed the pty, not on what the server believes it sent.

Env:
  FAKE_LOGIN_RESULT  path to write `<code>` to on success (required)
  FAKE_LOGIN_URL     the authorize URL to print (defaults to the corpus one)
"""
import os
import sys
import termios
import tty

URL = os.environ.get(
    "FAKE_LOGIN_URL",
    "https://claude.com/cai/oauth/authorize?code=true"
    "&client_id=9d1c250a-e61b-44d9-88ed-5944d1962f5e"
    "&response_type=code"
    "&redirect_uri=https%3A%2F%2Fplatform.claude.com%2Foauth%2Fcode%2Fcallback"
    "&scope=org%3Acreate_api_key+user%3Aprofile+user%3Ainference"
    "&code_challenge=PZKq0mF1WSQ0oYtqO3xVvT4WhK3nGmqLzUvNq2sWQ1k"
    "&code_challenge_method=S256"
    "&state=hVQ0m2rXqvY7bK1cLp9sTfR8dNzE4uJa",
)
RESULT = os.environ["FAKE_LOGIN_RESULT"]

PASTE = "Paste code here if prompted > "
BURST_START = b"\x1b[200~"
BURST_END = b"\x1b[201~"

# THE CHROME UNDER THE FIELD, which is why this harness exists at all.
#
# Claude Code 2.1.233 draws two blank rows and its dismissal footer BELOW the
# waiting field (verified on a live pty, 2026-08-17; the same rows are pinned as
# `cc233-*.txt` in the corpus beside this file). A fake provider that ended on
# the prompt let a tail-anchored reader pass every test in the repo and then read
# `Esc to cancel` on the real screen — no card, and the supervision freeze
# releasing while an OAuth code was live. So the fake draws the footer too, and
# puts the cursor back on the field the way the real TUI's repaint does.
FOOTER = "\r\n\r\n  Esc to cancel"

# THE AGENT CHROME ABOVE THE PANEL, which is why `start` used to give up on this
# session.
#
# A real Claude Code at `/login` is an AGENT that happens to be showing a login
# panel: its banner is on the screen and the slash command that opened the panel
# is still on the composer line above it — see `cc233-paste-prompt.txt` beside
# this file, the live capture this fixture is built from, whose first lines are
# the banner and `❯ /login`. The fake drew the panel and nothing else.
#
# That omission is not cosmetic, because `lifecycle::wait_for_agent_ready`'s
# proof that the launch worked is `agent_at_the_wheel` — literally "is one of
# `❯` / `❱` / `? for shortcuts` on the screen". With no chrome there is no
# glyph, so the boot gate polled the full ten seconds, `start` returned
# `ready: false`, and `start_locked`'s failed-launch arm persisted
# `last_status = "stopped"` on a session whose provider was alive and waiting at
# its prompt. Only the status detector's next tick (2s cadence) corrected it to
# `waiting`.
#
# MEASURED on this fixture before the fix: `POST /start` took 10702 ms and
# answered `{"ready": false}`, and the `GET /api/sessions` immediately after it
# — and again after `page.goto` — still read `status: "stopped"` while the pane
# capture in the very same row showed the live login prompt. So
# `web/tests/e2e/smoke/login-flow.spec.ts` did not *occasionally* navigate into
# that window; it navigated into it on EVERY run, and passed only when the
# correcting `sessions` delta reached the browser inside the 10 s `expect`
# budget. On a loaded CI runner that delta lands after the socket is up, or too
# late, and the focus route sits on `<StoppedSession>` (`chatPaneActive` is
# false for `status === 'stopped'`) — no `chat-panel`, no login card, a red
# shard on a green commit. That is the whole flake.
#
# Drawing the chrome makes the fake faithful to the corpus AND clears the boot
# gate on the first poll: measured after the fix, `start` takes 2055 ms and
# answers `{"ready": true}`, with a non-`stopped` status persisted before its
# response — there is no window left to race. The composer
# glyph is ABOVE the panel, exactly as in the live capture, so the lens still
# reads `paste_prompt` here and still refuses the
# `negative-login-in-scrollback` shape (where `❯` sits BELOW a finished login).
BANNER = (
    " ▐▛███▜▌   Claude Code v2.1.233\r\n"
    "▝▜█████▛▘  Opus 5 (1M context) with high effort · Claude Max\r\n"
    "  ▘▘ ▝▝    /opt/projects/supermux\r\n"
    "\r\n"
    "❯ /login\r\n"
    "\r\n"
)


def out(s):
    sys.stdout.write(s)
    sys.stdout.flush()


def prompt():
    """The field plus the footer under it, cursor back at the end of the label."""
    out(PASTE)
    out(FOOTER)
    out("\x1b[2A")  # up, past the blank row, onto the field's own row
    out("\r\x1b[%dC" % len(PASTE))  # and along to where the typing goes


def below_footer():
    """Move past the footer, so the next thing printed does not land on it."""
    out("\x1b[2B\r\n")


def read_masked():
    """Read one submitted line from the raw tty, echoing `*` and never the byte.

    Returns the payload with the bracketed-paste markers removed. The markers
    are stripped rather than required: a terminal that does not send them still
    has to work, it just loses the `c`-trap protection.
    """
    fd = sys.stdin.fileno()
    saved = termios.tcgetattr(fd)
    buf = b""
    try:
        tty.setraw(fd)
        while True:
            ch = os.read(fd, 1)
            if not ch:
                break
            if ch in (b"\r", b"\n"):
                break
            if ch == b"\x03":  # Ctrl-C
                raise KeyboardInterrupt
            if ch == b"\x15":  # Ctrl-U clears the field, like the real one
                out("\r" + " " * (len(PASTE) + len(buf)) + "\r" + PASTE)
                buf = b""
                continue
            buf += ch
            # Mask only the payload; the paste markers are not keystrokes.
            if not (BURST_START.startswith(buf[-len(BURST_START):])
                    or buf.endswith(BURST_START) or buf.endswith(BURST_END)):
                out("*")
    finally:
        termios.tcsetattr(fd, termios.TCSADRAIN, saved)
    return buf.replace(BURST_START, b"").replace(BURST_END, b"").decode("utf-8", "replace")


def main():
    # The agent's own chrome first — see BANNER. Without it the launch's boot
    # gate has nothing to recognise and `start` reports the session stopped.
    out(BANNER)
    out("Opening browser to sign in…\r\n")
    out("\r\n")
    out("Browser didn't open? Use the url below to sign in  (c to copy)\r\n")
    out("\r\n")
    out(URL + "\r\n")
    out("\r\n")
    # NO trailing newline on the prompt itself — that is the documented trap the
    # lens's anchoring depends on — and the dismissal footer under it, which is
    # what the anchoring has to see THROUGH.
    prompt()

    while True:
        code = read_masked()
        # `bad…` is the harness' way of driving the REJECTION branch: the server
        # accepts any well-formed `code#state`, so the provider has to be the one
        # that says no — which is the point, since the whole retry contract is
        # "re-prompt in place, never respawn".
        if "#" in code and len(code) > 8 and not code.startswith("bad"):
            break
        below_footer()
        out("Invalid code. Please make sure the full code was copied\r\n\r\n")
        prompt()

    with open(RESULT, "w") as fh:
        fh.write(code)

    below_footer()
    out("Logged in as sander@example.com\r\n\r\n")
    out("Login successful. Press Enter to continue…")

    # The mandatory Enter. In the real CLI this keypress writes the onboarding
    # flags; here it is what proves the driver sent it.
    fd = sys.stdin.fileno()
    saved = termios.tcgetattr(fd)
    try:
        tty.setraw(fd)
        while os.read(fd, 1) not in (b"\r", b"\n", b""):
            pass
    finally:
        termios.tcsetattr(fd, termios.TCSADRAIN, saved)
    with open(RESULT + ".confirmed", "w") as fh:
        fh.write("ok")
    out("\r\n")


if __name__ == "__main__":
    main()
