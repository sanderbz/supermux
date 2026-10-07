//! One transcript identity shared by the tailer, seed, history and full-entry reads.
use super::parser::Dialect;
use std::path::PathBuf;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TranscriptSource {
    pub project: PathBuf,
    pub working_dir: String,
    pub last_started: i64,
    pub owner_verified: bool,
    pub conversation_id: String,
    pub dialect: Dialect,
}
impl TranscriptSource {
    pub fn same_transcript(&self, other: &Self) -> bool {
        self.project == other.project
            && self.conversation_id == other.conversation_id
            && self.dialect == other.dialect
            && self.working_dir == other.working_dir
            && self.last_started == other.last_started
    }
    pub fn path(&self) -> PathBuf {
        self.project.join(format!("{}.jsonl", self.conversation_id))
    }
}

pub fn resolve(
    row: &crate::db::sessions::Session,
    pinned: Option<TranscriptSource>,
) -> Option<TranscriptSource> {
    let dialect = Dialect::for_provider(&row.provider);
    if dialect == Dialect::Codex {
        if let Some(source) =
            pinned.filter(|s| valid_pin(s, &row.dir, row.last_started, &row.codex_session_id))
        {
            return Some(source);
        }
    }
    let (project, conversation_id) = match dialect {
        Dialect::Claude => (
            crate::sessions::resumable::project_dir_for(&row.config_dir, &row.dir),
            row.cc_conversation_id.clone(),
        ),
        Dialect::Codex => {
            super::codex::locate_session_started(&row.dir, &row.codex_session_id, row.last_started)?
        }
    };
    Some(TranscriptSource {
        project,
        working_dir: row.dir.clone(),
        last_started: row.last_started,
        owner_verified: false,
        conversation_id,
        dialect,
    })
}

fn valid_pin(source: &TranscriptSource, dir: &str, started: i64, saved_id: &str) -> bool {
    source.dialect == Dialect::Codex
        && source.working_dir == dir
        && source.last_started == started
        && (source.owner_verified
            || saved_id.is_empty()
            || source.conversation_id.ends_with(saved_id))
}

/// Read-only process ownership outranks directory discovery. This works through
/// the native holder and tmux runtime and does not install hooks or restart agents.
pub async fn for_session(
    state: &crate::state::AppState,
    row: &crate::db::sessions::Session,
    throttle: bool,
) -> Option<TranscriptSource> {
    let store = state.chat_store(&row.name);
    let pinned = store.as_ref().and_then(|store| store.source());
    if row.provider == "codex" {
        if !owner_probe_allowed(
            store.as_deref(),
            &row.dir,
            row.last_started,
            &row.codex_session_id,
            throttle,
        ) {
            return pinned.filter(|source| {
                valid_pin(source, &row.dir, row.last_started, &row.codex_session_id)
            });
        }
        if let Ok(rt) = state.runtime_for(&row.name).await {
            if let Some(group) = foreground_group(rt.as_ref()).await {
                if let Some(paths) = process_rollouts(group).await {
                    let dir = row.dir.clone();
                    let owned = tokio::task::spawn_blocking(move || {
                        super::codex::source_from_paths(paths, &dir)
                    })
                    .await
                    .ok()
                    .flatten();
                    if let Some((project, conversation_id)) = owned {
                        // The current foreground owner proves terminal-side
                        // resume even when the persisted ID is still the old one.
                        return Some(TranscriptSource {
                            project,
                            working_dir: row.dir.clone(),
                            last_started: row.last_started,
                            owner_verified: true,
                            conversation_id,
                            dialect: Dialect::Codex,
                        });
                    }
                    // A successful ownership probe with no single root is a
                    // real ambiguity/boot window, not permission to guess by cwd.
                    return pinned.filter(|s| {
                        valid_pin(s, &row.dir, row.last_started, &row.codex_session_id)
                    });
                }
            }
        }
    }
    let row = row.clone();
    tokio::task::spawn_blocking(move || resolve(&row, pinned))
        .await
        .ok()
        .flatten()
}

fn owner_probe_allowed(
    store: Option<&super::store::ChatStore>,
    dir: &str,
    started: i64,
    saved_id: &str,
    throttle: bool,
) -> bool {
    !throttle || store.is_none_or(|store| store.claim_owner_probe(dir, started, saved_id))
}

/// The shared runtime foreground helper reads Linux /proc. Keep this macOS
/// lookup local to transcript ownership: it must not change signal/reaper logic.
async fn foreground_group(rt: &dyn crate::sessions::runtime::SessionRuntime) -> Option<u32> {
    #[cfg(target_os = "macos")]
    {
        let shell = rt.pane_pid().await.ok().flatten()?;
        let mut command = tokio::process::Command::new("/bin/ps");
        command
            .args(["-o", "tpgid=", "-p", &shell.to_string()])
            .kill_on_drop(true);
        let output = tokio::time::timeout(std::time::Duration::from_secs(2), command.output())
            .await
            .ok()?
            .ok()?;
        if !output.status.success() {
            return None;
        }
        foreground_from_ps(&String::from_utf8_lossy(&output.stdout), shell)
    }
    #[cfg(not(target_os = "macos"))]
    {
        crate::sessions::swarm::lead_pid_of(rt).await
    }
}

#[cfg(any(target_os = "macos", test))]
fn foreground_from_ps(output: &str, shell: u32) -> Option<u32> {
    let foreground: u32 = output.trim().parse().ok()?;
    (foreground > 0 && foreground != shell).then_some(foreground)
}

