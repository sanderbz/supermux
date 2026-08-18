// Web Speech feature-detection for the chat composer (mobile polish).
//
// The composer's trailing mic is a dictation affordance, and dictation runs on
// the Web Speech API (`SpeechRecognition` / the `webkitSpeechRecognition`
// prefix). iOS Safari and every iOS WKWebView expose NEITHER — so a mic shown
// there is a dead control the moment it is tapped. The composer gates the glyph
// on this predicate: present the mic only where speech recognition actually
// exists, hide it everywhere it does not.
//
// Pure and window-guarded so it is trivially unit-testable (the gate is asserted
// in `tests/unit/chat-composer-mic.test.tsx`) and safe under SSR / `bun test`,
// where `window` may be absent. Mirrors `use-dictation.ts`'s own `getRecognitionCtor`.

/**
 * True only when the browser exposes the Web Speech recognition constructor
 * under either its standard or `webkit`-prefixed name. False on iOS Safari /
 * WKWebView (no support) and in any non-DOM environment.
 */
export function speechRecognitionSupported(): boolean {
  if (typeof window === 'undefined') return false
  return 'SpeechRecognition' in window || 'webkitSpeechRecognition' in window
}
