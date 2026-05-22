// M16 — <Group /> + <KeyChip />: a single row of 4 function keys.
//
// TECH_PLAN §M16 / research/termius-ios-native-spec.md §"Swipeable 4-key
// accessory groups" + §"Keyboard accessory bar — heights & spacing":
//   • One Group = exactly one row of 4 user-editable function keys.
//   • Each chip: ≥44×44 pt HIT target (HIG floor), 32 pt VISIBLE height,
//     8 px continuous corner, SF Mono 13 pt semibold.
//   • Press feedback: scale 0.96 (iOS Safari has no `navigator.vibrate`, so the
//     CSS-only scale IS the haptic per §4.4); on Android, `navigator.vibrate(8)`
//     also fires, gated by `'vibrate' in navigator`.
//
// "White" chips = editable function keys, rendered on the bar's glass material
// (`bg-card`). The fixed gray nav cluster lives in accessory-bar.tsx, not here.

import { motion } from 'framer-motion'

import { cn } from '@/lib/utils'
import { springs } from '@/lib/springs'
import type { KbdGroup } from '@/lib/api'

/** Light haptic — Android only; a documented no-op on iOS Safari (§4.4). */
export function tapHaptic(): void {
  if ('vibrate' in navigator) navigator.vibrate(8)
}

/** Short on-chip label for a key NAME. The seed/table store full names the pty
 *  understands (`Ctrl-C`, `Esc`, …); the chip shows Termius-style caret notation
 *  (`^C`) so a 4-up row of 13 pt SF-Mono chips fits a 393 pt iPhone without
 *  wrapping. `onKey` still fires the FULL name — display-only transform. */
export function displayLabel(name: string): string {
  const ctrl = /^Ctrl-(.)$/i.exec(name)
  if (ctrl) return `^${ctrl[1].toUpperCase()}`
  return name
}

/** A single function-key chip. ≥44 pt hit target via `min-h-11`/`min-w-11`;
 *  the visible pill is 32 pt tall, centred inside that target. */
export function KeyChip({
  label,
  onPress,
}: {
  label: string
  onPress: () => void
}) {
  return (
    <motion.button
      type="button"
      // Press-scale 0.96 = the iOS CSS-only haptic equivalent (§4.4 caveat).
      whileTap={{ scale: 0.96 }}
      transition={springs.buttonPress}
      onPointerDown={tapHaptic}
      onClick={onPress}
      aria-label={`Send ${label}`}
      className={cn(
        // ≥44 pt hit target; 32 pt visible chip centred inside it.
        'flex min-h-11 min-w-11 flex-1 items-center justify-center px-0.5 py-1.5',
      )}
    >
      <span
        className={cn(
          'flex h-8 w-full items-center justify-center rounded-lg border border-border',
          'whitespace-nowrap bg-card font-mono text-[13px] font-semibold text-foreground',
          'active:bg-secondary',
        )}
      >
        {displayLabel(label)}
      </span>
    </motion.button>
  )
}

/** One group rendered as a row of 4 chips. Used inside the <Pager /> track. */
export function Group({
  group,
  onKey,
}: {
  group: KbdGroup
  onKey: (name: string) => void
}) {
  return (
    <div
      role="group"
      aria-label={`${group.name} keys`}
      // Tight chip-to-chip gap so four ≥44 pt chips fit a 393 pt iPhone zone.
      className="flex w-full items-center gap-1"
    >
      {group.keys.slice(0, 4).map((key, i) => (
        <KeyChip key={`${group.id}-${i}`} label={key} onPress={() => onKey(key)} />
      ))}
    </div>
  )
}
