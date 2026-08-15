// useTerminalInput — the one-line way a surface that owns a live-terminal ref
// gets a `SessionInput`.
//
// It exists so the ref→adapter plumbing (and the single lint suppression it
// needs) lives in ONE place instead of being copy-pasted into the three parent
// surfaces that hold a `React.useRef<UseLiveTermResult | null>`.

import * as React from 'react'

import { terminalSessionInput, type TerminalLike } from './terminal'
import type { SessionInput } from './types'

/** Build a stable terminal-plane `SessionInput` from a live-terminal ref.
 *
 *  Stable across the terminal mounting, unmounting and remounting (hover peeks,
 *  renderer switches): the handle is memoised once, and the ref is resolved per
 *  CALL, never at construction. */
export function useTerminalInput(
  termRef: React.RefObject<TerminalLike | null>,
): SessionInput {
  // The adapter STORES this getter in its method closures and calls it only
  // from those methods (event handlers) — never during render, which is what
  // the rule is actually guarding against. Pinned by session-input.test.ts,
  // "a ref source resolves per call — a handle built before mount still
  // works", which constructs the handle against an empty ref and then fills it.
  return React.useMemo(
    // eslint-disable-next-line react-hooks/refs
    () => terminalSessionInput(() => termRef.current),
    [termRef],
  )
}
