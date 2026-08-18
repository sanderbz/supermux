//! The archival file store: note format, atomic write, `INDEX.md`, and the
//! `save` write-back with lightweight ADD/UPDATE/NOOP dedup.
//!
//! **Format** copies Claude Code auto-memory verbatim — a YAML-ish frontmatter
//! block (`name`/`description`/`scope`/`type`/`modified`) then a free-form
//! Markdown body (Why / How-to-apply / `[[links]]`). Plain text: human-readable,
//! `git`-versionable, no DB.
//!
//! **Atomic write** mirrors [`crate::claude_tools::atomic`]'s proven
//! temp → fsync → `rename(2)` discipline (a crash mid-write never truncates a
//! note or the index), done synchronously here because the write CLI and recall
//! hook run as lean short-lived processes.

use std::fs;
use std::io::Write as _;
use std::path::{Path, PathBuf};

use anyhow::{Context, Result};

use super::{bot_dir, role_dir, slugify, NoteType, Scope};

/// Normalized token-Jaccard above which a new title is treated as a re-save of an
/// existing note (UPDATE in place) rather than a new one. Deliberately
/// conservative: slug-exact match is the primary dedup key; this only folds a
/// clear reword of the same fact (e.g. one extra word), never two distinct facts
/// that merely share a couple of common words.
const NEAR_DUP_THRESHOLD: f64 = 0.7;

/// One archival note, parsed from its `<slug>.md` file.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Note {
    pub slug: String,
    /// The one-sentence gist recall matches against (frontmatter `description`).
    pub description: String,
    pub scope: Scope,
    pub note_type: NoteType,
    /// RFC3339 `modified` stamp; empty if a hand-authored note omitted it.
    pub modified: String,
    /// The Markdown body below the frontmatter (Why / How / `[[links]]`).
    pub body: String,
}

impl Note {
    /// Render the full note file (frontmatter + body).
    pub fn render(&self) -> String {
        format!(
            "---\nname: {}\ndescription: {}\nscope: {}\ntype: {}\nmodified: {}\n---\n\n{}\n",
            self.slug,
            self.description,
            self.scope.as_str(),
            self.note_type.as_str(),
            self.modified,
            self.body.trim_end(),
        )
    }

    /// The `INDEX.md` line for this note: `- [<slug>](<slug>.md) — <description>`.
    /// Mirrors the auto-memory `MEMORY.md` one-gist-line-per-note shape.
    pub fn index_line(&self) -> String {
        format!("- [{}]({}.md) — {}", self.slug, self.slug, one_line(&self.description))
    }
}

/// One entry of an `INDEX.md`: the note slug + its gist. The recall hook reads
/// only the index to score, then loads the winning note bodies.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct IndexEntry {
    pub slug: String,
    pub description: String,
}

/// Parse a note file's text into a [`Note`]. Tolerant: a missing frontmatter
/// field falls back to a neutral default so a hand-edited note still loads.
pub fn parse_note(text: &str) -> Option<Note> {
    let rest = text.strip_prefix("---")?;
    let end = rest.find("\n---")?;
    let front = &rest[..end];
    // Body starts after the closing `---` line. Trim the trailing newline the
    // renderer adds so render→parse round-trips exactly.
    let after = &rest[end + 4..];
    let body = after.trim_start_matches('\n').trim_end().to_string();

    let mut slug = String::new();
    let mut description = String::new();
    let mut scope = Scope::Bot;
    let mut note_type = NoteType::Reference;
    let mut modified = String::new();
    for line in front.lines() {
        let Some((k, v)) = line.split_once(':') else {
            continue;
        };
        let v = v.trim();
        match k.trim() {
            "name" => slug = v.to_string(),
            "description" => description = v.to_string(),
            "scope" => scope = Scope::parse(v).unwrap_or(Scope::Bot),
            "type" => note_type = NoteType::parse(v),
            "modified" => modified = v.to_string(),
            _ => {}
        }
    }
    if slug.is_empty() {
        return None;
    }
    Some(Note {
        slug,
        description,
        scope,
        note_type,
        modified,
        body,
    })
}

