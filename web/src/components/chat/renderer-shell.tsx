/**
 * `RendererShell` — mounted-but-hidden retention (fase A5 T3).
 * ─────────────────────────────────────────────────────────────────────────────
 * This is where the master plan's *"Terminal escape hatch rots"* risk is
 * actually mitigated: the hatch is exercised on EVERY toggle because it never
 * leaves the tree.
 *
 * THE NINE INVARIANTS, each of which is a test or a grep-checkable rule:
 *
 *  1. ONE GRID CELL, TWO CHILDREN. `display:grid`; both panes at
 *     `grid-area: 1 / 1` — the §11.6 `.sm-swap` idiom `live-layer.tsx`'s
 *     `SwapCell` already uses. The hidden pane therefore keeps its EXACT box
 *     size, which is the whole mechanism: `use-live-term.ts`'s debounced
 *     `ResizeObserver` observes the container, and a container whose size never
 *     changes never fires — so a toggle emits ZERO `fit()` and ZERO `resize`
 *     frames.
 *
 *  2. HIDDEN MEANS `visibility:hidden; opacity:0; pointer-events:none` — never
 *     `display:none`, never the `hidden` attribute, never unmount.
 *     `display:none` collapses the box to 0×0, which fires the RO, which calls
 *     `fit()` against a zero-size container (the `d2c333c` class of bug:
 *     FitAddon measuring the wrong metrics and the grid reflowing on reveal).
 *     `visibility` is applied via framer's `transitionEnd` so the fade OUT is
 *     visible and the pane only goes invisible once it is already at opacity 0.
 *
 *  3. `useLiveTerm` IS NOT TOLD ANYTHING. No new prop, no `paused` flag, no
 *     manual `resize`/`resync` on toggle. The hook's WS, backoff, visibility
 *     resume health-check and keyboard-stable geometry all keep running exactly
 *     as they do in a visible terminal — which is the POINT: the hidden path is
 *     byte-identical to the visible one, so it cannot rot differently.
 *     (`hooks/use-live-term.ts` does not appear in this fase's diff.)
 *
 *  4. FOCUS NEVER LEAKS INTO AN INVISIBLE PTY. The hidden pane carries `inert`
 *     AND `aria-hidden="true"`, and the shell blurs anything inside it the
 *     moment it stops being visible — an invisible xterm holding DOM focus is a
 *     silent keystroke sink, and on iOS a soft keyboard that will not go away.
 *     This is the riskiest thing in the fase (§4 Risk 1), so the mitigation is
 *     layered rather than clever.
 *
 *  5. FIRST OPEN STILL HANDSHAKES BEHIND THE CROSSFADE. A renderer mounts the
 *     first time it is selected, not before. The first-ever Terminal tap pays
 *     the auth→resize→seed handshake once, under the fade; every later toggle
 *     is free. This is also the honest fix for the A1 geometry cost: the first
 *     terminal attach sets real pty geometry, and retention means it is never
 *     undone.
 *
 *  6. THE CROSSFADE IS ≤180 ms, SAME-CELL, ZERO LAYOUT SHIFT, from
 *     `lib/springs.ts` only (no literal `cubic-bezier(` anywhere), with a
 *     `useReducedMotion()` twin that swaps instantly. Both panes are
 *     opacity-animated in the same cell; nothing is measured, nothing reflows.
 *
 *  7. RETENTION IS FOCUS-ONLY — see `retention.ts` for the cost accounting.
 *     `grep -rn "RendererShell" web/src` must show exactly two call sites.
 *
 *  8. SESSION CHANGE TEARS BOTH DOWN. `<RendererShell key={name}>` at both call
 *     sites, plus the name check inside `retain()` as belt-and-braces: a
 *     retained terminal from session A must never be revealed under session B.
 *
 *  9. `stopped` BEATS EVERYTHING. The call sites keep their own
 *     `stopped ? <StoppedSession/> : …` ternary (unchanged), so both retained
 *     panes unmount with the shell; `retain()` encodes the same rule so a shell
 *     that IS mounted under a stopped session still mounts nothing.
 *
 * WHAT THIS FILE MUST NOT CONTAIN (grep rules, §3):
 *   · no `display:none` / `hidden=` on either pane;
 *   · no `backdrop-filter` / `transform` / `filter:` / `contain:` — any of them
 *     would make the shell a containing block for the phone's `fixed` KeyBar
 *     and joystick (§11.1);
 *   · no import of `chat-panel` or `live-terminal` — both panes arrive as
 *     `ReactNode` props, which is what keeps `chat-panel` behind its existing
 *     `React.lazy` boundary.
 */
