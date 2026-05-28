//! Build script (TECH_PLAN §8.1).
//!
//! Two jobs:
//!   1. `scripts/build.sh` copies `web/dist` → `server/static` before
//!      `cargo build --release`; the `#[derive(RustEmbed)] #[folder = "static/"]`
//!      in `src/static_assets.rs` embeds that directory into the binary at
//!      compile time. This script tells Cargo to re-run the build (and thus
//!      re-embed) whenever the generated web assets change, so a frontend
//!      rebuild is never silently stale.
//!   2. Bake compile-time version metadata (tag, sha, build timestamp) into
//!      env vars the `crate::updates` module reads with `option_env!`. The
//!      in-UI updater (v0.3.0) compares CURRENT_TAG/SHA against the latest
//!      GitHub release to decide whether an upgrade is available. Falls back
//!      to "dev" cleanly when run outside a git working tree (e.g. a packaged
//!      tarball build), so the build never depends on git.

use std::path::Path;
use std::process::Command;

fn main() {
    // ── 1. re-embed when the built web bundle changes ────────────────────────
    println!("cargo:rerun-if-changed=static");

    // rust-embed reads `static/` at compile time. If the build is run before
    // `build.sh`/`bun run build` has populated it, emit a loud warning rather
    // than failing — `cargo test` against a checkout without a frontend build
    // must still compile (the embed is just empty).
    if !Path::new("static").exists() {
        std::fs::create_dir_all("static").ok();
        println!(
            "cargo:warning=server/static is empty — run scripts/build.sh (or `bun run build` + copy) to embed the frontend; the binary will serve no SPA until then"
        );
    }

    // ── 2. bake version metadata for the in-UI updater ───────────────────────
    // Re-run if HEAD or any ref moves so a fresh commit reflects on next build.
    // These paths may not exist outside a git checkout — that's fine; Cargo just
    // notes them and re-runs when they appear or change.
    println!("cargo:rerun-if-changed=../.git/HEAD");
    println!("cargo:rerun-if-changed=../.git/refs");
    println!("cargo:rerun-if-changed=../.git/packed-refs");
    println!("cargo:rerun-if-env-changed=SUPERMUX_VERSION_TAG");
    println!("cargo:rerun-if-env-changed=SUPERMUX_VERSION_SHA");

    let tag = env_or_git_tag();
    let sha = env_or_git_sha();
    let build_time = build_timestamp_utc();

    println!("cargo:rustc-env=SUPERMUX_VERSION_TAG={}", tag);
    println!("cargo:rustc-env=SUPERMUX_VERSION_SHA={}", sha);
    println!("cargo:rustc-env=SUPERMUX_BUILD_TIME={}", build_time);
}

/// Tag resolution: explicit env var wins (CI/release builds AND the
/// workstation→remote `scripts/deploy.sh` path, which captures the tag from
/// the LOCAL `.git/` and forwards it via env — the remote tarball has no
/// `.git/`, so a git-describe-only fallback bakes "dev" into every shipped
/// binary), else `git describe --tags --always --dirty` (covers a normal
/// `cargo build` from a developer's checkout), else the literal `"dev"`. The
/// `"dev"` sentinel passes through `parse_tag()` as `None`, so the UI shows a
/// dev-build badge — the correct surface for a truly tagless build.
fn env_or_git_tag() -> String {
    if let Ok(v) = std::env::var("SUPERMUX_VERSION_TAG") {
        if !v.is_empty() {
            return v;
        }
    }
    run_git(&["describe", "--tags", "--always", "--dirty"]).unwrap_or_else(|| "dev".to_string())
}

/// Commit SHA: explicit env var wins (same `deploy.sh` injection as the tag
/// path above), else `git rev-parse HEAD`, else `"dev"`.
fn env_or_git_sha() -> String {
    if let Ok(v) = std::env::var("SUPERMUX_VERSION_SHA") {
        if !v.is_empty() {
            return v;
        }
    }
    run_git(&["rev-parse", "HEAD"]).unwrap_or_else(|| "dev".to_string())
}

/// UTC build timestamp, ISO-8601 (e.g. `2026-05-28T01:23:45Z`). Falls back to
/// the empty string if the system clock is somehow unavailable (never seen).
fn build_timestamp_utc() -> String {
    // Cheap, no chrono dep dance in build.rs — use the SystemTime + format ourselves.
    use std::time::{SystemTime, UNIX_EPOCH};
    let secs = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0);
    // Convert epoch seconds to a calendar date/time in UTC without pulling
    // chrono: a small Howard-Hinnant-style date algorithm.
    let (year, month, day, hour, minute, second) = epoch_to_ymd_hms_utc(secs);
    format!(
        "{:04}-{:02}-{:02}T{:02}:{:02}:{:02}Z",
        year, month, day, hour, minute, second
    )
}

/// Run `git <args>` and return its trimmed stdout, or `None` on any failure
/// (no git, no `.git` dir, command failed).
fn run_git(args: &[&str]) -> Option<String> {
    let out = Command::new("git").args(args).output().ok()?;
    if !out.status.success() {
        return None;
    }
    let s = String::from_utf8_lossy(&out.stdout).trim().to_string();
    if s.is_empty() { None } else { Some(s) }
}

/// Convert UNIX epoch seconds (UTC) to `(year, month, day, hour, minute, second)`.
/// Adapted from Howard Hinnant's `civil_from_days` — exact for all dates we care
/// about, no external deps.
fn epoch_to_ymd_hms_utc(secs: i64) -> (i32, u32, u32, u32, u32, u32) {
    let days = secs.div_euclid(86_400) as i64;
    let secs_of_day = secs.rem_euclid(86_400) as u32;
    let hour = secs_of_day / 3600;
    let minute = (secs_of_day / 60) % 60;
    let second = secs_of_day % 60;

    // Shift epoch from 1970-01-01 to 0000-03-01 (Hinnant's anchor).
    let z = days + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
    let doe = (z - era * 146_097) as u64;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe as i64 + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = (doy - (153 * mp + 2) / 5 + 1) as u32;
    let m = if mp < 10 { mp + 3 } else { mp - 9 } as u32;
    let y = y + if m <= 2 { 1 } else { 0 };

    (y as i32, m, d, hour, minute, second)
}
