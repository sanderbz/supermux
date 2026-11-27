#!/usr/bin/env python3
"""A stand-in Claude Code for the chat header's model picker, on a real pty.

It draws an idle Claude Code composer and reproduces the two `/model` paths
exactly as Claude Code 2.1.326 behaved when probed live against a throwaway
`CLAUDE_CONFIG_DIR` (see `server/src/sessions/model_pick.rs`):

* `/model <alias>` switches at once and answers `Set model to Sonnet 5.5 and
  saved as your default for new sessions`;
* a bare `/model` opens the picker — same title, same rows, same legend, the
  cursor on the CURRENT model's row, Up/Down wrapping, `Home` to row 1, a digit
  selecting AND saving at once, `s` = this session only, `Esc` = `Kept model
  as …`.

After every change it POSTs a statusline payload to the supermux tap, the way
the real statusline command does (`$SUPERMUX_URL` / `$SUPERMUX_SESSION` /
`$SUPERMUX_HOOK_TOKEN` are in the pane env), so the header chip moves on the
same wire it moves on in production. It posts once at boot too.

It also keeps a TRANSCRIPT the way Claude Code does, at
`$CLAUDE_CONFIG_DIR/projects/<encoded cwd>/<conv>.jsonl` with the conversation
pointer set by a real `SessionStart` hook: a main-agent assistant record
carrying `message.model` at boot (plus a sidechain record on another model,
which must never count), and on every pick the exact record 2.1.326 writes —
a `user` line whose content is `<local-command-stdout>Set model to `Fable 5.2`
for this session only</local-command-stdout>`. `FAKE_MODEL_NO_TAP=1` turns the
statusline posts off, so a test can prove the chip comes from the transcript.

`FAKE_MODEL_LOGGED_IN=1` draws the picker a LOGGED-IN account gets (captured
from a real session): versions in the labels (`Opus 5.5 ✔`), two spaces after
the number, short descriptions (row 1's naming `Opus 5.5`), and an unnumbered
`▸   More models` row the cursor can wrap onto.

Everything that crosses the pty is appended to `$FAKE_MODEL_LOG` as JSON lines
(`{"ev":"submit","text":"/model"}`, `{"ev":"key","key":"Down"}`, …), so a test
asserts on the keys that actually arrived, not on what the server believes it
sent.
"""
import json
import os
import sys
import textwrap
import termios
import time
import tty
import urllib.request
import uuid

LOG = os.environ.get("FAKE_MODEL_LOG")

ROWS = [
    ("Default (recommended)", None, "Use the default model (currently Opus 5.5) · $4/$20 per Mtok"),
    ("Opus", ("claude-opus-5-5", "Opus 5.5"), "Opus 5.5 · Best for everyday, complex tasks · $4/$20 per Mtok"),
    ("Fable", ("claude-fable-5-2", "Fable 5.2"), "Fable 5.2 · Most capable for your hardest and longest-running tasks · $8/$40 per Mtok"),
    ("Sonnet", ("claude-sonnet-5-5", "Sonnet 5.5"), "Sonnet 5.5 · Efficient for routine tasks · $2/$10 per Mtok"),
    ("Haiku", ("claude-haiku-5-5", "Haiku 5.5"), "Haiku 5.5 · Fastest for quick answers · $0.10/$0.50 per Mtok"),
]
ALIASES = {"opus": 1, "fable": 2, "sonnet": 3, "haiku": 4}
LOGGED_IN = os.environ.get("FAKE_MODEL_LOGGED_IN") == "1"
# The logged-in rows, verbatim from the real capture: (label column, description).
REAL_ROWS = [
    ("Default (recommended)", "Opus 5.5 \u00b7 Best for everyday, complex tasks"),
    ("Opus 5.5", "For complex work and everyday tasks"),
    ("Fable 5.2", "For your toughest challenges"),
    ("Sonnet 5.5", "Most efficient for simpler tasks"),
    ("Haiku 5.5", "Fastest for quick answers"),
]

BANNER = [
    " ▐▛███▛█   Claude Code v2.1.326",
    "▝▜██████▀  Opus 5.5 · Claude Max",
    " ▝▝   ▝▝   /opt/projects/supermux",
    "",
]

state = {"current": 1, "picker": None, "buf": "", "history": []}


def log(**ev):
    if LOG:
        with open(LOG, "a") as f:
            f.write(json.dumps(ev) + "\n")


CONV = str(uuid.uuid4())
STAMP = [0]


