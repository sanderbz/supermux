/// <reference types="vite/client" />
/// <reference types="vite-plugin-pwa/client" />

// Git sha this bundle was built from, injected by `vite.config.ts` `define`.
// `"dev"` outside a git working tree. Compared against the server's live
// `/api/version` `current.sha` by `src/lib/version-guard.ts`.
declare const __APP_BUILD_SHA__: string
