// Real brand marks for the store's icons (§2.2, blocker B1).
//
// The catalog ships no icon bytes (PulseMCP's endpoint carries none, and the
// curated featured set is `icon: ""`), so without this every card fell back to
// an initials-on-gradient monogram — the loudest placeholder tell in the build.
// This module maps a card to its REAL brand mark: a canonical single-path SVG
// (bundled, never hotlinked) drawn in the brand's own colour on its own tile,
// exactly like an App-Store icon — deliberately theme-independent so GitHub reads
// as GitHub in light and dark alike. A known-kind card with no wordmark (Postgres,
// the shared browser) gets a semantic glyph in a brand hue; anything unmatched
// falls through to the monogram (kept only as the honest last resort for
// user-authored connectors with no asset).

import * as React from 'react'
import {
  Box,
  Brain,
  Clock,
  Cloud,
  CreditCard,
  Database,
  Folder,
  GitBranch,
  Globe,
  Landmark,
  ListTodo,
  MapPin,
  MessageCircle,
  MousePointerClick,
  Palette,
  PenTool,
  Square,
  Users,
  Wallet,
  Zap,
  type LucideIcon,
} from 'lucide-react'

import type { ConnectorCard } from '@/lib/api/connectors'

/** A resolved brand mark: a 24×24 fill path (or a glyph node) + its brand hue. */
export interface BrandMark {
  /** The single `<path d>` on a 0 0 24 24 canvas (fill brands). */
  path?: string
  /** A pre-rendered node (semantic glyph brands). Mutually exclusive with `path`. */
  node?: React.ReactNode
  /** Brand colour — the mark ink AND the source of the tile's soft tint. */
  hex: string
}

// Canonical single-path marks (simple-icons geometry), 0 0 24 24.
const GITHUB =
  'M12 .297c-6.63 0-12 5.373-12 12 0 5.303 3.438 9.8 8.205 11.385.6.113.82-.258.82-.577 0-.285-.01-1.04-.015-2.04-3.338.724-4.042-1.61-4.042-1.61C4.422 18.07 3.633 17.7 3.633 17.7c-1.087-.744.084-.729.084-.729 1.205.084 1.838 1.236 1.838 1.236 1.07 1.835 2.809 1.305 3.495.998.108-.776.417-1.305.76-1.605-2.665-.3-5.466-1.332-5.466-5.93 0-1.31.465-2.38 1.235-3.22-.135-.303-.54-1.523.105-3.176 0 0 1.005-.322 3.3 1.23.96-.267 1.98-.399 3-.405 1.02.006 2.04.138 3 .405 2.28-1.552 3.285-1.23 3.285-1.23.645 1.653.24 2.873.12 3.176.765.84 1.23 1.91 1.23 3.22 0 4.61-2.805 5.625-5.475 5.92.42.36.81 1.096.81 2.22 0 1.606-.015 2.896-.015 3.286 0 .315.21.69.825.57C20.565 22.092 24 17.592 24 12.297c0-6.627-5.373-12-12-12'
const NOTION =
  'M4.459 4.208c.746.606 1.026.56 2.428.466l13.215-.793c.28 0 .047-.28-.046-.326L17.86 1.968c-.42-.326-.981-.7-2.055-.607L3.01 2.295c-.466.046-.56.28-.374.466zm.793 3.08v13.904c0 .747.373 1.027 1.214.98l14.523-.84c.841-.046.935-.56.935-1.167V6.354c0-.606-.233-.933-.748-.887l-15.177.887c-.56.047-.747.327-.747.933zm14.337.745c.093.42 0 .84-.42.888l-.7.14v10.264c-.608.327-1.168.514-1.635.514-.748 0-.935-.234-1.495-.933l-4.577-7.186v6.952L12.21 19s0 .84-1.168.84l-3.222.186c-.093-.186 0-.653.327-.746l.84-.233V9.854L7.822 9.76c-.094-.42.14-1.026.793-1.073l3.456-.233 4.764 7.279v-6.44l-1.215-.139c-.093-.514.28-.887.747-.933zM1.936 1.035l13.31-.98c1.634-.14 2.055-.047 3.082.7l4.249 2.986c.7.513.934.653.934 1.213v16.378c0 1.026-.373 1.634-1.68 1.726l-15.458.934c-.98.047-1.448-.093-1.962-.747l-3.129-4.06c-.56-.747-.793-1.306-.793-1.96V2.667c0-.839.374-1.54 1.447-1.632z'
