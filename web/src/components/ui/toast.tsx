// <Toast/> (M28) — self-contained toast system. No dependency on the app shell
// or any store, so later milestones can adopt it by dropping <ToastProvider>
// near the root and calling `useToast()` (from ./use-toast) anywhere beneath it.
//
// Spec (§M28 + Termius reconnect-banner finish):
//   - Glass capsule, 36px tall, top-center, respects the top safe-area inset.
//   - Slides in from the top with `.smooth(0.35)` (TOAST_SPRING).
//   - Auto-dismisses after 2.5s; the stack holds at most 3 (oldest drops first).
//   - Tone tints a leading status dot using the brand status colors.
//   - Honors prefers-reduced-motion (opacity crossfade, no translate).
//
// Voice note: pass copy from web/src/brand/copy.ts (e.g. TOAST.fileSaved).

import {
  useCallback,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react'
import { AnimatePresence, motion, useReducedMotion } from 'framer-motion'
import { TOAST_SPRING, TOAST_SPRING_OUT } from '../../brand/tokens'
import {
  ToastContext,
  type ToastAction,
  type ToastApi,
  type ToastOptions,
  type ToastTone,
} from './use-toast'

interface ToastItem extends Required<Omit<ToastOptions, 'duration' | 'action'>> {
  id: number
  duration: number
  action?: ToastAction
}

const MAX_STACK = 3
const DEFAULT_DURATION = 2500

const TONE_DOT: Record<ToastTone, string> = {
  default: 'hsl(var(--brand))',
  active: 'hsl(var(--status-active))',
  waiting: 'hsl(var(--status-waiting))',
  error: 'hsl(var(--status-error))',
}

export function ToastProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<ToastItem[]>([])
  const timers = useRef<Map<number, ReturnType<typeof setTimeout>>>(new Map())
  const nextId = useRef(1)

  const dismiss = useCallback((id: number) => {
    setItems((prev) => prev.filter((t) => t.id !== id))
    const handle = timers.current.get(id)
    if (handle) {
      clearTimeout(handle)
      timers.current.delete(id)
    }
  }, [])

  const toast = useCallback(
    ({
      message,
      tone = 'default',
      duration = DEFAULT_DURATION,
      action,
    }: ToastOptions) => {
      const id = nextId.current++
      setItems((prev) =>
        [...prev, { id, message, tone, duration, action }].slice(-MAX_STACK),
      )
      timers.current.set(
        id,
        setTimeout(() => dismiss(id), duration),
      )
      return id
    },
    [dismiss],
  )

  const api = useMemo<ToastApi>(() => ({ toast, dismiss }), [toast, dismiss])

  return (
    <ToastContext.Provider value={api}>
      {children}
      <ToastViewport items={items} onDismiss={dismiss} />
    </ToastContext.Provider>
  )
}

function ToastViewport({
  items,
  onDismiss,
}: {
  items: ToastItem[]
  onDismiss: (id: number) => void
}) {
  const reduce = useReducedMotion()

  return (
    <div
      aria-live="polite"
      style={{
        position: 'fixed',
        top: 'calc(env(safe-area-inset-top) + 8px)',
        left: 0,
        right: 0,
        zIndex: 9999,
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        gap: 8,
        pointerEvents: 'none',
      }}
    >
      <AnimatePresence initial={!reduce}>
        {items.map((t) => (
          // A div (not a button) so an inline action <button> (e.g. Undo) can
          // nest legitimately — no invalid-HTML / button-in-button. Clicking the
          // capsule body still dismisses; the action button stops propagation so
          // a tap on Undo doesn't ALSO dismiss before its handler is read.
          <motion.div
            key={t.id}
            role="status"
            onClick={() => onDismiss(t.id)}
            initial={reduce ? { opacity: 0 } : { opacity: 0, y: -44 }}
            animate={reduce ? { opacity: 1 } : { opacity: 1, y: 0 }}
            exit={
              reduce
                ? { opacity: 0, transition: { duration: 0.12 } }
                : { opacity: 0, y: -24, transition: TOAST_SPRING_OUT }
            }
            transition={reduce ? { duration: 0.12 } : TOAST_SPRING}
            style={{
              pointerEvents: 'auto',
              // Glass capsule, 36px tall.
              height: 36,
              display: 'inline-flex',
              alignItems: 'center',
              gap: 8,
              padding: t.action ? '0 6px 0 14px' : '0 14px',
              borderRadius: 18,
              border: '1px solid rgba(255,255,255,0.10)',
              background: 'rgba(20,20,20,0.72)',
              backdropFilter: 'blur(18px) saturate(140%)',
              WebkitBackdropFilter: 'blur(18px) saturate(140%)',
              boxShadow: '0 8px 28px -10px rgba(0,0,0,0.55)',
              color: '#fff',
              font: '600 13px/1 ui-sans-serif, system-ui, -apple-system, sans-serif',
              cursor: 'pointer',
              maxWidth: 'min(92vw, 420px)',
            }}
          >
            <span
              aria-hidden
              style={{
                width: 8,
                height: 8,
                borderRadius: 9999,
                flex: '0 0 auto',
                background: TONE_DOT[t.tone],
                boxShadow: `0 0 8px ${TONE_DOT[t.tone]}`,
              }}
            />
            <span
              style={{
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap',
              }}
            >
              {t.message}
            </span>
            {t.action && (
              <button
                type="button"
                onClick={(e) => {
                  // Run the action FIRST, then dismiss — and stop the capsule's
                  // own dismiss-on-click from also firing (double dismiss is
                  // harmless but the explicit order keeps intent clear).
                  e.stopPropagation()
                  t.action?.onClick()
                  onDismiss(t.id)
                }}
                style={{
                  pointerEvents: 'auto',
                  flex: '0 0 auto',
                  // 44pt HIG hit-target floor (P2 polish — the button was 28px,
                  // below the touch minimum). The button itself is a transparent
                  // 44px-tall box (top/bottom margin pulls it back inside the
                  // 36px capsule so the capsule doesn't grow); the VISIBLE chip is
                  // the inner span, kept compact. So the tappable area meets the
                  // floor while the chip still reads small within the capsule.
                  minHeight: 44,
                  marginTop: -4,
                  marginBottom: -4,
                  display: 'inline-flex',
                  alignItems: 'center',
                  padding: 0,
                  border: 'none',
                  background: 'transparent',
                  cursor: 'pointer',
                }}
              >
                <span
                  style={{
                    display: 'inline-flex',
                    alignItems: 'center',
                    height: 28,
                    padding: '0 12px',
                    borderRadius: 14,
                    background: 'rgba(255,255,255,0.14)',
                    color: '#fff',
                    font: '600 13px/1 ui-sans-serif, system-ui, -apple-system, sans-serif',
                  }}
                >
                  {t.action.label}
                </span>
              </button>
            )}
          </motion.div>
        ))}
      </AnimatePresence>
    </div>
  )
}
