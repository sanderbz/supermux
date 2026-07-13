// SnippetsManagerHost — the single shell-level mount of the snippets manager.
//
// Mirrors AgentToolsHost: every entry point (Settings → Manage snippets, and
// any future ⌘K / focus opener) calls `useSnippetsManager().openSheet()`; this
// host renders the ONE <SnippetsManagerSheet> bound to that store, so they share
// state without prop-drilling. Mounted from <CommandPalette> (already mounted
// once in <Layout>), giving it shell scope with no layout.tsx change.

import { useSnippetsManager } from '@/stores/snippets-manager-store'
import { SnippetsManagerSheet } from './snippets-manager-sheet'

export function SnippetsManagerHost() {
  const open = useSnippetsManager((s) => s.open)
  const setOpen = useSnippetsManager((s) => s.setOpen)
  return <SnippetsManagerSheet open={open} onOpenChange={setOpen} />
}

export default SnippetsManagerHost