const SLACK =
  'M5.042 15.165a2.528 2.528 0 0 1-2.52 2.523A2.528 2.528 0 0 1 0 15.165a2.527 2.527 0 0 1 2.522-2.52h2.52v2.52zM6.313 15.165a2.527 2.527 0 0 1 2.521-2.52 2.527 2.527 0 0 1 2.521 2.52v6.313A2.528 2.528 0 0 1 8.834 24a2.528 2.528 0 0 1-2.521-2.522v-6.313zM8.834 5.042a2.528 2.528 0 0 1-2.521-2.52A2.528 2.528 0 0 1 8.834 0a2.528 2.528 0 0 1 2.521 2.522v2.52H8.834zM8.834 6.313a2.528 2.528 0 0 1 2.521 2.521 2.528 2.528 0 0 1-2.521 2.521H2.522A2.528 2.528 0 0 1 0 8.834a2.528 2.528 0 0 1 2.522-2.521h6.312zM18.956 8.834a2.528 2.528 0 0 1 2.522-2.521A2.528 2.528 0 0 1 24 8.834a2.528 2.528 0 0 1-2.522 2.521h-2.522V8.834zM17.688 8.834a2.528 2.528 0 0 1-2.523 2.521 2.527 2.527 0 0 1-2.52-2.521V2.522A2.527 2.527 0 0 1 15.165 0a2.528 2.528 0 0 1 2.523 2.522v6.312zM15.165 18.956a2.528 2.528 0 0 1 2.523 2.522A2.528 2.528 0 0 1 15.165 24a2.527 2.527 0 0 1-2.52-2.522v-2.522h2.52zM15.165 17.688a2.527 2.527 0 0 1-2.52-2.523 2.526 2.526 0 0 1 2.52-2.52h6.313A2.527 2.527 0 0 1 24 15.165a2.528 2.528 0 0 1-2.522 2.523h-6.313z'
const LINEAR =
  'M2.886 4.18A11.982 11.982 0 0 1 11.99 0C18.624 0 24 5.376 24 12.009c0 3.64-1.62 6.903-4.18 9.105L2.887 4.18ZM1.817 5.626l16.556 16.556c-.524.33-1.075.62-1.65.866L.951 7.277c.247-.575.537-1.126.866-1.65ZM.322 9.163l14.515 14.515c-.71.172-1.443.282-2.195.322L0 11.358a12 12 0 0 1 .322-2.195Zm-.17 4.862 9.823 9.824a12.02 12.02 0 0 1-9.824-9.824Z'
const SENTRY =
  'M13.91 2.505c-.873-1.448-2.972-1.448-3.844 0L6.904 7.92a15.478 15.478 0 0 1 8.53 12.811h-2.221A13.301 13.301 0 0 0 5.784 9.814l-2.926 5.06a7.65 7.65 0 0 1 4.435 5.848H2.194a.365.365 0 0 1-.298-.534l1.413-2.402a5.16 5.16 0 0 0-1.614-.913L.296 19.275a2.182 2.182 0 0 0 .812 2.999 2.24 2.24 0 0 0 1.086.288h6.983a9.322 9.322 0 0 0-3.845-8.318l1.11-1.922a11.47 11.47 0 0 1 4.95 10.24h5.915a17.242 17.242 0 0 0-7.885-15.28l2.244-3.845a.37.37 0 0 1 .504-.13c.255.14 9.75 16.708 9.928 16.9a.365.365 0 0 1-.327.543h-2.287c.029.612.029 1.223 0 1.831h2.297a2.206 2.206 0 0 0 1.922-3.31z'
const PLAYWRIGHT =
  'M23.996 7.462c-.056.837-.257 2.135-.716 3.85-.995 3.715-4.27 10.874-10.42 9.227-6.15-1.65-5.407-9.487-4.412-13.201.46-1.716.934-2.94 1.305-3.694.42-.853.846-.289 1.815.523.684.573 2.41 1.791 5.011 2.488 2.601.697 4.706.506 5.583.352 1.245-.219 1.897-.494 1.834.455Zm-9.807 3.863s-.127-1.819-1.773-2.286c-1.644-.467-2.613 1.04-2.613 1.04Zm4.058 4.539-7.769-2.172s.446 2.306 3.338 3.153c2.862.836 4.43-.98 4.43-.981Zm2.701-2.51s-.13-1.818-1.773-2.286c-1.644-.469-2.612 1.038-2.612 1.038ZM8.57 18.23c-4.749 1.279-7.261-4.224-8.021-7.08C.197 9.831.044 8.832.003 8.188c-.047-.73.455-.52 1.415-.354.677.118 2.3.261 4.308-.28a11.28 11.28 0 0 0 2.41-.956c-.058.197-.114.4-.17.61-.433 1.618-.827 4.055-.632 6.426-1.976.732-2.267 2.423-2.267 2.423l2.524-.715c.227 1.002.6 1.987 1.15 2.838a5.914 5.914 0 0 1-.171.049Zm-4.188-6.298c1.265-.333 1.363-1.631 1.363-1.631l-3.374.888s.745 1.076 2.01.743Z'
