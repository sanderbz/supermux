import * as React from 'react'

export type Theme = 'system' | 'light' | 'dark'

const STORAGE_KEY = 'amux-theme'

interface ThemeContextValue {
  /** The user's preference (may be 'system'). */
  theme: Theme
  /** What's actually applied right now ('light' | 'dark'). */
  resolvedTheme: 'light' | 'dark'
  setTheme: (theme: Theme) => void
}

const ThemeContext = React.createContext<ThemeContextValue | null>(null)

function prefersDark(): boolean {
  return (
    typeof window !== 'undefined' &&
    window.matchMedia('(prefers-color-scheme: dark)').matches
  )
}

function resolve(theme: Theme): 'light' | 'dark' {
  if (theme === 'system') return prefersDark() ? 'dark' : 'light'
  return theme
}

function readStored(): Theme {
  try {
    const v = localStorage.getItem(STORAGE_KEY)
    if (v === 'light' || v === 'dark' || v === 'system') return v
  } catch {
    /* localStorage unavailable (private mode / Capacitor) — fall through */
  }
  return 'dark' // dark default (§M10)
}

/** Apply the resolved theme to <html>: toggle the `.dark`/`.light` class that
 *  drives Tailwind's `dark:` variant, and set color-scheme for native UI. */
function applyTheme(resolved: 'light' | 'dark') {
  const root = document.documentElement
  root.classList.remove('light', 'dark')
  root.classList.add(resolved)
  root.style.colorScheme = resolved
}

// Apply once at module-eval time (before React mounts) to avoid a flash of the
// wrong theme. main.tsx imports App → ThemeProvider before createRoot().render().
if (typeof document !== 'undefined') {
  applyTheme(resolve(readStored()))
}

export function ThemeProvider({ children }: { children: React.ReactNode }) {
  const [theme, setThemeState] = React.useState<Theme>(() => readStored())
  const [systemDark, setSystemDark] = React.useState<boolean>(() => prefersDark())

  // Derived during render — no setState-in-effect.
  const resolvedTheme: 'light' | 'dark' =
    theme === 'system' ? (systemDark ? 'dark' : 'light') : theme

  // Apply the resolved theme to <html> (DOM side-effect only).
  React.useLayoutEffect(() => {
    applyTheme(resolvedTheme)
  }, [resolvedTheme])

  // Track the OS preference; setState only runs from the event handler.
  React.useEffect(() => {
    const mq = window.matchMedia('(prefers-color-scheme: dark)')
    const onChange = () => setSystemDark(mq.matches)
    mq.addEventListener('change', onChange)
    return () => mq.removeEventListener('change', onChange)
  }, [])

  const setTheme = React.useCallback((next: Theme) => {
    try {
      localStorage.setItem(STORAGE_KEY, next)
    } catch {
      /* ignore persistence failure */
    }
    setThemeState(next)
  }, [])

  const value = React.useMemo<ThemeContextValue>(
    () => ({ theme, resolvedTheme, setTheme }),
    [theme, resolvedTheme, setTheme],
  )

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>
}

export function useTheme(): ThemeContextValue {
  const ctx = React.useContext(ThemeContext)
  if (!ctx) throw new Error('useTheme must be used within <ThemeProvider>')
  return ctx
}
