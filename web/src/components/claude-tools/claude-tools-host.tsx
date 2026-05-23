// ClaudeToolsHost — the single shell-level mount of the Claude tools manager.
//
// All three entry points (focus title-bar icon · ⌘K command · Settings section)
// call `useClaudeToolsSheet().openSheet(sessionName?)`; this host renders the ONE
// <ClaudeToolsSheet> instance bound to that store, so they share state without
// prop-drilling. It is mounted from <CommandPalette> (already mounted once in
// <Layout>), giving it shell scope with no layout.tsx change.
//
// The store carries only the focused session NAME; the host resolves that to the
// project working dir (`cwd`) from the live sessions list so the registry read
// scopes `.mcp.json` / `.claude/skills` / `.claude/commands` to the right
// project. `null` session → global-only (no cwd).

import { useClaudeToolsSheet } from '@/stores/claude-tools-store'
import { useSessions } from '@/hooks/use-sessions'
import { ClaudeToolsSheet } from './claude-tools-sheet'

export function ClaudeToolsHost() {
  const open = useClaudeToolsSheet((s) => s.open)
  const setOpen = useClaudeToolsSheet((s) => s.setOpen)
  const sessionName = useClaudeToolsSheet((s) => s.sessionName)
  const { sessions } = useSessions()

  const cwd =
    sessionName != null
      ? sessions.find((s) => s.name === sessionName)?.dir || undefined
      : undefined

  return (
    <ClaudeToolsSheet
      open={open}
      onOpenChange={setOpen}
      cwd={cwd}
      sessionName={sessionName}
    />
  )
}

export default ClaudeToolsHost
