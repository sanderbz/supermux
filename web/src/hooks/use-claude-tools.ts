// Claude tools data layer — TanStack Query wrappers around `claudeToolsApi`
// (web/src/lib/api/claude.ts). The registry read is the source of truth for the
// manager sheet (MCP servers · skills · commands), grouped by scope with secrets
// already MASKED on the server. Mutations (add / remove / enable / disable)
// invalidate the registry so the list re-reads from the config files.
//
// `retry: false` everywhere — a 404/501 (endpoint not wired in this build, or a
// transient server error) surfaces immediately as `isError` so the sheet shows a
// calm inline error state instead of spinning. The registry is fetched ONLY
// while the sheet is open (`enabled`) — opt-in, no always-on request, and the
// live health probe (`checkMcp`) is NEVER auto-run on list-read (it spawns
// servers); it is a per-row explicit action wired in `useCheckMcp`.

import {
  useMutation,
  useQuery,
  useQueryClient,
  type UseQueryResult,
} from '@tanstack/react-query'

import {
  claudeToolsApi,
  type AddMcpInput,
  type ClaudeRegistry,
  type McpHealth,
  type McpScope,
} from '@/lib/api/claude'

/** Query key — scoped per cwd so switching the focused session re-reads the
 *  right project slice without colliding with the global-only read. */
export function claudeToolsKey(cwd?: string) {
  return ['claude-tools', 'registry', cwd ?? '__global__'] as const
}

/** The grouped registry (MCP / skills / commands), secrets masked. Fetched only
 *  while `enabled` (the sheet is open). `cwd` resolves the project scope. */
export function useClaudeRegistry(
  cwd: string | undefined,
  enabled: boolean,
): UseQueryResult<ClaudeRegistry> {
  return useQuery({
    queryKey: claudeToolsKey(cwd),
    queryFn: () => claudeToolsApi.registry(cwd),
    enabled,
    retry: false,
    staleTime: 15_000,
  })
}

/** Invalidate every registry slice (cwd-scoped + global) after a mutation. */
function useInvalidateRegistry() {
  const qc = useQueryClient()
  return () => qc.invalidateQueries({ queryKey: ['claude-tools', 'registry'] })
}

/** Add an MCP server (guided form OR raw `config` blob). */
export function useAddMcp() {
  const invalidate = useInvalidateRegistry()
  return useMutation({
    mutationFn: (input: AddMcpInput) => claudeToolsApi.addMcp(input),
    onSuccess: invalidate,
  })
}

/** Remove an MCP server from its scope's file. */
export function useRemoveMcp() {
  const invalidate = useInvalidateRegistry()
  return useMutation({
    mutationFn: (vars: { name: string; scope?: McpScope; cwd?: string }) =>
      claudeToolsApi.removeMcp(vars.name, vars.scope, vars.cwd),
    onSuccess: invalidate,
  })
}

/** Trust (enable) / untrust (disable) a project `.mcp.json` server. */
export function useToggleMcp() {
  const invalidate = useInvalidateRegistry()
  return useMutation({
    mutationFn: (vars: { name: string; cwd: string; enable: boolean }) =>
      vars.enable
        ? claudeToolsApi.enableMcp(vars.name, vars.cwd)
        : claudeToolsApi.disableMcp(vars.name, vars.cwd),
    onSuccess: invalidate,
  })
}

/** OPT-IN live health probe (spawns the server). Never auto-run on list-read. */
export function useCheckMcp() {
  return useMutation<
    McpHealth,
    Error,
    { name: string; scope?: McpScope; cwd?: string }
  >({
    mutationFn: (vars) => claudeToolsApi.checkMcp(vars.name, vars.scope, vars.cwd),
  })
}
