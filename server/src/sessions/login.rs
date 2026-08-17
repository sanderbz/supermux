//! The OAuth login flow, as a product feature.
//!
//! `/login` is the one needs-input state a supermux user could not answer from
//! the web UI. It is **pty-only**: the JSONL transcript records
//! `<command-name>/login</command-name>` and, if it works, a one-line
//! `<local-command-stdout>Login successful</local-command-stdout>` — so the
//! chat renderer, which reads the transcript, is structurally blind to the
//! entire dialog. Everything that matters happens on the VT grid.
//!
//! This module is the **lens** for that grid (pure, no I/O, fixture-tested by
//! `tests/login_parity.rs` against the SAME corpus the web lens reads), plus the
//! two seams the flow needs to be driveable at all:
//!
//! * [`freeze`] / [`is_frozen`] — the supervision freeze. Between the URL being
//!   shown and the code being pasted, the PKCE `code_verifier` and the `state`
//!   nonce live **only in the CLI process**. Restarting the session there — an
//!   auto-heal, a scheduled fire that auto-wakes a stopped pane, a delegated
//!   prompt — invalidates the code the user is at that moment copying out of
//!   their browser, and the flow fails with `Authentication failed: Invalid
//!   authorization code` for a reason nothing in the UI can explain. So for the
//!   duration of a login this session is off limits to every automatic writer.
//! * [`validate_code`] / [`REDACTED_CODE`] — the pasted string is a
//!   **credential**. It never reaches `last_send_text` (the roster's send
//!   preview), never reaches the chat tail, and is never logged.
//!
//! ## The traps this encodes
//!
//! Each one is a live-verified property of Claude Code 2.1.227+ (state
//! catalogue `auth.login.*`), and each one breaks the obvious implementation:
//!
//! | trap | what this module does about it |
//! |---|---|
//! | a buffer of exactly `c` copies the URL and **clears the field** — and authorization codes commonly start with `c` | the code is written as ONE bracketed-paste burst, never char-by-char ([`paste_burst`]) |
//! | the PKCE verifier dies with the process | [`freeze`], and `Invalid code` is re-prompted IN PLACE — never by respawning |
//! | `hasCompletedOnboarding` is written only by the Enter on `Login successful` | [`Stage::Success`] is a state the UI must still act on, not a terminus |
//! | the paste prompt has **no trailing newline**, so any byte written after it re-matches | the prompt is required to be the last row that is not TUI CHROME ([`is_chrome_row`]), and rejection is read off the `Invalid code…` line rather than off a reappearance count |
//! | the authorize host moved to `claude.com` (`redirect_uri` `platform.claude.com`) | [`URL_HOSTS`] |
//! | `/design-login` prints the IDENTICAL prompt string | [`Flow`], disambiguated on the lines above the prompt |
//! | the field's echo is version-dependent — 2.1.227 masks it, 2.1.233 prints the code back verbatim | success is confirmed from `Login successful`, never from an echo read; and [`is_paste_row`] accepts the field's contents either way |

use std::time::{Duration, Instant};

use serde::Serialize;

// ── the lens ────────────────────────────────────────────────────────────────

/// Where a login flow currently is. Serialises snake_case — the same vocabulary
/// `web/src/components/chat/login-lens.ts` uses, so the shared corpus can name a
/// stage once.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Stage {
    /// `Select login method:` — three options, answered with arrows + Enter.
    MethodSelect,
    /// `Paste code here if prompted > ` — the masked field, waiting.
    PastePrompt,
    /// The same field, after `Invalid code. Please make sure the full code was
    /// copied`. Still the same process, so still the same PKCE verifier: this is
    /// a re-prompt, NOT a reason to restart anything.
    Invalid,
    /// `Login successful. Press Enter to continue…`. Needs one more keypress.
    Success,
    /// Anything in the login state machine that failed with a message.
    Error,
}

impl Stage {
    pub const fn as_str(self) -> &'static str {
        match self {
            Stage::MethodSelect => "method_select",
            Stage::PastePrompt => "paste_prompt",
            Stage::Invalid => "invalid",
            Stage::Success => "success",
            Stage::Error => "error",
        }
    }
}

/// WHICH OAuth flow is on screen. `/login` and `/design-login` print the
/// byte-identical `Paste code here if prompted > `, so the prompt alone cannot
/// tell them apart — the lines above it can.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Flow {
    /// `/login` — the account credential.
    Account,
    /// `/design-login` — the `user:design:read` credential `/design-sync` needs.
    Design,
}

impl Flow {
    pub const fn as_str(self) -> &'static str {
        match self {
            Flow::Account => "account",
            Flow::Design => "design",
        }
    }
}

/// A login dialog the lens can SEE.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct LoginSighting {
    pub stage: Stage,
    pub flow: Flow,
    /// The authorize URL, reassembled across the VT grid's hard wraps.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub url: Option<String>,
    /// The method selector's option labels, in TUI order.
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub options: Vec<String>,
    /// The verbatim error / rejection line, when there is one.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub message: Option<String>,
    /// `Logged in as {email}`, when the success screen names it.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub email: Option<String>,
}

