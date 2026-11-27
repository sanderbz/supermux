# Code-block copy — design

## Why

Claude hands the user commands, JSON (tool registrations), config and code to
paste elsewhere — another terminal, a server, a settings file. Today the only
way to take it is to select it by hand. On phone and tablet that is fiddly, and
the selection picks up rendering artefacts (the phone wraps fences, so a
selection can carry extra line breaks/spaces), which regularly breaks pasted
JSON.

## Goals

- One action copies a fenced code block's exact source text.
- Touch (phone, tablet): tapping the block copies it. A small, quiet "Tap to copy"
  label sits in the block's top-right corner so the gesture is discoverable;
  it turns into "Copied" on success.
- Desktop: a small copy button in the block's top-right corner; the block itself
  stays selectable and horizontally scrollable.
- Clear confirmation: a short "Copied" with a check, the block's border in
  the check's ink for the copy window, plus a haptic tick where the device
  supports `navigator.vibrate`.
- Touch, tall blocks: while the block's top corner is scrolled away, a twin of
  the hint rides the block's visible bottom-right edge, clear of the floating
  composer.

## Non-goals

- Inline code chips in running text.
- Per-line copy.

## Anti-goals

- A desktop click on the block must never copy by surprise (it would clobber a
  partial selection the user is making).
- What lands on the clipboard must never differ from the markdown source
  (no soft-wrap breaks, no diff markers, no highlight artefacts).

## Approaches considered

- **A. Copy button on every surface.** Explicit, no accidents — but on touch
  the user still has to hit a small target.
- **B. Tap-to-copy on touch, button on desktop.** Chosen: on touch selecting is
  the problem being solved, on desktop selection is worth keeping.
- (Tap-to-copy everywhere — rejected: conflicts with selecting/scrolling on
  desktop.)

## Decisions

- The copied text is the fence's raw text (the same plain text the renderer
  already derives for diff detection), trailing newline trimmed.
- Diff fences copy the post-change version: `+` lines without the marker,
  context lines kept, `-` lines dropped. *(Claude's call — user may override.)*
- Lives in `BubbleCode` (`web/src/components/chat/ui/bubble.tsx`) and the `pre`
  override in `web/src/components/chat/markdown/chat-components.tsx`; reuse the
  existing clipboard helper used by message copy.
- Branch `feat/code-block-copy` off `main`, one small PR upstream.

## Left to the builder

- Exact touch detection (surface context vs. `pointer: coarse`), following what
  the codebase already does.
- Copy-confirmation styling within the existing design tokens, both renderers
  (default and grok skin), light and dark.
- Tests: unit test for the copied text (plain, wrapped, diff); e2e smoke if the
  existing suite has a natural place for it. Respect the CSS size budget.
