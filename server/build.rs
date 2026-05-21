//! Build script.
//!
//! Re-runs the build (and thus the `rust-embed` derive over `server/static/`)
//! whenever the generated web assets change. `scripts/build.sh` copies
//! `web/dist` → `server/static` before `cargo build --release`; rust-embed
//! (wired in a later milestone) embeds that directory into the binary.

fn main() {
    println!("cargo:rerun-if-changed=static");
}