/// The masked field's label, verbatim. Matched unanchored because it can arrive
/// split across pty chunks — but its POSITION is anchored (see [`read_login`]).
pub const PASTE_PROMPT: &str = "Paste code here if prompted";
/// The rejection line. This — not a count of prompt reappearances — is how a
/// rejected code is known: the prompt has no trailing newline, so any later byte
/// re-matches it and a counter produces false rejections.
const INVALID_LINE: &str = "Invalid code. Please make sure the full code was copied";
const METHOD_SELECT: &str = "Select login method:";
/// The authorize hosts. `claude.ai` is NOT one of them any more — an allowlist
/// that still says so silently discards the URL and the card renders empty.
pub const URL_HOSTS: &[&str] = &["claude.com", "console.anthropic.com", "platform.claude.com"];

/// SGR (and every other escape) removed, because BOTH capture channels reach
/// these readers and only one of them is plain.
///
/// The detector tick hands over `capture_plain`; the chat surface polls
/// `?ansi=1` (the colour-true channel), and the native VT re-emits SGR PER ROW —
/// every line of that capture ends in `\x1b[0m`. A reader that matched on raw
/// rows saw `Paste code here if prompted > \x1b[0m`, failed its end-of-row
/// anchor and reported nothing, while its twin on the plain channel reported a
/// login. Stripping is a no-op on a plain capture, which is what keeps the two
/// planes reading the SAME corpus and agreeing.
fn strip_ansi(s: &str) -> std::borrow::Cow<'_, str> {
    if !s.contains('\x1b') {
        return std::borrow::Cow::Borrowed(s);
    }
    let mut out = String::with_capacity(s.len());
    let mut it = s.chars().peekable();
    while let Some(c) = it.next() {
        if c != '\x1b' {
            out.push(c);
            continue;
        }
        match it.next() {
            // CSI: parameters and intermediates, then one final byte.
            Some('[') => {
                for c in it.by_ref() {
                    if ('@'..='~').contains(&c) {
                        break;
                    }
                }
            }
            // OSC: runs to BEL or ST.
            Some(']') => {
                while let Some(c) = it.next() {
                    if c == '\x07' {
                        break;
                    }
                    if c == '\x1b' {
                        it.next();
                        break;
                    }
                }
            }
            // Any other two-byte escape.
            _ => {}
        }
    }
    std::borrow::Cow::Owned(out)
}

/// How far above the bottom of the capture the lens looks. Bounded, and bounded
/// again by the composer rule below — the capture is scrollback plus viewport,
/// and a login that finished an hour ago is not a login that is waiting.
const LOOKBACK: usize = 60;

/// U+276F at column 0 with no digit after it: the TUI's own composer. Its
/// presence BELOW a login marker is proof the flow is over — the dialog owns the
/// screen while it is up, and Claude Code does not draw the composer under it.
/// (A dialog's own caret row is `space + ❯ + space + digit + .`, so it is not
/// this.)
fn is_composer_row(line: &str) -> bool {
    let mut it = line.chars();
    if it.next() != Some('❯') {
        return false;
    }
    !it.as_str().trim_start().starts_with(|c: char| c.is_ascii_digit())
}

fn last_content_line(lines: &[&str]) -> Option<usize> {
    lines.iter().rposition(|l| !l.trim().is_empty())
}

/// The rows the login flow could still own: from the bottom, up to [`LOOKBACK`]
/// rows, stopping at the first composer row.
fn window(lines: &[&str]) -> Option<(usize, usize)> {
    let tail = last_content_line(lines)?;
    let floor = tail.saturating_sub(LOOKBACK);
    let mut start = floor;
    for i in (floor..=tail).rev() {
        if is_composer_row(lines[i]) {
            start = i + 1;
            break;
        }
    }
    if start > tail {
        return None;
    }
    Some((start, tail))
}

/// The dismissal hints Claude Code prints UNDER a live dialog, verbatim. They are
/// drawn below the element that is waiting, so a reader that anchors on the last
/// content row reads the footer instead of the field.
const FOOTER_HINTS: &[&str] = &[
    "Esc to cancel",
    "Esc to exit",
    "Esc to go back",
    "Enter to confirm",
    "Enter to select",
    "Enter to continue",
    "↑/↓ to navigate",
    "Tab to amend",
    "ctrl+e to explain",
];

/// A row the TUI draws BELOW the thing that is waiting, and which therefore does
/// NOT end a dialog.
///
/// THIS IS THE BUG THIS FUNCTION EXISTS FOR. Claude Code 2.1.233 draws the
/// paste field like this:
///
/// ```text
///   Paste code here if prompted >
///
///   Esc to cancel
/// ```
///
/// — two blank rows and a dismissal footer under the field, plus (in a session
/// whose composer box is on screen) the box rule and the permission-mode row. A
/// lens that asked "is the LAST content row the paste prompt?" therefore read
/// `Esc to cancel`, matched nothing, and returned `None` while an OAuth code was
/// live on the screen: no card, and — worse — [`observe`] counted login-free
/// captures and released the supervision freeze mid-flow, which is exactly when
/// an auto-heal invalidates the PKCE verifier the user is copying a code for.
///
/// Deliberately a SHORT list of the TUI's own furniture rather than "skip
/// anything that is not a prompt": a screen this module does not recognise must
/// still fall through to "no login here".
fn is_chrome_row(line: &str) -> bool {
    let t = line.trim();
    if t.is_empty() {
        return true;
    }
    // The permission-mode row under the composer box: `⏵⏵ auto mode on …`.
    if t.starts_with('⏵') {
        return true;
    }
    // A box rule, with or without a label inside it (`──── session ─────`).
    if t.contains("────")
        && t.chars()
            .filter(|c| !matches!(c, '─' | '━' | '═' | ' '))
            .count()
            <= 40
    {
        return true;
    }
    // The dismissal footer, whole or joined by the TUI's own `·` separator.
    t.split('·')
        .all(|seg| FOOTER_HINTS.contains(&seg.trim().trim_end_matches('.')))
}

