import { useEffect, useState } from 'react'

/**
 * Offscreen pause.
 *
 * A roster can hold more faces than fit on screen, and a face that nobody can
 * see should cost nothing: while this returns false, <SessionMark> unregisters
 * from the rAF loop and drops `data-live`, which also stops the CSS breathe.
 *
 * It returns true until we have positively observed the element to be out of
 * view, so a mark is never frozen on first paint, and environments without
 * IntersectionObserver (jsdom, older WebViews) simply always animate.
 */
export function useOnScreen(ref: React.RefObject<Element | null>, enabled: boolean): boolean {
  const [onScreen, setOnScreen] = useState(true)
  useEffect(() => {
    const el = ref.current
    if (!enabled || !el || typeof IntersectionObserver !== 'function') return
    const io = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) setOnScreen(entry.isIntersecting)
      },
      // A margin so a mark is already alive by the time it scrolls into view.
      { rootMargin: '96px' },
    )
    io.observe(el)
    return () => io.disconnect()
  }, [ref, enabled])
  return onScreen
}
