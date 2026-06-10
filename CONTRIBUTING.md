# Contributing to supermux

Thanks for your interest in contributing! This document covers the dev setup,
the test layout, and the conventions used in this repo.

## Repo layout

- `server/` — Rust backend (axum + sqlite + tmux orchestration). The web
  bundle is embedded into the binary at compile time (rust-embed reads
  `server/static/`).
- `web/` — React/TypeScript frontend (Vite, bun as package manager —
  `bun.lock` is the canonical lockfile).
- `scripts/` — build, install and deploy scripts.
- `docs/` — user-facing docs; `design/` — historical design notes.

## Dev loop

You need: Rust (stable), [bun](https://bun.sh), `tmux`, and on Linux the
build prerequisites (`build-essential pkg-config libssl-dev cmake unzip`).

Run the two halves side by side:

```bash
# terminal 1 — backend
cd server
cargo run

# terminal 2 — frontend with hot reload
cd web
bun install
bun run dev
```

The Vite dev server proxies API calls to the backend. For a production-style
single binary, `bash scripts/build.sh` builds the web bundle, copies it to
`server/static/`, and compiles the server with it embedded.

### ⚠️ Never `cargo build --release` on small hosts

A release build can OOM-thrash low-memory machines (the typical self-host
VPS). Use `cargo check` and debug builds for development; CI does the same.
See [`CLAUDE.md`](CLAUDE.md) — the agent-facing instruction file that encodes
this rule for AI coding assistants working in this repo.

## Tests

- **Server**: integration tests live in `server/tests/` (one file per
  feature area, shared fixtures in `server/tests/fixtures/`). Run with
  `cargo test` from `server/`. Note that the test build embeds the web
  bundle, so build the frontend first (`bun run build` in `web/`, then copy
  `web/dist` to `server/static/`) — `scripts/build.sh` does this for you.
- **Web**: Playwright end-to-end tests in `web/tests/e2e/`. Run
  `bun run test:e2e` (or `bun run test:e2e:smoke` for the quick subset),
  and `bun run lint` for ESLint.

CI (`.github/workflows/ci.yml`) gates on: web build, `cargo check
--all-targets`, and `cargo test`. rustfmt runs advisory-only — the codebase
is intentionally hand-formatted, so don't reformat files wholesale.

## Commit style

Conventional commits: `feat:`, `fix:`, `chore:`, `docs:`, `refactor:`,
optionally scoped (`fix(sessions): …`). Keep commits small and logical.

## Pull requests

- Describe what changed and why, and how you tested it.
- Include screenshots for UI changes.
- Make sure `cargo test` and the web build pass locally.

## Self-hosting / dogfood workflow

If you develop on a box that also runs supermux, see
[`docs/SELF_HOST_DEV.md`](docs/SELF_HOST_DEV.md) for the self-deploy
pipeline, and [`docs/TESTING.md`](docs/TESTING.md) for local/remote/mobile
testing recipes.

## Security

Please report vulnerabilities privately — see [`SECURITY.md`](SECURITY.md).