/// The last row in the window that is not [`is_chrome_row`] — the element that
/// is actually waiting.
fn last_live_row(lines: &[&str], start: usize, tail: usize) -> Option<usize> {
    (start..=tail).rev().find(|&i| !is_chrome_row(lines[i]))
}

/// Is this row the live paste prompt?
///
/// The prompt is drawn with no trailing newline, so the live shape is the prompt
/// followed by whatever the FIELD currently holds. That is `*`/`•` on a version
/// that masks it and — verified live on 2.1.233 — the typed characters
/// themselves on one that does not, so the contents are accepted either way: a
/// lens that only knew the masked shape stopped seeing the login the instant a
/// code was pasted into it, which is the one moment the freeze must hold.
///
/// The one thing the field may NOT contain is whitespace. That is what keeps
/// prose quoting the prompt (`labelled \`Paste code here if prompted > \` for
/// the …`) out, independently of the window rule above.
fn is_paste_row(line: &str) -> bool {
    let Some(i) = line.find(PASTE_PROMPT) else {
        return false;
    };
    let rest = line[i + PASTE_PROMPT.len()..].trim_start();
    let rest = rest.strip_prefix('>').unwrap_or(rest).trim();
    !rest.chars().any(char::is_whitespace)
}

/// Characters that may appear in a URL continuation row. Deliberately narrow: a
/// row containing a space is prose, not the rest of a URL.
fn is_url_char(c: char) -> bool {
    c.is_ascii_alphanumeric() || "-._~:/?#[]@!$&'()*+,;=%".contains(c)
}

/// The grid width a block was laid out at: the longest row in it. On a block
/// containing a wrapped line this IS the width, because a wrapped row is full by
/// definition.
fn grid_width(lines: &[&str]) -> usize {
    lines.iter().map(|l| l.chars().count()).max().unwrap_or(0)
}

/// One LOGICAL line, rebuilt from the physical rows the grid holds it in.
///
/// A hard wrap inserts nothing — no hyphen, no space — so the rows concatenate
/// raw and the join is only trimmed at the ends. Used for the error/rejection
/// messages, which are long English sentences and wrap on any real terminal:
/// reading only the first row gives "…Please try", which is a message no user
/// can act on and which no two terminal widths agree about.
fn join_wrapped(lines: &[&str], at: usize) -> String {
    let width = grid_width(lines);
    let mut out = lines[at].to_string();
    let mut i = at;
    while width > 0 && lines[i].chars().count() >= width {
        i += 1;
        let Some(next) = lines.get(i) else { break };
        // A continuation starts at column 0 and has content. A blank row, an
        // indented row (the TUI's own next element) or the end of the block all
        // close the line.
        if next.trim().is_empty() || next.starts_with(char::is_whitespace) {
            break;
        }
        out.push_str(next);
    }
    out.trim().to_string()
}

/// Reassemble a hard-wrapped URL out of the VT grid — the `capture-pane -p -J`
/// job, done without tmux.
///
/// A pty keeps no soft-wrap marker: a URL that ran past the right margin is
/// simply N full rows followed by a short one, and every one of them starts at
/// column 0. So the join rule is the two facts a wrap leaves behind:
///
/// 1. the row above is FULL — its length is the grid width (inferred as the
///    longest row in the block, which on a wrapped URL *is* the width);
/// 2. the row itself is unindented and made only of URL characters.
///
/// Both are required. (1) alone would swallow the next sentence whenever a line
/// happened to reach the margin; (2) alone would swallow any bare single-word
/// row that followed a short URL.
///
/// KNOWN LIMIT, stated rather than papered over: a URL that ends EXACTLY at the
/// right margin and is followed by a bare unindented single word made only of
/// URL characters is indistinguishable from a wrap, and that word is glued on.
/// Nothing in the grid can separate the two cases — the pty records no wrap
/// marker — and every captured Claude Code login block puts a blank row after
/// the URL, which closes the join. The failure is also self-announcing: the
/// authorize page rejects the mangled URL immediately, rather than the flow
/// half-succeeding.
pub fn reassemble_url(lines: &[&str]) -> Option<String> {
    reassemble_url_where(lines, |u| URL_HOSTS.iter().any(|h| u.contains(h)))
}

