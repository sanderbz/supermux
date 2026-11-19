import * as React from 'react'
import { shouldLoadOlder } from './backlog'
import { useDeferredFollow } from './follow-bottom'
import { TranscriptViewport } from './transcript-viewport'
export function useTranscriptScroll(name: string, older: { hasOlder: boolean; loadingOlder: boolean; loadOlder: () => void }) {
  const scrollRef = React.useRef<HTMLDivElement | null>(null)
  const controller = React.useRef<TranscriptViewport | null>(null)
  const [showJump, setShowJump] = React.useState(false)
  const follow = useDeferredFollow()
  const latest = React.useRef(older)
  React.useLayoutEffect(() => { latest.current = older })
  React.useLayoutEffect(() => {
    const el = scrollRef.current
    if (!el) return
    const view = new TranscriptViewport(el, follow, setShowJump); controller.current = view; view.attach()
    const focus = (e: Event) => { if ((e.target as HTMLElement).closest('input,textarea,[contenteditable="true"]')) view.beginFocus() }
    const surface = el.closest('[data-surface="chat"]')
    surface?.addEventListener('focusin', focus)
    const schedule = () => view.schedule(), visual = window.visualViewport
    visual?.addEventListener('resize', schedule); visual?.addEventListener('scroll', schedule)
    window.addEventListener('pageshow', schedule); document.fonts?.ready.then(schedule)
    return () => {
      view.dispose(); controller.current = null; surface?.removeEventListener('focusin', focus)
      visual?.removeEventListener('resize', schedule); visual?.removeEventListener('scroll', schedule)
      window.removeEventListener('pageshow', schedule)
    }
  }, [name, follow])
  React.useLayoutEffect(() => { controller.current?.sync() })
  const onScroll = React.useCallback(() => {
    const el = scrollRef.current, opts = latest.current
    if (el && shouldLoadOlder({ scrollTop: el.scrollTop, hasOlder: opts.hasOlder, loading: opts.loadingOlder })) opts.loadOlder()
  }, [])
  return { scrollRef, onScroll, showJump, jumpToBottom: React.useCallback(() => controller.current?.jump(), []), onReserveGrew: React.useCallback(() => controller.current?.sync(), []) }
}
