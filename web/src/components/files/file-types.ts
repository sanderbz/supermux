// File-type helpers shared across the Files route.
//
// `WRITABLE_EXTS` mirrors the backend whitelist (server/src/files/mod.rs) so
// the editor only offers Save for files the server will actually accept on PUT —
// keeping the affordance honest rather than letting a save 403 after the fact.

import {
  File,
  FileArchive,
  FileAudio,
  FileCode,
  FileImage,
  FileJson,
  FileText,
  FileVideo,
  type LucideIcon,
} from 'lucide-react'
import type { Extension } from '@codemirror/state'

import type { FsEntry } from '@/lib/api'

/** Mirror of the backend's `WRITABLE_EXTS` (server/src/files/mod.rs). */
const WRITABLE_EXTS = new Set([
  'md', 'markdown', 'mdx', 'txt', 'json', 'yml', 'yaml', 'toml', 'ini', 'cfg',
  'sh', 'bash', 'zsh', 'py', 'js', 'ts', 'jsx', 'tsx', 'mjs', 'cjs', 'css',
  'scss', 'less', 'html', 'htm', 'xml', 'svg', 'csv', 'sql', 'graphql', 'proto',
  'go', 'rs', 'java', 'rb', 'php', 'swift', 'kt', 'c', 'cpp', 'h', 'cs', 'r',
  'lua', 'pl', 'env', 'gitignore', 'dockerignore', 'tf', 'hcl', 'conf', 'log',
  'makefile',
])

/** Extension-less files the backend also treats as writable (Dockerfile, …). */
const EXTLESS_WRITABLE = true

export function extOf(name: string): string {
  const dot = name.lastIndexOf('.')
  if (dot <= 0) return '' // no extension, or a dotfile like `.gitignore`
  return name.slice(dot + 1).toLowerCase()
}

/** Is this a Markdown / MDX file? Drives the FileViewer's Preview ↔ Source
 *  toggle in the rendered-markdown surface. Mirrors the backend's
 *  `is_markdown` test (server/src/files/mod.rs). */
export function isMarkdown(name: string): boolean {
  const ext = extOf(name)
  return ext === 'md' || ext === 'markdown' || ext === 'mdx'
}

/** Does the backend accept a PUT to this filename? */
export function isWritable(name: string): boolean {
  const ext = extOf(name)
  if (ext === '') {
    // Dotfiles (`.gitignore`) report no extension; the backend matches their
    // bare name against the whitelist, while truly extension-less files
    // (Dockerfile, Makefile) are writable.
    const bare = name.replace(/^\./, '').toLowerCase()
    return EXTLESS_WRITABLE && (WRITABLE_EXTS.has(bare) || !name.includes('.'))
  }
  return WRITABLE_EXTS.has(ext)
}

const CODE_EXTS = new Set([
  'js', 'ts', 'jsx', 'tsx', 'mjs', 'cjs', 'py', 'go', 'rs', 'java', 'rb', 'php',
  'swift', 'kt', 'c', 'cpp', 'h', 'cs', 'r', 'lua', 'pl', 'sh', 'bash', 'zsh',
  'css', 'scss', 'less', 'html', 'htm', 'xml', 'sql', 'graphql', 'proto', 'tf',
  'hcl', 'toml', 'yml', 'yaml', 'ini', 'cfg', 'conf',
])
const ARCHIVE_EXTS = new Set(['zip', 'tar', 'gz', 'tgz', 'bz2', 'xz', 'rar', '7z'])
const IMAGE_EXTS = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'bmp', 'ico'])
const VIDEO_EXTS = new Set(['mp4', 'mov', 'webm', 'avi', 'mkv', 'm4v'])
const AUDIO_EXTS = new Set(['mp3', 'wav', 'ogg', 'm4a', 'aac', 'flac'])

