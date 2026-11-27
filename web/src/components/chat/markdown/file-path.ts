/**
 * Is this run of chat text a FILE on disk? (chat file quick-look)
 * ─────────────────────────────────────────────────────────────────────────────
 * Claude names files constantly — the plan it wrote, the `.env` it wants the
 * user to fill in with a key that must never travel through the chat — and the
 * user then had to walk the Files tree folder by folder to find it. A path in an
 * assistant bubble is therefore a destination, and this module decides which
 * runs of text ARE one.
 *
 * WHERE IT LOOKS. Only at what the author already set apart: an inline code
 * span (`/abs/plan.md`) and a markdown link's href (`[plan](docs/plan.md)`).
 * Never at bare prose — a regex over arbitrary sentences is exactly the thing
 * the mention pass refuses to be, and "and/or" is not a folder.
 *
 * WHAT COUNTS. A candidate has to look like a FILE, not merely like a path:
 *
 *   · absolute (`/…`), home (`~/…`) and explicit relative (`./…`, `../…`)
 *     paths, and relative paths with a slash (`src/app.ts`), whose last segment
 *     has a letter-bearing extension (`plan.md`), is a dotfile (`.env`), or is
 *     one of the well-known extensionless names (`Makefile`). That one rule
 *     rejects directories (which the quick look cannot show anyway), API routes
 *     (`/api/file`), `and/or`, `@scope/pkg` and `1/2.5`;
 *   · a bare name (`package.json`, `.env.local`) only with an extension from a
 *     file-type allowlist, because `console.log`, `React.lazy` and `example.com`
 *     are all bare dotted words too;
 *   · never anything with whitespace (`npm run build`), a URL scheme, a glob or
 *     shell metacharacter (`src/**\/*.ts`, `$HOME/x`), or a Windows drive.
 *
 * A trailing `:42` / `:42:7` (how Claude cites a line) is accepted and dropped:
 * the quick look opens the file, not the line.
 *
 * RESOLUTION. Absolute and `~/` paths go to the server as written — `to_abs`
 * expands the tilde there, against the server's own `$HOME`, which is the only
 * home that means anything. A relative path is joined onto the session's
 * working directory here; with no working directory it is not a link at all,
 * rather than a link that guesses.
 *
 * Pure and dependency-free: it runs inside the lazy markdown chunk and in the
 * unit runner, and imports nothing from either.
 */

/** Extensionless file names common enough to be worth a link. */
const BARE_NAMES = new Set([
  'Makefile',
  'Dockerfile',
  'Containerfile',
  'Procfile',
  'Gemfile',
  'Rakefile',
  'Justfile',
  'justfile',
  'Vagrantfile',
  'Brewfile',
  'LICENSE',
  'README',
  'CHANGELOG',
  'CODEOWNERS',
])

/**
 * Extensions a BARE file name (no slash) must carry to be a link. Deliberately
 * excludes the ones that are mostly something else in prose: TLDs (`.com`,
 * `.io`, `.dev`, `.ai`, `.app`), `.log` (`console.log` is a method call), and
 * the ones a property access ends in (`e.key`, `self.cfg`, `df.sample`,
 * `schema.properties`). `.env` / `.env.local` / `.env.example` are dotfiles
 * and pass on that rule instead; `process.env` does not. `.lock` is gated on
 * {@link LOCKFILE_STEMS} — `mutex.lock` is a method call.
 */
const BARE_EXTS = new Set([
  'md', 'mdx', 'markdown', 'txt', 'rst', 'adoc',
  'json', 'jsonc', 'json5', 'jsonl', 'ndjson', 'yaml', 'yml', 'toml', 'ini', 'conf',
  'plist', 'xml', 'csv', 'tsv',
  'ts', 'tsx', 'mts', 'cts', 'js', 'jsx', 'mjs', 'cjs', 'vue', 'svelte', 'astro',
  'css', 'scss', 'sass', 'less', 'html', 'htm',
  'rs', 'go', 'py', 'rb', 'php', 'java', 'kt', 'kts', 'swift', 'c', 'h', 'cc', 'cpp', 'hpp',
  'cs', 'scala', 'lua', 'ex', 'exs', 'erl', 'zig', 'nim', 'dart', 'r', 'jl', 'pl',
  'sh', 'bash', 'zsh', 'fish', 'ps1', 'sql', 'graphql', 'gql', 'proto', 'prisma',
  'patch', 'diff', 'pem', 'crt', 'pub',
  'png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'avif', 'ico', 'pdf',
  'mp4', 'webm', 'mov', 'mp3', 'wav', 'ogg', 'm4a',
  'zip', 'tar', 'gz', 'tgz',
])

/** Stems of the lockfiles worth a link (`package-lock` is `.json`). */
const LOCKFILE_STEMS = new Set([
  'cargo', 'yarn', 'bun', 'gemfile', 'poetry', 'flake', 'composer',
  'pipfile', 'uv', 'deno', 'mix', 'podfile',
])

/** Receivers: `res.json`, `event.key`, `import.meta.env` — code, not files. */
const RECEIVER_STEMS = new Set([
  'process', 'import.meta', 'res', 'req', 'request', 'response', 'e', 'evt', 'event',
  'self', 'this', 'window', 'document', 'console', 'module', 'exports',
])