/// [`reassemble_url`] with the host rule supplied by the caller — the provider
/// lens below needs `chatgpt.com`/`moonshot.cn`, not the Claude hosts.
pub fn reassemble_url_where(lines: &[&str], accept: impl Fn(&str) -> bool) -> Option<String> {
    let width = match grid_width(lines) {
        0 => return None,
        w => w,
    };
    for (i, line) in lines.iter().enumerate() {
        let Some(at) = line.find("https://") else {
            continue;
        };
        let head = &line[at..];
        // A URL followed by text on the same row is complete on that row.
        let (head, complete) = match head.find(char::is_whitespace) {
            Some(sp) => (&head[..sp], true),
            None => (head, false),
        };
        if !accept(head) {
            continue;
        }
        let mut url = head.to_string();
        if !complete {
            let mut prev_full = line.chars().count() >= width;
            for next in &lines[i + 1..] {
                if !prev_full {
                    break;
                }
                if next.is_empty()
                    || next.starts_with(char::is_whitespace)
                    || !next.chars().all(is_url_char)
                {
                    break;
                }
                url.push_str(next);
                prev_full = next.chars().count() >= width;
            }
        }
        return Some(url);
    }
    None
}

/// `/design-login` prints the same prompt as `/login`; only its preamble differs.
fn read_flow(block: &str) -> Flow {
    if block.contains("design login")
        || block.contains("design credential")
        || block.contains("Design-system access")
        || block.contains("user%3Adesign")
    {
        Flow::Design
    } else {
        Flow::Account
    }
}

/// ` ❯ 1. Claude account with subscription · …` → the label.
fn read_options(lines: &[&str]) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    for line in lines {
        let t = line.trim_start();
        let t = t.strip_prefix('❯').map(str::trim_start).unwrap_or(t);
        let Some(dot) = t.find(". ") else { continue };
        let (n, rest) = t.split_at(dot);
        if n.is_empty() || !n.chars().all(|c| c.is_ascii_digit()) {
            continue;
        }
        if n.parse::<usize>() != Ok(out.len() + 1) {
            continue;
        }
        out.push(rest[2..].trim().to_string());
    }
    out
}

/// Read one capture. Pure, total, cheap — no capture ever panics, and a capture
/// with no login on it reads as `None` rather than as a failure.
pub fn read_login(capture: &str) -> Option<LoginSighting> {
    let capture = strip_ansi(capture);
    let lines: Vec<&str> = capture.lines().collect();
    let (start, tail) = window(&lines)?;
    let win = &lines[start..=tail];
    let block: String = win.join("\n");
    let flow = read_flow(&block);
    let url = reassemble_url(win);

    // Success first: it is the only stage that can sit under a finished paste
    // field, and reading it as "still waiting for a code" would leave the user
    // staring at an input box for a login that already worked.
    if block.contains("Login successful") || block.contains("Logged in as") {
        let email = win
            .iter()
            .find_map(|l| l.split_once("Logged in as "))
            .map(|(_, e)| e.trim().trim_end_matches('.').to_string())
            .filter(|e| e.contains('@'));
        return Some(LoginSighting {
            stage: Stage::Success,
            flow,
            url: None,
            options: Vec::new(),
            message: None,
            email,
        });
    }

    // ANCHORED at the bottom, THROUGH THE CHROME: the prompt is drawn with no
    // trailing newline, so the live one is the last thing on the screen that is
    // not the dialog's own furniture (blank rows, `Esc to cancel`, the box rule,
    // the mode row — see `is_chrome_row`). Anywhere above that it is prose
    // quoting it, or a login that has already been answered.
    if last_live_row(&lines, start, tail).is_some_and(|i| is_paste_row(lines[i])) {
        let message = win
            .iter()
            .rposition(|l| l.contains(INVALID_LINE))
            .map(|i| join_wrapped(win, i));
        return Some(LoginSighting {
            stage: if message.is_some() {
                Stage::Invalid
            } else {
                Stage::PastePrompt
            },
            flow,
            url,
            options: Vec::new(),
            message,
            email: None,
        });
    }

    if block.contains(METHOD_SELECT) {
        return Some(LoginSighting {
            stage: Stage::MethodSelect,
            flow,
            url: None,
            options: read_options(win),
            message: None,
            email: None,
        });
    }

    // The error taxonomy. Every one of these is a verbatim string from the CLI's
    // own 5-state login machine; the message is surfaced as-is because a login
    // failure the user cannot read is a login failure they cannot fix.
    for i in (0..win.len()).rev() {
        let t = win[i].trim();
        if t.starts_with("OAuth error:")
            || t.starts_with("Login failed:")
            || t.starts_with("Authentication failed:")
            || t == "Login interrupted"
            || t == "Authentication timeout"
            || t.starts_with("OAuth state mismatch")
            || t.contains(INVALID_LINE)
        {
            return Some(LoginSighting {
                stage: Stage::Error,
                flow,
                url,
                options: Vec::new(),
                // The whole sentence, across the wrap. "OAuth error: Failed to
                // exchange authorization code for access token. Please try" is
                // not a message; it is the first 80 columns of one.
                message: Some(join_wrapped(win, i)),
                email: None,
            });
        }
    }
    None
}

// ── the other providers ─────────────────────────────────────────────────────

