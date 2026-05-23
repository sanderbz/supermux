// Toast context + hook (M28). Split out of toast.tsx so that component file can
// export only components (keeps React Fast Refresh happy). Import the provider
// from ./toast and the hook from here:
//   import { ToastProvider } from './ui/toast'
//   import { useToast } from './ui/use-toast'

import { createContext, useContext } from 'react'

export type ToastTone = 'default' | 'active' | 'waiting' | 'error'

/** An optional inline action rendered inside the toast (e.g. "Undo"). Clicking
 *  it runs `onClick` then dismisses the toast — used by the overview archive flow
 *  for a 5s reversible window. */
export interface ToastAction {
  label: string
  onClick: () => void
}

export interface ToastOptions {
  message: string
  tone?: ToastTone
  /** Auto-dismiss after this many ms. Default 2500. */
  duration?: number
  /** Optional inline action button (e.g. Undo). */
  action?: ToastAction
}

export interface ToastApi {
  /** Show a toast. Returns its id (for manual dismiss). */
  toast: (opts: ToastOptions) => number
  dismiss: (id: number) => void
}

export const ToastContext = createContext<ToastApi | null>(null)

export function useToast(): ToastApi {
  const ctx = useContext(ToastContext)
  if (!ctx) throw new Error('useToast must be used within <ToastProvider>')
  return ctx
}
