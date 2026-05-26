# supermux — guidance for Claude agents

## HARD RULE — never run `cargo build/test --release` on clawd-02

The supermux production box (clawd-02 — 4 vCPU / 7.5 GiB RAM / 2 GiB swap,
aarch64) has been wedged twice by an agent running an ad-hoc
`cargo build --release` (or `cargo test --release`) inside the on-server
`supermux-dev` session during a merge or compile-check. A release build peaks
at ~2 GB per rustc, cargo defaults to `-j 2` on a 4-core host, and the live
supermux + tmux + claude agents already use ~1.6 GB baseline — so a single
ad-hoc release build is enough to push the box into 2 GiB of swap and from
there into OOM-thrash. Once the box thrashes the load crosses ~50 and EVERY
service (ssh, https, ping) becomes unreachable for several minutes; full
recovery typically needs a reboot.

If you are an agent working in `/opt/projects/supermux-dev` (or any clone of
supermux on clawd-02), you **MUST NOT**:

- `cargo build --release` … anywhere, ever
- `cargo test --release` … anywhere, ever
- `cargo bench` (implies release) … ever
- any wrapper / `make` target / shell pipeline that ends up doing the above

The cargo-guard wrapper at `etc/clawd-bin/cargo` (installed to
`~/.local/bin/cargo` on the service user, first in PATH) refuses these
invocations with a clear message — but the rule above is the primary defense,
the wrapper is belt-and-suspenders. Don't try to work around it.

### What to do instead

For **compile-check** the code (catch type errors, missing imports, etc.):

    cargo check                  # full workspace
    cargo check -p supermux-server
    cargo check --tests          # also checks test compilation

`cargo check` skips codegen, runs ~10× faster, and uses a fraction of the
memory — it's the right tool for "did I break the build" loops.

For **tests** (defaults to the dev profile, which is what you want):

    cargo test                   # full test run, debug profile, fits in RAM
    cargo test -p supermux-server foo

For an **actual binary** to run locally (debug profile is fine on dev):

    cargo build                  # debug binary, ~1 GB rustc, no thrash

### Deploying your changes to live supermux

If you're an agent on the server (in `/opt/projects/supermux-dev` or any
on-server clone) and you want a committed change to go live on the running
supermux UI, **use the self-deploy script — that's exactly what it's for**:

    bash scripts/deploy-self.sh

It writes a deploy-request file that a root-side systemd path-unit picks up
and runs OUTSIDE the supermux sandbox (the supermux service can't sudo
because of `NoNewPrivileges` + capability drops, so this indirection is the
sanctioned no-sudo path). The runner builds the release binary, installs it,
restarts the service, verifies `/api/health`, and rolls back on failure.
This is the ONE place an on-server agent legitimately triggers a release
build — and because the script exports `SUPERMUX_RELEASE_OK=1`, the
cargo-guard wrapper lets it through.

From an operator's Mac, the equivalent is `scripts/deploy.sh` — it builds on
the host over SSH and installs the result via root sudo.

### Don't bypass the cargo-guard wrapper

The three legit deploy paths are:

- `scripts/deploy.sh` (operator runs from their Mac → builds on the host
  inside an SSH session)
- `scripts/deploy-self.sh` (on-server agents — see above)
- `scripts/build.sh` (called by both of the above)

All three export `SUPERMUX_RELEASE_OK=1` before invoking cargo. If you are
NOT one of these scripts, you are NOT allowed to set `SUPERMUX_RELEASE_OK=1`
yourself to bypass the wrapper — that defeats the safeguard. Same for
calling `~/.cargo/bin/cargo` by absolute path. If you think you need a
release build outside the deploy path, you don't — use `cargo check` or
`cargo build` (debug) and let `deploy-self.sh` handle the release build.

## Other ops notes for agents on clawd-02

- **Long-running tasks**: prefer `cargo check`, `bun run typecheck`,
  `bun run lint` over full builds in tight loops. If you genuinely need a
  binary, `cargo build` (debug) is fine.
- **Memory-heavy parallel jobs**: don't `make -j` or `cargo build -j$(nproc)`.
  Both rustc and bun can each take 1–2 GB; running ≥3 in parallel will spill
  into swap.
- **If you wedge the box anyway**: don't try to "recover" by spawning more
  shells or restarting services — that only adds pressure. The user reboots.
