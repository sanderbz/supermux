# Third-party notices

supermux is MIT-licensed (see [`LICENSE`](LICENSE)). It builds on open-source
dependencies under their own licenses, summarized here. This file is a
good-faith summary, not legal advice; the authoritative license text for each
dependency ships with the dependency itself (crates.io / npm package
contents).

## Rust dependencies (`server/`)

The server pulls in ~450 crates (see `server/Cargo.lock` for the exact set
and versions). License breakdown by crate count, from `cargo metadata`:

- The overwhelming majority are **MIT and/or Apache-2.0** dual-licensed.
- A handful use other permissive licenses: **ISC** (e.g. `rustls-webpki`,
  `untrusted`), **Unicode-3.0** (ICU components), **BSD-2/3-Clause**
  (e.g. `subtle`, `instant`, parts of `matchit` and `encoding_rs`),
  **Zlib**, **Unlicense/MIT**, **CC0-1.0**, **BSL-1.0** (dual-licensed),
  and **CDLA-Permissive-2.0** (`webpki-roots` — the Mozilla CA bundle data).
- `aws-lc-sys` (via `rustls`) bundles AWS-LC, which carries a combined
  ISC / Apache-2.0 / MIT / BSD-3-Clause license set.

### MPL-2.0 (weak copyleft) transitives

Two transitive crates are licensed under the Mozilla Public License 2.0.
They are used unmodified; per MPL-2.0, their source is available upstream:

- [`ece`](https://github.com/mozilla/rust-ece) — HTTP Encrypted
  Content-Encoding, used for Web Push notification payloads.
- [`option-ext`](https://github.com/soc/option-ext) — `Option` extension
  trait, pulled in by `dirs`.

To regenerate the full per-crate list:

```bash
cd server
cargo metadata --format-version 1 \
  | jq -r '.packages[] | select(.source != null) | "\(.name) \(.version): \(.license)"' \
  | sort -u
```

## JavaScript dependencies (`web/`)

Direct runtime dependencies (bundled into the web UI; see
`web/package.json` / `web/bun.lock` for versions and the full transitive
set):

| Package(s) | License |
|---|---|
| react, react-dom | MIT |
| @xterm/xterm + addons (canvas, fit, web-links, webgl) | MIT |
| @codemirror/* language packs, @uiw/react-codemirror, @codemirror/theme-one-dark | MIT |
| @radix-ui/react-* primitives | MIT |
| @dnd-kit/* | MIT |
| @tanstack/react-query | MIT |
| react-router-dom | MIT |
| react-markdown, remark-gfm, rehype-highlight, rehype-slug | MIT |
| lowlight | MIT |
| highlight.js (via lowlight / rehype-highlight) | **BSD-3-Clause** |
| framer-motion | MIT |
| vaul | MIT |
| zustand | MIT |
| clsx, tailwind-merge | MIT |
| class-variance-authority | **Apache-2.0** |
| lucide-react | ISC |

Build-time-only tooling (Vite, TypeScript, ESLint, Tailwind CSS,
Playwright, type packages) is not distributed with the application.

## Fonts

The web UI self-hosts **JetBrains Mono** (Nerd Font patched), licensed under
the **SIL Open Font License 1.1** — see
[`web/public/fonts/NOTICE.md`](web/public/fonts/NOTICE.md) for details and
upstream links.
