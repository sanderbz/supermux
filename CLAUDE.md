# supermux

- **Never `cargo build/test --release`** — small hosts OOM-thrash. Use `cargo check` / `cargo build` (debug). Wrapper at `~/.local/bin/cargo` refuses release unless `SUPERMUX_RELEASE_OK=1`.
- **To deploy your change to live supermux from the server**: run `bash scripts/deploy-self.sh` (sets the env, root path-unit installs + restarts + verifies + rolls back).
