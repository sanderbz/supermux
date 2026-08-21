// KB_MODES — the mode registry. id → { label, description, lazy loader }.
//
// This is the ONLY module that references the mode files, and it does so by lazy
// `import()`, so adding/removing a mode changes only this file — that is the whole
// conflict surface for the parallel mode-implementation agents (each owns ONE
// `mode-<id>-<slug>.tsx` file and never touches this registry).
//
// The Settings dropdown is built from `KB_MODES` (label + description); the mobile
// route resolves the active entry with `kbModeEntry(kbMode)` and `React.lazy`s its
// `load()`, so only the active mode's chunk is fetched. `field` is read by the
// composer (`useKbField()`) to decide contenteditable vs a real `<textarea>` —
// only mode 7 sets it.

import type { KbFieldKind, KbLayoutComponent } from './contract'

export interface KbModeEntry {
  /** 0..10 — the persisted `kbMode` value. */
  id: number
  /** Stable file/id slug. */
  slug: string
  /** SHORT dropdown label. */
  label: string
  /** One line under the label in the dropdown. */
  description: string
  /** Composer field type (mode 7 only; defaults to 'contenteditable'). */
  field?: KbFieldKind
  /** Lazy loader — only the active mode's chunk loads. */
  load: () => Promise<{ default: KbLayoutComponent }>
}

export const KB_MODES: readonly KbModeEntry[] = [
  {
    id: 0,
    slug: 'baseline',
    label: 'Baseline (current)',
    description:
      'visualViewport CSS vars — fixed box sized to --vvh, translated by offsetTop.',
    load: () => import('./mode-0-baseline'),
  },
  {
    id: 1,
    slug: 'pure-native',
    label: 'Pure native (dvh)',
    description: '100dvh flex column + interactive-widget=resizes-content, no JS sizing.',
    load: () => import('./mode-1-pure-native'),
  },
  {
    id: 2,
    slug: 'virtual-keyboard',
    label: 'VirtualKeyboard API',
    description: 'overlaysContent=true; composer fixed with env(keyboard-inset-bottom).',
    load: () => import('./mode-2-virtual-keyboard'),
  },
  {
    id: 3,
    slug: 'vv-height',
    label: 'VV imperative height',
    description: 'JS sets fixed box height = visualViewport.height each resize, top:0, no translate.',
    load: () => import('./mode-3-vv-height'),
  },
  {
    id: 4,
    slug: 'fixed-lift',
    label: 'Fixed composer + lift',
    description: 'composer fixed bottom:0 lifted by --kb (translateY / bottom).',
    load: () => import('./mode-4-fixed-lift'),
  },
  {
    id: 5,
    slug: 'sticky-footer',
    label: 'Sticky footer',
    description: 'one 100dvh scroll container, composer position:sticky bottom:0.',
    load: () => import('./mode-5-sticky-footer'),
  },
  {
    id: 6,
    slug: 'css-grid',
    label: 'CSS grid rows',
    description: 'height:100dvh; grid-template-rows: auto 1fr auto (header/body/composer).',
    load: () => import('./mode-6-css-grid'),
  },
  {
    id: 7,
    slug: 'native-textarea',
    label: 'Native <textarea>',
    description: 'real textarea field → iOS native keyboard avoidance (mirrors the flush terminal input).',
    field: 'textarea',
    load: () => import('./mode-7-native-textarea'),
  },
  {
    id: 8,
    slug: 'scroll-into-view',
    label: 'ScrollIntoView on focus',
    description: 'composer in normal flow; on focus scrollIntoView({block:end}) + scroll-padding.',
    load: () => import('./mode-8-scroll-into-view'),
  },
  {
    id: 9,
    slug: 'root-resize',
    label: 'Imperative root resize',
    description: 'set documentElement height = visualViewport.height; composer bottom:0.',
    load: () => import('./mode-9-root-resize'),
  },
  {
    id: 10,
    slug: 'clean-rebuild',
    label: 'Clean rebuild',
    description: 'from-scratch minimal dvh flex column, MobileSheet ripped out for this mode.',
    load: () => import('./mode-10-clean-rebuild'),
  },
] as const

export const DEFAULT_KB_MODE = 0

/** Resolve an id to its entry, falling back to baseline for any unknown value. */
export function kbModeEntry(id: number): KbModeEntry {
  return KB_MODES.find((m) => m.id === id) ?? KB_MODES[0]
}
