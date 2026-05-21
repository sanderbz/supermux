// Typed accessors for the runtime config the server injects into index.html as
// `window._AMUX_*` globals (TECH_PLAN §2, §4.10). Keeping auth-critical data on
// `window` (NOT localStorage) preserves a clean Capacitor wrap path — the native
// WebView injects these via a bootstrap script.

declare global {
  interface Window {
    _AMUX_AUTH_TOKEN?: string
    _AMUX_BASE_URL?: string
    _AMUX_WS_URL?: string
    _AMUX_VERSION?: string
  }
}

/** Bearer token for HTTP requests + the WS first-frame auth message. */
export function authToken(): string {
  return window._AMUX_AUTH_TOKEN ?? ''
}

/** API base URL. Falls back to same-origin via `import.meta.env.BASE_URL`. */
export function baseUrl(): string {
  return window._AMUX_BASE_URL ?? import.meta.env.BASE_URL
}

/** WebSocket base URL (ws:// or wss://). Derived from the page origin if unset. */
export function wsUrl(): string {
  if (window._AMUX_WS_URL) return window._AMUX_WS_URL
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:'
  return `${proto}//${location.host}`
}

/** Server build version (for the about/settings screen + cache busting). */
export function appVersion(): string {
  return window._AMUX_VERSION ?? 'dev'
}
