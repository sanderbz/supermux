//! Build script (TECH_PLAN §8.1).
//!
//! `scripts/build.sh` copies `web/dist` → `server/static` before
//! `cargo build --release`; the `#[derive(RustEmbed)] #[folder = "static/"]` in
//! `src/static_assets.rs` embeds that directory into the binary at compile time.
//! This script tells Cargo to re-run the build (and thus re-embed) whenever the
//! generated web assets change, so a frontend rebuild is never silently stale.

use std::path::Path;

fn main() {
    // Re-embed when the built web bundle changes.
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
}