/// Read + parse one note by slug from a tier dir. `None` if absent/unparseable.
pub fn load_note(dir: &Path, slug: &str) -> Option<Note> {
    let text = fs::read_to_string(dir.join(format!("{slug}.md"))).ok()?;
    parse_note(&text)
}

/// Parse an `INDEX.md` into its entries. Robust to blank lines and any non-entry
/// prose a human added around the list. `None`-safe: a missing file is `[]`.
pub fn read_index(dir: &Path) -> Vec<IndexEntry> {
    let Ok(text) = fs::read_to_string(dir.join("INDEX.md")) else {
        return Vec::new();
    };
    parse_index(&text)
}

fn parse_index(text: &str) -> Vec<IndexEntry> {
    let mut out = Vec::new();
    for line in text.lines() {
        // `- [<slug>](<slug>.md) — <description>`
        let line = line.trim();
        let Some(rest) = line.strip_prefix("- [") else {
            continue;
        };
        let Some(close) = rest.find(']') else { continue };
        let slug = rest[..close].to_string();
        let description = rest
            .split_once('—')
            .map(|(_, d)| d.trim().to_string())
            .unwrap_or_default();
        if !slug.is_empty() {
            out.push(IndexEntry { slug, description });
        }
    }
    out
}

/// Rewrite `INDEX.md` from a set of entries, newest-appended-last. Header comment
/// mirrors the auto-memory `MEMORY.md` "index" note.
fn render_index(entries: &[IndexEntry]) -> String {
    let mut out = String::from("# Memory index\n\n");
    for e in entries {
        out.push_str(&format!("- [{}]({}.md) — {}\n", e.slug, e.slug, one_line(&e.description)));
    }
    out
}

/// The outcome of a [`save`] call — the mem0-style dedup verb.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SaveOutcome {
    /// A new note file + a new index line.
    Add,
    /// An existing note (same slug or a near-identical title) rewritten with the
    /// new body/type and a fresh `modified` stamp.
    Update,
    /// The note already exists with identical body + type — nothing written, the
    /// `modified` stamp untouched.
    Noop,
}

impl SaveOutcome {
    pub fn as_str(self) -> &'static str {
        match self {
            SaveOutcome::Add => "ADD",
            SaveOutcome::Update => "UPDATE",
            SaveOutcome::Noop => "NOOP",
        }
    }
}

/// The write-back primitive. Writes/updates one note in the tier `dir`, keeps
/// `INDEX.md` in lockstep, and reports ADD/UPDATE/NOOP.
///
/// Dedup key: the slug derived from `title`. If a note with that slug exists, the
/// body+type decide UPDATE vs NOOP. Otherwise a near-duplicate title already in
/// the index (normalized token Jaccard ≥ 0.85) is UPDATEd in place rather than
/// spawning a second near-identical note. Failing both, it is an ADD.
///
/// Returns `(outcome, slug)`.
pub fn save(
    dir: &Path,
    scope: Scope,
    note_type: NoteType,
    title: &str,
    body: &str,
    now_rfc3339: &str,
) -> Result<(SaveOutcome, String)> {
    fs::create_dir_all(dir).with_context(|| format!("creating {}", dir.display()))?;
    let mut entries = read_index(dir);

    let slug = slugify(title);

    // 1) Exact-slug hit → compare body+type for NOOP vs UPDATE.
    if let Some(existing) = load_note(dir, &slug) {
        if existing.body.trim() == body.trim() && existing.note_type == note_type {
            return Ok((SaveOutcome::Noop, slug));
        }
        write_note(dir, &slug, scope, note_type, title, body, now_rfc3339)?;
        upsert_index(&mut entries, &slug, title);
        write_index(dir, &entries)?;
        return Ok((SaveOutcome::Update, slug));
    }

    // 2) Near-duplicate title already indexed → UPDATE that note in place.
    if let Some(dup) = entries
        .iter()
        .find(|e| title_similarity(&e.description, title) >= NEAR_DUP_THRESHOLD || e.slug == slug)
        .map(|e| e.slug.clone())
    {
        write_note(dir, &dup, scope, note_type, title, body, now_rfc3339)?;
        upsert_index(&mut entries, &dup, title);
        write_index(dir, &entries)?;
        return Ok((SaveOutcome::Update, dup));
    }

    // 3) ADD.
    write_note(dir, &slug, scope, note_type, title, body, now_rfc3339)?;
    upsert_index(&mut entries, &slug, title);
    write_index(dir, &entries)?;
    Ok((SaveOutcome::Add, slug))
}

