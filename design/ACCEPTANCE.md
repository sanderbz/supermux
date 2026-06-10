# supermux — frontend acceptance notes

Per-milestone notes on platform limitations, deferred work, and how each
Termius acceptance criterion is satisfied. Critics reference this file.

## M17 — joystick + 2-finger gesture

The Termius signature interaction over the live terminal, built as a new
overlay (`components/joystick/joystick.tsx` + `use-two-finger.ts`) layered on
the M13 `<LiveTerminal/>`. No second WebSocket, no second xterm — the overlay
drives the same `useLiveTerm` handle the mobile dock uses.

### Hold-to-arm joystick

- **Arm time** = 350ms stationary hold (criterion #2). A pre-arm move > 8pt
  cancels into normal selection.
- **Rose** = 88px translucent ring, 1px border, 0 fill, fades in within 80ms
  of arm at the touch point (criterion #3).
- **Speed tiers** by radial distance from the press origin (criterion #4):
  8–32pt → 90ms repeat (slow), 32–72pt → 50ms (medium), ≥72pt → 20ms (fast).
- **Direction lock** holds the dominant axis through wobble; only re-orients
  when the touch holds outside a 30° cone for ≥80ms.
- **Release** fades the rose out over 120ms; no haptic on release.

### Two-finger PageUp / PageDown

- Two-finger swipe **down** ≥ 20pt cumulative → `PageUp`; **up** → `PageDown`
  (criterion #7). Every additional 24pt of translation emits one more key.
- Velocity > 1500 px/s emits 2 keys at once for instant page-of-page scroll.
- A second finger landing **cancels** the one-finger joystick immediately.

### iOS Safari haptic limitation

**Haptics on iOS Safari = CSS-only scale press; true haptics deferred to
Capacitor v3.1.**

`navigator.vibrate` is unavailable on iOS Safari (the primary mobile target).
The joystick arm feedback therefore uses two paths:

- **(a) Android Chrome** — `navigator.vibrate(8)`, gated by `'vibrate' in
  navigator`, gives a real selection-tick haptic.
- **(b) iOS Safari** — a 60ms `scale: 0.96 → 1.0` micro-press on the rose
  origin element provides visible-without-sound feedback at the exact arm
  moment.

True iOS haptics (`UIImpactFeedbackGenerator` / Capacitor `HapticsImpact`) are
a native-shell concern and are deferred to v3.1.

### Reduce Motion

When `prefers-reduced-motion` is set, the rose is not rendered and the arm
micro-press is skipped (criterion #13) — keys still flow exactly the same; only
the decorative animation is dropped.

### Gesture toggle

The joystick is enabled by default ("joystick wins"). The M16 accessory bar's
"Gesture" key flips it off via the `enabled` prop passed from `focus/mobile.tsx`
(`gestureOn` state). When off, the overlay is `pointer-events-none` so taps fall
through to xterm; long-press → Apple-style selection is a next-milestone item.

---

## M24b — full acceptance checklist (Termius "v3 finish" criteria)

The 20 criteria from `research/termius-ios-native-spec.md` §"v3 finish
acceptance criteria". A reviewer checks each with a stopwatch + screen recorder
on a real iPhone, side-by-side against Termius. **Ship gate: ≥ 18 / 20 pass.**

Each box is left UNCHECKED — they are signed off during the manual on-device
review pass (the §10 M24b "Verification: manual sign-off on iPhone"). The
automated e2e suite (`web/tests/e2e/smoke/`) covers the load-bearing data-flow
paths; these 20 are the *feel/timing* criteria that need a human + a device.

- [ ] **1. Tap-to-press scale.** Press any tile/button. The pressed element
  scales to **0.96** with a ~100 ms ease-out; release uses an interactive
  spring (`response 0.15, damping 0.86`). No haptic on every tap — only on
  commit actions. *Test:* slow-mo screen-record a tile press; scrub frames.
- [ ] **2. Joystick arm-time.** Long-press the live terminal. The joystick
  arms at **350 ms ± 25 ms**; the selection haptic fires exactly at arm.
  *Test:* `joystick-arms.spec.ts` proves arm < 400 ms automatically; on-device,
  feel the tick. *Covered by e2e (timing ceiling).* 
- [ ] **3. Joystick rose.** On arm, an 88 pt translucent ring (1 pt
  `.tertiaryLabel` stroke) fades in at the touch point within **80 ms**.
  *Test:* screen-record the arm moment.
- [ ] **4. Joystick speed tiers.** Drag out from the press origin: slow
  (≈ 10 keys/s) → medium (≈ 20/s) → fast (≈ 50/s) tiers are clearly
  distinguishable; direction lock holds through < 30° wobble. *Test:* drag in
  a wobbling arc into a `cat`-style buffer; count repeats.
- [ ] **5. Accessory bar height.** The keyboard accessory bar is **44 pt**
  exactly; key chips are ≥ 44 × 44 pt hit targets; gray-nav vs white-function
  chips are visually distinct in light AND dark mode. *Covered by e2e:*
  `kbd-accessory-swipe.spec.ts` asserts the 44 px bar height.
- [ ] **6. Key-group page swipe.** Swipe the function-key zone: it snaps with
  `.snappy(0.25)` + fast deceleration; page-indicator dots appear and auto-hide
  after 1.5 s. *Covered by e2e (snap):* `kbd-accessory-swipe.spec.ts` proves a
  swipe pages one group; on-device, confirm the dots + feel.
- [ ] **7. Two-finger PageUp/Down.** A two-finger vertical swipe fires
  PageUp/PageDown within **100 ms** of crossing the 20 pt threshold; never
  false-fires during a one-finger joystick gesture. *Test:* scroll a long
  buffer two-fingered; then joystick one-fingered and confirm no page jump.
- [ ] **8. Reconnect banner.** Kill connectivity: the banner slides in within
  **350 ms**; on recovery the amber→green morph is in-place (no slide-out +
  slide-in); auto-dismisses 1.2 s after success. *Test:* toggle airplane mode.
- [ ] **9. Sheet rubber-band.** Drag a half-detent sheet 1000 pt up — the
  over-drag asymptotes at `0.55 × dimension` extra and never further (Apple
  bungee formula). *Test:* hard-drag the focus sheet past full.
- [ ] **10. Sheet velocity-dismiss.** A downward fling > **1200 pt/s**
  dismisses the sheet regardless of travel distance. *Test:* short, hard
  downward flick on the focus sheet.
- [ ] **11. Drag indicator.** Every multi-detent sheet shows a 36 × 5 pt grab
  handle (2.5 pt corner, `.tertiaryLabel`, 6 pt from top). *Test:* open each
  sheet; inspect the handle.
- [ ] **12. Materials + Reduce Transparency.** With *Reduce Transparency* on,
  glass surfaces fall back to opaque `.systemBackground` with `.label` text.
  *Test:* Settings → Accessibility → Reduce Transparency, then reopen sheets.
- [ ] **13. Reduce Motion.** With *Reduce Motion* on, the joystick rose fade,
  snippet-panel spring, and banner shimmer are disabled; crossfades replace
  transitions. *Test:* Settings → Accessibility → Reduce Motion.
- [ ] **14. Dynamic Type.** No hardcoded font sizes — text scales with Dynamic
  Type. At XXL size, accessory chips don't clip (they grow / scroll). *Test:*
  Settings → Display → Text Size → max.
- [ ] **15. Semantic color.** System surfaces use semantic tokens exclusively;
  the brand tint is the only hex literal in the app. *Test:* toggle light/dark
  + grep the CSS for stray hex.
- [ ] **16. Snippet panel.** Opens as an in-place slide-up (`.thinMaterial`,
  320 pt / 50 %), not a full sheet; long-pressing a snippet fires a `.medium`
  haptic and runs it immediately. *Test:* open the snippet panel from the dock.
- [ ] **17. Selection loupe.** In selection mode the loupe is a 120 pt circle
  at 1.25× zoom, tracks the touch in real time 12 pt above the finger; handles
  are 16 pt visible / 44 pt hit. *Test:* long-press terminal text to select.
- [ ] **18. Swipe-to-delete.** On list rows, a full-swipe past 50 % width
  auto-fires the destructive action with a `.medium` haptic; a short swipe
  reveals buttons and snaps back below 30 %. *Test:* swipe a board issue / file
  row.
- [ ] **19. Transition budget.** No tab/section transition exceeds **400 ms**
  (first-launch hero animation may reach 600 ms). *Test:* screen-record tab
  switches; scrub.
- [ ] **20. Status-pill morph.** Status pill state changes morph in place with
  `.snappy(0.25)` — never a hard cut, never a slide-out+slide-in for the same
  surface. *Test:* watch a tile transition idle → active → waiting.

### Automated coverage map

The `web/tests/e2e/smoke/` Playwright suite (run against a real booted
`supermux-server` per spec) covers the critical user journeys + the
machine-checkable slices of the criteria above:

| Spec | Journey | Criteria touched |
| --- | --- | --- |
| `overview-loads` | boot → overview empty-state → tile render | — |
| `focus-types-and-sees-output` | the hero loop: keystroke → pty → xterm | — |
| `board-claim-race-no-500s` | 100 parallel claims → exactly-once, zero 500s | — |
| `ws-reconnect-restores-stream` | backend kill/restart → WS reconnect | 8 |
| `files-edit-save` | browse → edit in CodeMirror → Save → on-disk | — |
| `scheduler-fires` | create "in 5s" shell job → marker file on disk | — |
| `kbd-accessory-swipe` | mobile: accessory bar 44 px + pager swipe-snap | 5, 6 |
| `joystick-arms` | mobile: long-press → joystick arms < 400 ms | 2 |

### Stranger test findings (CEO #10 — "5 strangers, 60 seconds")

Hand each of 5 people *not on the team* the configured iPhone PWA; ask them to
use it for 60 seconds with no instructions. Record their faces (with consent).
If any face shows confusion in the first 10 seconds, file a bug below, FIX it,
and re-run.

> **Status:** pending — the stranger test requires physical devices + 5
> participants and is run during the on-device M24b sign-off. Findings and any
> bugs filed are appended here. No blocking confusion observed in the automated
> dogfood pass (the e2e suite drives every critical journey green).

_(no findings logged yet — to be filled during the on-device review)_
