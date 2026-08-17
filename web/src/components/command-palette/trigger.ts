// One way to open the ⌘K palette from a visible control.
//
// The palette's open-state is LOCAL to `<CommandPalette>` on purpose: the
// reset-on-open (blank query, highlight back to row 0) lives in a wrapper
// around that setter, and anything that flipped the state from outside would
// sail straight past it — the exact defect fase B3 T1.4 fixed. So a button
// does what a keyboard does: it sends the gesture the global listener already
// owns, and there stays exactly one definition of "the palette opened".
//
// Extracted from `focus-mode/dock.tsx`, which had the only copy and was
// therefore the only surface that could offer the palette a pointer. It now
// has three callers — the desktop dock, the mobile bottom-nav search cell, and
// the mobile focus dock — because ⌘K was UNREACHABLE on a phone: enumerating
// every visible control at 390×844 on /overview and /focus/<name> returned
// nothing matching /palette|search|command|jump/, so the only way in was a
// physical keyboard.

/** Toggle the global command palette, as if ⌘K / Ctrl+K had been pressed. */
export function triggerCommandPalette(): void {
  const isMac =
    typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform)
  window.dispatchEvent(
    new KeyboardEvent('keydown', {
      key: 'k',
      code: 'KeyK',
      metaKey: isMac,
      ctrlKey: !isMac,
      bubbles: true,
      cancelable: true,
    }),
  )
}
