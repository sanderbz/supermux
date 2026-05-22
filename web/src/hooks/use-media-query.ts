// useMediaQuery — subscribe to a CSS media query (TECH_PLAN §4.3 / §4.8).
//
// Used to fork tile behaviour by input modality: `pointer: fine` enables the
// desktop hover-peek; `pointer: coarse` enables tap + long-press. SSR-safe
// (returns the current match synchronously when `matchMedia` exists).

import { useEffect, useState } from 'react'

export function useMediaQuery(query: string): boolean {
  const [matches, setMatches] = useState(
    () =>
      typeof window !== 'undefined' &&
      'matchMedia' in window &&
      window.matchMedia(query).matches,
  )

  useEffect(() => {
    if (typeof window === 'undefined' || !('matchMedia' in window)) return
    const mql = window.matchMedia(query)
    const onChange = () => setMatches(mql.matches)
    onChange()
    mql.addEventListener('change', onChange)
    return () => mql.removeEventListener('change', onChange)
  }, [query])

  return matches
}
