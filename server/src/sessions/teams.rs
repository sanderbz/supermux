//! Claude Code **Agent Teams** on-disk config reader.
//!
//! A Claude "agent team" is a LEAD session that spawns N teammate Claude sessions
//! as sibling tmux split-window PANES inside the lead's window. Claude Code writes
//! the team layout to `~/.claude/teams/{team}/config.json` regardless of supermux
//! env — that file is the SOURCE OF TRUTH for `members[].tmuxPaneId`, the team's
//! `leadSessionId`, and per-member metadata.
//!
//! This module resolves a `(team, member)` to its current tmux pane id (`%id`) and
//! the LEAD's bare supermux session name, then VALIDATES the `%id` still lives in
//! the lead's window before anyone streams it — tmux pane ids are a reused
//! server-global counter, so a freed `%id` can be re-handed to an unrelated pane.
//! Never cache a `%id`: re-read on every resolve (the plan's "re-read every tick"
//! rule, applied per-attach here).
//!
//! Everything here is DEFENSIVE: this is an experimental Claude Code feature whose
//! schema may drift, so unknown fields are ignored (`serde` default) and any parse
//! failure becomes a clean `Err`, never a panic.

use std::collections::HashSet;
use std::path::PathBuf;

use anyhow::{anyhow, Context, Result};
use serde::Deserialize;

use super::tmux;

/// One teammate as recorded in `config.json` `members[]`. Only the fields
/// needed are typed; the rest of the (drift-prone) schema is ignored.
#[derive(Debug, Clone, Deserialize)]
pub struct TeamMember {
    /// The member's stable name/id within the team (matches the `{member}` URL
    /// segment). Claude may key this as `name` or `id` depending on version, so
    /// both are accepted (see [`TeamMember::matches`]).
    #[serde(default)]
    pub name: Option<String>,
    #[serde(default)]
    pub id: Option<String>,
    /// The tmux pane id (`%id`) of this teammate's split-window pane. Absent for
    /// an `in-process` teammate (which has no pane — supermux forces `tmux` mode,
    /// so a live team's members should carry this).
    #[serde(rename = "tmuxPaneId", default)]
    pub tmux_pane_id: Option<String>,
}

impl TeamMember {
    /// Does this member match the requested `member` key (by `name` OR `id`)?
    fn matches(&self, member: &str) -> bool {
        self.name.as_deref() == Some(member) || self.id.as_deref() == Some(member)
    }

    /// The display/key for this member (prefers `name`, falls back to `id`).
    pub fn key(&self) -> Option<&str> {
        self.name.as_deref().or(self.id.as_deref())
    }
}

/// The shape of `~/.claude/teams/{team}/config.json` this module reads. Drift-tolerant:
/// unknown top-level fields are ignored.
#[derive(Debug, Clone, Deserialize)]
pub struct TeamConfig {
    /// The lead Claude session id. supermux maps this to a `supermux-<name>`
    /// session; see [`lead_session`](Self::lead_session) for the resolution.
    #[serde(rename = "leadSessionId", default)]
    pub lead_session_id: Option<String>,
    /// Some Claude versions record the lead under a different key — accept either.
    #[serde(rename = "leadName", default)]
    pub lead_name: Option<String>,
    #[serde(default)]
    pub members: Vec<TeamMember>,
}

impl TeamConfig {
    /// The lead's BARE supermux session name (no `supermux-` prefix). supermux
    /// runs the lead inside `supermux-<name>`, so the lead session id Claude
    /// records IS the bare name we validate panes against. Prefer `leadSessionId`,
    /// fall back to `leadName`.
    pub fn lead_session(&self) -> Option<&str> {
        self.lead_session_id
            .as_deref()
            .or(self.lead_name.as_deref())
    }

    /// Find the member by key (`name` or `id`).
    pub fn member(&self, member: &str) -> Option<&TeamMember> {
        self.members.iter().find(|m| m.matches(member))
    }
}

