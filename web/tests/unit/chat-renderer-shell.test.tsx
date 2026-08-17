/**
 * Fase A5 T3 — `RendererShell`, at the level a static render can hold to
 * account.
 * ─────────────────────────────────────────────────────────────────────────────
 * The BEHAVIOURAL proof is T6's thrash spec: a static render cannot prove a
 * WebSocket did not reconnect. What it CAN prove is the structure the whole
 * mechanism rests on, and each of these is a real failure mode rather than a
 * shape assertion:
 *
 *   · both panes in the DOM once both have been selected — the retention itself;
 *   · the hidden one carries `inert` + `aria-hidden` — the silent keystroke sink
 *     (§4 Risk 1, the riskiest thing in the fase);
 *   · NO `display:none` anywhere — the zero-size FitAddon reflow (§4 Risk 2);
 *   · ONE grid cell, both panes at `1 / 1` — the reason the ResizeObserver never
 *     fires and a toggle costs zero `resize` frames;
 *   · no containing-block property — the phone's `fixed` KeyBar and joystick
 *     would otherwise reparent to the shell (§11.1).
 */
import { describe, expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { readFileSync } from 'node:fs'

import { RendererShell } from '../../src/components/chat/renderer-shell'

const CHAT = <div data-testid="fake-chat">chat</div>
const TERM = <div data-testid="fake-term">term</div>

const shell = (o: {
  chatActive: boolean
  terminalMounts: boolean
  stopped?: boolean
}) =>
  renderToStaticMarkup(
    <RendererShell
      name="s1"
      chat={CHAT}
      terminal={TERM}
      chatActive={o.chatActive}
      terminalMounts={o.terminalMounts}
      stopped={o.stopped}
    />,
  )

const SOURCE = readFileSync(
  new URL('../../src/components/chat/renderer-shell.tsx', import.meta.url),
  'utf8',
)
/** The source with its prose stripped. The shell's doc comment NAMES every
 *  forbidden construct (that is the point of writing the rules down next to the
 *  code they govern), so a grep over the raw file would only ever assert that
 *  the comment exists. These rules are about what the module DOES. */
const CODE = SOURCE.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '')

describe('what is mounted', () => {
  test('chat selected → only chat is in the tree (first open, nothing retained)', () => {
    const out = shell({ chatActive: true, terminalMounts: false })
    expect(out).toContain('data-testid="fake-chat"')
    expect(out).not.toContain('data-testid="fake-term"')
  })

  test('the undecided frame mounts NEITHER (A1 no-flash rule)', () => {
    const out = shell({ chatActive: false, terminalMounts: false })
    expect(out).not.toContain('fake-chat')
    expect(out).not.toContain('fake-term')
    expect(out).toContain('data-testid="renderer-shell"')
  })

  test('stopped mounts neither, whatever the seam says', () => {
    const out = shell({ chatActive: true, terminalMounts: false, stopped: true })
    expect(out).not.toContain('fake-chat')
    expect(out).not.toContain('fake-term')
  })
})