fn write_note(
    dir: &Path,
    slug: &str,
    scope: Scope,
    note_type: NoteType,
    title: &str,
    body: &str,
    now_rfc3339: &str,
) -> Result<()> {
    let note = Note {
        slug: slug.to_string(),
        description: one_line(title),
        scope,
        note_type,
        modified: now_rfc3339.to_string(),
        body: body.to_string(),
    };
    write_atomic(&dir.join(format!("{slug}.md")), &note.render())
}

fn write_index(dir: &Path, entries: &[IndexEntry]) -> Result<()> {
    write_atomic(&dir.join("INDEX.md"), &render_index(entries))
}

/// Insert or replace the index line for `slug`, keeping insertion order (a
/// replace updates in place; a new slug appends).
fn upsert_index(entries: &mut Vec<IndexEntry>, slug: &str, title: &str) {
    let description = one_line(title);
    if let Some(e) = entries.iter_mut().find(|e| e.slug == slug) {
        e.description = description;
    } else {
        entries.push(IndexEntry {
            slug: slug.to_string(),
            description,
        });
    }
}

/// Synchronous atomic text write: temp sibling → fsync → `rename(2)`. Same
/// crash-safety contract as [`crate::claude_tools::atomic::write_json_atomic`],
/// sync because the callers are lean one-shot processes.
pub fn write_atomic(path: &Path, contents: &str) -> Result<()> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).with_context(|| format!("creating {}", parent.display()))?;
    }
    let name = path
        .file_name()
        .map(|s| s.to_string_lossy().into_owned())
        .unwrap_or_else(|| "note.md".into());
    let nonce = format!(
        "{}-{}",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or(0)
    );
    let tmp = path.with_file_name(format!(".{name}.supermux-tmp-{nonce}"));
    let mut f = fs::File::create(&tmp).with_context(|| format!("creating {}", tmp.display()))?;
    f.write_all(contents.as_bytes())?;
    f.sync_all()?;
    drop(f);
    fs::rename(&tmp, path)
        .with_context(|| format!("renaming {} -> {}", tmp.display(), path.display()))?;
    Ok(())
}

/// Resolve the tier dir for a scope, given the store root + identity. Role scope
/// with no role key is an error (a private-only bot cannot write the shared tier).
pub fn tier_dir(root: &Path, scope: Scope, session_name: &str, role_key: &str) -> Result<PathBuf> {
    match scope {
        Scope::Bot => Ok(bot_dir(root, session_name)),
        Scope::Role => {
            if role_key.trim().is_empty() {
                anyhow::bail!("--scope role requires a role (BOT_MEMORY_ROLE is empty for this bot)");
            }
            Ok(role_dir(root, role_key))
        }
    }
}

/// Collapse a title/description to a single trimmed line (an index line and a
/// frontmatter value must never carry a raw newline).
fn one_line(s: &str) -> String {
    s.split_whitespace().collect::<Vec<_>>().join(" ")
}

