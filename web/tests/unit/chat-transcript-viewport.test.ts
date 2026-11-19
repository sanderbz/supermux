import { describe, expect, test } from 'bun:test'
import { TranscriptViewport } from '../../src/components/chat/transcript-viewport'
class Track extends EventTarget {
  scrollTop = 0; clientHeight = 240; clientWidth = 744; scrollHeight = 2000
  style: Record<string, string> = {}; firstElementChild = null
  rows = Array.from({ length: 20 }, (_, i) => ({ key: 'row-' + i, top: i * 100, height: 100 }))
  getBoundingClientRect() { return { top: 0, bottom: this.clientHeight } }
  querySelectorAll() { return this.rows.map(row => ({ dataset: { chatAnchor: row.key }, getBoundingClientRect: () => ({ top: row.top - this.scrollTop, bottom: row.top + row.height - this.scrollTop }) })) }
  scroll(top: number) { this.scrollTop = top; this.dispatchEvent(new Event('scroll')) }
  wheel(deltaY: number) { const event = new Event('wheel'); Object.assign(event, { deltaY }); this.dispatchEvent(event) }
}
function fixture(defer = (fn: () => void) => { fn(); return true }) {
  const track = new Track(), away: boolean[] = []
  const view = new TranscriptViewport(track as unknown as HTMLDivElement, defer, value => away.push(value))
  view.attach(); track.dispatchEvent(new Event('scroll')); return { track, view, away }
}
describe('transcript reader position', () => {
  test('prepend keeps latest position after scrolling during fetch and simultaneous tail growth', () => {
    const { track, view } = fixture(); track.scroll(500); track.scroll(650)
    track.rows.forEach(row => row.top += 600); track.scrollHeight += 900
    view.sync(); expect(track.scrollTop).toBe(1250)
  })
  test('a reader move before its native scroll callback survives a concurrent prepend', () => {
    const { track, view } = fixture(); track.scroll(500)
    track.scrollTop = 650 // Native scroll event is delivered after the DOM commit.
    track.rows.forEach(row => row.top += 600); track.scrollHeight += 900
    view.sync(); expect(track.scrollTop).toBe(1250)
    track.dispatchEvent(new Event('scroll')); expect(track.scrollTop).toBe(1250)
  })
  test('tail growth keeps history fixed; delayed height change above preserves visible line', () => {
    const { track, view } = fixture(); track.scroll(550); track.scrollHeight += 300; view.sync(); expect(track.scrollTop).toBe(550)
    track.rows.filter(row => row.top >= 500).forEach(row => row.top += 180); track.scrollHeight += 180
    view.sync(); expect(track.scrollTop).toBe(730)
  })
  test('wheel down against bottom still follows later content', () => {
    const { track, view } = fixture(); track.wheel(200); track.scrollHeight += 300; view.sync(); expect(track.scrollTop).toBe(2060)
  })
  test('native focus scroll before keyboard resize preserves bottom; upward gesture cancels', () => {
    const { track, view } = fixture(); view.beginFocus(); track.scroll(1560); expect(track.scrollTop).toBe(1760)
    track.clientHeight = 120; view.sync(); expect(track.scrollTop).toBe(1880)
    track.wheel(-100); track.scroll(1450); track.scrollHeight += 300; view.sync(); expect(track.scrollTop).toBe(1450)
  })
  test('resize and hidden renderer retention preserve read anchor', () => {
    const { track, view } = fixture(); track.scroll(650)
    track.clientHeight = 0; track.rows.forEach(row => row.top += 100); track.scrollHeight += 100; view.sync(); expect(track.scrollTop).toBe(650)
    track.clientHeight = 160; view.sync(); expect(track.scrollTop).toBe(750)
  })
  test('explicit jump follows future asynchronous growth', () => {
    const { track, view, away } = fixture(); track.scroll(300); expect(away.at(-1)).toBe(true)
    view.jump(); track.scrollHeight += 500; view.sync(); expect(track.scrollTop).toBe(2260); expect(away.at(-1)).toBe(false)
  })
  test('selection-deferred follow reads latest user intent on release', () => {
    let selected = false; const pending: { run?: () => void } = {}
    const { track, view } = fixture(fn => { if (selected) { pending.run = fn; return false } fn(); return true })
    selected = true; track.scrollHeight += 300; view.sync(); expect(track.scrollTop).toBe(1760)
    track.wheel(-200); track.scroll(550); selected = false; pending.run?.(); expect(track.scrollTop).toBe(550)
  })
  test('if first anchor disappears, surviving visible row stays still', () => {
    const { track, view } = fixture(); track.scroll(650)
    track.rows = track.rows.filter(row => row.key !== 'row-6'); track.rows.filter(row => row.top >= 700).forEach(row => row.top -= 100); track.scrollHeight -= 100
    view.sync(); expect(track.scrollTop).toBe(550)
  })
})
