# showcase — README hero recording

A scripted Playwright run that drives the supermux dashboard through a
9-beat storyboard (overview → peek → type-on-hover → focus → ⌘K →
density+sort → mobile → outro) and writes the result to
`../docs/showcase/` as MP4, WebM, and GIF.

## Files
- `seed.ts` — populates 8 demo sessions via the supermux HTTP API with
  shell commands chosen so the status classifier paints them as a mix
  of Active / Waiting / Idle / Stopped.
- `record.ts` — Playwright driver. Launches Chromium headless,
  navigates to the dashboard, performs each beat with captioned
  pauses, and saves the recording. The mobile beat is rendered as an
  embedded iframe inside a phone-bezel CSS overlay so the canvas
  stays full-bleed.
- `verification.json` — per-beat manifest with timestamps, frame
  paths, and human-readable evidence notes from the visual inspection.

## Run

```bash
# 1. Start the supermux server (see top-level docs). Defaults assume
#    http://127.0.0.1:8833 + auth token at /tmp/sm-showcase-data/auth_token.
# 2. Seed sessions:
bun run seed.ts
# 3. Record:
bun run record.ts
# 4. Re-encode to mp4/webm/gif via ffmpeg (see scripts above).
```

## Notes
- The package is intentionally isolated under `showcase/` and is NOT
  part of the main web app.
- `out/` holds the raw .webm recording; check it in only when shipping
  a new hero asset.