/// What a NON-Claude provider is blocked on. Deliberately smaller than
/// [`LoginSighting`]: the other providers' device flows are not driven from here
/// (their PKCE/device-code lifecycles are their own), so the contract is an
/// HONEST CARD — name the state, show the link and the one-time code, say what
/// to do — instead of a half-automation that gets the timing wrong.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ProviderAuthKind {
    /// `Enter this one-time code` — a link plus a short code, expiring.
    DeviceCode,
    /// `Paste or type your API key` — a masked field holding a SECRET.
    ApiKey,
    /// `Sign in with ChatGPT` / `Sign in with Device Code` — the picker.
    MethodPicker,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct ProviderAuth {
    pub kind: ProviderAuthKind,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub url: Option<String>,
    /// The one-time code the user types into the browser. NOT a secret in the
    /// credential sense — it is meaningless without the browser session — but it
    /// is short-lived, so it is shown and never stored.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub code: Option<String>,
}

/// `ABCD-1234` — a device code row: short, loud, no spaces.
fn looks_like_device_code(line: &str) -> bool {
    let t = line.trim();
    (6..=16).contains(&t.chars().count())
        && t.chars().any(|c| c.is_ascii_alphanumeric())
        && t.chars().all(|c| c.is_ascii_alphanumeric() || c == '-')
        && t.chars().filter(|c| c.is_ascii_alphabetic()).all(|c| c.is_ascii_uppercase())
}

/// Read a non-Claude provider device-auth screen. Same window rule as [`read_login`].
pub fn read_provider_auth(capture: &str) -> Option<ProviderAuth> {
    let capture = strip_ansi(capture);
    let lines: Vec<&str> = capture.lines().collect();
    let (start, tail) = window(&lines)?;
    let win = &lines[start..=tail];
    let block = win.join("\n");

    if block.contains("Paste or type your API key") {
        return Some(ProviderAuth {
            kind: ProviderAuthKind::ApiKey,
            url: None,
            code: None,
        });
    }
    if block.contains("Enter this one-time code") || block.contains("device code authorization") {
        let code = win
            .iter()
            .skip_while(|l| !l.contains("Enter this one-time code"))
            .skip(1)
            .find(|l| looks_like_device_code(l))
            .map(|l| l.trim().to_string());
        return Some(ProviderAuth {
            kind: ProviderAuthKind::DeviceCode,
            url: reassemble_url_where(win, |_| true),
            code,
        });
    }
    if block.contains("Sign in with Device Code")
        || (block.contains("Sign in with ChatGPT") && block.contains("Provide your own API key"))
    {
        return Some(ProviderAuth {
            kind: ProviderAuthKind::MethodPicker,
            url: None,
            code: None,
        });
    }
    None
}

// ── the credential ──────────────────────────────────────────────────────────

/// What stands in for the pasted code anywhere a string is persisted or shown.
pub const REDACTED_CODE: &str = "<login code redacted>";

/// Longest code we will write. The real thing is ~100-200 chars
/// (`<authorizationCode>#<state>`); the cap is a sanity bound on an endpoint that
/// writes straight to a pty.
const MAX_CODE: usize = 512;

/// Validate a pasted `code#state` string.
///
/// * it must contain `#` — the callback page hands over BOTH halves joined by
///   one, and a code without its state nonce is rejected by the CLI after a
///   round trip the user has to sit through;
/// * it must carry no whitespace and no control bytes: this string is written
///   raw to a pty, so a stray `\r` would submit half a code and an `\x1b` would
///   be an escape-sequence injection into a live terminal.
pub fn validate_code(raw: &str) -> Result<String, String> {
    let code = raw.trim();
    if code.is_empty() {
        return Err("the login code is empty".into());
    }
    if code.len() > MAX_CODE {
        return Err(format!("the login code is longer than {MAX_CODE} characters"));
    }
    if code.chars().any(|c| c.is_whitespace() || c.is_control()) {
        return Err("the login code contains whitespace or control characters — paste the whole `code#state` string, unbroken".into());
    }
    if !code.contains('#') {
        return Err("that does not look like a full login code — it must contain the `#` that joins the code to its state nonce".into());
    }
    Ok(code.to_string())
}

/// The exact bytes a submitted code puts on the pty: ONE bracketed-paste burst,
/// then the submit.
///
/// Bracketed and in one burst because of the `c` trap: while the field is
/// waiting, a buffer that is exactly `c` copies the URL over OSC-52 and CLEARS
/// the field — and authorization codes commonly begin with `c`. Typing the code
/// character by character therefore destroys it on the first keystroke roughly
/// one time in forty. Inside `\x1b[200~ … \x1b[201~` the CLI takes the whole
/// string as a paste and no single character is ever alone in the buffer.
///
/// [`submit_code`] produces this shape through the runtime's own
/// `paste(bracketed)` + `Enter` pair (so the tmux and native backends each use
/// their tested write path); this function is what `tests/login_flow_e2e.rs`
/// asserts the fake provider actually received.
pub fn paste_burst(code: &str) -> Vec<u8> {
    let mut buf = Vec::with_capacity(code.len() + 16);
    buf.extend_from_slice(b"\x1b[200~");
    buf.extend_from_slice(code.as_bytes());
    buf.extend_from_slice(b"\x1b[201~");
    buf.extend_from_slice(b"\r");
    buf
}

