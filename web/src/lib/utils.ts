import { clsx, type ClassValue } from 'clsx'
import { twMerge } from 'tailwind-merge'

/** shadcn `cn()` — merge conditional class lists, de-dupe conflicting Tailwind
 *  utilities (last-wins). Every primitive in `components/ui/` uses this. */
export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}
