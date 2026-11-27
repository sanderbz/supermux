import { settingsRequest } from './client'

export function supportsManagedSkills(
  session: { provider: string; host_id?: number | null } | null,
) {
  return (
    session != null &&
    session.host_id == null &&
    ['claude', 'codex'].includes(session.provider)
  )
}

export interface SkillCard {
  name: string
  description: string
  revision: string
}
export interface SkillPackage {
  grants?: [string, boolean][]
  revision?: string
  files: Record<string, string>
}
export interface SkillCatalog {
  skills: SkillCard[]
  grants: [string, string, boolean][]
  effective: Record<string, string>
  pending: boolean
  can_edit: boolean
}
const base = '/api/agent-skills'
const item = (name: string) => `${base}/${encodeURIComponent(name)}`
const targetQuery = (target: string) => `?target=${encodeURIComponent(target)}`

export const skillLibrary = {
  sources: (target: string) =>
    settingsRequest<[string, string][]>(
      base + '/-/sources' + targetQuery(target),
    ),
  draft: (target: string, source: string, name: string) =>
    settingsRequest<SkillPackage>(
      base + '/-/sources?' + new URLSearchParams({ target, source, name }),
    ),
  list: (target: string) =>
    settingsRequest<SkillCatalog>(base + targetQuery(target)),
  get: (name: string) => settingsRequest<SkillPackage>(item(name)),
  save: (name: string, pkg: SkillPackage) =>
    settingsRequest(item(name), { method: 'PUT', body: JSON.stringify(pkg) }),
  remove: (card: SkillCard) =>
    settingsRequest(
      item(card.name) + '?revision=' + encodeURIComponent(card.revision),
      { method: 'DELETE' },
    ),
  grant: (name: string, target: string, enabled: boolean) =>
    settingsRequest(item(name) + '/grant' + targetQuery(target), {
      method: 'PUT',
      body: JSON.stringify({ enabled }),
    }),
  revoke: (name: string, target: string) =>
    settingsRequest(item(name) + '/grant' + targetQuery(target), {
      method: 'DELETE',
    }),
}

export function encodeBytes(bytes: Uint8Array): string {
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary)
}

export function markdown(files: Record<string, string>, path: string): string {
  return new TextDecoder().decode(
    Uint8Array.from(atob(files[path] ?? ''), (c) => c.charCodeAt(0)),
  )
}

export function encodeText(text: string): string {
  return encodeBytes(new TextEncoder().encode(text))
}
