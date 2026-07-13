// AgentToolsHost — the single shell-level mount of the provider-aware tools manager.
//
// All three entry points (focus title-bar icon · ⌘K command · Settings section)
// call `useAgentToolsSheet().openSheet(sessionName?)`; this host renders the ONE
// <AgentToolsSheet> instance bound to that store, so they share state without
// prop-drilling. It is mounted from <CommandPalette> (already mounted once in
// <Layout>), giving it shell scope with no layout.tsx change.
//
// The store carries only the focused session NAME; the host resolves that to the
// project working dir (`cwd`) from the live sessions list so the registry read
// scopes `.mcp.json` / `.claude/skills` / `.claude/commands` to the right
// project. `null` session → global-only (no cwd).

import { useAgentToolsSheet } from '@/stores/claude-tools-store'
import { useSessions } from '@/hooks/use-sessions'
import { AgentToolsSheet } from './claude-tools-sheet'

export function AgentToolsHost() {
  const open = useAgentToolsSheet((s) => s.open)
  const setOpen = useAgentToolsSheet((s) => s.setOpen)
  const sessionName = useAgentToolsSheet((s) => s.sessionName)
  const { sessions } = useSessions()

  const session =
    sessionName != null
      ? sessions.find((s) => s.name === sessionName)
      : undefined
  const cwd = session?.dir || undefined

  return (
    <AgentToolsSheet
      open={open}
      onOpenChange={setOpen}
      cwd={cwd}
      sessionName={sessionName}
      provider={session?.provider}
    />
  )
}

export default AgentToolsHost
