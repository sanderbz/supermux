//! Named key → pty bytes.
//!
//! The tmux path hands a key NAME to `tmux send-keys`, which owns the name →
//! bytes table. Without tmux we own it, so this module reproduces tmux's
//! `key-string.c` for every token supermux can actually emit: the REST
//! allowlist (`sessions::lifecycle::KEY_ALLOWLIST`), the WS `Key` frames, the
//! KeyBar/quick-keys chips, and the keys the server itself sends (`Enter`,
//! `Escape`, `C-c`, `BTab`).
//!
//! **Application cursor mode matters.** With DECCKM set (`\x1b[?1h` — readline,
//! vim, many TUIs) the arrows and Home/End must be sent as `SS3` (`\x1bOA`)
//! rather than `CSI` (`\x1b[A`), or the app sees literal garbage. tmux tracks
//! this per pane; we read it straight off our own VT, which is strictly more
//! direct.
//!
//! Unknown MULTI-character tokens return `None` (the caller rejects the
//! request, as tmux would); a single character is sent literally, which is what
//! makes the `y`/`n`/`q`/`~`/`|`/`$` chips work.

/// Translate one key name into the bytes to write to the pty.
///
/// `app_cursor` is the terminal's DECCKM state (see the module docs).
pub fn key_bytes(name: &str, app_cursor: bool) -> Option<Vec<u8>> {
    let name = normalize(name);
    let s: &str = &name;

    // Cursor keys + Home/End: CSI normally, SS3 in application-cursor mode.
    let csi_ss3 = |last: char| -> Option<Vec<u8>> {
        let intro = if app_cursor { "\x1bO" } else { "\x1b[" };
        Some(format!("{intro}{last}").into_bytes())
    };

    let out: Vec<u8> = match s {
        "Enter" => b"\r".to_vec(),
        "Escape" => b"\x1b".to_vec(),
        // Claude Code's "rewind / edit previous" double-tap, kept as one key so
        // the two bytes can't be split by an intervening keystroke.
        "EscEsc" => b"\x1b\x1b".to_vec(),
        "Tab" => b"\t".to_vec(),
        "BTab" => b"\x1b[Z".to_vec(),
        "Space" => b" ".to_vec(),
        "BSpace" => b"\x7f".to_vec(),
        "Up" => return csi_ss3('A'),
        "Down" => return csi_ss3('B'),
        "Right" => return csi_ss3('C'),
        "Left" => return csi_ss3('D'),
        "Home" => return csi_ss3('H'),
        "End" => return csi_ss3('F'),
        "PageUp" => b"\x1b[5~".to_vec(),
        "PageDown" => b"\x1b[6~".to_vec(),
        "IC" => b"\x1b[2~".to_vec(),
        "DC" => b"\x1b[3~".to_vec(),
        "F1" => b"\x1bOP".to_vec(),
        "F2" => b"\x1bOQ".to_vec(),
        "F3" => b"\x1bOR".to_vec(),
        "F4" => b"\x1bOS".to_vec(),
        "F5" => b"\x1b[15~".to_vec(),
        "F6" => b"\x1b[17~".to_vec(),
        "F7" => b"\x1b[18~".to_vec(),
        "F8" => b"\x1b[19~".to_vec(),
        "F9" => b"\x1b[20~".to_vec(),
        "F10" => b"\x1b[21~".to_vec(),
        "F11" => b"\x1b[23~".to_vec(),
        "F12" => b"\x1b[24~".to_vec(),
        _ => {
            if let Some(rest) = s.strip_prefix("C-") {
                return ctrl_bytes(rest);
            }
            if let Some(rest) = s.strip_prefix("M-") {
                return meta_bytes(rest);
            }
            // A single character is literal (`y`, `n`, `q`, `~`, `|`, `$`, …).
            let mut it = s.chars();
            match (it.next(), it.next()) {
                (Some(c), None) => c.to_string().into_bytes(),
                _ => return None,
            }
        }
    };
    Some(out)
}

/// `M-<x>` → `ESC` + `x`. Meta is the ESC prefix (tmux's default, and what
/// every readline app expects for `M-b` / `M-f` / `M-d`).
///
/// `x` must be exactly ONE printable ASCII character. `M-` used to append the
/// rest of the token verbatim, so `M-<anything>` was a hole straight through
/// the key-name allowlist into the pty: `M-` + arbitrary UTF-8 wrote arbitrary
/// bytes, and `M-[200~…` could forge control sequences. Named meta chords
/// (`M-Up`) are not part of supermux's key vocabulary, so rejecting every
/// multi-character form costs nothing and closes the hole.
fn meta_bytes(rest: &str) -> Option<Vec<u8>> {
    let mut it = rest.chars();
    match (it.next(), it.next()) {
        (Some(c), None) if c.is_ascii_graphic() || c == ' ' => Some(vec![0x1b, c as u8]),
        _ => None,
    }
}

