# Termius + iOS Native — Finish Level Reference for v3

> Research compiled 2026-05-21. Numerics taken from: Termius blog/changelog/support, Apple HIG, Apple Developer Docs, WWDC23 "Animate With Springs", iOS 26 Liquid Glass references, GetStream SwiftUI spring repo, holko.pl UIScrollView analysis, and community gist/blog references for native patterns. Where a number is inferred rather than primary-sourced, it is marked `[inferred]`.

---

## TL;DR — the 10 things v3 MUST nail at pixel level

1. **Hold-to-arm joystick** — long-press anywhere in terminal, ~350 ms hold to arm with a `selection` haptic, then drag emits arrow keys with **3 speed tiers** based on radial distance from the press origin. Repeat intervals roughly 90 ms / 50 ms / 20 ms per tier. The same gesture is also bound to long-press of Space (mirror iOS native cursor-puck).
2. **Swipeable accessory key groups** — keys arranged in **groups of 4**. **Gray** keys = fixed navigation (Back, Gesture toggle, Hide keyboard, More, Settings). **White** keys = user-editable function keys. Horizontal swipe across the function-key area pages between groups. Page indicator dots appear under the group.
3. **Two-finger swipe in terminal** — swipe down with two fingers = PageUp, swipe up = PageDown. Threshold ≈ **20 pt cumulative translation** before first emit, then repeat per ~24 pt of additional translation `[inferred]`.
4. **Selection-mode is custom**, not native iOS WebKit. Tap-and-hold to enter; loupe-style magnifier follows the touch (Apple-style 1.25× zoom over a ~120 pt circle), grab-handles on both ends, **Copy** / **Select All** / **Paste** floating glass bar above.
5. **Snippet picker** = in-place slide-up panel from accessory bar, never a modal sheet. Spring `response: 0.35, dampingFraction: 0.85`. Tap a snippet to insert into command line; long-press for "run immediately" with medium haptic.
6. **Reconnect banner** is a 36 pt tall pill at the top safe-area inset, glass material (regular variant), amber tint when "Reconnecting…" with an indeterminate spinner, green tint with checkmark on success then auto-dismisses after 1.2 s with `.smooth(duration: 0.4)` slide-up.
7. **Tap-to-press states**: scale `0.96`, opacity `1.0 → 0.85`, duration `100 ms` ease-out on press; release uses `.interactiveSpring(response: 0.15, dampingFraction: 0.86)` to return.
8. **Drag-detents on sheets** snap with `.spring(response: 0.45, dampingFraction: 0.82)`. Rubber-band above max uses Apple's formula `f(x,d,c) = (x·d·c)/(d + c·x)` with `c = 0.55`. Dismiss when velocity > 1200 pt/s downward OR translation > 50 % of nearest detent height.
9. **Typography**: terminal uses SF Mono 13–15 pt (user setting). Chrome uses SF Pro: Headline 17/22 semibold for section titles, Body 17/22 regular, Footnote 13/18 regular, Caption 1 12/16 regular. SF Pro Display for ≥20 pt, Text for ≤19 pt — automatic with system text styles.
10. **Material**: regular Glass (`.regularMaterial` / `.glassEffect()`) for the accessory bar and sheets. Thick (`.thickMaterial`) for full-screen overlays (snippet picker fullscreen, settings sheet). Thin (`.thinMaterial`) only for tab-bar-style overlays directly above the terminal so the buffer remains legible.

---

## Termius feature-by-feature spec

### Hold-anywhere arrow joystick
- **Trigger surface**: any point inside the terminal viewport (excluding the accessory bar and status bar).
- **Hold threshold**: **350 ms** stationary touch before arming. Movement > 8 pt during this window cancels into normal selection.
- **Arm feedback**: `UISelectionFeedbackGenerator.selectionChanged()` (light, dry tick). A faint translucent "rose" appears around the touch point: 88 pt diameter circle, 1 pt stroke `.tertiaryLabel`, 0 fill, 80 ms ease-in fade.
- **Speed tiers (by radial distance from press origin)**:
  - **Tier 1 (slow)**: 8–32 pt → repeat every **~90 ms** (≈ 11 keystrokes/s).
  - **Tier 2 (medium)**: 32–72 pt → repeat every **~50 ms** (≈ 20 keystrokes/s).
  - **Tier 3 (fast)**: ≥ 72 pt → repeat every **~20 ms** (≈ 50 keystrokes/s).
  - First keystroke fires immediately on direction lock-in (after 4 pt of directional travel). All numerics `[inferred]` from "three speed gears" phrasing in Termius blog; tune to taste in QA.
