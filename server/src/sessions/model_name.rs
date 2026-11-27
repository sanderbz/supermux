//! Model naming, both directions — the ONE place.
//!
//! `SessionView.live_model` carries an id AND a display name, but its two
//! sources each hand over only one: an assistant record's `message.model` is an
//! id (`claude-opus-5-5`), a `/model` answer is a display name (`Fable 5.2`, or
//! the Default row's `Opus 5.5 (default)`). These derive the other half.

/// A display name for a model id, as Claude Code's statusline prints it:
/// `claude-opus-5-5` → `Opus 5.5`, `claude-haiku-4-5-20251001` → `Haiku 4.5`,
/// `claude-opus-5[1m]` → `Opus 5 (1M context)`. Every id Claude Code 2.1.326
/// reported falls out of this rule (pinned by the tests). Anything
/// unrecognisable comes back as the id itself — honest, if not pretty.
pub fn display_for_id(id: &str) -> String {
    let (base, one_m) = match id.strip_suffix("[1m]") {
        Some(b) => (b, true),
        None => (id, false),
    };
    let Some(rest) = base.strip_prefix("claude-") else {
        return id.to_string();
    };
    let mut parts = rest.split('-');
    let Some(family) = parts
        .next()
        .filter(|f| !f.is_empty() && f.chars().all(|c| c.is_ascii_alphabetic()))
    else {
        return id.to_string();
    };
    // Version parts are short numbers; a trailing date stamp is not.
    let version: Vec<&str> = parts
        .filter(|p| p.len() <= 2 && p.chars().all(|c| c.is_ascii_digit()))
        .collect();
    let mut name = family[..1].to_ascii_uppercase() + &family[1..];
    if !version.is_empty() {
        name = format!("{name} {}", version.join("."));
    }
    if one_m {
        name.push_str(" (1M context)");
    }
    name
}

/// The inverse, for a `/model` answer that names only the display name
/// (`Fable 5.2` → `claude-fable-5-2`; the Default row's `Opus 5.5 (default)` →
/// `claude-opus-5-5`). Only the family half matters to a reader of the id (the
/// header checks its row by family), so an exact id is not promised.
pub fn id_for_display(display: &str) -> String {
    let base = display.split(" (").next().unwrap_or(display).trim();
    let mut words = base.split_whitespace();
    let family = words.next().unwrap_or("").to_ascii_lowercase();
    let version = words.next().unwrap_or("").replace('.', "-");
    let mut id = format!("claude-{family}");
    if !version.is_empty() {
        id = format!("{id}-{version}");
    }
    if display.contains("(1M context)") {
        id.push_str("[1m]");
    }
    id
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn display_names_for_the_ids_claude_code_reports() {
        assert_eq!(display_for_id("claude-opus-5-5"), "Opus 5.5");
        assert_eq!(display_for_id("claude-fable-5-2"), "Fable 5.2");
        assert_eq!(display_for_id("claude-sonnet-5-5"), "Sonnet 5.5");
        assert_eq!(display_for_id("claude-haiku-4-5-20251001"), "Haiku 4.5");
        assert_eq!(display_for_id("claude-opus-5[1m]"), "Opus 5 (1M context)");
        assert_eq!(display_for_id("claude-nova"), "Nova");
        // Not a Claude id: returned as-is rather than mangled.
        assert_eq!(display_for_id("gpt-x"), "gpt-x");
        assert_eq!(display_for_id("claude-"), "claude-");
    }

    #[test]
    fn ids_for_the_display_names_a_model_answer_carries() {
        assert_eq!(id_for_display("Fable 5.2"), "claude-fable-5-2");
        assert_eq!(id_for_display("Opus 5 (1M context)"), "claude-opus-5[1m]");
        assert_eq!(id_for_display("Haiku"), "claude-haiku");
        // The Default row's answer, live on 2.1.326:
        // `Set model to \`Opus 5.5 (default)\` for this session only`.
        assert_eq!(id_for_display("Opus 5.5 (default)"), "claude-opus-5-5");
        for id in ["claude-opus-5-5", "claude-fable-5-2", "claude-opus-5[1m]"] {
            assert_eq!(id_for_display(&display_for_id(id)), id, "round trip {id}");
        }
    }
}