def transcript_path():
    root = os.environ.get("CLAUDE_CONFIG_DIR") or os.path.join(os.path.expanduser("~"), ".claude")
    enc = os.path.realpath(os.getcwd()).replace("/", "-").replace(".", "-")
    d = os.path.join(root, "projects", enc)
    os.makedirs(d, exist_ok=True)
    return os.path.join(d, CONV + ".jsonl")


def record(rec_type, message, **extra):
    STAMP[0] += 1
    rec = {
        "type": rec_type,
        "uuid": f"{CONV}-{STAMP[0]}",
        # Real time, as Claude Code stamps it: supermux ignores model signals
        # written before the session's current start.
        "timestamp": time.strftime("%Y-%m-%dT%H:%M:%S.000Z", time.gmtime()),
        "sessionId": CONV,
        "isSidechain": False,
        "message": message,
    }
    rec.update(extra)
    with open(transcript_path(), "a") as f:
        f.write(json.dumps(rec) + "\n")


def hook_session_start():
    """Point supermux's tailer at this transcript, as Claude Code's hook does."""
    url = os.environ.get("SUPERMUX_URL")
    session = os.environ.get("SUPERMUX_SESSION")
    if not url or not session:
        return
    body = json.dumps({"session": session, "event": "SessionStart", "payload": {"session_id": CONV}}).encode()
    req = urllib.request.Request(
        f"{url}/api/_internal/hook",
        data=body,
        headers={"Content-Type": "application/json", "X-Supermux-Hook-Token": os.environ.get("SUPERMUX_HOOK_TOKEN", "")},
        method="POST",
    )
    try:
        urllib.request.urlopen(req, timeout=2).read()
    except Exception as e:
        log(ev="hook_error", error=str(e))


def post_statusline():
    if os.environ.get("FAKE_MODEL_NO_TAP") == "1":
        return
    url = os.environ.get("SUPERMUX_URL")
    session = os.environ.get("SUPERMUX_SESSION")
    if not url or not session:
        return
    mid, name = ROWS[state["current"]][1]
    body = json.dumps({"model": {"id": mid, "display_name": name}, "version": "2.1.326"}).encode()
    req = urllib.request.Request(
        f"{url}/api/_internal/statusline?session={session}",
        data=body,
        headers={
            "Content-Type": "application/json",
            "X-Supermux-Hook-Token": os.environ.get("SUPERMUX_HOOK_TOKEN", ""),
        },
        method="POST",
    )
    try:
        urllib.request.urlopen(req, timeout=2).read()
    except Exception as e:  # a missed tap is a stale chip, never a crash
        log(ev="statusline_error", error=str(e))


def width():
    try:
        return max(40, os.get_terminal_size(sys.stdout.fileno()).columns)
    except OSError:
        return 100


def wrapped(text, indent, cols):
    """Ink-style wrap: the text in its own column, continuation lines indented."""
    lines = textwrap.wrap(text, max(10, cols - indent)) or [""]
    return [lines[0]] + [" " * indent + l for l in lines[1:]]


def draw():
    cols = width()
    out = list(BANNER) + state["history"]
    rule = "\u2500" * cols
    if state["picker"] is None:
        out += [rule, "\u276f " + state["buf"], rule, "  \u23f5\u23f5 auto mode on (shift+tab to cycle)"]
    else:
        out += [rule, "  Select model"]
        out += ["  " + l.lstrip() for l in wrapped(
            "Switch between Claude models. Your pick becomes the default for new sessions. "
            "For other or older models, use --model.", 0, cols - 2)]
        out.append("")
        for i, (label, _, desc) in enumerate(ROWS):
            tick = " \u2714" if i == state["current"] else ""
            caret = "\u276f" if i == state["picker"] else " "
            if LOGGED_IN:
                label, desc = REAL_ROWS[i]
                head = f"  {caret} {i + 1}.  {(label + tick).ljust(22)} "
            else:
                head = f"  {caret} {i + 1}. {(label + tick).ljust(24)} "
            body = wrapped(desc, len(head), cols)
            out.append(head + body[0])
            out += body[1:]
        if LOGGED_IN:
            caret = "\u276f" if state["picker"] == len(ROWS) else " "
            out.append(f"  {caret} \u25b8   More models")
        out += ["", "  \u25d0 Medium effort (default) \u2190/\u2192 to adjust", ""]
        out += ["  " + l.lstrip() for l in wrapped(
            "Enter to set as default \u00b7 s to use this session only \u00b7 Esc to cancel", 0, cols - 2)]
    sys.stdout.write("\x1b[2J\x1b[H" + "\r\n".join(out))
    sys.stdout.flush()


def answer(line):
    state["history"] += [f"  ⎿  {line}", ""]


