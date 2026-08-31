import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './styles/globals.css'
import App from './App.tsx'
import { initPWA } from '@/lib/pwa'
import { installFetchInstrumentation } from '@/lib/api/fetch-wrap'
// Side-effect import: captures the path the SPA BOOTED at, which is what makes
// "open where I left off" a launch behaviour rather than a navigation one. It
// has to happen here, in the entry chunk — a lazy route chunk loads too late to
// tell a cold load onto `/` from a walk back to it. See lib/cold-start.ts.
import '@/lib/cold-start'

// Install the global fetch wrapper BEFORE any component renders so the
// FIRST /api/* call is observed by the connection-state machine. Idempotent.
installFetchInstrumentation()

// Register the service worker (offline app-shell cache) + inject the iOS
// launch-splash <link> tags. No-op in dev / non-PWA environments.
initPWA()

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