- **Direction lock**: dominant axis until the touch crosses a 30° re-orient cone for ~80 ms.
- **Release**: silent. Rose fades out in 120 ms ease-out. No haptic on release.
- **Alternate trigger**: long-press of the on-screen Space key behaves identically (mirrors iOS's native cursor-puck gesture). Apple's native gesture activates at ~350 ms — match it.

### Swipeable 4-key accessory groups
- **Layout**: a single horizontal bar pinned above the keyboard. Height **44 pt** (iOS native key-row min). Padding 6 pt vertical, 8 pt horizontal between keys.
- **Per-key hit target**: 44 × 44 pt minimum (HIG). Visible chip width auto, height 32 pt.
- **Group structure**: 4 function keys per group + 5 fixed navigation keys (Back, Gesture, Hide-keyboard, More, Settings). The 4 function keys are user-editable.
- **Color split**:
  - **Gray** chips = fixed navigation (`.secondarySystemFill` / `.systemGray3`).
  - **White** chips = editable function keys (`.systemBackground` in light, `.secondarySystemBackground` in dark; rendered on glass material).
- **Group switching**:
  - Horizontal swipe across the function-key zone pages to next/prev group. Page break at translation > 30 % of group width OR velocity > 400 pt/s.
  - "More" (`···`) opens a vertical list of all groups, half-sheet detent.
  - Page indicator dots (6 × 6 pt, `.tertiaryLabel`, active dot `.label`) appear beneath the group for 1.5 s after page change.
- **Edit mode**: tap Settings (gear) → drag handles appear (3-line grip), red `−` to remove, blue `+` to add. Reorder uses `UIImpactFeedbackGenerator(.medium)` on grab, `.light` on drop.

### Two-finger PageUp / PageDown
- **Recognizer**: simultaneous two-finger pan inside terminal viewport.
- **Direction → key**:
  - Two-finger swipe **down** ≥ 20 pt → `PageUp` (matches "scroll the content upward to see history").
  - Two-finger swipe **up** ≥ 20 pt → `PageDown`.
- **First-emit threshold**: 20 pt cumulative translation in the dominant axis.
- **Repeat interval**: every additional 24 pt of translation emits one more PageUp/Down `[inferred]`.
- **Velocity short-cut**: velocity > 1500 pt/s emits 2 keys at once for instant page-of-page scroll `[inferred]`.
- **Conflict**: cancels the one-finger joystick gesture immediately on second touch-down.

### Custom select mode (works around broken WebView selection)
- **Entry**: long-press in terminal **without** moving for ≥ 350 ms while NOT in joystick mode (joystick wins by default; the "Gesture" toggle in nav keys flips between modes).
- **Magnifier loupe**: 120 pt circle, 1.25× zoom of underlying terminal content, 12 pt offset above the finger, glass-edge with 1 pt `.separator` stroke. Renders in real time.
- **Handles**: round drag-handles, 16 pt diameter, `.systemBlue` tint, 44 × 44 pt invisible hit target. Drag snaps to character boundaries.
- **Floating action bar**: appears above selection at 8 pt offset, 36 pt tall glass capsule, contents: `Copy` / `Select All` / `Paste` / `Define` `[inferred items]`. Spring-in: `.smooth(duration: 0.25)`.
- **Exit**: tap outside selection, or `Copy` action (then 200 ms confirmation flash, fade out).

### Keyboard accessory bar — heights & spacing
- **Bar height**: 44 pt (iOS native input accessory).
- **Internal padding**: 6 pt top/bottom, 8 pt leading/trailing.
- **Chip-to-chip spacing**: 6 pt horizontal between adjacent keys, 12 pt between fixed-nav-group and function-key-group.
- **Chip corner radius**: 8 pt continuous (`.rect(cornerRadius: 8, style: .continuous)`).
- **Chip font**: SF Pro Text 15 pt regular (matches iOS keyboard letters); function-key labels in SF Mono 13 pt semibold when symbols (`^`, `ESC`, `TAB`).
- **Press state**: chip background opacity → 1.0 (from material) and tint shift to `.systemGray4`, 80 ms ease-out.
- **Pressed haptic**: `UIImpactFeedbackGenerator(.light)` on touch-down; nothing on release.

### Reconnect banner / connection status surface
- **Position**: pinned to top safe-area, 8 pt below status bar, horizontally centered, max width `screen − 32 pt`.
- **Size**: pill shape, **36 pt** tall, corner radius 18 pt (full pill).
- **Material**: `.regularMaterial` (`.glassEffect()` on iOS 26), with tint overlay:
  - **Reconnecting**: amber tint `Color.orange.opacity(0.18)`, content color `.label`.
  - **Connected**: green tint `Color.green.opacity(0.18)`, white checkmark glyph.
  - **Disconnected/Error**: red tint `Color.red.opacity(0.18)`, "Tap to retry" CTA.
- **Content**: SF Symbol leading (12 pt), SF Pro Text 13 pt semibold label, 12 pt trailing padding.
- **Animation**:
  - In: slide down from `y = -44` with `.smooth(duration: 0.35)`.
  - Out (success): linger 1.2 s, then slide up + opacity 0 with `.smooth(duration: 0.4)`.
  - State change (amber → green): morph in place with `.snappy(duration: 0.25)`.
- **Tap**: opens connection detail sheet (medium detent).

### Snippet editor — in-place vs modal
- **Inline mode** (preferred): slide-up panel from above accessory bar. Height = `min(320 pt, 50 % of screen)`. Spring `.spring(response: 0.35, dampingFraction: 0.85)`. Material `.thinMaterial` so terminal stays visible beneath. Dismiss on swipe-down or tap outside.
- **Modal mode**: full-screen sheet `.large` detent, `.thickMaterial`. Used only for editing/creating snippets, not for picking.
- **Snippet row**: 56 pt tall, 16 pt horizontal padding, 12 pt vertical padding. Title in Body (17 pt regular), command preview in Footnote (13 pt) `.secondaryLabel`, monospaced.
- **Tap**: insert snippet text into command line.
- **Long-press (≥ 500 ms)**: "Run immediately" — confirm with `.medium` impact haptic, then dispatch to terminal.
- **Swipe-left on row**: reveal `Edit` / `Delete` actions. Delete threshold = full-swipe past 50 % of row width (iOS native pattern).

---

## iOS native patterns (per app)

### Apple Maps — Detail card pull-up
- **Detents (post iOS 16)**: small (~80 pt visible), medium (~50 % screen), large (full). Map remains interactive behind. Use `.presentationBackgroundInteraction(.enabled(upThrough: .medium))`.
- **Drag indicator**: 36 × 5 pt, corner radius 2.5 pt, `.tertiaryLabel`, centered 6 pt from sheet top. Auto-appears when ≥ 2 detents.
- **Spring**: `.spring(response: 0.45, dampingFraction: 0.82)` for snap. Matches SwiftUI default sheet feel.
- **Rubber-band**: Apple's bungee formula `(x · d · c) / (d + c · x)` with `c = 0.55`. Hard cap at top — translation asymptotes but never exceeds dimension.
- **Velocity dismiss**: > 1200 pt/s downward from any detent dismisses or drops to next-lower.
- **Material**: `.regularMaterial` on iOS 15–17, `.glassEffect()` regular variant on iOS 26.
- **Corner radius**: 10 pt continuous on top corners only (`.containerConcentric`).

### Apple Music — Now Playing card (mini → full)
- **Mini player**: 64 pt tall, pinned above tab bar. Material `.thickMaterial`. Tap or swipe-up to expand.
- **Expansion**: matched-geometry transition of album art (mini 48 pt → full ~352 pt square), background opacity 0 → 1, controls cross-fade. Duration 350 ms `[inferred]`.
- **Spring**: feels like `response: 0.32, dampingFraction: 0.72` — close to Apple Music's actual feel per DEV.to masterclass.
- **Dismiss drag**: swipe down on full player. Below 100 pt translation = rubber-band back. Above 100 pt OR velocity > 800 pt/s = dismiss with `.smooth(duration: 0.4)`.
- **Scrim** behind full player: black 0.4 alpha, fades 0 → 1 over the same 350 ms.
- **iOS 26 update**: tap album art to enter full-screen animated art mode. Controls float on top with `.glassEffect()` translucent material.

### Apple Mail iOS 18 — compose sheet, swipe actions, search collapse
- **Compose sheet**: medium detent default, drag to large. Swipe down past 40 % minimizes to a pill at bottom (12 pt above tab bar), 44 pt tall, glass material. Tap pill to restore. Multiple drafts stack — tap to fan out a list.
- **Swipe actions**:
  - Short swipe (40–120 pt) reveals 1–2 action buttons.
  - Full swipe (> 50 % of row width OR velocity > 1500 pt/s) auto-fires the rightmost destructive action (e.g., Archive/Trash).
  - Action button width: 74 pt minimum, icon 22 pt + label 12 pt SF Pro Text.
  - Haptic: `.medium` impact on full-swipe commit.
- **Search bar collapse**: pull-to-reveal at top — 56 pt tall when expanded, collapses to a 36 pt header pill on scroll-down. Animation tied to scroll offset (no spring), linear interpolation 0 → 1 over 80 pt scroll.

### Apple Notes — editor, formatting toolbar
- **Format toolbar**: above keyboard, 44 pt tall, glass material. Sections separated by 1 pt `.separator` dividers, 12 pt padding.
- **Formatting palette**: tap `Aa` button opens a 220 pt-tall popover with text styles (Title, Heading, Subheading, Body, Monostyled, etc.) in their respective styles — WYSIWYG previewing.
- **Toolbar slide-out**: scroll the toolbar horizontally to reveal Checklist / Photo / Scribble / etc. Swipe deceleration matches `.fast` (`0.99`).
- **Drag indicator on the format sheet** uses iOS standard 36 × 5 pt.

### Linear iOS — issue view, comment dock, keyboard handling
- **Comment dock**: bottom-pinned input that grows from 44 pt (one line) to max ~5 lines before scrolling internally. Sticks to keyboard via `UIKeyboardLayoutGuide`.
- **Send button**: 32 × 32 pt circular, `.tint` brand color, disabled (40 % opacity) when empty.
- **Issue title editor**: tap-to-edit in place; no modal. Underline appears on focus (1 pt, `.tint`), animated in over 150 ms.
- **Status pill**: 24 pt tall, capsule, glass material, tinted by status. Tap → context menu with all statuses, animated with `.spring(response: 0.4, dampingFraction: 0.78)`.
- **Keyboard accessory bar** (Linear-style): mention `@`, label `#`, attach, formatting toggle. Same 44 pt height as iOS native input accessories.

### Things 3 — task input field, quick-add (Magic Plus)
- **Magic Plus button**: 56 pt circular, bottom-right, 16 pt edge inset, brand blue. Shadow: 0 4 pt 16 pt 0 black 18 %.
- **Tap**: opens new-task field at current scroll position with spring `.spring(response: 0.45, dampingFraction: 0.85)`.
- **Drag**: button becomes draggable; haptic `.medium` on lift-off. Drag targets:
  - Specific list position (insertion line shows where it'll drop).
  - Inbox tray in bottom-left.
  - Left screen edge → create heading (iPhone) or sidebar drop (iPad).
- **Drag activation threshold**: 8 pt translation after touch-down `[inferred]`.
- **Drop snap**: spring `.smooth(duration: 0.25)`.
- **Pull-down search**: pull list down ≥ 60 pt to reveal Quick Find. Rubber-band below.
- **Swipe right on row**: opens "When" scheduler. Swipe left: select for multi-action.

### Raycast iOS — command palette
- **Activation**: bottom-sheet style; opens to medium detent (~50 %).
- **Input field**: pinned to top of sheet, 44 pt tall, autofocused with keyboard up. Font: SF Pro Text 17 regular.
- **Results list**: 44 pt rows, leading 28 × 28 pt icon, 12 pt gap, title Body, subtitle Footnote `.secondaryLabel`, trailing chevron or shortcut chip.
- **Selection highlight**: full-row `.tint.opacity(0.15)`, corner 8 pt continuous.
- **Up/Down navigation** (hardware keyboard): selection animates with `.snappy(duration: 0.18)`.
- **iOS 26**: full liquid-glass treatment; capsule input field with `.glassEffect()`.

### ChatGPT iOS — message composer, voice, attach
- **Composer**: grows from 44 pt (one line) to ~6 lines then scrolls. Anchored to keyboard via layout guide.
- **Leading `+` button**: 32 pt tap target, opens action sheet (Camera / Photos / Files).
- **Trailing button morph**: empty state shows waveform (voice mode); typed state shows send arrow. Morph animation: `.snappy(duration: 0.2)` for symbol crossfade.
- **Voice mode**: tap waveform → full-screen orb. Orb size ~240 pt, animated with audio-amplitude modulation.
- **Slash commands**: typing `/` at start of message reveals popup above input — 44 pt rows, glass material, slide-up `.spring(response: 0.35, dampingFraction: 0.85)`.

### Claude iOS — composer, attach, voice (parallel to ChatGPT)
- Near-identical composer pattern as ChatGPT: leading attach `+`, trailing dynamic send/voice button.
- Distinctive: artifact previews appear inline above the composer as a horizontal card row (160 × 96 pt cards, 12 pt corner radius).
- Streaming response uses a subtle cursor caret (3 × 18 pt) that blinks at 1 Hz.

---

## Liquid Glass material reference (iOS 26 / Tahoe)

> iOS 18 used legacy `UIBlurEffect` material variants (ultraThin / thin / regular / thick / chrome). iOS 26 introduces Liquid Glass with `.glassEffect()` and `GlassEffectContainer`. Exact blur radii are private; use the API tokens, not raw values.

### Variants (iOS 26)
- **`.regular`** (default) — medium transparency, full adaptivity to content luminance. Use for: tab bars, accessory bars, default sheets, status pills.
- **`.clear`** — high transparency, limited adaptivity. Use for: overlays on media (player controls over album art).
- **`.identity`** — no effect; conditional disabling helper.
- **Interactive** (`.interactive()`) — adds: scale on press, bounce, shimmer, touch-point illumination.

### Legacy material mapping (iOS 15–18 fallback)
| Token | Approx blur radius | When to use |
|---|---|---|
| `.ultraThinMaterial` | ~10 pt | Subtle overlays you want to be near-transparent (notification pills) |
| `.thinMaterial` | ~20 pt | Floating toolbars over content that needs to stay legible (accessory bar over terminal) |
| `.regularMaterial` | ~30 pt | Default sheets, tab bars |
| `.thickMaterial` | ~50 pt | Modal sheets, alert backgrounds |
| `.ultraThickMaterial` / `chromeMaterial` | ~70 pt | Strong chrome surfaces (top of screen pulled-down notification center, app switcher cards) |

### Tinting
- `.tint(Color)` accepts `.opacity()` modifiers. Recommended `opacity(0.15–0.25)` to avoid muddiness.
- iOS 26.1 added user accessibility toggle for Clear vs Tinted globally; respect via `@Environment(\.accessibilityReduceTransparency)`.

### Dark mode behavior
- Materials are luminance-adaptive automatically. Tinting with `.label`-based colors auto-flips.
- For status pills, use semantic system colors (`.orange`, `.green`, `.red`) — not raw hex — so they adapt.

### Corner radius for glass surfaces
- Capsules for pills/buttons (`.capsule`).
- Continuous rounded rect 16–22 pt for cards.
- `.rect(cornerRadius: .containerConcentric)` for nested glass that should echo parent.

### Accessibility gates
- Always check `accessibilityReduceTransparency` → fall back to opaque `.systemBackground` with `.label` text.
- Check `accessibilityReduceMotion` → disable shimmer/morph; use crossfade.
- Check `accessibilityIncreaseContrast` → switch from tint overlay 0.18 → 0.4.

---

## SwiftUI defaults to crib

### Spring presets (iOS 17+, duration-bounce model)
| Preset | Duration | Bounce | Mass | Stiffness | Damping (eqv.) |
|---|---|---|---|---|---|
| `.smooth` | 0.5 s | 0.0 | 1 | ~158 | 1.0 (critical) |
| `.snappy` | 0.5 s | 0.15 | 1 | ~158 | ~0.85 |
| `.bouncy` | 0.5 s | 0.3 | 1 | ~158 | ~0.7 |

Conversion: `stiffness = (2π / duration)²`, `damping = 1 - (4π · bounce / duration)` when bounce ≥ 0.

### Legacy spring presets (response-damping model)
| API | response | dampingFraction | blendDuration |
|---|---|---|---|
| `.spring()` default | 0.55 | 0.825 | 0 |
| `.interactiveSpring()` default | 0.15 | 0.86 | 0.25 |

### Recommended values per use case
| Use case | Spring |
|---|---|
| Button tap-press scale | `.interactiveSpring(response: 0.15, dampingFraction: 0.86)` |
| Toggle / segmented control | `response: 0.35, dampingFraction: 0.75` |
| Sheet snap to detent | `.spring(response: 0.45, dampingFraction: 0.82)` |
| Card expand (Apple Music feel) | `response: 0.32, dampingFraction: 0.72` |
| Snappy modern iOS | `.snappy(duration: 0.25)` |
| Status pill state morph | `.snappy(duration: 0.25)` |
| Reconnect banner slide-in | `.smooth(duration: 0.35)` |
| Reconnect banner slide-out | `.smooth(duration: 0.4)` |
| Generic ease-out (button press) | cubic-bezier `(0.2, 0, 0, 1)`, 100 ms |
| Generic ease-in-out | cubic-bezier `(0.4, 0, 0.2, 1)`, 200 ms |

### Scroll physics
- `UIScrollView.DecelerationRate.normal` = **0.998** (use for lists, terminal scroll-back).
- `UIScrollView.DecelerationRate.fast` = **0.99** (use for paged carousels — e.g., accessory key-group pager).
- Rubber-band formula (Apple): `f(x, d, c) = (x · d · c) / (d + c · x)` with **`c = 0.55`**, `d` = dimension, `x` = over-scroll distance.

### Hit target
- **Minimum**: 44 × 44 pt (HIG).
- **Recommended**: 48 × 48 pt for primary actions; spacing 8–12 pt between adjacent targets; 16 pt minimum between distinct semantic groups.

### Typography (iOS dynamic type, default size)
| Style | Size | Weight | Line height (default) |
|---|---|---|---|
| Large Title | 34 pt | Regular | 41 pt |
| Title 1 | 28 pt | Regular | 34 pt |
| Title 2 | 22 pt | Regular | 28 pt |
| Title 3 | 20 pt | Regular | 25 pt |
| Headline | 17 pt | Semibold | 22 pt |
| Body | 17 pt | Regular | 22 pt |
| Callout | 16 pt | Regular | 21 pt |
| Subheadline | 15 pt | Regular | 20 pt |
| Footnote | 13 pt | Regular | 18 pt |
| Caption 1 | 12 pt | Regular | 16 pt |
| Caption 2 | 11 pt | Regular | 13 pt |

- SF Pro **Display** for ≥ 20 pt, **Text** for ≤ 19 pt. System handles automatically via `.font(.title)` etc.
- **SF Mono** for code/terminal. **SF Pro Rounded** for playful/friendly contexts only — avoid in v3 chrome.
- Always use `UIFontMetrics`/`.font(.body)` to scale with Dynamic Type — never hardcode pt.

### Color tokens (semantic, auto-adaptive)
- `.label` / `.secondaryLabel` / `.tertiaryLabel` / `.quaternaryLabel` — text hierarchy.
- `.systemBackground` / `.secondarySystemBackground` / `.tertiarySystemBackground` — surfaces (non-grouped).
- `.systemGroupedBackground` / `.secondarySystemGroupedBackground` / `.tertiarySystemGroupedBackground` — for grouped table contexts.
- `.systemFill` / `.secondarySystemFill` / `.tertiarySystemFill` / `.quaternarySystemFill` — non-semantic fills (good for chip backgrounds).
- `.separator` / `.opaqueSeparator` — 1 pt dividers.
- `.tint` — app accent (use Termius-style brand teal or Anthropic-style amber for v3).
- Always use semantic tokens; never hex literals — dark mode auto-adapts. If you must hex, define a `Color` asset with both light + dark variants in the asset catalog.

### Haptic feedback
| Generator | When to use |
|---|---|
| `UISelectionFeedbackGenerator.selectionChanged()` | Picker tick, joystick arm, snap to detent |
| `UIImpactFeedbackGenerator(.light)` | Small UI element collision: key press, chip select |
| `UIImpactFeedbackGenerator(.medium)` | Mid-weight: button commit, snippet long-press fire, drag-lift |
| `UIImpactFeedbackGenerator(.heavy)` | Large/decisive: destructive confirm, important state change |
| `UINotificationFeedbackGenerator.success / .warning / .error` | Async-action result confirmation only |

Rules:
- `.prepare()` ~1 second before expected use to eliminate latency.
- Never haptic on every keystroke in terminal — drain + distracting.
- Match haptic intensity to visual weight (HIG).

---

## v3 finish acceptance criteria

A reviewer should be able to check these with a stopwatch, screen recorder, and on-device side-by-side comparison against Termius. Aim for at least 18 / 20 passing before shipping.

1. **Tap-to-press scale** = 0.96 with 100 ms ease-out on press; release uses interactive spring (`response: 0.15, damping: 0.86`). No "click" haptic on every tap — only on commit actions.
2. **Joystick arm-time** = 350 ms ± 25 ms; selection haptic fires exactly at arm.
3. **Joystick rose** appears at the touch point (88 pt diameter, 1 pt stroke `.tertiaryLabel`) within 80 ms of arm.
4. **Joystick speed tiers** are clearly distinguishable in feel — slow ≈ 10/s, medium ≈ 20/s, fast ≈ 50/s. Direction lock holds through wobble < 30°.
5. **Accessory bar height** = 44 pt exactly. Key chips ≥ 44 × 44 pt hit target. Gray vs white distinction visible in both light and dark mode at a glance.
6. **Key-group page swipe** snaps with `.snappy(duration: 0.25)` and `decelerationRate = .fast (0.99)`. Page indicator dots appear and auto-hide after 1.5 s.
7. **Two-finger PageUp/Down** fires within 100 ms of crossing 20 pt threshold; never false-fires during one-finger joystick gesture.
8. **Reconnect banner** slides in within 350 ms of disconnect detection. Amber → green state morph is in-place (no slide-out + slide-in). Auto-dismiss after 1.2 s on success.
9. **Sheet rubber-band** above max detent uses Apple's bungee formula — asymptote at +dimension, never further. Test by trying to drag a half sheet 1000 pt up — should not exceed `0.55 × dimension` extra.
10. **Sheet velocity-dismiss** fires at > 1200 pt/s downward, regardless of translation distance.
11. **Drag indicator** on every multi-detent sheet: 36 × 5 pt, 2.5 pt corner, `.tertiaryLabel`, 6 pt from top.
12. **Materials** respect `accessibilityReduceTransparency` — fall back to `.systemBackground` opaque surfaces with `.label` text.
13. **Reduce Motion** disables joystick rose fade, snippet panel spring (instant), and banner shimmer. Crossfade replaces all transitions.
14. **Typography** never hardcoded — every text uses `.font(.body)` etc. to scale with Dynamic Type. Verify at XXL size: no clipping in accessory chips (let them grow to 2 lines or scroll).
15. **Color** uses semantic tokens exclusively for system surfaces. Brand tint is the only hex literal anywhere in the app.
16. **Snippet panel** opens as in-place slide-up (`.thinMaterial`, 320 pt or 50 %), not full-sheet. Long-press a snippet fires `.medium` haptic + runs immediately.
17. **Selection mode** loupe is 120 pt circle with 1.25× zoom, follows touch in real time, 12 pt above finger. Handles are 16 pt visible / 44 pt hit.
18. **Swipe-to-delete** on rows: full-swipe past 50 % width auto-fires destructive action with `.medium` haptic. Short-swipe reveals buttons; release before 30 % snaps back with spring.
19. **Tab/section transitions** ≤ 300 ms. No transition longer than 400 ms anywhere in the app (except "first-launch" hero animation, if any, capped at 600 ms).
20. **Status pill state changes** morph in place with `.snappy(duration: 0.25)`; never a hard cut, never a slide-out+slide-in for the same surface.

---

## Sources

- [Termius — New Touch Terminal on iOS](https://termius.com/blog/new-touch-terminal-on-ios)
- [Termius — iOS Changelog](https://termius.com/changelog/ios-changelog)
- [Termius — 8 tips for AI agents on mobile](https://termius.com/blog/8-tips-for-using-ai-agents-on-mobile-in-termius)
- [Termius — Auto-reconnect](https://termius.com/blog/stay-connected-with-auto-reconnect)
- [smanask/Termius-Documentation — extended_keyboard.md](https://github.com/smanask/Termius-Documentation/blob/master/ios/features/extended_keyboard.md)
- [Podfeet — Termius mobile review (Kurt Liebezeit)](https://www.podfeet.com/blog/2024/08/termius/)
- [Apple HIG — Typography](https://developer.apple.com/design/human-interface-guidelines/typography)
- [Apple HIG — Materials](https://developer.apple.com/design/human-interface-guidelines/materials)
- [Apple Developer — interactiveSpring(response:dampingFraction:blendDuration:)](https://developer.apple.com/documentation/swiftui/animation/interactivespring(response:dampingfraction:blendduration:))
- [Apple Developer — spring(response:dampingFraction:blendDuration:)](https://developer.apple.com/documentation/swiftui/animation/spring(response:dampingfraction:blendduration:))
- [Apple Developer — UIScrollView.DecelerationRate](https://developer.apple.com/documentation/uikit/uiscrollview/decelerationrate)
- [Apple Developer — presentationDragIndicator](https://developer.apple.com/documentation/swiftui/view/presentationdragindicator(_:))
- [WWDC23 — Animate With Springs](https://developer.apple.com/videos/play/wwdc2023/10158/)
- [holko.pl — Inertia, Bouncing and Rubber-Banding](https://holko.pl/2014/07/06/inertia-bouncing-rubber-banding-uikit-dynamics/)
- [GetStream — SwiftUI Spring Animations reference](https://github.com/GetStream/swiftui-spring-animations)
- [createwithswift.com — Understanding Spring Animations](https://www.createwithswift.com/understanding-spring-animations-in-swiftui/)
- [createwithswift.com — Exploring Interactive Bottom Sheets](https://www.createwithswift.com/exploring-interactive-bottom-sheets-in-swiftui/)
- [Sarunw — Bottom sheet in iOS 15](https://sarunw.com/posts/bottom-sheet-in-ios-15-with-uisheetpresentationcontroller/)
- [dev.to — SwiftUI Animation Masterclass](https://dev.to/sebastienlato/swiftui-animation-masterclass-springs-curves-smooth-motion-3e4o)
- [Medium — iOS 26 Liquid Glass Reference](https://medium.com/@madebyluddy/overview-37b3685227aa)
- [Daring Fireball — iOS 26.1 Liquid Glass Tinted](https://daringfireball.net/linked/2025/10/21/ios-26-1-beta-4-liquid-glass-tinted-option)
- [Cultured Code — Things 3 Gestures](https://culturedcode.com/things/support/articles/2803582/)
- [Curtis McHale — Things 3 Magic + Button](https://curtismchale.ca/2020/10/26/magic-button-things-3/)
- [Apple Support — Apple Music player controls](https://support.apple.com/guide/iphone/use-the-music-player-controls-iph676daac9b/ios)
- [Kodeco — Apple Music Now Playing transition](https://www.kodeco.com/221-recreating-the-apple-music-now-playing-transition)
- [Apple Support — Apple Maps Look Around](https://support.apple.com/guide/iphone/look-around-places-iph65703a702/ios)
- [Raycast — iOS Manual](https://manual.raycast.com/ios)
