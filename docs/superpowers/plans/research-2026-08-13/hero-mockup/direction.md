# supermux primary interface — design direction: **Paper & Candy**

Deliverable of the design-direction round, 2026-08-14. Replaces the rejected B0 mark-system board.
All evidence images live in this folder (`/tmp/claude-1000/-opt-projects-supermux/0ce1fa02-9bc2-41c3-b2c6-7b2814d510c0/scratchpad/direction/`). Ten GPT Image 2 generations, est. USD 1.70 total, logged in `../openai-spend.log`.

**The one-line direction:** warm paper surfaces in both themes, zero saturation anywhere in the chrome — and a living cast of flat candy-coloured characters with eyes, who are the only colour, the only status system, and the reason the app reads as *people* instead of processes.

---

## 1. The chosen direction, and what the images proved

### The exploration set

| file | direction tested | verdict |
|---|---|---|
| `L1-light-glass.png` | (a) Grok-faithful warm glass, light | **Kept as the light base.** The roster instantly reads as a DM list; receipts-as-prose works; system lines work. Weakness: avatars were same-shape squircles — identity carried only by hue. |
| `D1-dark-premium.png` | (c) dark premium developer read | **Kept as the dark base — strongest single image of round 1.** Warm charcoal (not black), candy marks glowing as the only colour, off-white user bubble. It reads "expensive instrument at night", exactly the premium register the terminal audience respects. |
| `L2-light-tinted.png` | (b) warmer/softer, whole-app agent tint | Tint amplitude 5x too high — the app became a salmon skin. **But** it contributed the round's best single element: inline provenance chips (tiny face + name on a 14% tint pill) sitting *inside a sentence*. |
| `D2-dark-tinted.png` | dark + agent room-tint | Cinematic and alive (dark room lit by a teal lamp) but the tint leaked into the sidebar and ate neutrality. Proved the room-tint concept; set its ceiling. |
| `A1-roster-study.png` | avatar-in-context, roster scale | **Proved the entire status language:** narrowed slash-eyes = working, wide round eyes = waiting, one small dot on the head corner = needs attention, triangular 3-face cluster = crew. Nothing else needed. Also proved silhouette variety (pebble/egg/sphere/cluster) is what makes a roster read as a cast. |
| `A2-handoff-study.png` | avatar-in-context, handoff grammar | Proved the delegation pill (`[face] ●●● asking Patch… [face]`), the arrival divider with inline faces, and chips-in-prose — all three read as colleagues talking, zero graph-edge feel. |
| `M1-mobile.png` | mobile | Concept survives the phone; flagged two mistakes to fix (green circle checks too heavy; mascot style drifted). |

### The refinement (synthesis of the strongest)

| file | what it is |
|---|---|
| `R1-hero-dark.png` | **THE reference image for the product.** D1's charcoal + A1's silhouette/eye language + A2's handoff grammar + the room-tint from D2 dialed down to ~5% + hairline agent-coloured composer ring. Everything coexists in one seamless frame and nothing fights. |
| `R2-hero-light.png` | The same direction in light: selected row washed in the agent's coral at low opacity, conversation pane in barely-there afternoon-light warmth, chips-in-prose, crew facepile, "Typing…" as a roster line. |
| `M2-mobile-final.png` | Mobile re-cut to the final cast and receipt grammar. The concept survives at 390px because the mark is a face. |

### Why this direction (rationale)

