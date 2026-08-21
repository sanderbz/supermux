// useKbField — the composer FIELD type the ACTIVE keyboard-layout mode wants.
//
// 'textarea' only for mode 7 ('native-textarea', which swaps the composer's
// contenteditable for a real `<textarea>` so iOS does its native focused-control
// keyboard avoidance — the same mechanism that keeps the terminal `<input>`
// flush); 'contenteditable' for every other mode.
//
// It lives HERE, beside the registry, rather than in `ui-store.ts`, so the core
// store never imports the registry onto the hero/entry chunk. It is read by the
// composer (`plain-editable.tsx`) — a module on the lazy chat-panel chunk, off
// the cold-load path — when mode 7 wires it up.

import { useUI } from '@/stores/ui-store'

import type { KbFieldKind } from './contract'
import { kbModeEntry } from './registry'

export const useKbField = (): KbFieldKind =>
  useUI((s) => kbModeEntry(s.kbMode).field ?? 'contenteditable')
