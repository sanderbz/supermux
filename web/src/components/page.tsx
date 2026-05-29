import * as React from 'react'

import { cn } from '@/lib/utils'

/** Consistent route scaffold: a Title-Case (never UPPERCASE) heading over a
 *  centered content area. Used by every route's placeholder. */
export function Page({
  title,
  children,
  className,
}: {
  title: string
  children: React.ReactNode
  className?: string
}) {
  return (
    <div
      className={cn(
        'mx-auto flex h-full w-full max-w-5xl flex-col px-4 py-6 sm:px-6',
        className,
      )}
    >
      <h1 className="text-2xl font-semibold tracking-tight">{title}</h1>
      <div className="flex flex-1 items-center justify-center">{children}</div>
    </div>
  )
}
