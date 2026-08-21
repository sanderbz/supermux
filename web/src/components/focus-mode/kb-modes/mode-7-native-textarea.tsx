// Mode 7 — NATIVE <textarea>.
//
// The highest-signal candidate in the whole system. On the owner's device the
// TERMINAL composer — a native `<input>` inside `focus-mode/dock.tsx` — is FLUSH
// on the soft keyboard with zero band, while the CHAT composer (a
// `contenteditable`) floats the ~68px black band. The obvious hypothesis: iOS
// gives a *real focused form control* (`<input>` / `<textarea>`) its native
// keyboard-avoidance — scrolling/anchoring the focused control to sit exactly
// above the keyboard — but does NOT extend that treatment to a focused
// `contenteditable`. So this mode makes the chat field a real `<textarea>` and
// lets the platform do what it already does for the terminal input.
//
// TWO PARTS, ONE OWNED HERE
//   1. The FIELD swap (NOT in this file). The registry entry for this mode
//      carries `field: 'textarea'`; `useKbField()` (kb-modes/use-kb-field.ts)
//      resolves that for the active mode, and the composer field
//      (`chat/plain-editable.tsx`) renders a real `<textarea>` — preserving the
//      existing draft / send / autosize wiring — instead of the contenteditable.
//      That swap is the mechanism, but it lives in shared composer/store files,
//      not here.
//   2. The LAYOUT (this file). Deliberately identical to Mode 1 (Pure native):
//      a single `height:100dvh` flex column with a `flex-1 min-h-0` scroll body
//      and the composer riding flush at the column bottom. No JS, no
//      `visualViewport` read, no `translate`, no CSS-var indirection — the only
//      moving part is the browser's own keyboard avoidance acting on the now-
//      native focused control. Pairing the field swap with the *simplest*
//      declarative column is intentional: it isolates the variable under test
//      (contenteditable → textarea) so a zero-band result is attributable to the
//      native control and nothing else.
//
// TECHNIQUE
//   · Outer box: `position:relative; height:100dvh; display:flex;
//     flex-direction:column; min-height:0`. `relative` so ChatSurface's
//     pre-wrapped `absolute inset-x-0 bottom-0 z-[4]` composer footer and the
//     `absolute` header-overlay card anchor to THIS box's edges. `min-height:0`
//     lets the body child shrink below its content so its own overflow scroller
//     engages instead of the box growing past the viewport.
//   · Body: rendered as handed — it already carries
//     `min-h-0 flex-1 overflow-y-auto overscroll-contain`, so it takes the
//     remaining height and owns its own scroll (never the page).
//   · Composer: last child, pinned flush to the box bottom. Its home-indicator
//     safe-area pad is owned by `ComposerFrame`
//     (`pb-[max(min(--kb-safe-bottom,--safe-bottom),14px)]`), so this mode adds
//     NO extra bottom padding — a second `env(safe-area-inset-bottom)` here would
//     re-introduce exactly the black band the whole system exists to kill.
//
// NO imperative opt-in: there is no global to flip. The field swap is declared on
// the registry entry and read reactively by the composer, so mounting/unmounting
// this layout leaves no residue — switching modes is clean.
//
// RISK: contenteditable → textarea changes autosize / paste / IME behaviour; the
// draft wiring must survive the swap (that is the composer's responsibility, not
// this file's). And if a given iOS build does NOT give the focused `<textarea>`
// special avoidance either, this degrades to the same overlay caveat as Mode 1.
// The owner keeps it only if his hardware gives zero band.
//
// Invariants (contract.ts): default-exports a KbLayoutComponent; renders header,
// body, composer in that visual order; body owns its scroll; composer keeps its
// safe-area pad; no resting transform/filter/backdrop-filter/contain on the box,
// so it never becomes an unintended containing block for fixed chrome.

import type { KbLayoutComponent } from './contract'

const Mode7NativeTextarea: KbLayoutComponent = ({ header, body, composer }) => {
  return (
    <div
      data-kb-mode="native-textarea"
      style={{
        position: 'relative',
        height: '100dvh',
        display: 'flex',
        flexDirection: 'column',
        minHeight: 0,
        width: '100%',
      }}
    >
      {header}
      {body}
      {composer}
    </div>
  )
}

export default Mode7NativeTextarea