async fn process_rollouts(group: u32) -> Option<Vec<PathBuf>> {
    use std::time::Duration;
    let mut command = tokio::process::Command::new("ps");
    command
        .args(["-axo", "pid=,ppid=,pgid="])
        .kill_on_drop(true);
    let output = tokio::time::timeout(Duration::from_secs(2), command.output())
        .await
        .ok()?
        .ok()?;
    if !output.status.success() {
        return None;
    }
    let pids = owned_pids(&String::from_utf8_lossy(&output.stdout), group)?;
    #[cfg(target_os = "linux")]
    {
        let mut paths = Vec::new();
        let mut accessible = false;
        for pid in pids {
            if let Ok(entries) = std::fs::read_dir(format!("/proc/{pid}/fd")) {
                accessible = true;
                paths.extend(
                    entries
                        .flatten()
                        .filter_map(|entry| std::fs::read_link(entry.path()).ok()),
                );
            }
        }
        accessible.then_some(paths)
    }
    #[cfg(not(target_os = "linux"))]
    {
        let ids = pids
            .iter()
            .map(u32::to_string)
            .collect::<Vec<_>>()
            .join(",");
        let executable = if cfg!(target_os = "macos") {
            "/usr/sbin/lsof"
        } else {
            "lsof"
        };
        let mut command = tokio::process::Command::new(executable);
        command
            .args(["-nP", "-b", "-w", "-a", "-p", &ids, "-Fn"])
            .kill_on_drop(true);
        let output = tokio::time::timeout(Duration::from_secs(2), command.output())
            .await
            .ok()?
            .ok()?;
        if !output.status.success() {
            return None;
        }
        Some(
            String::from_utf8_lossy(&output.stdout)
                .lines()
                .filter_map(|line| line.strip_prefix('n').map(PathBuf::from))
                .collect(),
        )
    }
}

/// Include foreground descendants that create their own process groups (Codex
/// app-server does this). A partial tree is not sufficient ownership evidence.
fn owned_pids(snapshot: &str, foreground: u32) -> Option<Vec<u32>> {
    use std::collections::BTreeSet;
    let rows: Vec<(u32, u32, u32)> = snapshot
        .lines()
        .filter_map(|line| {
            let mut fields = line.split_whitespace();
            Some((
                fields.next()?.parse().ok()?,
                fields.next()?.parse().ok()?,
                fields.next()?.parse().ok()?,
            ))
        })
        .collect();
    let mut owned: BTreeSet<u32> = rows
        .iter()
        .filter(|row| row.2 == foreground)
        .map(|row| row.0)
        .collect();
    if owned.is_empty() || owned.len() > 128 {
        return None;
    }
    for _ in 0..16 {
        let next: Vec<u32> = rows
            .iter()
            .filter(|row| owned.contains(&row.1) && !owned.contains(&row.0))
            .map(|row| row.0)
            .collect();
        if next.is_empty() {
            return Some(owned.into_iter().collect());
        }
        owned.extend(next);
        if owned.len() > 128 {
            return None;
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn macos_foreground_metadata_resolves_agent_and_rejects_idle_or_missing_tty() {
        // Observed native shell209 has TPGID306; its daemon411 has no TTY.
        assert_eq!(foreground_from_ps("  306\n", 209), Some(306));
        assert_eq!(foreground_from_ps("209\n", 209), None);
        for output in ["0\n", "-1\n", "", "invalid", "306\n411\n"] {
            assert_eq!(foreground_from_ps(output, 209), None, "{output:?}");
        }
    }

    #[test]
    fn rest_discovery_cannot_consume_the_tailers_adoption_probe() {
        let store = super::super::store::ChatStore::new();
        for _ in 0..100 {
            assert!(owner_probe_allowed(
                Some(&store),
                "/fixture",
                1,
                "thread",
                false
            ));
        }
        assert!(owner_probe_allowed(
            Some(&store),
            "/fixture",
            1,
            "thread",
            true
        ));
        assert!(!owner_probe_allowed(
            Some(&store),
            "/fixture",
            1,
            "thread",
            true
        ));
    }
    #[test]
    fn verified_resume_pin_survives_stale_saved_id_but_not_a_session_restart() {
        let mut pin = TranscriptSource {
            project: PathBuf::from("/fixture"),
            working_dir: "/fixture".into(),
            last_started: 10,
            owner_verified: true,
            conversation_id: "rollout-new-thread".into(),
            dialect: Dialect::Codex,
        };
        assert!(valid_pin(&pin, "/fixture", 10, "old-thread"));
        assert!(!valid_pin(&pin, "/fixture", 20, "old-thread"));
        pin.owner_verified = false;
        assert!(!valid_pin(&pin, "/fixture", 10, "old-thread"));
        assert!(valid_pin(&pin, "/fixture", 10, "new-thread"));
    }
    #[test]
    fn foreground_tree_includes_cross_group_daemon_but_not_unrelated_cli() {
        let pids = owned_pids(
            "306 209 306\n411 306 411\n984 411 984\n8829 20 8829\n55574 20 55574\n",
            306,
        )
        .unwrap();
        assert_eq!(pids, vec![306, 411, 984]);
    }
    #[test]
    fn ownership_tree_overflow_is_not_a_partial_answer() {
        let mut rows = String::from("1 0 1\n");
        for pid in 2..140 {
            rows.push_str(&format!("{pid} 1 {pid}\n"));
        }
        assert!(owned_pids(&rows, 1).is_none());
    }
}
