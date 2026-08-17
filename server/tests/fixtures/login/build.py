#!/usr/bin/env python3
"""Regenerate the /login capture fixtures + `cases.jsonl`.

Provenance: the verbatim strings come from the state catalogue built for this
repo (`master-catalog.json`, states `auth.login.*` / `auth.design_login`, CC
2.1.227 pinned) — each line below is a `verbatim` entry of one of those states,
laid out the way a VT grid holds it. The URL is a REAL-SHAPED authorize URL for
the host the catalogue pins (`claude.com/cai/oauth/authorize`, redirect_uri
`platform.claude.com`) with the secrets replaced by same-length gibberish: no
capture of a live PKCE challenge belongs in a repo.

Run:  python3 server/tests/fixtures/login/build.py
"""
import json
import os

HERE = os.path.dirname(os.path.abspath(__file__))

URL = (
    "https://claude.com/cai/oauth/authorize?code=true"
    "&client_id=9d1c250a-e61b-44d9-88ed-5944d1962f5e"
    "&response_type=code"
    "&redirect_uri=https%3A%2F%2Fplatform.claude.com%2Foauth%2Fcode%2Fcallback"
    "&scope=org%3Acreate_api_key+user%3Aprofile+user%3Ainference"
    "&code_challenge=PZKq0mF1WSQ0oYtqO3xVvT4WhK3nGmqLzUvNq2sWQ1k"
    "&code_challenge_method=S256"
    "&state=hVQ0m2rXqvY7bK1cLp9sTfR8dNzE4uJa"
)

PASTE = "Paste code here if prompted > "


def grid(lines, width):
    """Lay `lines` out on a `width`-column VT grid, hard-wrapping like a pty.

    A wrapped row is FULL (exactly `width` chars) and its continuation starts at
    column 0 — which is the only thing that tells a reassembler where a logical
    line broke, because the pty keeps no soft-wrap marker.
    """
    out = []
    for line in lines:
        if line == "":
            out.append("")
            continue
        while len(line) > width:
            out.append(line[:width])
            line = line[width:]
        out.append(line)
    return out


def banner():
    return [
        "▐▛███▜▌ Claude Code v2.1.227",
        "▝▜█████▛▘ Sonnet 4.5 · Claude Max",
        "  ▘▘ ▝▝  ~/projects/supermux",
        "",
    ]


def url_block():
    return [
        "Opening browser to sign in…",
        "",
        "Browser didn't open? Use the url below to sign in  (c to copy)",
        "",
        URL,
        "",
    ]


CASES = []


def case(name, lines, width, **expect):
    text = "\n".join(grid(lines, width)) + "\n"
    # The paste prompt has NO trailing newline — that is a documented trap and
    # the liveness rule depends on it, so the fixture must not add one.
    if text.rstrip("\n").endswith(PASTE.rstrip()) or expect.get("no_final_newline"):
        text = text.rstrip("\n")
    expect.pop("no_final_newline", None)
    fname = f"{name}.txt"
    with open(os.path.join(HERE, fname), "w") as fh:
        fh.write(text)
    row = {"name": name, "file": fname, "width": width}
    row.update(expect)
    CASES.append(row)


# ── 1. the method selector ───────────────────────────────────────────────────
case(
    "method-select",
    banner()
    + [
        "Select login method:",
        "",
        "Claude Code can be used with your Claude subscription or billed based on API usage through your Console account.",
        "",
        " ❯ 1. Claude account with subscription · Pro, Max, Team, or Enterprise",
        "   2. Anthropic Console account · API usage billing",
        "   3. 3rd-party platform · Amazon Bedrock, Microsoft Foundry, or Vertex AI",
        "",
        "Enter to confirm · Esc to cancel",
    ],
    80,
    stage="method_select",
    flow="account",
    options=[
        "Claude account with subscription · Pro, Max, Team, or Enterprise",
        "Anthropic Console account · API usage billing",
        "3rd-party platform · Amazon Bedrock, Microsoft Foundry, or Vertex AI",
    ],
    waiting=True,
)

# ── 2-5. the paste prompt, at four wrap widths ───────────────────────────────
for width in (52, 80, 100, 400):
    case(
        f"paste-prompt-w{width}",
        banner() + url_block() + [PASTE],
        width,
        stage="paste_prompt",
        flow="account",
        url=URL,
        waiting=True,
    )

