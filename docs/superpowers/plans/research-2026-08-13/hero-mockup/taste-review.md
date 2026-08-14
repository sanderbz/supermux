## TASTE REVIEW — hero mockup vs Grok

**Verdict: ITERATE.** Not close to the last rejection — this is a different class of work and the concept is genuinely carried. But one shipped artifact is visibly broken, the dark theme has inverted elevation, and three objects read cheap. Sending it as-is after a hard rejection would be a mistake; all fixes below are small and precise.

---

### 1. Blind-swap test

At true 1:1 CSS px (`/tmp/.../scratchpad/taste/swap-roster-1to1.png`, Grok downsampled from DPR2 — my first composite was scale-skewed, and the "our type is smaller" read was an artifact of that; measured cap heights are **Grok name 10.5px / ours 10.0px, Grok bubble 13.5px / ours 14.5px** — type scale is matched, and our row pitch 66px vs Grok's 59px is *more* generous).

A stranger reads ours as **the same class of product**. The roster arguably beats Grok's on rhythm. Where the eye catches cheapness, in the order it catches it:

1. **The permission-card button row** (`board-light.png` x549–960, y862–896). Three button grammars in one row: saturated coral fill / 0.5px outlined pill / naked grey text. And `--accent-ink:#1c1917` puts near-black text on saturated coral — the muddiest object on screen. Grok has no saturated filled button anywhere in a transcript. This is the MSN-dialog moment.
2. **The composer's coral ring** — `page.html:206`, `box-shadow:0 0 0 1px color-mix(accent 42%)`. A thin saturated outline permanently drawn around a 744px pill reads as a form field stuck in `:focus`. Grok's composer is a 0.5px near-invisible hairline. Both grey filled circles (`.plus` 38px, `.mic` 40px) add toolbar-button vibe; Grok's `+` is a bare glyph.
3. **Mono creep.** Five monospace runs in one transcript: receipt values (`clean · 0 errors`, `212 passed`, `v0.6.0 tagged` — `.rcp .val:153`), the path in prose, the code block, `cargo publish --dry-run`, and **`Typing… · 0:42`** (`.presence .el:180`). Grok's receipts are proportional (`→ list pulled · 52 accounts`). The stopwatch is telemetry smuggled back into the presence slot (C4).
4. **Accent on every large surface.** `--pane` = accent 4%, `--bubble-agent` = accent 5%, `--row-selected` 8%, composer ring 42%, primary button 100%. Measured: page (254,245,242) C\*3.5, bubble (242,229,225) C\*5.1 — vs Grok's page #fcfcfc C\*0.0 and bubble (243,243,242) C\*0.5. **Our own studio caption says "warm neutral chrome, and the cast is the only colour" and the pixels contradict it.** The composition ends up monochrome coral; Grok's neutral page is exactly what lets seven saturated marks be the only colour.
5. **One surface tone doing three jobs.** Bubble, receipt card and prose bubble are all `#F2E5E1` at three different widths (915 / 718 / 1285 px right edges) → a ragged staircase with no elevation logic, while the in-flight pill and permission card are white. Four surface tones, no ladder.
6. **Inline chips are filled pills** (`.chip:178`, `background:var(--chip-bg)`, `vertical-align:-6px`) → the provenance sentence's two lines have visibly uneven leading, and the chips read as Jira tags. Verified in `grok/dark-hero-00.png`: Grok renders "⬤ Account Manager" as coloured **text**, no fill.
7. **No imagery, no depth, anywhere** (G21, unfixed). The single object that makes Grok's column feel like a *place* is the 16:10 photographic desktop embed. Ours substitutes a grey monospace diff hunk. The transcript's hero object is a code diff.

---

### 2. Avatars — honest grade

The engine is real and good: seeded superellipsoid solid, quaternion pose, per-state eye geometry (`working` = narrowed slants, `waiting` = round, `done` = squint), blink + micro-saccade clock with per-seed phase, silhouette never moves (C5 clean), `breathe` ambient. Better machinery than Grok's.

But three things keep it off reference:

- **Gradient vs flat.** Ours: measured 8 L\* lit→shade per mark (Quill 55.6→47.5). Grok: **0** — flat single hue (sampled `#F19D38`, `#6464EF`, `#885CF5`, C\* 66–88). Flat is why Grok's punch; our airbrushed blobs read softer and faintly 2010.
- **Dark eyes vs white.** `ink: L>.55 ? '#111316'` gives near-black eyes on all seven light bodies. The Grok *character canon* (`avatar-ref/crops/`) does use black eyes — but the **in-product roster mark uses white ellipses**, and the sparkle is what reads as alive. Side by side, Grok's faces glint; ours are deadpan.
- **One species in eight colours.** All six `SHAPES` are convex superellipsoids, n∈[2,3.6], axis-aligned. Idle eye tilt is `asym()*6` = ±6°, imperceptible; `pxL/pxR` pinned to 0 so **no face ever looks anywhere**. Grok's roster has a triangle, a rhombus and circles; the canon has a cloud. Our column reads as a colour-graded icon set, not a cast — which is the one place the old G17 critique survives.

**Grade: close.** Craft is high; character is monotone.

---

### 3. Concept-carry against the contract

**Carried, on the pixels:** C1 (no slug anywhere — Release Train, Patch, Quill, Ledger, Compass, Lookout, Kestrel, Render crew) · C3 (lowercase first-person tails: "tagged v0.6.0. two checks left.", "euro formats parse clean now.") · C4 (`Typing…` in the same slot, no bullet/spinner — except the `0:42`) · C5 · C6 (one dot, on Quill's face only) · C8 (divider + inline provenance) · C9 (`[face] ●●● asking Patch… [face]` — verb, no arrow) · C10 (`Renamed to Release Train`, `Created schedule · Nightly release watch`) · C11 (1:47 PM / Yesterday) · C12 desktop (`SB · Sander`) · C13 (crew row identical shape, real member facepile, its own last line) · C14 · C15 motion (both cubic-beziers, `arrive`, `morph`, `blip`, `breathe`, colocated `prefers-reduced-motion` twin at :242).

**Not carried:**
- **C7 is asserted, not demonstrated.** `--accent:#f15f58` is a hard-coded root token (`:41`), not derived from focus. Only one agent is ever shown focused, so the contract's own falsifier ("screenshot two different sessions focused") cannot be run.
- **C12 fails on mobile** — no human anywhere on the phone screens.
- **C7's clause "the agent accent never encodes state"** is violated by `.btn.primary{background:var(--accent)}` — the identity hue is used for an action, and because the agent is coral, "Allow once" reads destructive.

Does it feel like named colleagues, alive, warm? **Yes** — the roster passes the one-sentence blur test cleanly; it reads as a contacts list, not a CI board. The `done. it's live.` bubble on mobile carries a different eye state than the working avatar above it, which is the nicest single detail in the file.

---

### 4. Still dated / clinical

- Permission card: three button grammars, saturated fill (see #1).
- Composer ring + two grey filled icon circles (#2).
- Mono creep + stopwatch (#3).
- `Typing…` set in **italic** (`.row .pv em`) — the only italic in the product; reads as an editorial annotation, not presence.
- `✓` and `→` in receipts are lighter than their text, so the lines read half-disabled.
- **Dark theme elevation is inverted**: measured pane (37,31,28), bubble (33,31,30) — the assistant bubble is *darker* than the page it sits on. Grok dark: pane 35 → bubble 47. Our dark bubbles recede into wells; the code block nearly vanishes.
- **Mobile dead space**: ~130px void between the floating header and "Renamed to Release Train" (`mobile-light@2x` y230–350). Grok's phone shows a message clipped under the header — evidence of a conversation in progress. Ours looks like an unfinished layout.
- `.bubble` max-width 592 inside a 744 track → a permanent 108px right gutter and the ragged staircase.

---

### 5. BLOCKER — one shipped artifact is broken

**`hero-mockup/studio-paper.png`, dark artboard, is defective.** The permission card is an empty dark rectangle (no text, no buttons), the in-flight pill is a dead black box, and **the composer is missing entirely**. Sampled at y2265: paper (40,32,27) flat across the whole strip; charcoal at the same coords has the composer (231,225,218). Crop: `/tmp/.../scratchpad/taste/studio-paper-darkbreak.png`.

Cause: every failing element is a `backdrop-filter` surface (`.pill:165`, `.card:188`, `.composer:203`) — they fail to composite when the sheet is captured with the *other* skin active. `board-dark.png` and `studio-charcoal.png` render correctly, so it's a capture-order bug, not a design bug. But this is the file most likely to be opened first.

---

### Grades

| area | grade |
|---|---|
| roster | **reference-class** (borderline — italic `Typing…`, name 14/500 slightly label-y, crew facepile rings too thin to separate the three marks) |
| conversation | **close** (all primitives correct; surface hierarchy, mono creep, permission card, no depth) |
| avatars | **close** (engine reference-class; flat/white-eye/cast-variety keep it off) |
| composer | **below** (coral ring + two filled grey circles) |
| overall | **close — iterate** |

---

### Fix list (executable, anchored to `hero-mockup/src/page.html`)

1. **:165/:188/:203** — re-shoot `studio-paper.png` with the dark board captured in its own pass (as `board-dark.png` already is). Verify by pixel-diffing studio-paper's dark half against studio-charcoal's; they must match.
2. **:72** `--bubble-agent:#211f1e` → `#2b2724`. Bubble must sit ~+12/255 **above** `--pane`, matching Grok's 35→47.
3. **:206** drop the composer ring to a 0.5px hairline at rest; move the accent ring to `:focus-within` at ≤22%.
4. **:198** kill `.btn.primary{background:var(--accent)}`. One button grammar: three 0.5px hairline pills, primary distinguished by weight 600 + `--fill-soft-2`, `Not now` gets a pill too. The identity hue never encodes an action (C7).
5. **:153, :180, :192** — proportional type for receipt values; delete `· 0:42`; keep mono only for the code block and the literal command. Bump `✓`/`→` to full ink.
6. **:178–180** — remove `--chip-bg` and the `vertical-align:-6px` hack; render provenance as mark + name in the sender's hue, inline, no fill (matches `grok/dark-hero-00.png`).
7. **:49, :51, :70** — take the accent out of `--pane` and `--bubble-agent`. Keep the warm paper as a fixed neutral (`#faf7f4`/`#fdfbf9`); accent lives only on selected row, focus ring, chips and the marks. Make the pixels agree with your own caption.
8. **:421** — halve or remove the mark body gradient (`hi`/`lo` → ≤3% top-left lift). Flat reads bolder.
9. **:427 + :401–408** — give each named character a pinned pose: gaze offset (`pxL/pxR` ±18) and a signature idle eye angle (±25–35°, not ±6°); add ≥2 non-convex silhouettes (wedge/triangle, cloud). Refs: `grok/anim-hero-08` sidebar, `avatar-ref/crops/07-Cloudee.png`.
10. Test **white eyes** on light-bodied marks (`ink` threshold at :424) — A/B against `grok/anim-hero-08` at 40px.
11. **Mobile** — start the transcript scrolled so a bubble is clipped under the header (kill the 130px void); put the initials chip in the mobile header or amend C12.
12. **:113** `.row .pv em` → `font-style:normal`.
13. Add one warm, non-flat object to the transcript (a real preview/screenshot card) so the column isn't 100% flat vector.
14. **Ship a second board with Patch (teal) focused.** `--accent` is currently hard-coded at :41. This is the cheapest way to prove §1.6 / C7 — and it will immediately settle whether a tinted page is beautiful or garish.
15. **Presentation** — the studio sheet reintroduces board grammar: title, subtitle, `PAPER — LIGHT` / `CHARCOAL — DARK` plate labels, and on-screen `390 × 844` pixel dimensions. That is the shape of the artifact that got rejected. Lead with `board-light.png` full-bleed, demote the sheet to an appendix, drop the dimension labels.

Working crops for the builder: `/tmp/claude-1000/-opt-projects-supermux/0ce1fa02-9bc2-41c3-b2c6-7b2814d510c0/scratchpad/taste/` (`swap-roster-1to1.png`, `grok-roster-2x.png`, `ours-marks-3x.png`, `ours-conv-top.png`, `ours-conv-bot.png`, `studio-paper-darkbreak.png`).