/// `~/.claude` (honouring `CLAUDE_CONFIG_DIR`), mirroring `claude_config` /
/// `resumable`'s resolution so a custom config dir is respected uniformly.
fn claude_config_dir() -> PathBuf {
    if let Ok(d) = std::env::var("CLAUDE_CONFIG_DIR") {
        let d = d.trim();
        if !d.is_empty() {
            return PathBuf::from(d);
        }
    }
    dirs::home_dir()
        .unwrap_or_else(|| PathBuf::from("."))
        .join(".claude")
}

/// Path to a team's config: `~/.claude/teams/{team}/config.json`.
pub fn team_config_path(team: &str) -> PathBuf {
    claude_config_dir()
        .join("teams")
        .join(team)
        .join("config.json")
}

/// Read + parse `~/.claude/teams/{team}/config.json`. Defensive: a missing file
/// or malformed JSON is an `Err` (callers surface it as a clean WS close), never
/// a panic. NEVER cached — read fresh so a `%id` is always current.
///
/// **Path safety.** `team` is validated against the supermux slug rule
/// ([`super::valid_name`]) BEFORE any filesystem use, so a `{team}` URL segment
/// like `../etc` can never traverse out of the teams directory.
pub fn read_team_config(team: &str) -> Result<TeamConfig> {
    if !super::valid_name(team) {
        return Err(anyhow!("invalid team name '{team}'"));
    }
    let path = team_config_path(team);
    let raw = std::fs::read_to_string(&path)
        .with_context(|| format!("reading team config {}", path.display()))?;
    serde_json::from_str::<TeamConfig>(&raw)
        .with_context(|| format!("parsing team config {}", path.display()))
}

/// A resolved + VALIDATED teammate pane, ready to stream.
#[derive(Debug, Clone)]
pub struct ResolvedPane {
    /// The lead's bare supermux session name (window the pane lives in).
    pub lead_session: String,
    /// The validated tmux pane id (`%id`).
    pub pane_id: String,
}

/// The pane-unique STREAM KEY for the registry + FIFO/log basenames:
/// `{team}/{member}`. Keyed by the STABLE team directory name (NOT the lead
/// session identifier) so the live WS create path and the end-of-team evict
/// path (`teams::board_sync::evict_teammate_streams`) compose the IDENTICAL
/// key. `leadSessionId` is often a Claude UUID, so keying on it left evict
/// unable to match the live entry and leaked the registry. Distinct per
/// teammate, stable across the team's life, and (after the streamer's sanitize)
/// a safe flat filename.
pub fn teammate_stream_key(team: &str, member: &str) -> String {
    format!("{team}/{member}")
}

/// Resolve `(team, member)` → a live, validated [`ResolvedPane`]. Steps, in order:
///   1. Read `config.json` FRESH (never cached — pane ids are reused).
///   2. Resolve the member's `tmuxPaneId` (or the caller's override).
///   3. Locate the BARE supermux session whose window currently contains the
///      `%id` via [`tmux::find_pane_session`] — scans every `supermux-*` session
///      in one tmux roundtrip. A `%id` not present anywhere is a true stale id
///      (refused, never streamed) — fail-closed so a re-handed pane can't leak.
///
/// **Why we don't trust `leadSessionId` for validation any more.**
/// Ground truth from `~/.claude/teams/viral-news-hunt/config.json` shows Claude
/// records `leadSessionId` as a Claude session UUID (`8a7e1f9e-…`), NOT the
/// supermux session name. The old code did `pane_in_session(leadSessionId, %id)`
/// → `tmux has-session -t supermux-8a7e1f9e-…` → false → "stale id" close 4404
/// → frontend reconnects forever. Finding the pane's CURRENT session directly
/// removes that whole brittleness without losing the staleness guard.
///
/// `pane_override` lets a caller (e.g. the frontend, which already has the
/// `%id` from the team model/SSE) skip config parsing for the pane id while still
/// going through validation. The lead-session field is populated from whichever
/// `supermux-*` window actually owns the pane (the validated answer, not the
/// raw config string), so downstream stream-keying is consistent.
pub async fn resolve_member_pane(
    team: &str,
    member: &str,
    pane_override: Option<&str>,
) -> Result<ResolvedPane> {
    // Path safety: both URL segments must be slug-safe BEFORE we touch the
    // filesystem (`read_team_config` revalidates `team`; this guards `member`
    // for symmetry + future FS keying off the member name).
    if !super::valid_name(member) {
        return Err(anyhow!("invalid member name '{member}'"));
    }
    let cfg = read_team_config(team)?;

    let pane_id = match pane_override {
        Some(p) if !p.trim().is_empty() => p.trim().to_string(),
        _ => cfg
            .member(member)
            .and_then(|m| m.tmux_pane_id.clone())
            .ok_or_else(|| {
                anyhow!("team '{team}' member '{member}' has no tmuxPaneId (in-process or absent)")
            })?,
    };

    // Locate the host supermux session by scanning live panes.
    // Returns the BARE session name (the supermux key), so the stream
    // key + diagnostics stay consistent with the session model.
    let host = tmux::find_pane_session(&pane_id)
        .await
        .with_context(|| format!("scanning live panes for {pane_id}"))?
        .ok_or_else(|| {
            anyhow!(
                "pane '{pane_id}' is not present in any supermux-* session \
                 (stale id or pane gone)"
            )
        })?;

    Ok(ResolvedPane {
        lead_session: host,
        pane_id,
    })
}