/// `C-<x>` → the control byte. Letters fold to `x & 0x1f`; the punctuation
/// controls tmux supports are spelled out.
fn ctrl_bytes(rest: &str) -> Option<Vec<u8>> {
    let mut it = rest.chars();
    let (c, extra) = (it.next()?, it.next());
    if extra.is_some() {
        // `C-Space` is the only multi-char control name we accept (NUL).
        return if rest.eq_ignore_ascii_case("space") {
            Some(vec![0x00])
        } else {
            None
        };
    }
    let b = match c.to_ascii_lowercase() {
        'a'..='z' => (c.to_ascii_lowercase() as u8) & 0x1f,
        '@' | ' ' => 0x00,
        '[' => 0x1b,
        '\\' => 0x1c,
        ']' => 0x1d,
        '^' => 0x1e,
        '_' | '?' => 0x1f,
        _ => return None,
    };
    Some(vec![b])
}

/// Fold the friendly spellings the web client and the KeyBar emit onto the
/// tmux token the table is written in.
fn normalize(name: &str) -> String {
    match name {
        "Esc" => return "Escape".into(),
        "Return" => return "Enter".into(),
        "BackTab" | "ShiftTab" => return "BTab".into(),
        "Backspace" => return "BSpace".into(),
        // A bare LF: inserts a line break in Claude's prompt WITHOUT submitting.
        "Newline" | "LF" => return "C-j".into(),
        "Insert" => return "IC".into(),
        "Delete" | "Del" => return "DC".into(),
        "PPage" => return "PageUp".into(),
        "NPage" => return "PageDown".into(),
        _ => {}
    }
    if let Some(rest) = name.strip_prefix("Ctrl-") {
        return format!("C-{rest}");
    }
    if let Some(rest) = name.strip_prefix("Alt-") {
        return format!("M-{rest}");
    }
    if let Some(rest) = name.strip_prefix("Meta-") {
        return format!("M-{rest}");
    }
    name.to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Mirror of `sessions::lifecycle::KEY_ALLOWLIST` (private to that module,
    /// which this slice does not own). If a key is ever added there, this list
    /// must grow with it — the assertion below is what makes that visible.
    const REST_ALLOWLIST: &[&str] = &[
        "Enter", "Escape", "Tab", "BTab", "Space", "BSpace", "Up", "Down", "Left", "Right",
        "Home", "End", "PageUp", "PageDown", "IC", "DC", "C-c", "C-d", "C-z", "C-l", "C-a",
        "C-e", "C-k", "C-u", "C-r", "C-p", "C-n", "C-b", "C-f", "C-w", "M-b", "M-f", "M-d", "y",
        "n", "q", "F1", "F2", "F3", "F4", "F5", "F6", "F7", "F8", "F9", "F10", "F11", "F12",
    ];

    #[test]
    fn every_rest_allowlist_key_resolves_to_bytes() {
        for k in REST_ALLOWLIST {
            let b = key_bytes(k, false);
            assert!(b.is_some(), "no bytes for allowlisted key {k:?}");
            assert!(!b.unwrap().is_empty(), "empty bytes for {k:?}");
        }
    }

    #[test]
    fn keys_the_server_and_keybar_emit_resolve_too() {
        // KeyBar/quick-keys + the tokens lifecycle.rs sends itself + the ones
        // the brief calls out explicitly.
        for k in [
            "C-m", "C-j", "C-g", "Ctrl-C", "Ctrl-U", "Ctrl-L", "Ctrl-G", "Esc", "EscEsc",
            "Newline", "Backspace", "BackTab", "Insert", "Delete", "~", "/", "|", "&", "$", "#",
            "`", "*", "p", "d",
        ] {
            assert!(key_bytes(k, false).is_some(), "no bytes for {k:?}");
        }
    }

    #[test]
    fn control_and_named_bytes_match_the_wire_contract() {
        assert_eq!(key_bytes("Enter", false).unwrap(), b"\r");
        assert_eq!(key_bytes("C-m", false).unwrap(), b"\r");
        assert_eq!(key_bytes("C-j", false).unwrap(), b"\n");
        assert_eq!(key_bytes("Newline", false).unwrap(), b"\n");
        assert_eq!(key_bytes("Escape", false).unwrap(), b"\x1b");
        assert_eq!(key_bytes("EscEsc", false).unwrap(), b"\x1b\x1b");
        assert_eq!(key_bytes("C-c", false).unwrap(), b"\x03");
        assert_eq!(key_bytes("C-u", false).unwrap(), b"\x15");
        assert_eq!(key_bytes("C-g", false).unwrap(), b"\x07");
        assert_eq!(key_bytes("C-d", false).unwrap(), b"\x04");
        assert_eq!(key_bytes("C-z", false).unwrap(), b"\x1a");
        assert_eq!(key_bytes("C-l", false).unwrap(), b"\x0c");
        assert_eq!(key_bytes("C-w", false).unwrap(), b"\x17");
        assert_eq!(key_bytes("BTab", false).unwrap(), b"\x1b[Z");
        assert_eq!(key_bytes("BSpace", false).unwrap(), b"\x7f");
        assert_eq!(key_bytes("Tab", false).unwrap(), b"\t");
        assert_eq!(key_bytes("Space", false).unwrap(), b" ");
        assert_eq!(key_bytes("PageUp", false).unwrap(), b"\x1b[5~");
        assert_eq!(key_bytes("PageDown", false).unwrap(), b"\x1b[6~");
        assert_eq!(key_bytes("Home", false).unwrap(), b"\x1b[H");
        assert_eq!(key_bytes("End", false).unwrap(), b"\x1b[F");
        assert_eq!(key_bytes("IC", false).unwrap(), b"\x1b[2~");
        assert_eq!(key_bytes("DC", false).unwrap(), b"\x1b[3~");
        assert_eq!(key_bytes("M-b", false).unwrap(), b"\x1bb");
        assert_eq!(key_bytes("M-d", false).unwrap(), b"\x1bd");
        assert_eq!(key_bytes("F1", false).unwrap(), b"\x1bOP");
        assert_eq!(key_bytes("F12", false).unwrap(), b"\x1b[24~");
        assert_eq!(key_bytes("y", false).unwrap(), b"y");
    }

    #[test]
    fn arrows_switch_to_ss3_in_application_cursor_mode() {
        assert_eq!(key_bytes("Up", false).unwrap(), b"\x1b[A");
        assert_eq!(key_bytes("Up", true).unwrap(), b"\x1bOA");
        assert_eq!(key_bytes("Down", true).unwrap(), b"\x1bOB");
        assert_eq!(key_bytes("Right", true).unwrap(), b"\x1bOC");
        assert_eq!(key_bytes("Left", true).unwrap(), b"\x1bOD");
        assert_eq!(key_bytes("Home", true).unwrap(), b"\x1bOH");
        assert_eq!(key_bytes("End", true).unwrap(), b"\x1bOF");
        // PageUp/Down are CSI in both modes.
        assert_eq!(key_bytes("PageUp", true).unwrap(), b"\x1b[5~");
    }

    #[test]
    fn unknown_multi_char_tokens_are_rejected() {
        assert!(key_bytes("NoSuchKey", false).is_none());
        assert!(key_bytes("C-", false).is_none());
        assert!(key_bytes("", false).is_none());
        // …but any single char is literal.
        assert_eq!(key_bytes("!", false).unwrap(), b"!");
    }

    #[test]
    fn meta_takes_one_ascii_char_and_nothing_else() {
        // The forms that are actually used.
        assert_eq!(key_bytes("M-b", false).unwrap(), b"\x1bb");
        assert_eq!(key_bytes("Alt-x", false).unwrap(), b"\x1bx");
        assert_eq!(key_bytes("Meta-.", false).unwrap(), b"\x1b.");
        assert_eq!(key_bytes("M- ", false).unwrap(), b"\x1b ");

        // `M-` used to splice the remainder of the token straight into the pty.
        assert!(key_bytes("M-", false).is_none());
        assert!(key_bytes("M-Up", false).is_none(), "named meta chords are not our vocabulary");
        assert!(key_bytes("M-rm -rf /", false).is_none());
        assert!(key_bytes("M-[200~", false).is_none(), "must not forge control sequences");
        assert!(key_bytes("M-é", false).is_none(), "non-ASCII must not reach the pty");
        assert!(key_bytes("M-\x1b", false).is_none(), "no injecting a bare ESC");
        assert!(key_bytes("M-\n", false).is_none());
    }
}