import * as React from 'react'
import { motion, useReducedMotion } from 'framer-motion'

// Relative, not `@/`: this module is rendered by `bun test`
// (`tests/unit/chat-renderer-shell.test.tsx`), whose resolver reads the root
// tsconfig.json — which carries no `paths`. Same reason as `chat-surface.tsx`.
import { motionOff, tweens } from '../../lib/springs'

import { retain, type Retention } from './retention'

/** The crossfade, at the short end of the plan's "≤180 ms". Duration + `eases`
 *  from `lib/springs.ts` — the same source and the same idiom the other
 *  same-cell swaps in this folder use (`live-layer.tsx`'s `SwapCell`,
 *  `composer.tsx`, `header-pill.tsx`). No literal `cubic-bezier(` anywhere. */
// A6/T6.2 — was a private `FADE_S = 0.18`. The renderer crossfade is the
// same-cell swap the whole folder already performs, so it now takes the
// shared 0.26s `tweens.swap`. The 80ms it gains buys the two renderers one
// motion language instead of two that nearly match.

export interface RendererShellProps {
  /** The session. Also the `key` the call sites pass — invariant 8. */
  name: string
  /** `chatPaneActive(...)` — chat is the VISIBLE renderer this frame. */
  chatActive: boolean
  /** `terminalPaneMounts(...)` — the terminal is the VISIBLE renderer. */
  terminalMounts: boolean
  /** The pty is gone; mount neither pane (invariant 9). */
  stopped?: boolean
  /** The chat renderer. Evaluated by the CALLER, so this module imports
   *  neither renderer and `chat-panel` stays behind its lazy boundary. */
  chat: React.ReactNode
  /** The live terminal. */
  terminal: React.ReactNode
  /** Optional extra teardown when the terminal stops being visible — the call
   *  sites pass `termRef.current?.blur()`, xterm's own public API. The shell
   *  ALSO blurs at the DOM level (invariant 4); this is the belt to that
   *  braces, not a replacement for it. */
  onTerminalHidden?: () => void
  className?: string
}

export function RendererShell({
  name,
  chatActive,
  terminalMounts,
  stopped = false,
  chat,
  terminal,
  onTerminalHidden,
  className,
}: RendererShellProps) {
  const reduce = useReducedMotion() ?? false

  // The mount set.
  //
  // React's documented "adjust state during render" pattern, NOT an effect and
  // NOT a ref: an effect would leave the retained pane one frame behind (the
  // toggle would flash empty), and a ref written during render is what the
  // `react-hooks` rules forbid. `retain` returns the SAME object when nothing
  // changed, so the comparison terminates on the first pass; and the render
  // below reads `mounted`, the freshly folded value, so it is correct in this
  // frame even before React re-renders with it.
  const [prev, setPrev] = React.useState<Retention | null>(null)
  const mounted = retain(prev, {
    name,
    chat: chatActive,
    terminal: terminalMounts,
    stopped,
  })
  if (mounted !== prev) setPrev(mounted)

  // Which pane the user is looking at. A retained pane that is not the visible
  // one is hidden — never unmounted, never collapsed.
  const chatVisible = chatActive
  const termVisible = !chatActive && terminalMounts

  return (
    <div
      data-testid="renderer-shell"
      // ONE cell. `grid` + both children at `1 / 1` is what makes the hidden
      // pane keep its exact box, which is what stops the ResizeObserver firing.
      // `relative` is deliberately absent: nothing here positions out of flow.
      className={['grid h-full w-full min-h-0', className].filter(Boolean).join(' ')}
    >
      {mounted.chat && (
        <Pane
          testid="renderer-pane-chat"
          visible={chatVisible}
          reduce={reduce}
        >
          {chat}
        </Pane>
      )}
      {mounted.terminal && (
        <Pane
          testid="renderer-pane-terminal"
          visible={termVisible}
          reduce={reduce}
          onHidden={onTerminalHidden}
        >
          {terminal}
        </Pane>
      )}
    </div>
  )
}

/**
 * One occupant of the cell.
 *
 * `visibility` rides framer's `transitionEnd` rather than a class: set as a
 * class it would apply on the first frame of the fade-out and the crossfade
 * would be a blink; set here it applies only once opacity has reached 0. On the
 * way IN it is part of `animate`, so it applies immediately and the pane fades
 * up from invisible-but-laid-out.
 */