/// Resolve the LEAD pane of `session_name`'s tmux window when that session is
/// hosting an Agent Team (multi-bug fix: "main pane shows teammate content" +
/// "typing into lead doesn't reach").
///
/// **The bug it fixes.** `/ws/sessions/{name}` and its server-side `tmux`
/// commands historically address `supermux-{name}` (a SESSION target). tmux
/// resolves a session target to the **currently-active pane** in the session's
/// only window. For a single-pane session (no team) that's always the lead, so
/// the bug never surfaced. But once Claude `split-window`s a teammate, the
/// freshly-created teammate pane becomes active by default — and any agent
/// action (a `select-pane`, a teammate write that triggers tmux focus events)
/// can flip the active pane mid-stream. From that moment forward every
/// session-target command (`send-keys`, `capture-pane`, `pipe-pane`,
/// `resize-window`) silently retargets the teammate, so the user typing into
/// `/focus/<lead>` sees the teammate's screen and their keystrokes land in the
/// teammate's pty.
///
/// **The fix.** Find a team in `~/.claude/teams/*/config.json` whose teammate
/// `tmuxPaneId`s intersect the live panes of `supermux-{session_name}`'s window.
/// The LEAD pane is the window pane that is NOT in any teammate set. Return
/// `Some(pane_id)` so callers can target it explicitly via [`tmux::Tmux::for_pane`].
/// Returns `None` when:
///   * `session_name` isn't a team host (no config references its panes), OR
///   * the lead pane can't be uniquely discriminated this tick (e.g. the panes
///     have all churned), OR
///   * the tmux session is gone / the call faulted — fail-open: the caller
///     falls back to the historical session-target (today's behaviour, which
///     is correct for non-team sessions).
///
/// This is intentionally cheap and stateless: ONE `tmux list-panes` plus a
/// directory walk of `~/.claude/teams/`. Never cached — pane ids can churn
/// across ticks, and the team config can change on disk while the user is on
/// the focus route (`pane_override` is a hint, not a contract).
pub async fn resolve_lead_pane(session_name: &str) -> Option<String> {
    // 1. List the live panes in this session's window.
    let lead_tmux = tmux::Tmux::new(session_name);
    let live_panes = match lead_tmux.list_pane_ids().await {
        Ok(p) if !p.is_empty() => p,
        _ => return None,
    };
    // 2. Single-pane session → not a team OR the lead pane IS the only pane.
    //    Either way the session-target is already correct; tell the caller to
    //    keep the legacy behaviour. (Zero-regression for non-team sessions.)
    if live_panes.len() == 1 {
        return None;
    }
    // 3. Walk `~/.claude/teams/*/config.json` and collect every teammate `%id`
    //    across every team. We deliberately don't try to match team→session
    //    first: a team's `leadSessionId` is often a Claude UUID, not the
    //    supermux name, so the cheapest reliable signal
    //    is "any teammate %id that lives in THIS window means the team is
    //    hosted here, and the lead is the leftover pane."
    let teams_root = claude_config_dir().join("teams");
    let entries = match std::fs::read_dir(&teams_root) {
        Ok(e) => e,
        Err(_) => return None, // no teams dir → not a team
    };
    let mut teammate_panes: HashSet<String> = HashSet::new();
    for entry in entries.flatten() {
        let name = entry.file_name();
        let name_str = match name.to_str() {
            Some(s) => s,
            None => continue,
        };
        // Skip dot-prefixed (`.archived`, `.tmp`) and any non-dir entry.
        if name_str.starts_with('.') {
            continue;
        }
        if !entry.path().is_dir() {
            continue;
        }
        let cfg = match read_team_config(name_str) {
            Ok(c) => c,
            Err(_) => continue, // malformed config → skip this team
        };
        for m in &cfg.members {
            if let Some(p) = m.tmux_pane_id.as_deref() {
                let p = p.trim();
                if !p.is_empty() {
                    teammate_panes.insert(p.to_string());
                }
            }
        }
    }
    if teammate_panes.is_empty() {
        return None; // no teams known to claude → keep legacy session-target
    }
    // 4. Does at least one teammate pane live in this window? If not, this
    //    session isn't hosting any team — fall through.
    let any_teammate_here = live_panes.iter().any(|p| teammate_panes.contains(p));
    if !any_teammate_here {
        return None;
    }
    // 5. The lead pane = live panes minus all teammate panes. Expected: exactly
    //    one match. If the math gives 0 (every pane is a teammate — shouldn't
    //    happen) or >1 (multiple non-teammate panes — also unexpected), fall
    //    back to None so the caller keeps the legacy behaviour rather than
    //    guessing wrong.
    discriminate_lead_pane(&live_panes, &teammate_panes)
}