const ICLOUD =
  'M13.762 4.29a6.51 6.51 0 0 0-5.669 3.332 3.571 3.571 0 0 0-1.558-.36 3.571 3.571 0 0 0-3.516 3A4.918 4.918 0 0 0 0 14.796a4.918 4.918 0 0 0 4.92 4.914 4.93 4.93 0 0 0 .617-.045h14.42c2.305-.272 4.041-2.258 4.043-4.589v-.009a4.594 4.594 0 0 0-3.727-4.508 6.51 6.51 0 0 0-6.511-6.27z'

/** id/name substring → mark. Order matters (first hit wins). */
const FILL_BRANDS: Array<[RegExp, string, string]> = [
  [/github/i, GITHUB, '#181717'],
  [/notion/i, NOTION, '#0A0A0A'],
  [/slack/i, SLACK, '#611F69'],
  [/linear/i, LINEAR, '#5E6AD2'],
  [/sentry/i, SENTRY, '#362D59'],
  [/playwright/i, PLAYWRIGHT, '#2EAD33'],
  [/icloud/i, ICLOUD, '#3693F3'],
]

/** Resolve a card to its brand mark, or `null` (→ monogram last resort). */
export function brandMark(card: ConnectorCard): BrandMark | null {
  const hay = `${card.id} ${card.display_name}`
  for (const [re, path, hex] of FILL_BRANDS) {
    if (re.test(hay)) return { path, hex }
  }
  if (/postgres/i.test(hay)) {
    return { node: <Database strokeWidth={2} className="size-[62%]" aria-hidden />, hex: '#4169E1' }
  }
  if (card.kind === 'builtin_browser' || /\bbrowser\b/i.test(hay)) {
    return { node: <Globe strokeWidth={2} className="size-[62%]" aria-hidden />, hex: '#0EA5E9' }
  }
  // A curated card ships a lucide glyph NAME as its reliable, always-present icon
  // (brand SVGs above are the nice-to-have). This guarantees every catalog card
  // renders a real, meaningful icon on its own tinted tile — never an initials
  // monogram, which is now the honest last resort for user-authored cards only.
  const mark = lucideMark(card.lucide)
  if (mark) return mark
  return null
}

/** kebab lucide-name → [component, brand-ish tile hue]. Only the names the
 *  curated catalog actually ships; anything else falls through to the monogram. */
const LUCIDE_MARKS: Record<string, [LucideIcon, string]> = {
  folder: [Folder, '#E8A33D'],
  globe: [Globe, '#2563EB'],
  'git-branch': [GitBranch, '#F1502F'],
  brain: [Brain, '#8B5CF6'],
  'list-ordered': [ListTodo, '#6366F1'],
  clock: [Clock, '#0EA5E9'],
  box: [Box, '#64748B'],
  'list-todo': [ListTodo, '#F06A6A'],
  'square-kanban': [ListTodo, '#2684FF'],
  // Finance connectors each get a DISTINCT glyph + brand hue so Stripe / PayPal /
  // Plaid / Square never resolve to one shared card-like mark (they used to all be
  // `CreditCard`). Stripe keeps the card, PayPal a wallet, Plaid a bank landmark,
  // Square its namesake square — recognisable and never identical.
  'credit-card': [CreditCard, '#635BFF'], // Stripe
  wallet: [Wallet, '#003087'], // PayPal
  landmark: [Landmark, '#00A98F'], // Plaid
  square: [Square, '#2A2A2A'], // Square
  'message-circle': [MessageCircle, '#1F8DED'],
  cloud: [Cloud, '#F38020'],
  users: [Users, '#FF7A59'],
  zap: [Zap, '#FF4A00'],
  'layout-template': [Globe, '#146EF5'],
  palette: [Palette, '#00C4CC'],
  figma: [PenTool, '#F24E1E'],
  'hard-drive': [Folder, '#1FA463'],
  'map-pin': [MapPin, '#EA4335'],
  table: [Database, '#E5A100'],
  'mouse-pointer-click': [MousePointerClick, '#40B5A4'],
  database: [Database, '#4169E1'],
}

/** Resolve a lucide icon NAME to a mark (a glyph node + tile hue), or `null`. */
export function lucideMark(name: string | undefined | null): BrandMark | null {
  if (!name) return null
  const hit = LUCIDE_MARKS[name.trim().toLowerCase()]
  if (!hit) return null
  const [Icon, hex] = hit
  return { node: <Icon strokeWidth={2} className="size-[58%]" aria-hidden />, hex }
}
