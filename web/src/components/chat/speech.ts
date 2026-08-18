// Web Speech feature-detection for the chat composer.
//
// The composer's rest-state mic is a dictation affordance, and dictation runs on
// the Web Speech API (`SpeechRecognition` / the `webkitSpeechRecognition`
// prefix). iOS Safari and iOS WKWebView DO expose it under the `webkit` prefix —
// dictation works on the iPhone, which is why `focus-mode/use-dictation.ts`
// carries iOS-specific `onend` handling. So the mic is shown on iOS, not hidden;
// it is only absent where the browser exposes NEITHER constructor.
//
// The composer itself gates on `useDictation().supported` (the same predicate,
// through the hook that also runs the recognition session). This pure helper is
// kept as the window-guarded predicate the unit tests assert directly, and as a
// dependency-free reader for any surface that only needs the boolean. Mirrors
// `use-dictation.ts`'s own `getRecognitionCtor`.

/**
 * True when the browser exposes the Web Speech recognition constructor under
 * either its standard or `webkit`-prefixed name — which INCLUDES iOS Safari /
 * WKWebView (`webkitSpeechRecognition`). False only where neither exists and in
 * any non-DOM environment (SSR / `bun test`).
 */
export function speechRecognitionSupported(): boolean {
  if (typeof window === 'undefined') return false
  return 'SpeechRecognition' in window || 'webkitSpeechRecognition' in window
}
