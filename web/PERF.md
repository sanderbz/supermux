# Performance budgets

supermux has a measured, enforced performance budget. This document defines the
budgets, how they are enforced, and how to re-run the suite.

## Budgets

| Metric                     | Budget            | Enforced by                       |
| -------------------------- | ----------------- | --------------------------------- |
| Main app JS                | ≤ 200 KB gzipped  | `scripts/size-budget.mjs` (exit 1)|
| CSS                        | ≤ 30 KB gzipped   | `scripts/size-budget.mjs` (exit 1)|
| Lighthouse performance     | ≥ 85              | manual / CI Lighthouse run        |
| First Contentful Paint     | < 500 ms          | Lighthouse                        |
| Time to Interactive        | < 1.5 s           | Lighthouse                        |
| Overview, 20 tiles @ 2s SSE| 60fps iPhone 14 / 30fps iPhone SE | DevTools Performance trace |
| Focus terminal keystroke   | < 50 ms LAN / < 100 ms Tailscale  | DevTools / Safari Web Inspector |

"Main app JS" is the entry chunk plus any non-vendor app code. Vendor chunks
(`vendor-react`, `vendor-xterm`, `vendor-framer`, `vendor-codemirror`) are split
out via `manualChunks` in `vite.config.ts`; they cache independently across
deploys and the heavy `vendor-codemirror` language packs only load behind the
lazy `code-editor` route — never on the overview / focus-terminal hero path —
so they are not counted against the main-app-JS budget.

## How to run

### Bundle size gate (automated, gates the build)

```sh
cd web
bun run build:perf      # tsc + vite build + size budget gate (exits 1 on overage)
# or, against an existing dist/:
bun run perf:size
```

`bun run build` stays unchanged (no gate) for fast iteration; CI should run
`build:perf` so an oversized bundle fails the pipeline.

### Lighthouse (perf ≥ 85, FCP, TTI)

```sh
cd web
bun run dev &                                  # dev server on :5173
bunx lighthouse http://localhost:5173/        --only-categories=performance        --output html --output-path perf/baselines/lighthouse-overview.html
bunx lighthouse http://localhost:5173/focus/demo        --only-categories=performance        --output html --output-path perf/baselines/lighthouse-focus.html
```

Archive the resulting HTML reports in `web/perf/baselines/`.

### Runtime trace (hero loop — 20-tile overview, 2s SSE deltas)

1. Open the overview with 20 sessions streaming `preview_lines` deltas every 2s.
2. Chrome DevTools → Performance → record ~10s of steady state.
3. Assert: no long tasks > 50 ms during steady state; 60fps (iPhone 14) /
   30fps (iPhone SE) on real devices via Safari Web Inspector.
4. Save the trace / Web Inspector screenshot under `web/perf/baselines/`.

## Current baseline

See `perf/baselines/baseline.json` and `perf/baselines/bundle-size.txt`
(measured 2026-05-22):

- Main app JS: **44.8 KB gzipped** / 200 KB budget — 22% (PASS)
- CSS: **10.3 KB gzipped** / 30 KB budget — 34% (PASS)

## Updating budgets

Budgets live in `scripts/size-budget.mjs` (`BUDGET_APP_JS`, `BUDGET_CSS`).
Changing them is a deliberate decision — keep it in sync with this doc.
