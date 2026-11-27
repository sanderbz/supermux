# Code-block copy Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** One action copies a chat fence's exact source text — tap the block on touch, a corner button on desktop — with a visible "Copied" and a haptic tick.

**Architecture:** A pure helper derives the clipboard text from the fence's raw text (diff → post-change version). `BubbleCode` gains an optional `copyText` prop that adds the corner button, the touch tap handler and the confirmation; the markdown `pre` override passes it. Touch vs. pointer is decided by `(pointer: coarse)` — CSS for visibility, `matchMedia` at tap time for behaviour — so a tablet (which renders the `desktop` surface) gets tap-to-copy too.

**Tech Stack:** React 19, Tailwind v4, `lucide-react` icons, `bun test` (unit, SSR markup), Playwright (smoke).

**Spec:** `docs/superpowers/specs/2026-11-27-code-block-copy-design.md`

## Global Constraints

- Clipboard text = fence source, trailing newline trimmed; never the rendered/wrapped text.
- Diff fences copy the post-change version: `+` lines without marker, context lines without their leading space, `-` lines dropped.
- Reuse `copyText` from `web/src/components/chat/message-export.ts`; never show ✓ when it resolves `false`.
- No colour literals — B0 tokens only (see header of `chat-components.tsx`). Must read in both renderers (default + grok skin), light and dark.
- Touch targets ≥ 44px under `pointer: coarse` is not needed (button hidden there); desktop button follows `message-actions.tsx` button styling.
- CSS size budget (`node scripts/size-budget.mjs`) must still pass.
- No `cargo … --release`; web-only change.

## Review Focus

1. **Desktop drag-select inside a block** — must not copy and must not lose the selection (click handler only acts under coarse pointer). Test in Task 2.
2. **Clipboard unavailable** (insecure context / denied) — no ✓, no vibrate. Test in Task 2.
3. **Tablet: `desktop` surface + coarse pointer** — tap copies; button hidden. Smoke test in Task 3.
4. **Touch user long-presses to select part of a block** — a tap with a non-empty selection inside the block must not copy over it. Test in Task 2.
5. **Rapid repeat taps** — confirmation timer resets, no stacked timers / setState after unmount. Test in Task 2.

---

### Task 1: Clipboard text for a fence

**Files:**
- Create: `web/src/components/chat/markdown/fence-copy.ts`
- Modify: `web/src/components/chat/markdown/chat-components.tsx` (move `diffLines` out to `fence-copy.ts` and import it; behaviour unchanged)
- Test: `web/tests/unit/chat-fence-copy.test.ts`

**Interfaces:**
- Produces: `export function diffLines(text: string): string[] | null` (moved verbatim) and `export function fenceCopyText(raw: string): string`.

- [ ] **Step 1: Write the failing tests**

```ts
import { describe, expect, test } from 'bun:test'
import { fenceCopyText } from '../../src/components/chat/markdown/fence-copy'

describe('fenceCopyText', () => {
  test('plain fence: verbatim, one trailing newline trimmed', () => {
    expect(fenceCopyText('npm i\nnpm test\n')).toBe('npm i\nnpm test')
  })
  test('JSON keeps its exact whitespace', () => {
    const json = '{\n  "mcpServers": {\n    "x": { "command": "npx" }\n  }\n}\n'
    expect(fenceCopyText(json)).toBe(json.slice(0, -1))
  })
  test('diff: post-change version, markers stripped, removals dropped', () => {
    expect(fenceCopyText(' a\n-b\n+c\n d\n')).toBe('a\nc\nd')
  })
  test('a single leading minus is not a diff', () => {
    expect(fenceCopyText('-x\n')).toBe('-x')
  })
  test('empty fence copies empty string', () => {
    expect(fenceCopyText('')).toBe('')
  })
})
```

- [ ] **Step 2: Run to verify failure**

