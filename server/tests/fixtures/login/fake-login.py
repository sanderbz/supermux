#!/usr/bin/env python3
"""A fake OAuth provider on a real pty — the regression harness for the whole flow.

It prints the captured Claude Code `/login` dialog verbatim (the same strings the
corpus beside this file holds), waits on a MASKED field the way the real one
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


def out(s):
    sys.stdout.write(s)
    sys.stdout.flush()


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
    out("Opening browser to sign in…\r\n")
    out("\r\n")
    out("Browser didn't open? Use the url below to sign in  (c to copy)\r\n")
    out("\r\n")
    out(URL + "\r\n")
    out("\r\n")
    # NO trailing newline — this is the documented trap the lens's anchoring
    # depends on, so the fake must reproduce it.
    out(PASTE)

    while True:
        code = read_masked()
        # `bad…` is the harness' way of driving the REJECTION branch: the server
        # accepts any well-formed `code#state`, so the provider has to be the one
        # that says no — which is the point, since the whole retry contract is
        # "re-prompt in place, never respawn".
        if "#" in code and len(code) > 8 and not code.startswith("bad"):
            break
        out("\r\n\r\nInvalid code. Please make sure the full code was copied\r\n\r\n")
        out(PASTE)

    with open(RESULT, "w") as fh:
        fh.write(code)

    out("\r\n\r\nLogged in as sander@example.com\r\n\r\n")
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
