// Platform detection + keyboard-shortcut formatting helpers.
//
// Centralizes the "is this a Mac?" check so every surface renders the
// modifier glyph the same way — ⌘ on Apple keyboards, Ctrl on
// Windows/Linux/Chrome OS. SSR-safe (returns false when `navigator` is
// undefined, so the first paint is always the more conservative
// "Ctrl" rendering until React hydrates).

/** True when the user is on an Apple-keyboard surface (macOS desktop,
 *  iPadOS, iOS). We use `navigator.platform` which is deprecated-but-stable
 *  for this exact use case; `userAgentData.platform` would be cleaner but
 *  is Chromium-only. Matches the existing detection in
 *  `components/focus-mode/dock.tsx`. */
export function isMacLike(): boolean {
  if (typeof navigator === 'undefined') return false
  return /Mac|iPhone|iPad/.test(navigator.platform)
}

/** The visible glyph for the platform's "command" modifier — the one
 *  paired with letter/number keys for app shortcuts. */
export function modKeyGlyph(): '⌘' | 'Ctrl' {
  return isMacLike() ? '⌘' : 'Ctrl'
}

/** ARIA-friendly spoken form of the modifier ("Command" / "Control"). */
export function modKeyAriaWord(): 'Command' | 'Control' {
  return isMacLike() ? 'Command' : 'Control'
}

/** Format a compact combo string like `"mod+1"` or `"mod+k"` into the
 *  individual visible parts a <Kbd> component renders. The `mod` token
 *  resolves to the platform's command modifier; everything else is passed
 *  through verbatim with first-letter caps (so `"k"` renders as `"K"`).
 *  Multiple modifiers (e.g. `"mod+shift+a"`) are supported. */
export function formatKbdParts(combo: string): string[] {
  return combo.split('+').map((part) => {
    const lower = part.trim().toLowerCase()
    if (lower === 'mod') return modKeyGlyph()
    if (lower === 'shift') return isMacLike() ? '⇧' : 'Shift'
    if (lower === 'alt' || lower === 'opt') return isMacLike() ? '⌥' : 'Alt'
    if (lower === 'ctrl') return isMacLike() ? '⌃' : 'Ctrl'
    if (lower === 'enter' || lower === 'return') return isMacLike() ? '⏎' : 'Enter'
    if (lower === 'esc') return 'Esc'
    if (lower === 'tab') return isMacLike() ? '⇥' : 'Tab'
    if (lower === 'space') return 'Space'
    // Single letters & digits: uppercase letters; digits unchanged.
    if (lower.length === 1) return lower.toUpperCase()
    return part
  })
}

/** Spoken ARIA label for a combo, e.g. "Command 1" / "Control 1". */
export function formatKbdAria(combo: string): string {
  return combo
    .split('+')
    .map((part) => {
      const lower = part.trim().toLowerCase()
      if (lower === 'mod') return modKeyAriaWord()
      if (lower === 'shift') return 'Shift'
      if (lower === 'alt' || lower === 'opt') return isMacLike() ? 'Option' : 'Alt'
      if (lower === 'ctrl') return 'Control'
      if (lower === 'enter' || lower === 'return') return 'Enter'
      if (lower === 'esc') return 'Escape'
      if (lower === 'tab') return 'Tab'
      if (lower === 'space') return 'Space'
      if (lower.length === 1) return lower.toUpperCase()
      return part
    })
    .join(' ')
}
