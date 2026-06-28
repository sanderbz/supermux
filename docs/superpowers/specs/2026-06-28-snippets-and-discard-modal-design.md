# Snippets editing/visibility + discard-modal click-through — design

Date: 2026-06-28
Branch: `fix/snippets-and-discard-modal`

Three reported issues, fixed together since two of them share the snippet surfaces.

## Issue 1 — Discard-changes modal is click-through (bug)

### Symptom
On desktop (reported on Brave/macOS), using "edit in native editor", then Cancel
after a change, shows the "Discard changes?" bar. Its Cancel and Discard buttons
do nothing, and clicks pass through to the Attach button behind it.

### Root cause
The desktop editor is a Radix `modal` Dialog (`desktop-compose-panel.tsx`). Radix's
dismissable-layer sets `body { pointer-events: none }` and re-enables pointer
events only inside the dialog's own portal. `DiscardConfirmSheet`
(`mobile-compose-sheet.tsx`) renders *outside* that portal and never sets
`pointer-events-auto`, so its backdrop and buttons inherit `pointer-events: none`.
Clicks therefore fall through to the still-interactive dialog content (the Attach
button) behind it. Not Brave-specific — reproduces on any desktop browser.

### Fix
Add `pointer-events-auto` to both the backdrop `motion.div` and the modal panel
`motion.div` inside `DiscardConfirmSheet`. Harmless on the mobile path (no Radix
modal there); corrects the desktop path. No behavioural/design change otherwise.

## Issue 2 — Cannot edit snippets

### Current state
The full edit stack already exists: `usePatchSnippet`, the `PATCH /api/snippets/{id}`
endpoint, and the `SnippetEditor` Vaul sheet (used by the focus-mode snippet
panel via swipe-left). Only the **Settings** screen lacks an entry point — it can
list, create, and delete, but not edit.

### Fix
In `snippets-section.tsx`, add a pencil (Edit) button to each row that opens the
existing `SnippetEditor` seeded with that snippet. `SnippetEditor` already handles
patch-vs-create and cache invalidation; Vaul drawers work on desktop. Row gains
both a pencil (edit) and a chevron (expand, see Issue 3), alongside the existing
trash button.

## Issue 3 — Cannot see full snippet text

### Current state
Body text is single-line `truncate` everywhere it is listed: Settings rows,
focus-modal live rows, and the default-seed rows. Two snippets with similar/equal
titles can't be told apart without deleting/recreating or (on mobile) swipe-editing.

### Fix — expand-on-tap, both surfaces
A per-row, local, non-persisted expanded state. Collapsed = today's single
truncated line. Expanded = full body wrapped (`whitespace-pre-wrap`, mono,
user-selectable).

- **Settings rows** (`snippets-section.tsx`): add a chevron toggle button. Expanded
  reveals the full body below the title. Height change is layout-animated
  (consistent with the existing `motion.div` rows).
- **Focus-modal rows** (`snippet-panel.tsx` `SnippetRowItem`): the row is a single
  draggable `motion.button` (tap=insert, long-press=run, swipe=edit/delete), so a
  nested expand button is not valid. Add the chevron as an **absolutely-positioned
  sibling** over the right edge of the row, with its own `onClick` calling
  `stopPropagation()` (and `pointer`-events handled so it never arms the long-press
  or starts a drag). When expanded, render the full body in a panel **below** the
  fixed-height row, outside the `motion.button`.
- **Default-seed rows**: keep simple truncation (bodies are short built-ins like
  `continue`, `/compact`). No expand affordance needed.

Chevron rotates 90deg (right → down) on expand. Each row's state is independent and
resets when the list unmounts.

## Out of scope
- No backend changes (PATCH already exists).
- No reordering changes.
- No persistence of the expanded/collapsed state.

## Verification
- `bun run build` (tsc + vite) and `bun run lint` clean in the worktree.
- Manual: Settings edit opens editor and saves; chevron expands full text on both
  surfaces; desktop discard modal Cancel/Discard buttons work and backdrop
  dismisses (no click-through to Attach).
- Screenshots of all visual changes attached to the PR.