1. **It passes the blur test.** Blur the nouns in `R1-hero-dark.png` or `R2-hero-light.png` and a stranger reads a messaging app's contact list — not a dashboard, not CI. The rejected board failed this at a glance.
2. **It copies Grok's concept, not its surface.** We did not clone the gloss-sphere marks (that would be the MSN trap again — someone else's mascot style, imitated). We took the *claims*: named colleagues, verbatim speech in the roster, presence instead of telemetry, one human on screen — and expressed them with an avatar system we own end-to-end (the avatar-lab reimplementation, `../avatar-ref/proto/avatar.mjs`), which is flatter, more geometric, and more "developer-tool" than Grok's candy gloss. Side by side with the real Grok pixels (`../grok/anim-hero-08.png`, `../grok/dark-hero-00.png`), ours reads as a sibling with its own accent, not a knock-off.
3. **The dark theme is the flagship.** Terminal people live in dark themes; `R1-hero-dark.png` is the frame that must win the side-by-side, and it does — the warm charcoal + candy cast combination has no equivalent in the Grok frames (theirs is a default-light product). Light is fully specified and equally finished, but dark is the poster.
4. **One saturation budget.** In every kept image the only chroma on screen is the cast (and the 5% room the cast tints). That restraint is what the avatar forensics called "the finding": absence is the premium signal. The rejected board had six competing accent systems; this direction has one.

---

## 2. The visual system

### 2.1 Palette

All neutrals are warm — every grey carries a red-yellow bias (OKLCH hue ~60–80°, C 0.003–0.010). Pure `#ffffff` and `#000000` are banned everywhere.

**Light theme ("Paper")** — grounded in `R2-hero-light.png` (sampled values in parentheses):

| token | value | use |
|---|---|---|
| `--bg` | `#faf7f4` (sampled `#faf7f6`) | app base, sidebar |
| `--pane` | `color-mix(in oklab, var(--agent-accent) 5%, #fbf9f6)` | conversation pane — the room-tint |
| `--surface` | `rgba(252,250,248,0.65)` + `backdrop-filter: blur(80px) saturate(180%)` | floating panels, header, composer |
| `--bubble-agent` | `#f4f1ef` | assistant + receipts bubbles |
| `--bubble-user` | `#1c1917` | user bubble (warm near-black, ink-coloured) |
| `--ink` | `#1c1917` | names, bubble text |
| `--ink-2` | `#79716b` | previews, timestamps, system lines |
| `--hairline` | `rgba(28,20,10,0.08)` at 0.5px | all borders |
| `--row-selected` | `color-mix(in oklab, var(--agent-accent) 8%, var(--bg))` (sampled `#fbefeb`) | selected roster row |

**Dark theme ("Charcoal")** — grounded in `R1-hero-dark.png`:

| token | value | use |
|---|---|---|
| `--bg` | `#191918` (sampled) | app base, sidebar — warm charcoal, never blue-black |
| `--pane` | `color-mix(in oklab, var(--agent-accent) 5%, #1c1b19)` (sampled `#1d1c1a`) | conversation pane |
| `--surface` | `rgba(32,30,28,0.6)` + same backdrop-filter | floating panels |
| `--bubble-agent` | `#1f1f1e` (sampled) | assistant + receipts bubbles |
| `--bubble-user` | `#f2ede7` | user bubble (warm off-white — the human glows in the dark room) |
| `--ink` | `#f5f1ec` | names, bubble text |
| `--ink-2` | `#a8a29b` | previews, timestamps, system lines |
| `--hairline` | `rgba(255,246,235,0.07)` at 0.5px | all borders |
| `--row-selected` | `color-mix(in oklab, var(--agent-accent) 9%, var(--bg))` | selected roster row |

**The cast (identity hues — identical in both themes).** Generated by construction per the avatar report §6.2, not by table: OKLCH **L 0.70, C 0.155**, 12-slot hue ring, hue = `hash(session_name) → slot × 30° + 8°`. The five anchors visible in the heroes (sampled from `R1`/`R2`):

| slot | sampled | OKLCH target |
|---|---|---|
| coral | `#f15f58` | 0.70 / 0.155 / 28° |
| amber | `#f4a521` | 0.78 / 0.16 / 75° (amber slot gets +0.08 L — dark yellows read dirty) |
| teal | `#3fafae` | 0.68 / 0.11 / 190° |
| periwinkle | `#4b75f0` | 0.60 / 0.19 / 265° (blue slot −0.10 L, +C — light blues read washed) |
| violet | `#7447f1` | 0.55 / 0.21 / 290° |

(Per-slot L/C trims are part of the spec: perceptual candy, not mathematical uniformity. Escape hatches per the report: one near-white `#e9e5f2`-body and one near-black `#141416`-body reserved for special sessions.)