/** `Next.js` and friends are products, not files in the working dir. */
const PRODUCT_STEMS = new Set([
  'next', 'node', 'vue', 'three', 'chart', 'd3', 'express', 'nuxt', 'nest', 'deno',
  'react', 'angular', 'ember', 'backbone', 'socket.io', 'p5', 'anime', 'moment',
])

/** Characters that make a run code or a pattern rather than a path. */
const NOT_A_PATH = /[\s*?<>|"'`$!{}()[\];,=&^%\\]/

/** `scheme:` — a URL, a `mailto:`, a `data:` URI, a `C:` drive. */
const SCHEME = /^[A-Za-z][A-Za-z0-9+.-]*:/

/** `:42` / `:42:7` / `#L42` — a line citation, dropped before the test. */
const LINE_SUFFIX = /(?::\d+(?::\d+)?|#L\d+(?:-L?\d+)?)$/

/** A last segment that names a file: an extension with a letter in it, a
 *  dotfile, or a well-known extensionless name. */
function looksLikeFileName(name: string): boolean {
  if (!name || name === '.' || name === '..') return false
  if (BARE_NAMES.has(name)) return true
  // Dotfile: `.env`, `.gitignore`, `.env.local`.
  if (/^\.[A-Za-z0-9_][\w.-]*$/.test(name)) return true
  // `stem.ext`, the extension 1–10 chars with at least one letter (`1/2.5`
  // and `v1.2` are numbers, not files).
  return /^[\w@+~-][\w.@+~-]*\.(?=[A-Za-z0-9]*[A-Za-z])[A-Za-z0-9]{1,10}$/.test(name)
}

/**
 * The file a run of chat text names, as WRITTEN (line suffix dropped), or
 * `null` when it is not one. Resolution against a working dir is separate
 * ({@link resolveFilePath}) so this half can be tested without one.
 *
 * `href: true` is for a markdown link target, where a space is a decoded
 * `%20` the author escaped on purpose — not the gap between a command and its
 * arguments. It is tested as an underscore and returned as written.
 */
export function filePathCandidate(raw: string, opts?: { href?: boolean }): string | null {
  const text = raw.trim()
  if (!opts?.href) return candidate(text)
  const probed = candidate(text.replace(/ /g, '_'))
  // `candidate` only ever trims the END (the line suffix), so its answer is a
  // prefix of the probe and therefore the same length of the original.
  return probed === null ? null : text.slice(0, probed.length)
}

function candidate(text: string): string | null {
  if (text.length < 2 || text.length > 1024) return null
  if (NOT_A_PATH.test(text)) return null
  const path = text.replace(LINE_SUFFIX, '')
  // After the line suffix is gone, any colon left is a scheme or a drive.
  if (SCHEME.test(path) || path.includes(':')) return null
  if (path.startsWith('//')) return null // protocol-relative URL
  if (path.endsWith('/')) return null // a directory, said so

  const slash = path.lastIndexOf('/')
  const name = slash >= 0 ? path.slice(slash + 1) : path
  if (!looksLikeFileName(name)) return null

  if (slash < 0) {
    // A bare name — the riskiest shape, so it has to earn it: a dotfile, a
    // well-known name, or an allowlisted extension.
    if (BARE_NAMES.has(name) || name.startsWith('.')) return path
    const dot = name.lastIndexOf('.')
    const stem = name.slice(0, dot).toLowerCase()
    const ext = name.slice(dot + 1).toLowerCase()
    if (RECEIVER_STEMS.has(stem)) return null
    if (ext === 'js' && PRODUCT_STEMS.has(stem)) return null
    if (ext === 'lock') return LOCKFILE_STEMS.has(stem) ? path : null
    return BARE_EXTS.has(ext) ? path : null
  }

  if (path.startsWith('/')) return path
  if (path.startsWith('~/')) return path
  if (path.startsWith('~')) return null // `~user/…` — not ours to expand
  if (path.startsWith('@')) return null // `@scope/pkg.js` reads as a package
  return path
}

/** Collapse `.` and `..` segments of an absolute path. Never climbs above `/`. */
function normalizeAbsolute(path: string): string {
  const out: string[] = []
  for (const seg of path.split('/')) {
    if (seg === '' || seg === '.') continue
    if (seg === '..') out.pop()
    else out.push(seg)
  }
  return `/${out.join('/')}`
}

/**
 * The path to hand the files API, or `null` when this run is not a file link.
 *
 * `/abs` and `~/x` pass through (the server expands the tilde); anything
 * relative is joined onto `cwd`, and without a `cwd` there is no link.
 */
export function resolveFilePath(
  raw: string,
  cwd?: string | null,
  opts?: { href?: boolean },
): string | null {
  const path = filePathCandidate(raw, opts)
  if (!path) return null
  if (path.startsWith('/')) return normalizeAbsolute(path)
  if (path.startsWith('~/')) return path
  if (!cwd) return null
  const base = cwd.replace(/\/+$/, '')
  if (base.startsWith('~')) return `${base}/${path.replace(/^\.\//, '')}`
  if (!base.startsWith('/')) return null
  return normalizeAbsolute(`${base}/${path}`)
}