describe('the hidden pane', () => {
  // A fresh static render cannot show a RETAINED pane (retention is a fold over
  // frames), so the hidden-pane contract is asserted on the frame where the
  // terminal is visible and chat is not yet mounted, and on its mirror. The
  // fold itself is `chat-retention.test.ts`.
  test('the visible pane carries neither inert nor aria-hidden', () => {
    const out = shell({ chatActive: true, terminalMounts: false })
    expect(out).toMatch(/data-testid="renderer-pane-chat"[^>]*data-visible="true"/)
    expect(out).not.toContain('aria-hidden="true"')
    expect(out).not.toMatch(/renderer-pane-chat"[^>]*inert/)
  })

  test('a pane that is mounted but not visible is inert AND aria-hidden', () => {
    // `terminalMounts` true with `chatActive` true is the frame right after a
    // toggle to chat, before the seam's booleans settle — the terminal is in
    // the tree and must already be inert.
    const out = shell({ chatActive: true, terminalMounts: true })
    expect(out).toContain('data-testid="fake-term"')
    expect(out).toMatch(
      /data-testid="renderer-pane-terminal"[^>]*data-visible="false"/,
    )
    expect(out).toMatch(/renderer-pane-terminal[^>]*aria-hidden="true"/)
    expect(out).toMatch(/renderer-pane-terminal[^>]*inert/)
  })
})

describe('the eviction order (invariant 4) — the caret is read BEFORE inert', () => {
  // THE BLOCKER THIS ENCODES. `inert` was set first and the containment check
  // read `document.activeElement` afterwards — and a focused element inside an
  // inert subtree reports as `<body>` while STILL receiving every keydown. So
  // the check compared `<body>` against the pane, found no containment, blurred
  // nothing, and the invisible xterm kept the keyboard: a sentence typed at the
  // chat surface was executed in the agent's pty.
  //
  // Order is the whole fix, and order is what a static render cannot show — so
  // it is asserted on the source, next to the rule it protects.
  test('activeElement is sampled before the inert attribute is written', () => {
    const read = CODE.indexOf('document.activeElement')
    const write = CODE.indexOf("setAttribute('inert'")
    expect(read).toBeGreaterThan(-1)
    expect(write).toBeGreaterThan(-1)
    expect(read).toBeLessThan(write)
  })

  test('the hide edge falls back to :focus inside the pane', () => {
    // The second reading, for every path where the caret arrived while the pane
    // was ALREADY inert (and `activeElement` therefore never saw it).
    expect(CODE).toContain("querySelector<HTMLElement>(':focus')")
  })
})

describe('the grep rules (§3), asserted on the source', () => {
  test('never display:none, never a `hidden` attribute', () => {
    expect(CODE).not.toMatch(/display\s*:\s*['"]?none/)
    // `aria-hidden` is required (invariant 4); the bare `hidden` ATTRIBUTE is
    // forbidden (it is `display:none` by another name).
    expect(CODE).not.toMatch(/(?<!aria-)hidden=\{/)
    const out = shell({ chatActive: true, terminalMounts: true })
    expect(out).not.toContain('display:none')
    expect(out).not.toContain('display: none')
  })

  test('the shell creates no containing block for the phone’s fixed chrome', () => {
    for (const bad of [
      'backdrop-filter',
      'backdrop-blur',
      'transform',
      'filter:',
      'contain:',
      'will-change',
    ]) {
      expect(CODE).not.toContain(bad)
    }
  })

  test('one grid cell: both panes at grid-area 1 / 1', () => {
    const out = shell({ chatActive: true, terminalMounts: true })
    expect(out).toContain('data-testid="renderer-shell"')
    expect(out).toMatch(/renderer-shell"[^>]*class="[^"]*\bgrid\b/)
    // Two occupants, both in the same cell.
    expect(out.match(/grid-area:1 \/ 1|grid-area: 1 \/ 1/g)?.length).toBe(2)
  })

  test('it imports neither renderer — both panes arrive as props', () => {
    expect(CODE).not.toContain('chat-panel')
    expect(CODE).not.toContain('live-terminal')
    expect(CODE).toContain('React.ReactNode')
  })

  test('motion comes from springs.ts only — no cubic-bezier, no transition: all', () => {
    expect(CODE).not.toContain('cubic-bezier(')
    expect(CODE).not.toContain('transition: all')
    expect(CODE).toContain('useReducedMotion')
    expect(CODE).toContain("from '../../lib/springs'")
  })

  test('no colour literals (B0 tokens only)', () => {
    expect(CODE).not.toMatch(/#[0-9a-fA-F]{6}\b/)
  })

  test('use-live-term is not told anything — the shell never names it', () => {
    expect(CODE).not.toContain('useLiveTerm(')
    expect(CODE).not.toContain('paused')
  })
})
