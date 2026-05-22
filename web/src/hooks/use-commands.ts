// useCommands — TanStack Query bindings for the M18 composer surfaces.
//
// Two caches, both backed by the M9 authed endpoints:
//   * `useSlashCommands()` — `GET /api/slash-commands`, cached 60s (the command
//     set rarely changes mid-session; §M18 subagent prompt). Powers the "/"
//     slash menu.
//   * `useSnippets()` + mutations — `GET/POST/PATCH/DELETE /api/snippets`,
//     powers the snippet panel + editor. Mutations invalidate the list so the
//     panel reflects writes immediately.
//
// No polling — the slash command list is static enough for a 60s staleTime and
// the snippet list is cache-invalidated on every local write (the only writer).

import {
  useMutation,
  useQuery,
  useQueryClient,
} from '@tanstack/react-query'

import {
  commandsApi,
  type SlashCommand,
  type SnippetCreateInput,
  type SnippetPatchInput,
  type SnippetRow,
} from '@/lib/api'

const SLASH_KEY = ['slash-commands'] as const
const SNIPPETS_KEY = ['snippets'] as const

/** The merged built-in + skill slash-command list (cached 60s). */
export function useSlashCommands() {
  return useQuery<SlashCommand[]>({
    queryKey: SLASH_KEY,
    queryFn: commandsApi.listSlashCommands,
    staleTime: 60_000,
    retry: false,
  })
}

/** All snippets, ordered by `position`. */
export function useSnippets() {
  return useQuery<SnippetRow[]>({
    queryKey: SNIPPETS_KEY,
    queryFn: commandsApi.listSnippets,
    staleTime: 30_000,
    retry: false,
  })
}

/** Create a snippet, then refresh the list. */
export function useCreateSnippet() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (input: SnippetCreateInput) => commandsApi.createSnippet(input),
    onSuccess: () => qc.invalidateQueries({ queryKey: SNIPPETS_KEY }),
  })
}

/** Patch a snippet (title / body / position), then refresh. */
export function usePatchSnippet() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: ({ id, patch }: { id: number; patch: SnippetPatchInput }) =>
      commandsApi.patchSnippet(id, patch),
    onSuccess: () => qc.invalidateQueries({ queryKey: SNIPPETS_KEY }),
  })
}

/** Delete a snippet, then refresh the list. */
export function useDeleteSnippet() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (id: number) => commandsApi.deleteSnippet(id),
    onSuccess: () => qc.invalidateQueries({ queryKey: SNIPPETS_KEY }),
  })
}
