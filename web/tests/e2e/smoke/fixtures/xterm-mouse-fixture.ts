// Test fixture for xterm-mouse-suppression.spec.ts. Bundled by the spec (via
// `bun build`) and loaded into a backend-free page so the spec can drive the REAL
// xterm Terminal + the REAL disableXtermMouseTracking() against each other.
import { Terminal } from '@xterm/xterm'
import { disableXtermMouseTracking } from '../../../../src/lib/disable-xterm-mouse'

declare global {
  interface Window {
    __xtermMouseFixture?: {
      Terminal: typeof Terminal
      disableXtermMouseTracking: typeof disableXtermMouseTracking
    }
  }
}

window.__xtermMouseFixture = { Terminal, disableXtermMouseTracking }
