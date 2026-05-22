import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './styles/globals.css'
import App from './App.tsx'
import { initPWA } from '@/lib/pwa'

// M23b: register the service worker (offline app-shell cache) + inject the iOS
// launch-splash <link> tags. No-op in dev / non-PWA environments.
initPWA()

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
