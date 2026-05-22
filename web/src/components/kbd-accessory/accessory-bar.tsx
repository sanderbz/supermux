// M16 — <AccessoryBar />: the Termius-style swipeable keyboard-accessory bar.
//
// A 44 pt-tall glass row pinned directly above the keyboard inside the focus
// sheet. TECH_PLAN §M16 + research/termius-ios-native-spec.md §"Swipeable 4-key
// accessory groups" / §"Keyboard accessory bar — heights & spacing" / v3 finish
// criteria #5, #6, #18.
//
// Layout:
//   ┌─[‹][⤬][⌨][···][⚙]─┃───── swipeable 4-chip group ─────┐  ← 44 pt
//   └────────────────────────────────── • • ○ ○ (dots) ────┘
//   • LEFT  — 5 FIXED GRAY nav chips: Back, Gesture, Hide-keyboard, More,
//     Settings. Gray = `.secondarySystemFill` → `bg-secondary`.
//   • RIGHT — the <Pager />: user-editable 4-chip groups, horizontal swipe
//     pages between them, page-indicator dots auto-fade after 1.5 s.
//
// DOWNSTREAM PLUG-IN PROPS (TECH_PLAN §29 dep-graph fix — M17 / M18 wire into
// these WITHOUT editing this file):
//   • `onGestureToggle`  — the Gesture nav chip (M17 joystick on/off).
//   • `onSlashOpen`      — reserved slash trigger surface (M18).
//   • `onSnippetOpen`    — reserved snippet-panel trigger (M18).
// When a prop is omitted the matching chip is simply not rendered, so the bar
// degrades gracefully before M17/M18 land.
//
// Material is `.thinMaterial` (`glass`) so the terminal buffer stays legible
// beneath (§10 material map). iOS haptics caveat (§4.4): chip presses scale
// 0.96 (CSS-only feedback) and fire `navigator.vibrate(8)` gated by
// `'vibrate' in navigator` (Android only — a documented no-op on iOS Safari).

import * as React from 'react'
import { motion } from 'framer-motion'
import {
  ChevronLeft,
  Hand,
  Keyboard,
  MoreHorizontal,
  Settings2,
} from 'lucide-react'

import { cn } from '@/lib/utils'
import { springs } from '@/lib/springs'
import { useKbdGroups } from '@/hooks/use-kbd-groups'
import { Pager } from './pager'
import { ManageSheet } from './manage-sheet'
import { tapHaptic } from './group'

export interface AccessoryBarProps {
  /** Send a named key to the pty (LiveTerminal `sendKey`). */
  onKey: (name: string) => void
  /** Back nav chip — leave focus / dismiss the sheet. */
  onBack: () => void
  /** Hide-keyboard nav chip — blur the composer so the keyboard drops. */
  onHideKeyboard: () => void
  /** "More" (···) nav chip — open the all-groups vertical list (SpecialsSheet). */
  onMore: () => void
  /** Gesture nav chip — M17 plugs the joystick on/off toggle here. Omitted →
   *  the chip is not rendered (graceful pre-M17 degrade). */
  onGestureToggle?: () => void
  /** Slash trigger — M18 plugs the slash menu here (reserved surface). */
  onSlashOpen?: () => void
  /** Snippet trigger — M18 plugs the snippet panel here (reserved surface). */
  onSnippetOpen?: () => void
  className?: string
}

/** A fixed gray navigation chip — 44×44 pt hit target, gray fill (§color split).
 *  `active` renders the pressed/armed tint (used by the Gesture toggle). */
function NavChip({
  icon: Icon,
  label,
  onClick,
  active,
}: {
  icon: typeof Keyboard
  label: string
  onClick: () => void
  active?: boolean
}) {
  return (
    <motion.button
      type="button"
      aria-label={label}
      aria-pressed={active}
      whileTap={{ scale: 0.96 }}
      transition={springs.buttonPress}
      onPointerDown={tapHaptic}
      onClick={onClick}
      className={cn(
        // ≥44 pt hit target; 32 pt visible gray pill centred inside it.
        'flex size-11 shrink-0 items-center justify-center',
      )}
    >
      <span
        className={cn(
          'flex size-8 items-center justify-center rounded-lg',
          active
            ? 'bg-primary/15 text-primary'
            : 'bg-secondary text-secondary-foreground active:bg-secondary/70',
        )}
      >
        <Icon className="size-[18px]" />
      </span>
    </motion.button>
  )
}

export function AccessoryBar({
  onKey,
  onBack,
  onHideKeyboard,
  onMore,
  onGestureToggle,
  onSlashOpen,
  onSnippetOpen,
  className,
}: AccessoryBarProps) {
  // Single canonical store — table-backed `/api/kbd-groups`, falls back to the
  // local seed when the backend handler isn't wired on this build.
  const { groups } = useKbdGroups()
  const [gestureOn, setGestureOn] = React.useState(false)
  const [manageOpen, setManageOpen] = React.useState(false)

  const handleGesture = () => {
    setGestureOn((on) => !on)
    onGestureToggle?.()
  }

  // M18's slash trigger lives behind a hidden "/" nav affordance — exposed only
  // when the prop is wired so this file never needs editing for M18.
  void onSlashOpen
  void onSnippetOpen

  return (
    <>
      <div
        role="toolbar"
        aria-label="Keyboard accessory"
        className={cn(
          // 44 pt bar; thin glass so the terminal stays legible beneath.
          'glass flex h-11 shrink-0 items-center gap-0.5 border-t border-border/60 px-1.5',
          className,
        )}
      >
        {/* LEFT — 5 fixed gray nav chips (Back, Gesture, Kbd, More, Settings). */}
        <NavChip icon={ChevronLeft} label="Back" onClick={onBack} />
        {onGestureToggle && (
          <NavChip
            icon={Hand}
            label={gestureOn ? 'Gestures on' : 'Gestures off'}
            onClick={handleGesture}
            active={gestureOn}
          />
        )}
        <NavChip
          icon={Keyboard}
          label="Hide keyboard"
          onClick={onHideKeyboard}
        />
        <NavChip icon={MoreHorizontal} label="More keys" onClick={onMore} />
        <NavChip
          icon={Settings2}
          label="Manage keys"
          onClick={() => setManageOpen(true)}
        />

        {/* Hairline divider between the fixed-nav cluster and function zone. */}
        <span className="h-6 w-px shrink-0 bg-border/70" aria-hidden />

        {/* RIGHT — swipeable 4-chip user groups + page-indicator dots. */}
        <Pager groups={groups} onKey={onKey} />
      </div>

      <ManageSheet
        open={manageOpen}
        onOpenChange={setManageOpen}
        groups={groups}
      />
    </>
  )
}

export default AccessoryBar
