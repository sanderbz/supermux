All 15 items verified against my own pixels. Here is the report.

---

## VERIFICATION — hero-mockup iterate round

### Per-item (my measurements, not the fixer's)

| # | verdict | my evidence |
|---|---|---|
| **1** sheet integrity | **PASS** | Located all three boards in `appendix-sheet.png` by correlation search: light @(40,44), dark @(40,1108), patch @(40,2172). Pixel-diff vs the standalone renders: mean abs **0.0021 / 0.0422 / 0.0014**, max **2 / 3 / 3** of 255, pct>2 = **0.0000 / 0.0001 / 0.0001 %**. The dark board inside the sheet is bit-for-bit the good render — composer, permission card and in-flight pill all composite. The `backdrop-filter` blocker is gone. |
| **2** dark elevation | **PASS** | Ladder sampled at 4 sites each: sidebar **(26,26,24)** L\*9.2 → pane **(32,31,29)** L\*11.8 → bubble/receipt **(44,41,38)** L\*16.8 → card/composer **(51,47,44)** L\*19.7. Bubble = pane **+12**, correct direction, Grok's 35→47 matched. |
| **3** composer ring | **PASS** | Vertical border scan x=860: exactly **one** device row of border — light `(235,232,229)`, dark `(68,63,58)`, both C\*≈1. No coral anywhere on the pill. Accent ring is `:focus-within` @22 % (`page.html:246`). `+` disc gone. *Note: the 40 px mic disc survives (light 215,212,210 / dark 209,203,197) — that was §1.2 prose, not a numbered item.* |
| **4** one button grammar | **PASS** | Three 0.5 px hairline pills, `Not now` included. Primary fill **C\* 1.18** light / **3.15** dark (`239,236,235` / `71,67,63`) — zero accent chroma, distinguished by weight 600 + soft fill. The MSN-dialog object is gone. |
| **5** mono / receipts | **PASS** | `.rcp .val` carries no `font-family` (tabular-nums only) → values proportional. `· 0:42` and the `setInterval` clock absent from source and render. `✓`/`→` are spans inheriting `var(--ink)` with **no opacity rule** — my darkest-ink sample matches the label text. Mono survives in exactly **2** CSS rules (`.code:161`, `.card .q code:228`); `.path` is Inter. Lead board renders **one** mono run total. |
| **6** chips | **PASS** | `--chip-bg` and `vertical-align:-6px` gone (`:218` is now `-3px` on the mark only). Both themes: mark + name inline in the sender's hue, no fill, **even leading** across the two wrapped lines. Matches `grok/dark-hero-00.png`. |
| **7** accent off large surfaces | **PASS** | Light pane C\* **3.5 → 1.22**, bubble **5.1 → 2.71**. Falsifier run: pane `[253,251,249]` and sidebar `[250,247,244]` are **byte-identical** between the coral and the teal board. The warm paper is a fixed neutral, which is what item 7 asked for. |
| **8** flat marks | **PASS** | Per-mark ΔL\*(lit−shade) on the shipped strip: **+0.02, +0.17, +0.34, +0.41, −0.39, +0.23, +1.18** (residual = edge AA). Same measurement on `ab/strip-white-old@2x`: **+2.0 … +4.0**. Chroma preserved (C\* 38–83 vs Grok 66–88). `LIFT` defaults to `flat` → 0 `linearGradient` nodes in the shipped render. |
| **9** cast variety | **PASS** | Seven distinguishable silhouettes: pebble, egg, circle, capsule, **rhombus**, **cloud**, **wedge**. Per-character gaze and idle tilt are visibly different face to face. This now **exceeds** the reference — Grok's roster is six near-identical circles + one triangle, with the *same* two eye marks on all seven. |
| **10** white eyes | **PASS** | Eye-pixel means for all 7: ≈`(249,247,245)`, min L 207–223. Correct call: `grok/anim-hero-08`'s in-product sidebar uses white on every mark. |
| **11** mobile | **PASS** | 130 px void gone; the frame is clipped at y≈114 under the floating header (whose blur carries the sunset through — nice); opaque status strip; `SB` chip in the header (C12 satisfied). |
| **12** italic | **PASS** | `:120` and `:222` both `font-style:normal`; zero italic outside the four `@font-face` descriptors. Confirmed in render. |
| **13** warm object | **PASS (weakest of the 15)** | Real depth: layered gradients, horizon haze, grain, drop shadow, real 11 px marks in the mini-sidebar, caption row. It is unambiguously warm and non-flat and the code diff is off the lead. But at 1:1 next to Grok it reads as an *illustration of* a screenshot — synthetic sky, grey skeleton bars inside. (Grok's inner windows are also part-skeleton, so the gap is smaller than it sounds.) |
| **14** derived accent | **PASS on mechanism, PARTIAL on execution** | `--accent` written from `CAST[focus].hue` (`:941`, `:976`); one swap re-skins selected row `(251,235,230)`→`(233,240,236)`, header mark, in-flight pill, composer placeholder — with neutrals byte-identical. **But** see finding B below. |
| **15** presentation | **PASS** | Sheet crops confirm: no title, no subtitle, no `PAPER — LIGHT` plates, no `390 × 844`. `board-light.png` is a standalone full-bleed lead. `studio-paper.png` / `studio-charcoal.png` deleted from disk. |

### Blind-swap retest, true 1:1 (Grok downsampled from DPR2)

**Roster — better than Grok.** Composite `…/scratchpad/v/swap-roster.png`. Ours wins on silhouette variety and on per-face gaze; Grok's seven faces carry the identical eye pair. Row rhythm reads more generous. The only place the eye catches ours as "more UI" is the tinted selected row vs Grok's neutral grey — and that is now a defensible C7 choice because the teal board proves the mechanism.

**Conversation — same class.** Composite `…/v/swap-conv.png`. Grok still wins on two things: the photographic embed, and labelling the work card (`Computer` + `• Done`). We win on the delegation pill, inline provenance, receipt typography and the button row. Where the eye catches now, in order: (1) the picture frame — correct, it is meant to be the hero object; (2) the black user bubble — correct, highest contrast; (3) the permission card. **Nothing reads cheap.** All three objects the review flagged as cheap (coral fill, coral ring, filled chips) are gone, and I could not find a replacement for them.

**Dark — fixed.** Ladder reads at a glance; nothing recedes into a well.

### Fresh glance — what the fixes exposed

**A. Copy contradiction on the lead board (the one the owner opens first).** `permission()` hard-codes the question at `page.html:831`: `' before I tag the release?'`. On `board-light.png` the receipt directly above reads **`release → v0.6.0 tagged`** and the roster snippet reads **`tagged v0.6.0`** — the agent asks permission to do the thing it just reported having done. Item 5 made this *more* visible by promoting the receipt values to proportional 15 px.

**B. The two boards share their bottom third verbatim.** Band diff over the pane, `board-light` vs `board-patch-focused`: y660–940 is **0.00 %** different — the schedule divider, the working bubble, `Typing…` and the **entire** permission card (command, subtitle, all three buttons) are the same pixels. Source confirms: both branches end in the identical 4-call sequence (`:880-889` / `:925-934`). On the Patch board — a session about euro parsing whose last human line is `good. open the PR` — "before I tag the release?" is off-topic. Seen together, the C7 proof reads as a re-skin.

**C. Appendix sheet padding.** Content bbox y 43→3352 on a 3488 canvas: top pad 43, bottom pad **135**, and the last row is a 915 px card in a 1904 px row. Appendix-grade, but it is trailing slop.

**D. For the record — the review was wrong on one point.** `grok/anim-hero-08` shows Grok's composer `+` **in a filled grey disc**. The fixer removed ours, so we now diverge from the reference in the direction the review asked for. Fine either way; just don't "correct" it back on someone's say-so.

---

## VERDICT: one more round — but a copy round, not a design round

Every one of the 15 items is a genuine PASS on my own pixels. The blocker is dead, the dark theme is right, the three cheap objects are gone, and the roster now beats the reference. Visually this is ready. What is not ready is that the lead artifact's two most prominent text objects contradict each other, and after a hard rejection that is the kind of thing an owner reads first.

**Minimal list (2 required, 1 optional — all in `hero-mockup/src/page.html`):**

1. **`:831`** — make the permission question a parameter instead of a hard-coded string, and resolve the contradiction on the lead board. Either change the third receipt row to `build → 2 checks running` (keeping "before I tag the release?"), or keep the receipt and ask `…before the nightly run?`. One string.
2. **`:889`** — give the Patch board its own final four nodes (sysLine + working bubble + presence + permission). Something in its own world, e.g. `git push --force-with-lease` · *"in supermux/server · rewrites the branch you're on"*. This is what makes board #2 read as a second session rather than a palette swap.
3. *(optional)* Sheet bottom padding 135 → 44 and centre or widen the avatar-strip card in the last row.

Re-shoot `board-light`, `board-patch-focused` (+`@2x`) and `appendix-sheet` after; no other artifact is affected. No re-review needed on my side — these are verifiable by reading the two strings.

**Files:** deliverables `/tmp/claude-1000/-opt-projects-supermux/0ce1fa02-9bc2-41c3-b2c6-7b2814d510c0/scratchpad/hero-mockup/` · my composites and crops `/tmp/claude-1000/-opt-projects-supermux/0ce1fa02-9bc2-41c3-b2c6-7b2814d510c0/scratchpad/v/` (`swap-roster.png`, `swap-conv.png`, `btnrow-light.png`, `btnrow-dark.png`, `prov-dark.png`, `mob-light-top.png`, `sheet-top.png`, `sheet-bot.png`) · measurement harness `/tmp/claude-1000/-opt-projects-supermux/0ce1fa02-9bc2-41c3-b2c6-7b2814d510c0/scratchpad/m.py`.