/// Pure helper: pick the LEAD pane from a window's `live_panes` given the
/// set of `teammate_panes` known to claude. Returns `Some(pane_id)` iff
/// exactly one pane is NOT in the teammate set (the lead pane). Returns `None`
/// in every other case (0 or >1 leftover panes) — the caller falls back to the
/// legacy session-target so an unexpected pane layout never produces a WRONG
/// answer (fail-open).
///
/// Factored out so the `live tmux + on-disk config` integration is one thin
/// adapter ([`resolve_lead_pane`]) and the discrimination MATH is exercised
/// directly by the unit tests below.
fn discriminate_lead_pane(
    live_panes: &[String],
    teammate_panes: &HashSet<String>,
) -> Option<String> {
    let mut non_teammate: Vec<&String> =
        live_panes.iter().filter(|p| !teammate_panes.contains(*p)).collect();
    if non_teammate.len() == 1 {
        return Some(non_teammate.remove(0).clone());
    }
    None
}

/// Pure guard for the kill-teammate endpoint (`DELETE
/// /api/sessions/{name}/teammates/{pane_id}`): may `pane_id` be killed inside a
/// window whose live panes are `live_panes`? The LEAD pane is `lead_pane` when
/// [`resolve_lead_pane`]'s config-based discrimination resolved one, else the
/// FIRST-listed pane (tmux lists a window's panes in index order and the lead
/// is the original, never-moved first pane). Errors map 1:1 onto the HTTP
/// contract:
///   * `NotFound` — `pane_id` is not in THIS session's window (unknown, stale,
///     or another session's pane — never killable through this session).
///   * `BadRequest` — `pane_id` IS the lead pane (killing it would end the
///     whole team; the lead tile's Stop owns that path).
pub fn validate_teammate_pane(
    live_panes: &[String],
    lead_pane: Option<&str>,
    pane_id: &str,
) -> Result<(), crate::error::AppError> {
    use crate::error::AppError;
    if !live_panes.iter().any(|p| p == pane_id) {
        return Err(AppError::NotFound(format!(
            "pane '{pane_id}' is not in this session's window"
        )));
    }
    let lead = lead_pane.or_else(|| live_panes.first().map(String::as_str));
    if lead == Some(pane_id) {
        return Err(AppError::BadRequest(
            "refusing to kill the lead pane — use Stop on the lead session".to_string(),
        ));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_minimal_config_and_resolves_member_fields() {
        // The drift-tolerant parse: extra fields ignored, member found by `name`,
        // pane id + lead session extracted.
        let json = r#"{
            "leadSessionId": "myproj",
            "someUnknownFutureField": 42,
            "members": [
                {"name": "worker-1", "tmuxPaneId": "%17", "color": "blue"},
                {"name": "worker-2", "tmuxPaneId": "%18"}
            ]
        }"#;
        let cfg: TeamConfig = serde_json::from_str(json).unwrap();
        assert_eq!(cfg.lead_session(), Some("myproj"));
        let m = cfg.member("worker-1").unwrap();
        assert_eq!(m.tmux_pane_id.as_deref(), Some("%17"));
        assert!(cfg.member("nope").is_none());
    }

    #[test]
    fn member_matches_by_id_when_name_absent() {
        let json = r#"{"leadName":"lead","members":[{"id":"m1","tmuxPaneId":"%3"}]}"#;
        let cfg: TeamConfig = serde_json::from_str(json).unwrap();
        // lead falls back to leadName; member matches by id.
        assert_eq!(cfg.lead_session(), Some("lead"));
        assert_eq!(cfg.member("m1").unwrap().tmux_pane_id.as_deref(), Some("%3"));
    }

    #[test]
    fn teammate_stream_key_is_team_slash_member() {
        assert_eq!(teammate_stream_key("teamA", "worker-1"), "teamA/worker-1");
    }

    #[test]
    fn missing_members_default_to_empty() {
        // A config with no members array still parses (defensive default).
        let cfg: TeamConfig = serde_json::from_str(r#"{"leadSessionId":"x"}"#).unwrap();
        assert!(cfg.members.is_empty());
    }

    #[test]
    fn read_team_config_rejects_traversal_team_name_before_fs() {
        // Path-safety guard: a `{team}` segment that fails the slug rule must
        // fail FAST with no filesystem read attempted. Spot-checks the
        // path-traversal vector + a sibling-escape vector.
        for bad in ["..", "../etc/passwd", "team/../other", ""] {
            let err = read_team_config(bad).unwrap_err().to_string();
            assert!(
                err.contains("invalid team name"),
                "expected invalid-team-name error for {bad:?}, got: {err}"
            );
        }
    }

    #[tokio::test]
    async fn resolve_member_pane_rejects_traversal_member_name() {
        // Symmetric guard for the `{member}` URL segment — also slug-validated
        // before the config read (which would otherwise trigger an FS read keyed
        // by `team`).
        let err = resolve_member_pane("ok-team", "../escape", None)
            .await
            .unwrap_err()
            .to_string();
        assert!(
            err.contains("invalid member name"),
            "expected invalid-member-name error, got: {err}"
        );
    }

    // Lead-pane discrimination — pins the multi-bug fix:
    // "main pane shows teammate content" + "typing into lead doesn't reach"
    // both stem from a session WS resolving to whatever tmux thinks is the
    // active pane. The pure math here is the single source of truth: the lead
    // pane is the window pane NOT in any teammate set.

    fn panes(ids: &[&str]) -> Vec<String> {
        ids.iter().map(|s| s.to_string()).collect()
    }
    fn teammates(ids: &[&str]) -> HashSet<String> {
        ids.iter().map(|s| s.to_string()).collect()
    }

    #[test]
    fn discriminate_picks_the_one_non_teammate_pane_as_lead() {
        // The bug repro layout from the live server: lead %6 plus three
        // teammates %7/%8/%9 split into the window. The session-target would
        // resolve to whichever pane tmux had active; the discrimination math
        // returns the LEAD pane unambiguously.
        let live = panes(&["%6", "%7", "%9", "%8"]); // any order tmux returns
        let mates = teammates(&["%7", "%8", "%9"]);
        assert_eq!(discriminate_lead_pane(&live, &mates), Some("%6".into()));
    }

    #[test]
    fn discriminate_returns_none_when_zero_panes_are_left() {
        // Every pane is a teammate (shouldn't happen — claude always leaves the
        // lead pane in the window — but if it does, fail-open rather than guess
        // wrong: returning None makes the caller use the session-target which
        // at worst lands on the active pane, the same as today).
        let live = panes(&["%7", "%8", "%9"]);
        let mates = teammates(&["%7", "%8", "%9"]);
        assert_eq!(discriminate_lead_pane(&live, &mates), None);
    }

    #[test]
    fn discriminate_returns_none_when_two_panes_are_left() {
        // Two non-teammate panes (e.g. the user manually `tmux split-window`d
        // their own pane, or claude is mid-spawn). Ambiguous → None, the
        // caller falls back to the session-target so we never write to a
        // wrong pane based on a guess.
        let live = panes(&["%6", "%10", "%7"]);
        let mates = teammates(&["%7"]);
        assert_eq!(discriminate_lead_pane(&live, &mates), None);
    }

    // Kill-teammate validation — pins the endpoint's HTTP contract: 404 for a
    // pane outside this window, 400 for the lead pane (config-resolved OR the
    // first-listed fallback), Ok only for a genuine teammate pane.

    #[test]
    fn validate_rejects_pane_outside_window_as_not_found() {
        let live = panes(&["%6", "%7", "%8"]);
        // A pane id from some OTHER session's window (or a stale/reused id) —
        // never killable through this session.
        let err = validate_teammate_pane(&live, Some("%6"), "%42").unwrap_err();
        assert!(matches!(err, crate::error::AppError::NotFound(_)), "got: {err:?}");
    }

    #[test]
    fn validate_rejects_resolved_lead_pane_as_bad_request() {
        let live = panes(&["%6", "%7", "%8"]);
        let err = validate_teammate_pane(&live, Some("%6"), "%6").unwrap_err();
        assert!(matches!(err, crate::error::AppError::BadRequest(_)), "got: {err:?}");
    }

    #[test]
    fn validate_falls_back_to_first_listed_pane_as_lead() {
        // Discrimination couldn't resolve the lead (None) → the first-listed
        // pane (tmux index order; the lead is the original first pane) is
        // protected instead — the guard never silently disarms.
        let live = panes(&["%6", "%7"]);
        let err = validate_teammate_pane(&live, None, "%6").unwrap_err();
        assert!(matches!(err, crate::error::AppError::BadRequest(_)), "got: {err:?}");
        // A single-pane window has ONLY the lead — nothing is killable.
        let solo = panes(&["%6"]);
        let err = validate_teammate_pane(&solo, None, "%6").unwrap_err();
        assert!(matches!(err, crate::error::AppError::BadRequest(_)), "got: {err:?}");
    }

    #[test]
    fn validate_allows_a_genuine_teammate_pane() {
        let live = panes(&["%6", "%7", "%8"]);
        assert!(validate_teammate_pane(&live, Some("%6"), "%8").is_ok());
        // Same with the first-listed fallback.
        assert!(validate_teammate_pane(&live, None, "%7").is_ok());
    }

    #[test]
    fn discriminate_passes_through_unrelated_teammate_panes() {
        // The teammate set may contain panes that don't live in THIS window
        // (other teams elsewhere) — those just don't intersect and don't
        // affect the math. The lead is still the one non-teammate in this
        // window. (The async wrapper above also requires AT LEAST ONE teammate
        // from any team to be in this window — that gate is tested
        // operationally; this pure helper just does the subtraction.)
        let live = panes(&["%42"]);
        let mates = teammates(&["%7", "%8"]); // panes in some other team
        assert_eq!(discriminate_lead_pane(&live, &mates), Some("%42".into()));
    }
}