/// Replace anything that looks like a login code in `text`.
///
/// Used on the paths that persist or broadcast what was written to a pty
/// (`last_send_text`, the chat tail, a log line). The shape is deliberately
/// broad — a long unbroken run containing `#` — because the cost of masking a
/// stray token is a preview that reads `<login code redacted>`, and the cost of
/// missing one is a credential in the database.
pub fn mask_codes(text: &str) -> String {
    text.split_inclusive(char::is_whitespace)
        .map(|tok| {
            let t = tok.trim_end();
            if t.len() >= 24 && t.contains('#') && t.chars().all(|c| !c.is_control()) {
                let ws = &tok[t.len()..];
                format!("{REDACTED_CODE}{ws}")
            } else {
                tok.to_string()
            }
        })
        .collect()
}

// ── the supervision freeze ──────────────────────────────────────────────────

/// A freeze that outlives its flow is a session nothing can write to, so every
/// freeze expires by itself. 15 minutes is long enough to walk to another
/// device, open a browser, sign in and come back; the OAuth codes themselves
/// expire well inside it.
pub const FREEZE_TTL: Duration = Duration::from_secs(15 * 60);

/// How many consecutive login-free captures release a SCREEN-DRIVEN freeze.
///
/// One is not enough: the detector tick can land on a frame the TUI is halfway
/// through redrawing, and releasing on that would open the window a redraw wide
/// — precisely the window an auto-heal needs to kill the verifier. Two ticks is
/// 2-10 s of "there is genuinely no login on this screen", and an explicit
/// freeze (the one the API's `start` takes) is never released this way at all.
const CLEAN_TICKS_TO_RELEASE: u8 = 2;

#[derive(Debug, Clone)]
struct Freeze {
    at: Instant,
    reason: &'static str,
    /// Was this freeze taken because the SCREEN showed a login, rather than
    /// because someone asked for one? Only a screen-driven freeze releases
    /// itself when the screen clears; an explicit one waits for confirm/cancel
    /// (or the TTL), because the flow may legitimately show nothing for a
    /// moment between `/login` and the URL block.
    screen_driven: bool,
    /// Consecutive login-free captures seen since the last sighting.
    clean: u8,
}

static FROZEN: once_cell::sync::Lazy<dashmap::DashMap<String, Freeze>> =
    once_cell::sync::Lazy::new(dashmap::DashMap::new);

/// Take this session off limits to every automatic writer.
///
/// Called the moment a login flow is STARTED, not when the URL appears: the
/// window that matters opens with the `/login` keystroke, and an auto-heal that
/// lands two seconds later has already killed the verifier.
pub fn freeze(name: &str, reason: &'static str) {
    FROZEN.insert(
        name.to_string(),
        Freeze {
            at: Instant::now(),
            reason,
            screen_driven: false,
            clean: 0,
        },
    );
    tracing::info!(session = %name, reason, "login: supervision frozen");
}

/// Reconcile the freeze with what is actually ON THE SCREEN. Called once per
/// detector tick with the capture that tick already took.
///
/// This is what makes the protection real for the login nobody asked this app
/// for — the overwhelmingly common one, where Claude Code hit an expired
/// credential and the user typed `/login` into the terminal themselves. A freeze
/// that only existed for flows started through the API would leave exactly those
/// sessions exposed to the heal that kills their verifier.
pub fn observe(name: &str, capture: &str) {
    if read_login(capture).is_some() {
        match FROZEN.get_mut(name) {
            Some(mut f) => {
                f.at = Instant::now();
                f.clean = 0;
            }
            None => {
                FROZEN.insert(
                    name.to_string(),
                    Freeze {
                        at: Instant::now(),
                        reason: "login on screen",
                        screen_driven: true,
                        clean: 0,
                    },
                );
                tracing::info!(session = %name, "login: supervision frozen — a login is on screen");
            }
        }
        return;
    }
    let release = match FROZEN.get_mut(name) {
        Some(mut f) if f.screen_driven => {
            f.clean = f.clean.saturating_add(1);
            f.clean >= CLEAN_TICKS_TO_RELEASE
        }
        _ => false,
    };
    if release {
        unfreeze(name);
    }
}

/// Release the session. Idempotent — the cancel path, the success path and the
/// TTL sweep all call it.
pub fn unfreeze(name: &str) {
    if FROZEN.remove(name).is_some() {
        tracing::info!(session = %name, "login: supervision released");
    }
}

/// Is this session mid-login? Expired freezes are swept here rather than by a
/// timer: the read is the only thing that cares.
pub fn is_frozen(name: &str) -> bool {
    match FROZEN.get(name).map(|f| f.at.elapsed() < FREEZE_TTL) {
        Some(true) => true,
        Some(false) => {
            FROZEN.remove(name);
            false
        }
        None => false,
    }
}

/// Why this session is frozen, for the sentence the UI shows.
pub fn freeze_reason(name: &str) -> Option<&'static str> {
    if !is_frozen(name) {
        return None;
    }
    FROZEN.get(name).map(|f| f.reason)
}

/// The refusal an automatic writer gets while a login is in flight.
pub fn frozen_error(name: &str) -> crate::error::AppError {
    crate::error::AppError::Conflict(format!(
        "session '{name}' is signing in — writes are frozen until the login finishes \
         (restarting or typing into it now would invalidate the login code)"
    ))
}