/** Pick a monochrome lucide glyph for a directory entry. */
export function iconForEntry(entry: FsEntry): LucideIcon {
  if (entry.type === 'dir') return File // dir handled by caller (Folder icon)
  const ext = extOf(entry.name)
  if (IMAGE_EXTS.has(ext)) return FileImage
  if (VIDEO_EXTS.has(ext)) return FileVideo
  if (AUDIO_EXTS.has(ext)) return FileAudio
  if (ARCHIVE_EXTS.has(ext)) return FileArchive
  if (ext === 'json') return FileJson
  if (CODE_EXTS.has(ext)) return FileCode
  if (ext === 'md' || ext === 'markdown' || ext === 'mdx' || ext === 'txt')
    return FileText
  return File
}

/** Lazy-loaded CodeMirror language extensions, keyed by extension. Dynamic
 *  imports keep each grammar out of the initial bundle (perf budget). */
const LANG_LOADERS: Record<string, () => Promise<Extension>> = {
  md: async () => (await import('@codemirror/lang-markdown')).markdown(),
  markdown: async () => (await import('@codemirror/lang-markdown')).markdown(),
  mdx: async () => (await import('@codemirror/lang-markdown')).markdown(),
  js: async () => (await import('@codemirror/lang-javascript')).javascript(),
  mjs: async () => (await import('@codemirror/lang-javascript')).javascript(),
  cjs: async () => (await import('@codemirror/lang-javascript')).javascript(),
  jsx: async () =>
    (await import('@codemirror/lang-javascript')).javascript({ jsx: true }),
  ts: async () =>
    (await import('@codemirror/lang-javascript')).javascript({ typescript: true }),
  tsx: async () =>
    (await import('@codemirror/lang-javascript')).javascript({
      jsx: true,
      typescript: true,
    }),
  json: async () => (await import('@codemirror/lang-json')).json(),
  py: async () => (await import('@codemirror/lang-python')).python(),
  html: async () => (await import('@codemirror/lang-html')).html(),
  htm: async () => (await import('@codemirror/lang-html')).html(),
  css: async () => (await import('@codemirror/lang-css')).css(),
  scss: async () => (await import('@codemirror/lang-css')).css(),
  less: async () => (await import('@codemirror/lang-css')).css(),
  yml: async () => (await import('@codemirror/lang-yaml')).yaml(),
  yaml: async () => (await import('@codemirror/lang-yaml')).yaml(),
  rs: async () => (await import('@codemirror/lang-rust')).rust(),
  sql: async () => (await import('@codemirror/lang-sql')).sql(),
  c: async () => (await import('@codemirror/lang-cpp')).cpp(),
  h: async () => (await import('@codemirror/lang-cpp')).cpp(),
  cpp: async () => (await import('@codemirror/lang-cpp')).cpp(),
  xml: async () => (await import('@codemirror/lang-xml')).xml(),
  svg: async () => (await import('@codemirror/lang-xml')).xml(),
  go: async () => (await import('@codemirror/lang-go')).go(),
  php: async () => (await import('@codemirror/lang-php')).php(),
}

export function languageLoaderFor(name: string): (() => Promise<Extension>) | null {
  return LANG_LOADERS[extOf(name)] ?? null
}

/** Markdown / plain-text wrap; code keeps horizontal scroll. */
export function shouldWrap(name: string): boolean {
  const ext = extOf(name)
  return ext === '' || ext === 'md' || ext === 'markdown' || ext === 'mdx' ||
    ext === 'txt' || ext === 'log'
}

const UNITS = ['B', 'KB', 'MB', 'GB', 'TB']
export function formatBytes(bytes: number): string {
  if (bytes <= 0) return '0 B'
  const i = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), UNITS.length - 1)
  const n = bytes / 1024 ** i
  return `${i === 0 ? n : n.toFixed(n >= 10 || i === 0 ? 0 : 1)} ${UNITS[i]}`
}

/** Relative time from a Unix-epoch-seconds mtime, builder-terse. */
export function formatMtime(epochSeconds: number): string {
  if (!epochSeconds) return ''
  const diff = Date.now() / 1000 - epochSeconds
  if (diff < 60) return 'just now'
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`
  if (diff < 86400 * 7) return `${Math.floor(diff / 86400)}d ago`
  return new Date(epochSeconds * 1000).toLocaleDateString()
}
