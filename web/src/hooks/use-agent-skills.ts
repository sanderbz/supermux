import { useQuery } from '@tanstack/react-query'
import { skillLibrary } from '@/lib/api/skill-library'

export function useCatalog(target: string, enabled = true) {
  return useQuery({
    enabled,
    queryKey: ['agent-skills', target],
    queryFn: () => skillLibrary.list(target),
    refetchInterval: (query) => (query.state.data?.pending ? 5000 : false),
  })
}