/// Normalized token-set Jaccard similarity of two titles — the near-duplicate
/// gate. Lowercased, split on non-alphanumerics, short tokens dropped.
fn title_similarity(a: &str, b: &str) -> f64 {
    let ta = token_set(a);
    let tb = token_set(b);
    if ta.is_empty() || tb.is_empty() {
        return 0.0;
    }
    let inter = ta.iter().filter(|t| tb.contains(*t)).count();
    let union = ta.len() + tb.len() - inter;
    if union == 0 {
        0.0
    } else {
        inter as f64 / union as f64
    }
}

fn token_set(s: &str) -> std::collections::BTreeSet<String> {
    s.to_lowercase()
        .split(|c: char| !c.is_alphanumeric())
        .filter(|t| t.len() >= 3)
        .map(|t| t.to_string())
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tmp() -> PathBuf {
        let d = std::env::temp_dir().join(format!("bm-store-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&d).unwrap();
        d
    }

    #[test]
    fn render_then_parse_roundtrips() {
        let note = Note {
            slug: "grep-oom".into(),
            description: "never use bounded quantifiers on long-line greps".into(),
            scope: Scope::Bot,
            note_type: NoteType::Bugfix,
            modified: "2026-08-18T12:00:00Z".into(),
            body: "**Why:** it OOMs.\n\n**How:** use -F.\n\nSee also [[watchdog]].".into(),
        };
        let parsed = parse_note(&note.render()).expect("parses");
        assert_eq!(parsed, note);
    }

    #[test]
    fn save_add_then_noop_then_update() {
        let d = tmp();
        let (o1, slug) = save(&d, Scope::Bot, NoteType::Reference, "Deploy flow", "ship via release", "T0").unwrap();
        assert_eq!(o1, SaveOutcome::Add);

        // Same title + body + type → NOOP, modified untouched.
        let (o2, _) = save(&d, Scope::Bot, NoteType::Reference, "Deploy flow", "ship via release", "T1").unwrap();
        assert_eq!(o2, SaveOutcome::Noop);
        assert_eq!(load_note(&d, &slug).unwrap().modified, "T0", "NOOP must not restamp");

        // Same title, changed body → UPDATE, modified refreshed.
        let (o3, _) = save(&d, Scope::Bot, NoteType::Reference, "Deploy flow", "ship via in-app updater", "T2").unwrap();
        assert_eq!(o3, SaveOutcome::Update);
        let n = load_note(&d, &slug).unwrap();
        assert_eq!(n.modified, "T2");
        assert_eq!(n.body.trim(), "ship via in-app updater");

        // INDEX has exactly one line for this slug.
        let idx = read_index(&d);
        assert_eq!(idx.iter().filter(|e| e.slug == slug).count(), 1, "one index line, not duplicated");
        fs::remove_dir_all(&d).ok();
    }

    #[test]
    fn near_duplicate_title_updates_in_place() {
        let d = tmp();
        let (_, slug1) = save(&d, Scope::Bot, NoteType::Reference, "The grep OOM defense", "a", "T0").unwrap();
        // Near-identical title (extra word) → UPDATE the same note, not a 2nd file.
        let (o, slug2) = save(&d, Scope::Bot, NoteType::Reference, "The grep OOM defense rule", "b", "T1").unwrap();
        assert_eq!(o, SaveOutcome::Update);
        assert_eq!(slug1, slug2, "near-dup folds onto the original slug");
        assert_eq!(read_index(&d).len(), 1);
        fs::remove_dir_all(&d).ok();
    }

    #[test]
    fn role_scope_requires_role_key() {
        let root = tmp();
        assert!(tier_dir(&root, Scope::Role, "alpha", "").is_err());
        assert!(tier_dir(&root, Scope::Role, "alpha", "reviewer").is_ok());
        assert!(tier_dir(&root, Scope::Bot, "alpha", "").is_ok());
        fs::remove_dir_all(&root).ok();
    }
}
