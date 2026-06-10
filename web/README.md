# supermux frontend

The React + TypeScript + Vite PWA that talks to the supermux server (`../server/`).
Built artifacts are embedded into the Rust binary at compile time via
[`rust-embed`], so the binary serves the frontend directly — there is no
separate static-asset deploy step.

## Dev loop

From this directory:

```sh
bun install         # or: npm install (bun.lock is canonical)
bun run dev         # vite dev server with HMR, proxied to a local supermux
bun run build       # tsc -b && vite build  → dist/, picked up by the embed step
bun run test        # vitest (browser-mode component tests)
bun run lint        # eslint
```

The dev server proxies API + SSE + WebSocket calls to a locally running
supermux server on `http://127.0.0.1:8824` (configurable via `VITE_API_BASE`
in `.env.local`). Start the backend separately with `cargo run` in `../server`.

## Layout

- `src/routes/` — top-level pages (`/`, `/focus/:name`, `/files`, etc.).
- `src/components/` — feature components, grouped by domain (`focus-mode/`,
  `session-tile/`, `terminal/`, `team/`, `files/`, `board/`, `snippets/`, …).
- `src/lib/api/` — typed client per API module + a shared `client.ts`.
- `src/hooks/` — shared cross-cutting hooks (sessions, teams, SSE, …).
- `src/stores/` — Zustand stores for UI state that survives unmount.
- `public/` — assets that ship as-is in the embedded bundle.

## Embedding into the server binary

`server/build.rs` shells out to `bun run build` and then `rust-embed` packs
`dist/` into the binary. A `vite build` failure breaks `cargo build`. The
`scripts/build.sh` wrapper does both halves for CI + the in-app updater.

[`rust-embed`]: https://crates.io/crates/rust-embed
