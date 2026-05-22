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
  type ToastApi,
  type ToastOptions,
  type ToastTone,
} from './use-toast'

interface ToastItem extends Required<Omit<ToastOptions, 'duration'>> {
  id: number
  duration: number
}

const MAX_STACK = 3
const DEFAULT_DURATION = 2500

const TONE_DOT: Record<ToastTone, string> = {
  default: 'hsl(var(--accent))',
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
    ({ message, tone = 'default', duration = DEFAULT_DURATION }: ToastOptions) => {
      const id = nextId.current++
      setItems((prev) => [...prev, { id, message, tone, duration }].slice(-MAX_STACK))
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
          <motion.button
            key={t.id}
            type="button"
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
              padding: '0 14px',
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
          </motion.button>
        ))}
      </AnimatePresence>
    </div>
  )
}