function Pane({
  testid,
  visible,
  reduce,
  onHidden,
  children,
}: {
  testid: string
  visible: boolean
  reduce: boolean
  onHidden?: () => void
  children: React.ReactNode
}) {
  const ref = React.useRef<HTMLDivElement>(null)
  // The pane's own visibility, as of the LAST run of the effect below. Seeded
  // with the first render's value so a pane that mounts already hidden is not
  // read as a hide EDGE (there is nothing to evict from a pane nobody has been
  // in yet).
  const wasVisibleRef = React.useRef(visible)

  // Invariant 4 — focus never leaks into an invisible pane.
  //
  // Runs the moment the pane stops being visible, BEFORE the fade completes: a
  // keystroke landing in the 180 ms of the crossfade is exactly the silent sink
  // this exists to stop. `inert` (below) prevents focus from getting BACK in;
  // this evicts whatever was already there.
  React.useEffect(() => {
    const el = ref.current
    if (!el) return
    // `inert`, set IMPERATIVELY.
    //
    // The `inert={!visible}` prop below is what renders in SSR (and is what the
    // unit test reads), but framer-motion's DOM prop filter DROPS it in the
    // browser — measured on the thrash bench: the hidden pane came back with
    // `data-testid,data-visible,aria-hidden,class,style` and no `inert`. Since
    // `inert` is the one attribute that stops a hidden xterm from being focused
    // (Risk 1, the worst failure in the fase), it is not something to leave to
    // a third party's allowlist.
    if (visible) el.removeAttribute('inert')
    else el.setAttribute('inert', '')

    const wasVisible = wasVisibleRef.current
    wasVisibleRef.current = visible

    if (visible) return
    const active = document.activeElement
    if (active instanceof HTMLElement && el.contains(active)) active.blur()

    // `onHidden` is an EDGE, not a state.
    //
    // Both call sites pass a fresh inline arrow every render
    // (`onTerminalHidden={() => termRef.current?.blur()}`), so `onHidden` is a
    // new identity on EVERY parent render and this effect re-runs while the
    // pane has been hidden all along. Firing the callback on each of those runs
    // is what turned a one-shot "evict focus from the pane you just left" into
    // a recurring page-wide blur: the hidden terminal's handle blurs
    // `document.activeElement`, which by then is the CHAT COMPOSER the user
    // just clicked. Focus dropped to <body>, the leading characters of the
    // message were swallowed, and the first `t` hit the global renderer hotkey
    // and flipped the surface — after which the rest of the sentence was typed
    // straight into the agent's pty.
    //
    // The blur above is containment-checked and therefore safe to repeat; the
    // callback is not ours to reason about, so it only fires on the real
    // visible→hidden transition.
    if (wasVisible) onHidden?.()
  }, [visible, onHidden])

  return (
    <motion.div
      ref={ref}
      data-testid={testid}
      data-visible={visible ? 'true' : 'false'}
      // `inert` blocks focus, clicks and the accessibility tree for the whole
      // subtree — the modern one-attribute answer to the retained-xterm
      // keystroke sink. `aria-hidden` is kept beside it because inert's a11y
      // behaviour is newer than some of the screen readers this app runs under.
      inert={!visible}
      aria-hidden={!visible}
      // A6/T6.6 — offscreen surfaces pause. Both renderers stay MOUNTED across
      // the toggle (that is the whole point of the retention model), so exactly
      // one of them is always invisible and, before A6, still running every
      // ambient CSS loop it owns: `.sm-blip` (the typing wave), `.sm-spin` (2.4s
      // per running receipt line) and one `.sm-breathe` per face in the gutter.
      // `[data-offscreen]` in globals.css sets `animation-play-state: paused`
      // for the whole subtree — paused, not `none`, so a toggle back resumes at
      // the frame it left rather than restarting every loop in unison.
      data-offscreen={visible ? undefined : ''}
      // Both panes occupy the SAME cell, so the box neither moves nor resizes
      // when the occupant changes. `minHeight: 0` keeps a flex/grid child from
      // refusing to shrink, which is what would silently change the terminal's
      // measured height.
      style={{ gridArea: '1 / 1', minHeight: 0 }}
      className="h-full w-full min-w-0"
      initial={false}
      animate={
        visible
          ? { opacity: 1, visibility: 'visible', pointerEvents: 'auto' }
          : {
              opacity: 0,
              pointerEvents: 'none',
              // Only AFTER the fade — see the doc comment.
              transitionEnd: { visibility: 'hidden' },
            }
      }
      transition={reduce ? motionOff : tweens.swap}
    >
      {children}
    </motion.div>
  )
}
