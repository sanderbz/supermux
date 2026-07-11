# Mobile Focus — Floating KeyBar (spec)

**Branch:** `feat/mobile-focus-keybar` · **Scope:** mobile focus page only (`web/src/routes/focus/mobile.tsx`). Desktop untouched.

## Goal

Replace the bottom-sliding "Quick keys" Vaul drawer (opened by the `···` "Specials"
dock icon) with a **floating glass KeyBar pinned near the top of the screen**. It exists
so the user can navigate Claude's on-screen option lists with **arrow keys + Enter**
WITHOUT summoning the on-screen keyboard (which re-aligns the whole viewport) and
WITHOUT the bottom panel overlapping the very options being chosen.

## Behaviour

- The `···` **Specials dock icon now TOGGLES the KeyBar** (was: opened the bottom sheet).
  Toggling is remembered (persisted) so the bar stays on across reloads/sessions.
- The bar **floats and stays** until toggled off. It never blocks the terminal except on
  its own footprint.
- Default keys: **← ↑ ↓ → Enter**. The set is **customizable** (add/remove from the full
  catalog) via a trailing edit affordance on the bar; persisted in its own pref.
- Nothing from the old catalog is lost: the existing `quick-keys.ts` catalog + the
  `MobileActionSheet` editor are **repurposed** as the KeyBar's "customize which keys"
  picker (opened from the bar's edit button), not deleted.

## Layout & styling

- **Position:** a horizontally-centered floating pill, `position: fixed`,
  `top: calc(env(safe-area-inset-top) + 44px + 20px)` (≈20px below the 44px header's
  bottom edge). `z-index` above the terminal, below modals/sheets (terminal is z-low;
  action sheets are `z-[70]`; use `z-40`–`z-50` band like `PeekOfNext`).
- **Surface:** reuse the `glass` utility but a touch more transparent
  (`background-color: color-mix(in srgb, var(--card) 62%, transparent)` local override),
  `rounded-full` or `rounded-2xl`, `border border-border/60`, subtle shadow. Keep the
  existing reduced-transparency / `@supports not (backdrop-filter)` fallbacks legible.
- **Buttons:** echo the keyboard accessory chips (`dock.tsx` `AccessoryChip`), i.e. a
  bit SMALLER than the 48px bottom chips: `h-[34px]`–`h-[38px]`, `min-w-10`/`min-w-11`,
  `rounded-xl`, `text-[13px]`–`text-[14px] font-medium`, arrow glyphs `size-[18px]
  strokeWidth={1.75}` (lucide Arrow{Up,Down,Left,Right}). Gap `gap-1.5`/`gap-2`,
  inner padding `px-2.5`/`px-3`.
- **Overflow:** if the custom set is wide, the row scrolls horizontally
  (`overflow-x-auto`, hidden scrollbar) exactly like the accessory bar.
- Trailing edit affordance: a small `Pencil`/`SlidersHorizontal` chip (same height,
  muted) opens the picker.

## Touch-safety (hard requirements)

- Only the **pill's own footprint** is interactive; the rest of the screen stays the
  terminal. Do NOT stretch a full-width pointer-catcher across the screen.
- The pill container: `pointer-events-auto` so taps on it never reach the terminal
  pane's `onTermPointerUp` (which would call `focusTerm()` and pop the keyboard).
- **Every button** must use the canonical focus-steal guard from this codebase:
  `onPointerDown={(e) => e.preventDefault()}` **and** `onMouseDown={(e) => e.preventDefault()}`
  so a tap NEVER focuses xterm's helper textarea → the keyboard never opens on press.
  (Same trick as `AccessoryChip`/`Chip`/`EnterButton`.) `touch-action: manipulation`.
- Keys are sent via the existing handle: `termRef.current?.sendKey(name)` (already wired
  in `mobile.tsx`). `keyToBytes` already supports Up/Down/Left/Right/Enter/Esc/etc.

## Animation ("top of the world", all `useReducedMotion()`-aware)

- **Enter:** pill springs down from under the header — `initial {opacity:0, y:-8,
  scale:0.96}` → `animate {opacity:1, y:0, scale:1}` with a spring from
  `@/lib/springs` (e.g. `springs.sheetDetent` or `springs.snappy`). Buttons **stagger**
  in (small per-child delay, ~18–26ms) for a natural "unfurl".
- **Exit:** reverse (collapse up + fade) via `AnimatePresence`.
- **Press:** `whileTap={{ scale: 0.9 }}` + `springs.buttonPress`, plus a brief
  **key-flash/glow** on send (there's no visible keyboard to confirm the press) — a
  short background/opacity pulse on the pressed chip.
- **Hold-to-repeat** on the arrow keys: press-and-hold repeats the key (initial delay
  ~300ms then ~60–90ms interval) so navigating long option lists is fluid. Clean up
  timers on pointerup/cancel/leave and on unmount (AbortSignal or refs).
- Reduced motion: skip translate/scale/stagger; use plain opacity; keep hold-to-repeat.

## State / persistence

- Open/closed state + the custom key set persist. Reuse the app's pref mechanism
  (`useQuickKeys` / server pref pattern; see `web/src/hooks/use-quick-keys.ts`). Use a
  NEW pref key (e.g. `focus_key_bar` → `{ open: boolean, keys: string[] }`), independent
  of the legacy `quick_keys`. Default `{ open: false, keys: ['Left','Up','Down','Right','Enter'] }`.
  A localStorage fallback is fine if wiring a server pref is heavy; keep it simple.

## Files (expected touch-list)

- **New:** `web/src/components/focus-mode/key-bar.tsx` — the floating KeyBar component.
- **New:** `web/src/routes/dev-focus-mobile.tsx` — DEV-only offline harness (see below).
- **Edit:** `web/src/routes/focus/mobile.tsx` — replace `specialsOpen`→bottom-sheet
  wiring with the KeyBar toggle + render `<KeyBar/>`; keep `MobileActionSheet` editor
  reachable from the bar's edit button.
- **Edit:** `web/src/components/focus-mode/dock.tsx` — `···` Specials icon now calls the
  toggle (rename the prop intent, e.g. `onToggleKeyBar`).
- **Edit:** `web/src/App.tsx` — register the `/dev/focus-mobile/:name?` lazy route
  (mirror the existing `/dev/focus/:name?` block; DEV-only, tree-shaken).
- Reuse (do not rewrite): `quick-keys.ts`, `mobile-action-sheet.tsx`,
  `use-quick-keys.ts`, `use-live-term.ts` (`sendKey`), `springs.ts`, `glass` CSS.

## DEV harness route (required for visual testing)

`web/src/routes/dev-focus-mobile.tsx`, registered at `/dev/focus-mobile/:name?` in
`App.tsx` (lazy, `import.meta.env.DEV` gated, matching `/dev/focus`). It must render the
REAL `MobileFocus` with mock sessions so the KeyBar can be screenshotted offline at a
390px viewport (LiveTerminal shows its "Connecting…" pill — expected, fine).

- Add an optional `mockSessions?: TileSession[]` (and if needed a forced-mobile flag) to
  `MobileFocus` mirroring how `DesktopFocus` already accepts `mockSessions`/`mockTeams`,
  so the dev route can inject `MOCK_TILES` without a backend. Seed the KeyBar `open:true`
  by default in the dev route so the bar is visible on load.
- To make the screenshot MEANINGFUL, render a fake "Claude is asking you to choose"
  option list in the mock terminal area if cheap; otherwise the connecting pill is
  acceptable — the bar is what we review.

## Out of scope

Desktop focus. Auto-detecting when Claude is prompting (no magic auto-show). Migrating
legacy `quick_keys` selections into the new pref.

## Verification (owned by the orchestrator, not the impl agent)

Vite dev in the worktree + Playwright at 390×844, DPR=1, capture: bar closed, bar open,
mid-enter animation frames, a chip pressed, keyboard-open coexistence, wide/scrolling
custom set, light + dark. Judge: position (20px under header), size (smaller than 48px),
transparency+legibility, touch footprint (no full-screen catcher), animation feel,
no keyboard-pop on press.
