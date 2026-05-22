# amux v3 — frontend acceptance notes

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
