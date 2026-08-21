// Mode 7 — NATIVE <textarea>. STUB.
//
// TODO(mode-7): the LAYOUT is the pure-native flex column (like mode 1), BUT this
//   mode's registry entry sets `field:'textarea'` so the composer renders a real
//   `<textarea>` (via `useKbField()` read in `plain-editable.tsx`) instead of the
//   contenteditable. That lets iOS do its NATIVE focused-control avoidance — the
//   same mechanism that keeps the terminal `<input>` flush on the owner device,
//   which makes this the highest-signal candidate. The field swap is wired in the
//   store + composer (shared files); THIS file only owns the layout column.
//   Risk: contenteditable→textarea changes autosize/paste/IME; preserve the draft
//   wiring (owned by the composer, not this file).
//
// Invariants (contract.ts): default-export a KbLayoutComponent; header/body/
// composer order; body owns its scroll; composer keeps its safe-area pad. Until
// implemented this renders the baseline passthrough so the registry import
// resolves and switching to this mode does not crash.

import type { KbLayoutComponent } from './contract'

const Mode7NativeTextarea: KbLayoutComponent = ({ header, body, composer }) => {
  return (
    <>
      {header}
      {body}
      {composer}
    </>
  )
}

export default Mode7NativeTextarea