**Eye ink:** `#111316` on bodies with L > 0.55, `#f5f7fa` below — never pure black/white (avatar report §2).

**Semantic signal (the attention dot, error text):** `#e5484d`. This is the *only* colour in the system that is not an identity hue, and it appears in exactly one place at a time.

### 2.2 Surface treatment

- **Glass, not cards.** Elevation comes from translucency + backdrop-filter + a 0.5px hairline. Box-shadows near-zero: one soft ambient `0 1px 2px rgba(0,0,0,0.04)` (light) / none (dark). Nothing "floats on a shadow"; things sit *in* the glass.
- **All borders 0.5px.** No 1px border anywhere. (Gap G20 closed.)
- **The room-tint:** focusing a session writes `--agent-accent`, `--agent-tint` on the app root. Consumers: conversation pane wash (5%), selected row (8%), mention-chip pills (14%), composer focus ring (accent at 35% alpha, 1px), card-title hover underline (1.5px, full accent). Ceiling is hard: the sidebar and all other rows stay neutral — `D2-dark-tinted.png` shows what happens when it leaks (mood, but lost neutrality); `R1` shows the calibrated version.
- **One photographic/depth element allowed:** preview cards inside the transcript (screenshots an agent shares) at radius 12 inside a radius-16 card — the Grok trick (`anim-hero-08`) that makes the column feel like a place. Never as chrome.

### 2.3 Type

One humanist sans throughout (Inter/system-ui stack; SF on Apple). Monospace appears **only inside receipt values and code the agent quotes** — never in chrome.