// ── the driver ──────────────────────────────────────────────────────────────

use crate::error::AppError;
use crate::state::AppState;

/// How much scrollback the login read looks at. The URL block plus the prompt is
/// ~10 rows even at a phone width; 120 is slack for a session that printed a
/// forced-method banner and an expiry warning first.
const READ_LINES: usize = 120;

/// Everything the login card needs, in one read.
#[derive(Debug, Clone, Serialize)]
pub struct LoginView {
    /// The Claude `/login` dialog, when one is on screen.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub login: Option<LoginSighting>,
    /// A non-Claude provider device-auth screen. Detected and explained, not driven.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub provider_auth: Option<ProviderAuth>,
    /// Is supervision frozen for this session right now?
    pub frozen: bool,
}

/// Read the session's screen and classify it. Read-only, no lock.
pub async fn view(state: &AppState, name: &str) -> Result<LoginView, AppError> {
    let capture = super::lifecycle::peek(state, name, READ_LINES).await?;
    Ok(LoginView {
        login: read_login(&capture),
        provider_auth: read_provider_auth(&capture),
        frozen: is_frozen(name),
    })
}

/// The runtime for a session that must be running. Every write below goes
/// through it DIRECTLY rather than through `lifecycle::send_*`, because the
/// login flow is the one writer the freeze must not refuse.
async fn live_runtime(
    state: &AppState,
    name: &str,
) -> Result<std::sync::Arc<dyn super::runtime::SessionRuntime>, AppError> {
    if !crate::db::sessions::exists(&state.pool, name).await? {
        return Err(AppError::NotFound(format!("session '{name}'")));
    }
    let rt = state.runtime_for(name).await?;
    if !rt.alive().await {
        return Err(AppError::Conflict(format!("session '{name}' is not running")));
    }
    Ok(rt)
}

/// Begin a login: FREEZE FIRST, then type the slash command.
///
/// The order is the whole point. The dangerous window opens at the keystroke,
/// not at the URL: an auto-heal or a scheduled fire landing between `/login` and
/// the paste restarts the process that is holding the verifier, and the code the
/// user is at that moment copying is already dead.
pub async fn start(state: &AppState, name: &str, design: bool) -> Result<LoginView, AppError> {
    let rt = live_runtime(state, name).await?;
    freeze(name, if design { "design-login" } else { "login" });
    let lock = state.lock_for(name);
    let _guard = lock.lock().await;
    let cmd = if design { "/design-login" } else { "/login" };
    rt.send_text(cmd).await?;
    super::lifecycle::submit_gap_for(rt.as_ref()).await;
    rt.send_key("Enter").await?;
    drop(_guard);
    Ok(LoginView {
        login: None,
        provider_auth: None,
        frozen: true,
    })
}

/// Answer `Select login method:` — arrows and Enter, never text.
pub async fn choose_method(state: &AppState, name: &str, index: usize) -> Result<(), AppError> {
    if index > 8 {
        return Err(AppError::BadRequest("login method index out of range".into()));
    }
    let rt = live_runtime(state, name).await?;
    let lock = state.lock_for(name);
    let _guard = lock.lock().await;
    for _ in 0..index {
        rt.send_key("Down").await?;
    }
    super::lifecycle::submit_gap_for(rt.as_ref()).await;
    rt.send_key("Enter").await?;
    Ok(())
}

/// Submit the pasted `code#state`.
///
/// Nothing here persists, logs or broadcasts `code`. The only place it goes is
/// the pty. The `Ok` carries no echo of it either — success is read back off the
/// screen (`Login successful`), never off the masked field.
/// `clear` first sends Ctrl-U. It is OPT-IN, and the card only sets it on a
/// RETRY: after `Invalid code…` the field may still hold the rejected attempt,
/// and a paste appended to it is rejected forever. On a first attempt the field
/// is known-empty (we typed `/login` ourselves two seconds earlier), and a blind
/// control byte into a masked credential field that might not bind Ctrl-U is a
/// worse failure than the stale-prefill bug it would be guarding against.
pub async fn submit_code(
    state: &AppState,
    name: &str,
    code: &str,
    clear: bool,
) -> Result<(), AppError> {
    let code = validate_code(code).map_err(AppError::BadRequest)?;
    let rt = live_runtime(state, name).await?;
    let lock = state.lock_for(name);
    let _guard = lock.lock().await;
    if clear {
        rt.send_key("C-u").await.ok();
    }
    rt.paste(&code, true).await?;
    super::lifecycle::submit_gap_for(rt.as_ref()).await;
    rt.send_key("Enter").await?;
    tracing::info!(session = %name, "login: code submitted ({REDACTED_CODE})");
    Ok(())
}

/// The Enter on `Login successful. Press Enter to continue…`, and the release.
///
/// MANDATORY, and it is not a formality: that keypress is what writes
/// `hasCompletedOnboarding` / `lastOnboardingVersion`. A wrapper that stops
/// driving at "Login successful" leaves the session parked AND makes every
/// later session on the host boot into the first-run wizard holding perfectly
/// valid credentials.
///
/// It deliberately does NOT re-send the prompt whose turn died on the 401:
/// Claude Code retries that turn itself once the credential lands, and a second
/// copy would run the work twice.
pub async fn confirm(state: &AppState, name: &str) -> Result<(), AppError> {
    let rt = live_runtime(state, name).await?;
    {
        let lock = state.lock_for(name);
        let _guard = lock.lock().await;
        rt.send_key("Enter").await?;
    }
    unfreeze(name);
    Ok(())
}