def set_model(row, scope):
    if row == 0:
        row = 1  # "Default" resolves to Opus on this account
    state["current"] = row
    name = ROWS[row][1][1]
    log(ev="pick", model=ROWS[row][0].lower(), scope=scope)
    if scope == "session":
        line = f"Set model to {name} for this session only"
        logged = f"Set model to `{name}` for this session only"
    else:
        line = f"Set model to {name} and saved as your default for new sessions"
        logged = f"Set model to `{name}` and saved as your default for new sessions"
    answer(line)
    record("user", {"role": "user", "content": f"<local-command-stdout>{logged}</local-command-stdout>"})
    post_statusline()


def submit():
    text = state["buf"].strip()
    state["buf"] = ""
    log(ev="submit", text=text)
    state["history"].append(f"❯ {text}")
    if text == "/model":
        state["picker"] = state["current"]
        return
    if text.startswith("/model "):
        arg = text.split(" ", 1)[1].strip()
        if arg in ALIASES:
            set_model(ALIASES[arg], "default")
        else:
            answer(f"Model '{arg.replace(' ', '')}' not found")
        return
    answer("(stand-in agent: no model behind this)")


def picker_key(key):
    p = state["picker"]
    # The logged-in picker's unnumbered `More models` row is a stop too.
    n = len(ROWS) + (1 if LOGGED_IN else 0)
    if p == len(ROWS) and key in ("Enter", "s"):
        log(ev="more_models")
        return
    if key == "Up":
        state["picker"] = (p - 1) % n
    elif key == "Down":
        state["picker"] = (p + 1) % n
    elif key == "Home":
        state["picker"] = 0
    elif key == "Enter":
        state["picker"] = None
        set_model(p, "default")
    elif key == "s":
        state["picker"] = None
        set_model(p, "session")
    elif key.isdigit() and 1 <= int(key) <= n:
        state["picker"] = None
        set_model(int(key) - 1, "default")
    elif key == "Escape":
        state["picker"] = None
        answer(f"Kept model as {ROWS[state['current']][1][1]}")


SEQS = {
    "\x1b[A": "Up", "\x1bOA": "Up",
    "\x1b[B": "Down", "\x1bOB": "Down",
    "\x1b[H": "Home", "\x1bOH": "Home",
    "\x1b[C": "Right", "\x1bOC": "Right",
    "\x1b[D": "Left", "\x1bOD": "Left",
}


def tokens(data):
    """Split one read into keys and paste bodies."""
    i = 0
    while i < len(data):
        if data.startswith("\x1b[200~", i):
            end = data.find("\x1b[201~", i)
            end = len(data) if end < 0 else end
            yield ("paste", data[i + 6:end])
            i = end + 6
            continue
        for seq, key in SEQS.items():
            if data.startswith(seq, i):
                yield ("key", key)
                i += len(seq)
                break
        else:
            ch = data[i]
            i += 1
            if ch == "\x1b":
                yield ("key", "Escape")
            elif ch in "\r\n":
                yield ("key", "Enter")
            elif ch == "\x03":
                raise KeyboardInterrupt
            elif ch == "\x7f":
                yield ("key", "BSpace")
            else:
                yield ("char", ch)


def main():
    fd = sys.stdin.fileno()
    saved = termios.tcgetattr(fd)
    tty.setraw(fd)
    # Ask for bracketed paste, as Claude Code does.
    sys.stdout.write("\x1b[?2004h")
    try:
        draw()
        mid = ROWS[state["current"]][1][0]
        record("assistant", {"role": "assistant", "model": mid, "content": [{"type": "text", "text": "Ready when you are."}]})
        # A subagent on another model: the session's chip must ignore it.
        record("assistant", {"role": "assistant", "model": "claude-haiku-5-5", "content": [{"type": "text", "text": "subagent"}]}, isSidechain=True)
        hook_session_start()
        post_statusline()
        while True:
            data = os.read(fd, 4096)
            if not data:
                break
            for kind, val in tokens(data.decode("utf-8", "replace")):
                if kind == "paste":
                    log(ev="paste", text=val)
                    if state["picker"] is None:
                        state["buf"] += val
                    continue
                key = val
                log(ev="key", key=key)
                if state["picker"] is not None:
                    picker_key(key)
                elif key == "Enter":
                    submit()
                elif key == "BSpace":
                    state["buf"] = state["buf"][:-1]
                elif kind == "char":
                    state["buf"] += key
            draw()
    except KeyboardInterrupt:
        pass
    finally:
        termios.tcsetattr(fd, termios.TCSADRAIN, saved)


if __name__ == "__main__":
    main()
