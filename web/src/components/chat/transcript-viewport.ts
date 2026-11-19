import { FOLLOW_THRESHOLD_PX, jumpVisible } from './backlog'
import type { FollowFn } from './follow-bottom'
interface Anchor { key: string; offset: number }
/** One owner for scroll writes. Total-height deltas cannot distinguish an older
 * page from concurrent new content below. Preserve visible row identity instead. */
export class TranscriptViewport {
  private following = true
  private anchors: Anchor[] = []
  private expectedTop: number | null = null
  private lastTop = 0
  private width = 0
  private height = 0
  private closed = false
  private observer: ResizeObserver | null = null
  private raf = 0
  private el: HTMLDivElement
  private defer: FollowFn
  private changed: (away: boolean) => void
  private focusUntil = 0
  private touch: { x: number; y: number } | null = null
  constructor(el: HTMLDivElement, defer: FollowFn, changed: (away: boolean) => void) { this.el = el; this.defer = defer; this.changed = changed }
  attach(): void {
    this.el.style.overflowAnchor = 'none'
    this.el.addEventListener('scroll', this.onScroll)
    this.el.addEventListener('wheel', this.onWheel, { passive: true })
    this.el.addEventListener('touchstart', this.onTouchStart, { passive: true }); this.el.addEventListener('touchmove', this.onTouchMove, { passive: true })
    this.el.addEventListener('keydown', this.onKey)
    if (typeof ResizeObserver !== 'undefined') {
      this.observer = new ResizeObserver(() => this.sync()); this.observer.observe(this.el)
      if (this.el.firstElementChild) this.observer.observe(this.el.firstElementChild)
    }
    this.sync()
  }
  dispose(): void {
    this.closed = true; this.observer?.disconnect(); cancelAnimationFrame(this.raf)
    this.el.removeEventListener('scroll', this.onScroll); this.el.removeEventListener('wheel', this.onWheel)
    this.el.removeEventListener('touchstart', this.onTouchStart); this.el.removeEventListener('touchmove', this.onTouchMove); this.el.removeEventListener('keydown', this.onKey)
  }
  private rows(): HTMLElement[] { return Array.from(this.el.querySelectorAll('[data-chat-anchor]')) }
  private remember(): void {
    const bounds = this.el.getBoundingClientRect()
    const rows = this.rows()
    let lo = 0, hi = rows.length
    while (lo < hi) { const mid = (lo + hi) >>> 1; if (rows[mid].getBoundingClientRect().bottom <= bounds.top) lo = mid + 1; else hi = mid }
    this.anchors = []
    for (let i = lo; i < rows.length && this.anchors.length < 4; i++) {
      const row = rows[i], r = row.getBoundingClientRect(); if (r.top >= bounds.bottom) break
      this.anchors.push({ key: row.dataset.chatAnchor!, offset: r.top - bounds.top })
    }
    this.lastTop = this.el.scrollTop; this.width = this.el.clientWidth; this.height = this.el.clientHeight
  }
  private report(): void { this.changed(!this.following && jumpVisible(this.el.scrollHeight - this.el.scrollTop - this.el.clientHeight)) }
  private write(top: number): void {
    top = Math.max(0, Math.min(top, this.el.scrollHeight - this.el.clientHeight))
    if (Math.abs(this.el.scrollTop - top) < 1) return
    this.expectedTop = top; this.el.scrollTop = top
  }
  /** Called after React commits and later image/font/receipt/viewport resizes. */
  sync = (): void => {
    if (this.closed || this.el.clientHeight === 0 || this.el.clientWidth === 0) return
    // Scroll events are delivered asynchronously. A network commit can arrive
    // after the reader moved but before its scroll callback; include that delta
    // in the old row offsets before measuring the new DOM.
    if (Date.now() >= this.focusUntil && this.width === this.el.clientWidth && this.height === this.el.clientHeight && Math.abs(this.el.scrollTop - this.lastTop) >= 1 && (this.expectedTop === null || Math.abs(this.el.scrollTop - this.expectedTop) >= 1)) {
      const delta = this.el.scrollTop - this.lastTop
      this.anchors = this.anchors.map(a => ({ ...a, offset: a.offset - delta }))
      this.following = this.el.scrollHeight - this.el.scrollTop - this.el.clientHeight < FOLLOW_THRESHOLD_PX
      this.lastTop = this.el.scrollTop
    }
    this.defer(() => {
      if (this.closed || this.el.clientHeight === 0) return
      if (this.following) this.write(this.el.scrollHeight - this.el.clientHeight)
      else {
        const rows = this.rows(), bounds = this.el.getBoundingClientRect()
        const anchor = this.anchors.find(a => rows.some(row => row.dataset.chatAnchor === a.key))
        const row = anchor && rows.find(row => row.dataset.chatAnchor === anchor.key)
        if (row && anchor) this.write(this.el.scrollTop + row.getBoundingClientRect().top - bounds.top - anchor.offset)
      }
      this.remember(); this.report()
    })
  }
  private takeOver = (): void => { this.focusUntil = 0; this.following = false; this.remember(); this.report() }
  private onWheel = (e: WheelEvent): void => { if (e.deltaY < 0 && this.el.scrollTop > 0) this.takeOver() }
  private onTouchStart = (e: TouchEvent): void => { const t = e.touches[0]; this.touch = t ? { x: t.clientX, y: t.clientY } : null }
  private onTouchMove = (e: TouchEvent): void => {
    const t = e.touches[0], prev = this.touch
    if (!t || !prev) return
    if (t.clientY - prev.y > Math.abs(t.clientX - prev.x) && this.el.scrollTop > 0) this.takeOver()
    this.touch = { x: t.clientX, y: t.clientY }
  }
  beginFocus = (): void => { if (this.following) this.focusUntil = Date.now() + 1200 }
  private onKey = (e: KeyboardEvent): void => {
    if ((e.target as HTMLElement).closest('input,textarea,button,a,select,summary,[role="button"],[contenteditable="true"]')) return
    if ((['ArrowUp', 'PageUp', 'Home'].includes(e.key) || (e.key === ' ' && e.shiftKey))) this.takeOver()
  }
  private onScroll = (): void => {
    if (this.closed || this.el.clientHeight === 0) return
    if (this.expectedTop !== null && Math.abs(this.el.scrollTop - this.expectedTop) < 1) {
      this.expectedTop = null; this.remember(); this.report(); return
    }
    this.expectedTop = null
    // Native focus scrolling/clamping during resize is layout, not user intent.
    if ((this.following && Date.now() < this.focusUntil) || this.width !== this.el.clientWidth || this.height !== this.el.clientHeight) { this.sync(); return }
    if (Math.abs(this.el.scrollTop - this.lastTop) >= 1) {
      this.following = this.el.scrollHeight - this.el.scrollTop - this.el.clientHeight < FOLLOW_THRESHOLD_PX
      this.remember(); this.report()
    }
  }
  jump = (): void => {
    this.following = true
    // Smooth intermediate frames can falsely cancel following; jump immediately.
    this.write(this.el.scrollHeight - this.el.clientHeight); this.remember(); this.report()
  }
  schedule = (): void => {
    if (this.closed || this.raf) return
    this.raf = requestAnimationFrame(() => { this.raf = 0; this.sync() })
  }
}