/// Abandon the flow: Esc out of the dialog and release supervision.
pub async fn cancel(state: &AppState, name: &str) -> Result<(), AppError> {
    let res = live_runtime(state, name).await;
    if let Ok(rt) = res {
        let lock = state.lock_for(name);
        let _guard = lock.lock().await;
        rt.send_key("Escape").await.ok();
    }
    // The release runs even when the session is gone — a freeze whose session
    // died is exactly the freeze nothing else would ever clear.
    unfreeze(name);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_code_must_carry_its_state_nonce() {
        assert!(validate_code("abc123").is_err());
        assert!(validate_code("").is_err());
        assert!(validate_code("code#state").is_ok());
    }

    #[test]
    fn a_code_may_not_smuggle_control_bytes_onto_the_pty() {
        assert!(validate_code("code\r#state").is_err());
        assert!(validate_code("code\x1b[200~#state").is_err());
        assert!(validate_code("code #state").is_err());
    }

    #[test]
    fn the_burst_is_bracketed_and_submitted_once() {
        let b = paste_burst("abc#def");
        assert_eq!(b, b"\x1b[200~abc#def\x1b[201~\r".to_vec());
    }

    #[test]
    fn masking_hides_a_code_and_leaves_prose_alone() {
        let code = "cQfTy2QK9nZ8vLpR3sWx7mBd4gHj1kAe#hVQ0m2rXqvY7bK1cLp9sTfR8dNzE4uJa";
        assert!(!mask_codes(&format!("pasted {code} ok")).contains(code));
        assert_eq!(mask_codes("run #42 again"), "run #42 again");
    }

    /// The real Claude Code 2.1.233 in-session `/login`, captured from a live
    /// pty at 100 columns: the composer echo of the slash command, the dialog's
    /// box rule, the URL block, then the field with TWO blank rows and
    /// `Esc to cancel` UNDER it.
    const CC233_PASTE: &str = "\
❯ /login

────────────────────────────────────────
  Login

  Browser didn't open? Use the url below to sign in (c to copy)

https://claude.com/cai/oauth/authorize?code=true&state=qdmN08Ic1LHPEqrasmcGdxuuUbs0F6btgz7tWcVdfdY


  Paste code here if prompted >

  Esc to cancel";

    #[test]
    fn the_field_is_seen_through_the_footer_the_tui_draws_under_it() {
        let got = read_login(CC233_PASTE).expect("2.1.233 draws a paste prompt here");
        assert_eq!(got.stage, Stage::PastePrompt);
        assert!(got.url.is_some_and(|u| u.contains("claude.com")));
    }

    #[test]
    fn the_field_is_still_seen_once_a_code_is_in_it() {
        // 2.1.233 does NOT mask this field — it echoes what was typed. A lens
        // that only knew the masked shape went blind at the exact moment the
        // code was on the screen, and the freeze released under it.
        let typed = CC233_PASTE.replace(
            "Paste code here if prompted >",
            "Paste code here if prompted > c0de#state",
        );
        assert_eq!(read_login(&typed).unwrap().stage, Stage::PastePrompt);
        let masked = CC233_PASTE.replace(
            "Paste code here if prompted >",
            "Paste code here if prompted > ********",
        );
        assert_eq!(read_login(&masked).unwrap().stage, Stage::PastePrompt);
    }

    #[test]
    fn prose_quoting_the_prompt_is_not_a_field() {
        // The row rule alone has to hold, independently of the composer rule:
        // the field's contents never contain whitespace.
        assert!(!is_paste_row("  labelled `Paste code here if prompted > ` for the code"));
        assert!(is_paste_row("  Paste code here if prompted > "));
    }

    #[test]
    fn an_error_under_the_field_still_reads_as_an_error() {
        // Ordering guard for the chrome skip: `Press Enter to retry.` is NOT
        // chrome, so the error screen never degrades into "still waiting".
        let cap = format!("{CC233_PASTE}\n\n  OAuth error: Request failed with status code 400\n\n  Press Enter to retry.\n\n  Esc to cancel");
        let got = read_login(&cap).unwrap();
        assert_eq!(got.stage, Stage::Error);
        assert_eq!(
            got.message.as_deref(),
            Some("OAuth error: Request failed with status code 400")
        );
    }

    #[test]
    fn a_freeze_expires_by_itself() {
        freeze("ttl-probe", "test");
        assert!(is_frozen("ttl-probe"));
        FROZEN.get_mut("ttl-probe").unwrap().at = Instant::now() - FREEZE_TTL - Duration::from_secs(1);
        assert!(!is_frozen("ttl-probe"));
    }

    #[test]
    fn unfreeze_is_idempotent() {
        unfreeze("never-frozen");
        freeze("idem", "test");
        unfreeze("idem");
        unfreeze("idem");
        assert!(!is_frozen("idem"));
    }
}