Run: `cd web && bun test tests/unit/chat-fence-copy.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `fenceCopyText(raw: string): string`** in `fence-copy.ts`; move `diffLines` (with its doc comment) there and import it back into `chat-components.tsx`.

- [ ] **Step 4: Run unit tests**

Run: `cd web && bun test tests/unit/chat-fence-copy.test.ts tests/unit/chat-markdown-code.test.tsx`
Expected: all PASS (existing fence tests unchanged).

- [ ] **Step 5: Commit** — `feat(chat): fence copy text helper`

---

### Task 2: Copy affordance on `BubbleCode`

**Files:**
- Modify: `web/src/components/chat/ui/bubble.tsx:179-190` (`BubbleCode`)
- Modify: `web/src/components/chat/markdown/chat-components.tsx` (`pre` override passes `copyText={fenceCopyText(plainText(children))}`)
- Test: `web/tests/unit/chat-markdown-code.test.tsx` (extend)

**Interfaces:**
- Consumes: `fenceCopyText` (Task 1), `copyText` (`message-export.ts`).
- Produces: `BubbleCode({ children, className, copyText? }: { children: ReactNode; className?: string; copyText?: string })`. Without `copyText` it renders exactly as today.

Behaviour:
- Wrapper `div` (`relative`, takes over the `mt-[11px]`) around the existing `<pre>`.
- Desktop button: top-right, `aria-label="Copy code"`, `Copy` icon (lucide) → `Check` + visible text `Copied` for 1500 ms; hidden under `[@media(pointer:coarse)]:hidden`; shown always (not hover-only — hover doesn't exist on hybrid devices and discoverability matters).
- Touch: `<pre onClick>` acts only when `window.matchMedia('(pointer: coarse)').matches` AND `window.getSelection()` has no non-collapsed range inside the block. Cursor/`role` unchanged on desktop.
- Touch hint: a quiet, decorative label `Tap to copy` (small, `text-ink-3`, top-right, `aria-hidden`), shown only under a coarse pointer (`hidden [@media(pointer:coarse)]:inline-flex`) and swapped for the `Copied` pill while copied.
- On success only: set copied state (timer reset on repeat, cleared on unmount), `navigator.vibrate?.(10)`, and render a small `Copied` pill top-right that is visible on every pointer type (`aria-live="polite"`).
- Grok skin: check `grok-mode.css` rules targeting `pre` in bubbles still apply to the inner `<pre>`; adjust selector only if one targets the wrapper position.

- [ ] **Step 1: Write the failing tests** (SSR markup, extend existing file)

```tsx
test('a fence renders a copy button', () => {
  expect(fence('desktop')).toContain('aria-label="Copy code"')
})
test('the button hides under a coarse pointer', () => {
  expect(fence('desktop')).toContain('[@media(pointer:coarse)]:hidden')
})
test('a fence shows a tap hint only under a coarse pointer', () => {
  const out = fence('phone')
  expect(out).toContain('Tap to copy')
  expect(out).toContain('[@media(pointer:coarse)]:inline-flex')
})
test('BubbleCode without copyText renders no button', () => {
  const out = renderToStaticMarkup(<BubbleCode>x</BubbleCode>)
  expect(out).not.toContain('Copy code')
})
```

Plus a pure, DOM-free unit for the tap guard, extracted as
`export function shouldTapCopy(coarse: boolean, selectionInside: boolean): boolean` in `fence-copy.ts`:

```ts
test('tap copies only on coarse pointer with no selection inside', () => {
  expect(shouldTapCopy(true, false)).toBe(true)
  expect(shouldTapCopy(false, false)).toBe(false)
  expect(shouldTapCopy(true, true)).toBe(false)
})
```

- [ ] **Step 2: Run to verify failure** — `cd web && bun test tests/unit/chat-markdown-code.test.tsx tests/unit/chat-fence-copy.test.ts` → FAIL.

- [ ] **Step 3: Implement** as described above.

- [ ] **Step 4: Run unit + lint + typecheck**

Run: `cd web && bun test tests/unit && bun run lint && npx tsc -b`
Expected: all PASS, no new lint errors.

- [ ] **Step 5: Commit** — `feat(chat): copy a code block with one tap or click`

---

### Task 3: Smoke test + budget

**Files:**
- Create: `web/tests/e2e/smoke/chat-code-copy.spec.ts` (follow `chat-fixture.ts` / `chat-touch-targets.spec.ts` for seeding a transcript with a fenced block and for touch contexts)
- Modify (only if needed): `web/scripts/size-budget.mjs`

- [ ] **Step 1: Write the spec** with `permissions: ['clipboard-read', 'clipboard-write']`:
  - desktop (fine pointer): click `Copy code` → `navigator.clipboard.readText()` equals the fence source (no trailing newline); `Copied` visible.
  - tablet (`hasTouch: true`, `isMobile: true`, 1024×768 → desktop surface): button not visible, `Tap to copy` visible; tap the `<pre>` → clipboard equals source.
  - desktop: click inside the `<pre>` (not the button) → clipboard unchanged.

- [ ] **Step 2: Run** — `cd web && npx playwright test tests/e2e/smoke/chat-code-copy.spec.ts` → PASS.

- [ ] **Step 3: Budget** — `cd web && bun run build:perf` → size budget passes. If CSS grows past the budget, bump by the minimum (precedent: commit `73a73b74`) in its own commit.

- [ ] **Step 4: Manual check** — phone + desktop, default and grok renderer, light and dark (via `/run` or dev server).

- [ ] **Step 5: Commit** — `test(chat): smoke the code-block copy`