| role | spec |
|---|---|
| conversation header name | 16 / 600 / tracking −0.2 |
| roster name | 14 / 500 / tracking −0.15 / `--ink` |
| roster preview (the agent's words) | 13 / 400 / `--ink-2` / 1 line, ellipsis |
| timestamp | 12 / 400 / `--ink-2`, tabular figures |
| bubble text | 15 / 400 / line-height 1.45 |
| receipts | 15 / 400; tool name 600; values tabular |
| system lines | 13 / 400 / `--ink-2`, centred |
| presence ("Typing…") | 13 / 400 italic / `--ink-2` |
| composer placeholder | 15 / 400 / `--ink-2` |
| human footer | 13 / 500 |

### 2.4 Spacing rhythm

8px base grid. Sidebar 280px fixed (collapses to a 64px face-rail below 900px; faces survive, text goes). Roster: 16px inset, rows 64px tall (40px mark + two text lines), 8px internal padding, 2px between rows, selected wash radius 12. Transcript: max-width 720px, centred; 8px between grouped bubbles, 20px between speakers, 28px around system lines/dividers. Composer floats 16px off the bottom edge.

### 2.5 The marks (avatar treatment)

**Technique:** the clean-room avatar-lab reimplementation from the avatar tech report §6 (`../avatar-ref/proto/avatar.mjs` architecture) — real 3D superellipsoid rasterised to three flat SVG paths per frame. **Flat variant, zero decoration:** no gradient, no specular, no stroke, no mouth, ever. Identity = silhouette × hue × eye-geometry, all seeded from the session name via independent hash streams.

- **Shapes:** the six-shape table from §6.3 (sphere, egg, capsule, blob, pebble, cube) with ±6% seeded axis jitter. `A1-roster-study.png` and `R1-hero-dark.png` prove why: a roster of varied silhouettes reads as a cast; the same-shape roster of `L1` read as a product line.
- **Eyes:** surface-projected asymmetric capsules (report §4) — per-side deltas ≤8% height/width, ±7° angle, mandatory. Blink = height-lerp to a 5-unit floor.
- **Sizes:** 40px roster / 28px conversation header & mobile header / 24px delegation pill ends / 16px inline chips & dividers (at ≤24px: analytic silhouette only, ~48 outline points, blink kept, ambient body motion dropped — report §6.5).
- **Status lives in the eyes** (report §6.4 timing tables verbatim): idle = calm drift, natural blink; working = narrowed slashes, active blink, small steady rhythm; waiting = wide round eyes held, micro-saccades, attentive blink; failed = squint + slight tilt, motion off; done/sleeping = near-closed, slow drift. Live sessions get ambient motion at low amplitude; finished ones are still. **A roster that is quietly blinking is the product's heartbeat.**
- **Attention attaches without touching the silhouette:** one 7px `#e5484d` dot resting ON the head's upper-right corner, ringed 2px in the page colour (see Quill in `R1`, Lookout in `R2`). Never a ring around the mark, never a notch, never an overlay. Silhouette-diff between any two states outside the eye region = zero pixels.
- **Crews:** 1-over-2 triangular cluster of the actual members' marks at 18px, each ringed 2px in page colour, same 64px row (`A1` row 4, `R1`/`R2` "Render crew").
- **The human is never a mark:** initials chip + first name, bottom-left, every surface (`SB · Sander` in every hero). The asymmetry is the org chart.

### 2.6 Corner radii — one deliberate ladder

window **24** → composer & pills **999** → bubbles **18** → cards/receipts **16** → embedded preview **12** → roster row **12** → mention chip **8** → attention dot **999**. Nothing at 4–6px; nothing square.

### 2.7 Warmth/softness — the parameters that separate premium from clinical

1. Warm-biased neutrals everywhere (the entire difference between `R2` and "white app with grey text").
2. Exactly one saturation system (the cast + its 5–14% tints). Second accent = clinical.
3. 0.5px hairlines + translucency instead of borders + shadows.
4. Ink pairs are soft: warm-black on warm-paper (~14:1), never #000-on-#fff (21:1 reads as office software).
5. Generous emptiness: 720px transcript in a wide pane; whitespace is the luxury signal.
6. Radii start at 8 and go up.
7. Motion: arrivals overshoot `cubic-bezier(.2,.9,.3,1.15)` (0.45s, translateX −10px for roster rows), settles ease out `cubic-bezier(.22,1,.36,1)` (0.3s); presence/badge changes cross-fade in place over 0.26s; every rule ships a `prefers-reduced-motion` twin. Two curves total, no third.
8. Faces, asymmetric on purpose. The few-degree eye asymmetry is the "alive" parameter (avatar report §2).

---

## 3. Concept contract → visual expression (C1–C15)

| # | contract | how this direction expresses it |
|---|---|---|
| C1 | name + face, never a slug | Roster/header/composer show `display_name` ("Release Train") + seeded mark. Slug only in a detail popover with "copy for agent". Every hero image contains zero kebab-case. |
| C2 | self-naming, narrated | Centred system line "Renamed to Release Train" (`R2`, top of transcript) in `--ink-2`, 13px — first entry of every session's story. |
| C3 | line 2 = agent's last words, verbatim | Roster previews in all heroes are lowercase first-person speech ("deploy's live. rolled in 40s."). Rendered from `chat_tail`, byte-identical; empty when unspoken — never telemetry. |
| C4 | presence, not telemetry | "Typing…" replaces the preview in the same slot/type/ink (Patch row in `R2`; under newest bubble in `R1`). No spinner, bullet, or bar anywhere in the frame. |
| C5 | face is the status | Eye-states per §2.5: slashes = working, wide = waiting, near-closed = done (`A1` proves all three at roster scale). No status chrome on the row. |
| C6 | exactly one attention channel | The single corner dot (Quill in `R1`). Nothing else encodes "needs input". |
| C7 | app tints to the agent | `--agent-*` props: pane wash 5%, selected row 8%, chips 14%, composer ring, hover underline — visible calibrated in `R1` (coral ring on composer, warm cast on pane) with the neutral-sidebar ceiling honoured. |
| C8 | provenance in prose, sender's colour + face | Arrival divider "Messages from ⬤ Patch and ⬤ Quill" with 16px faces + in-sentence chips on 14% pills (`R1`, `R2`, `A2`). Chips are buttons that navigate. |
| C9 | delegation = sentence with a verb + faces | The in-flight pill `[coral face] ●●● asking Patch… [teal face]` (`R1` mid-transcript, `A2` study). Label in recipient's accent; no arrows ever. |
| C10 | system narrates itself | "Created schedule · Nightly release watch" as a transcript line (`R2`, `M2`). Same primitive for rename/worktree/model/provider/compaction/board-link. No toasts, no silent writes. |
| C11 | wall-clock, ticking | `1:47 PM / 11:02 AM / Yesterday` right-aligned 12px tabular in every roster (all heroes). Container query drops timestamps first when the roster narrows. |
| C12 | the one human, always | `SB · Sander` footer bottom-left in `L1/D1/R1/R2` — initials chip, never a mark. Persists on every surface incl. mobile (behind the back-stack root). |
| C13 | a team is a crew | "Render crew" row: identical 64px row, triangular 3-face cluster, crew's last line as preview (`R1`, `R2`, `A1` row 4). Never a member count. |
| C14 | conversation on first paint | The transcript IS the pane: bubbles, receipts (`✓ cargo check → clean · 0 errors` as prose), system lines. Terminal = one explicit action away, styled as an embedded preview card, never the default. |
| C15 | no self-measurement; everything morphs | No number about the UI exists in any frame. Presence/badges cross-fade in place (0.26s); the two-curve motion set + reduced-motion twins from §2.7. |

---

## 4. Deltas vs the rejected board — what changes so it stops looking like MSN 1900

1. **The deliverable is a product frame, not a decision board.** No section letters, no "OWNER DECISIONS", no probes. You look at `R1-hero-dark.png` and feel something or you don't. (G1–G3)
2. **The conversation exists and is the centre.** The rejected board contained zero messages. Here ~70% of every frame is transcript: prose, receipts, system lines, handoffs. (G4)
3. **Slugs → colleagues.** `deploy-fix, render-bug, ci-green` → `Release Train, Patch, Quill, Lookout` — self-chosen door-plate names with faces. (G6)
4. **Telemetry line → verbatim speech.** "● Editing scripts/deploy-self.sh" → "deploy's live. rolled in 40s." Nobody was speaking; now someone is. (G7–G8)
5. **Three attention channels → eyes + one dot.** Gutter bar, red-dot column and status bullet are deleted, not restyled. (G9, G18)
6. **Enamel badges → faces with a gaze.** Dome/puck/gem/wedge with crescent stickers → seeded 3D-projected characters whose asymmetric eyes carry state and blink. The single biggest fix. (G14, G16, G17)
7. **Muddy heraldry → candy at L 0.70 / C 0.155.** Olive/oxblood/plum (L* 38–52) → coral `#f15f58`, amber `#f4a521`, teal `#3fafae`, periwinkle `#4b75f0`, violet `#7447f1`, identical in both themes. (G15)
8. **White cards + 1px borders → warm glass + 0.5px hairlines.** `#faf7f4` / `#191918` substrates, translucency for elevation, warm ink instead of near-black-on-white. (G19–G20)
9. **6–8px house radius → the 8…24 ladder.** Softness becomes structural, not decorative. (G22)
10. **`◆ supermux → web ◑` → "⬤ ●●● asking Patch… ⬤".** The graph edge is replaced by a sentence mid-utterance with a face at each end. (G25–G26)
11. **Uptime deltas → wall clock.** `2m / 1h` → `1:47 PM / Yesterday`. (G10)
12. **The human appears.** `SB · Sander`, every screen. (G5)
13. **Static pairs → a motion vocabulary.** Two curves, in-place morphs, ticking clocks, blinking cast, reduced-motion twins. (G13, G29)
14. **Zero self-measurement.** No ΔE, no L*, no IoU anywhere the user can see — including this round's own QA, which stays in this folder. (G2)

---

## 5. Builder brief — the hero mockup

**Deliverable:** one seamless primary-interface mockup, HTML/CSS (real DOM, not an image), in **both themes**, desktop **1440×900** + one mobile frame **390×844**. Visual truth = `R1-hero-dark.png` (dark), `R2-hero-light.png` (light), `M2-mobile-final.png` (mobile), `A1`/`A2` for close-up grammar. Where a generated image and this spec disagree, the spec wins (the images contain model artifacts: occasional wrong eye-ink, slightly heavy tints).

**Frame:** window radius 24, glass substrate per §2.1, three regions — sidebar 280px, conversation pane, floating composer. Focused session: **Release Train** (coral pebble). Roster top→bottom: Release Train (selected, 8% coral wash) · Patch (teal egg, eyes = slashes, preview = *Typing…*) · Quill (periwinkle sphere, wide eyes, `#e5484d` corner dot, "readme rewritten. shorter now.", 10:12 AM) · Lookout (amber blob, calm, "ci green across the board.", Yesterday) · Render crew (3-face cluster amber/violet/teal, "that flicker's gone on ios.", Yesterday). Search field above; `+` in the sidebar header; footer `SB · Sander`.

**Transcript of Release Train (exact order):**
1. Centred system line — `Renamed to Release Train`
2. Assistant bubble — `tagged v0.6.0 and the build is rolling. two checks left.`
3. Receipts bubble — `✓ cargo check → clean · 0 errors` / `✓ tests → 212 passed` / `✓ release → v0.6.0 tagged` (checkmark in ink, tool name 600, values tabular; plain bubble, no boxes/icons/collapse)
4. In-flight delegation pill, centred — 24px coral face · three animated dots + `asking Patch…` in teal · 24px teal face, both ringed in page colour; pill morphs open on arrival
5. Arrival divider — `Messages from ⬤ Patch and ⬤ Quill` (16px faces)
6. Assistant bubble opening with chips — `⬤ Patch sent over the failing job and ⬤ Quill tightened the notes. both folded into tonight's run.` (chips: 16px face + name in sender's hue on 14% pill; real buttons)
7. User bubble (right, `--bubble-user`) — `ship it once CI is green`
8. Centred system line — `Created schedule · Nightly release watch`
9. Working row: assistant bubble `rolling the last check now.` with italic `Typing…` beneath in the presence slot
10. Composer — pill, `+` left, placeholder `Message Release Train`, mic right, focus ring in coral at 35%

**Mobile frame:** the same conversation per `M2-mobile-final.png` — floating glass header (back chevron, 28px coral mark, "Release Train"), transcript items 2/3/8/7 + closing bubble `done. it's live.`, floating pill composer.

**Behavioural notes for the mockup:** marks are live SVG from the avatar engine (three paths, §2.5), blinking on the report's timing tables, blink clocks seeded per session so the roster never syncs; timestamps tick; roster rows enter with the arrive curve; presence text cross-fades. `prefers-reduced-motion`: static calm pose, no drift, everything still readable.

**Do not:** add gradients/speculars to marks; use monospace in chrome; show a slug, a spinner, a progress bar, a count on a mark, or any number about the UI itself; let the agent tint touch the sidebar; use pure black or pure white anywhere.

---

## Accessibility floors (pass/fail gates, checked last — never the design driver)

- Names/bubble text vs their surfaces ≥ 4.5:1 — passes: `#1c1917` on `#faf7f4` ≈ 14.8:1; `#f5f1ec` on `#191918` ≈ 14.6:1; bubble pairs equivalent.
- Secondary ink ≥ 4.5:1 — `#79716b` on `#faf7f4` ≈ 4.6:1; `#a8a29b` on `#191918` ≈ 7.5:1. Pass (adjust L, not hue, if a surface tint dips it).
- Mark-only signals ≥ 3:1 where meaning is mark-only: the attention dot contrasts against its 2px page-colour ring (`#e5484d` vs `#faf7f4` ≈ 3.9:1; vs `#191918` ≈ 3.4:1). Pass.
- Eye-state meaning is never mark-only: presence text ("Typing…", "Done.") duplicates it in words; the dot duplicates needs-input. Screen-reader labels mirror the presence lexicon.
- Focus rings: 2px accent-coloured, on every interactive element, both themes.
