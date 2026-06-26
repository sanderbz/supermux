import { apiToken, apiUrl } from '@/lib/api/client'
import { homeDir, projectsDir } from '@/env'

/** Create a fresh subdir under the projects root (or home if unset).
 *
 *  PRAGMATIC SOLUTION: reuse the existing `PUT /api/file` flow with a
 *  placeholder `README.md` inside the target folder — the server's `put_file`
 *  calls `create_dir_all(parent)` before writing, so the folder springs into
 *  existence as a side-effect. `.md` is in the WRITABLE_EXTS allowlist; a
 *  README is also more useful than a hidden `.gitkeep` (the user can edit it
 *  later, or the agent can fill it in). No new server endpoint needed.
 *  Returns the created folder's absolute path on success, or null on failure.
 *
 *  Shared by the WherePicker's "Create a new folder" row and the New-session
 *  panel's default name → auto-folder flow. */
export async function createProjectFolder(name: string): Promise<string | null> {
  const safe = name.replace(/[^A-Za-z0-9._-]/g, '').replace(/^[.]+/, '')
  if (!safe) return null
  const root = (projectsDir() || homeDir()).replace(/\/+$/, '')
  if (!root) return null
  const folder = `${root}/${safe}`
  const token = apiToken()
  const auth: Record<string, string> = token
    ? { Authorization: `Bearer ${token}` }
    : {}
  try {
    // If the folder already EXISTS, reuse it — never write, so we can't truncate
    // an existing README.md (a slug can collide with a real project). Only a
    // brand-new folder gets the placeholder.
    const probe = await fetch(
      apiUrl(`/api/ls?path=${encodeURIComponent(folder)}`),
      { headers: { ...auth } },
    )
    if (probe.ok) return folder
    // Materialise the folder as a side-effect of writing a placeholder README
    // (the server's put_file create_dir_all's the parent). The probe above
    // proved it didn't exist, so this never clobbers anything.
    const res = await fetch(apiUrl('/api/file'), {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', ...auth },
      body: JSON.stringify({ path: `${folder}/README.md`, content: `# ${safe}\n` }),
    })
    if (!res.ok) return null
    return folder
  } catch {
    return null
  }
}