# ── 6. the field already carries masked keystrokes ───────────────────────────
case(
    "paste-prompt-masked",
    banner() + url_block() + [PASTE + "*" * 24],
    80,
    stage="paste_prompt",
    flow="account",
    url=URL,
    waiting=True,
)

# ── 7. rejection, re-prompted in place ───────────────────────────────────────
case(
    "invalid-code",
    banner()
    + url_block()
    + [
        "Invalid code. Please make sure the full code was copied",
        "",
        PASTE,
    ],
    80,
    stage="invalid",
    flow="account",
    url=URL,
    message="Invalid code. Please make sure the full code was copied",
    waiting=True,
)

# ── 8. success — still needs the Enter that writes the onboarding flags ──────
case(
    "success",
    banner()
    + [
        "Opening browser to sign in…",
        "",
        "Logged in as sander@example.com",
        "",
        "Login successful. Press Enter to continue…",
    ],
    80,
    stage="success",
    flow="account",
    email="sander@example.com",
    waiting=True,
)

# ── 9. /design-login — the IDENTICAL paste prompt, a different flow ──────────
case(
    "design-login",
    banner()
    + [
        "Starting design login…",
        "",
        "Waiting for browser authorization…",
        "",
        "Browser didn't open? Use the url below to sign in  (c to copy)",
        "",
        URL.replace("user%3Ainference", "user%3Adesign%3Aread"),
        "",
        PASTE,
    ],
    80,
    stage="paste_prompt",
    flow="design",
    url=URL.replace("user%3Ainference", "user%3Adesign%3Aread"),
    waiting=True,
)

# ── 10. the error state machine ──────────────────────────────────────────────
case(
    "oauth-error",
    banner()
    + [
        "Opening browser to sign in…",
        "",
        "OAuth error: Failed to exchange authorization code for access token. Please try again.",
        "",
        "Press Enter to retry.",
    ],
    80,
    stage="error",
    flow="account",
    message="OAuth error: Failed to exchange authorization code for access token. Please try again.",
    waiting=True,
)

case(
    "login-interrupted",
    banner() + ["Opening browser to sign in…", "", "Login interrupted"],
    80,
    stage="error",
    flow="account",
    message="Login interrupted",
    waiting=True,
)

# ── 11-13. the three ways a naive matcher goes wrong ─────────────────────────
case(
    "negative-idle-composer",
    banner()
    + [
        "> summarise the diff",
        "",
        "⏺ Done — three files, all in the renderer.",
        "",
        "❯ ",
    ],
    80,
    stage=None,
    waiting=False,
)

case(
    "negative-login-in-scrollback",
    banner()
    + url_block()
    + [
        PASTE + "*" * 60,
        "",
        "Login successful. Press Enter to continue…",
        "",
        "❯ what were we doing?",
        "",
        "⏺ You had just signed back in. Picking up where we left off:",
        "",
        "  1. the renderer wiring",
        "  2. the roster tiers",
        "",
        "❯ ",
    ],
    80,
    stage=None,
    waiting=False,
)

case(
    "negative-prose-quotes-the-prompt",
    banner()
    + [
        "❯ how does the claude login flow work?",
        "",
        "⏺ Claude Code prints an authorize URL and then waits on a masked field",
        "  labelled `Paste code here if prompted > ` for the `code#state` string",
        "  from the callback page. It is pty-only — the transcript records the",
        "  slash command and nothing else.",
        "",
        "❯ ",
    ],
    80,
    stage=None,
    waiting=False,
)

with open(os.path.join(HERE, "cases.jsonl"), "w") as fh:
    fh.write(
        json.dumps(
            {
                "_": "The shared /login classification corpus. Rust half: "
                "server/tests/login_parity.rs. TypeScript half: "
                "web/tests/unit/login-lens-parity.test.ts. Regenerate with "
                "server/tests/fixtures/login/build.py — never by hand."
            }
        )
        + "\n"
    )
    for row in CASES:
        fh.write(json.dumps(row, ensure_ascii=False) + "\n")

print(f"{len(CASES)} cases")
