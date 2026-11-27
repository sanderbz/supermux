/**
 * Chat file quick-look — which runs of chat text are FILES.
 *
 * A path Claude writes becomes a button that opens the file over the chat. The
 * cost of a false positive is a link to "File not found" on something that was
 * never a file (`console.log`, `and/or`, `npm run build`); the cost of a false
 * negative is the old dig through the Files tree. Both directions are pinned.
 */
import { describe, expect, test } from 'bun:test'
import type { ComponentType } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'

import { chatComponents } from '../../src/components/chat/markdown/chat-components'
import { filePathCandidate, resolveFilePath } from '../../src/components/chat/markdown/file-path'

const CWD = '/home/jan/projects/app'

describe('filePathCandidate — true positives', () => {
  test.each([
    ['/home/jan/projects/app/.env', '/home/jan/projects/app/.env'],
    ['/abs/path/file.env', '/abs/path/file.env'],
    ['~/notes/plan.md', '~/notes/plan.md'],
    ['./scripts/deploy.sh', './scripts/deploy.sh'],
    ['../shared/config.toml', '../shared/config.toml'],
    ['src/lib/path.ts', 'src/lib/path.ts'],
    ['docs/superpowers/plans/2026-11-27-quicklook.md', 'docs/superpowers/plans/2026-11-27-quicklook.md'],
    ['web/src/app.tsx:42', 'web/src/app.tsx'],
    ['server/src/main.rs:12:5', 'server/src/main.rs'],
    ['src/foo.ts#L10-L20', 'src/foo.ts'],
    ['package.json', 'package.json'],
    ['README.md', 'README.md'],
    ['.env', '.env'],
    ['.env.local', '.env.local'],
    ['.env.example', '.env.example'],
    ['Cargo.lock', 'Cargo.lock'],
    ['yarn.lock', 'yarn.lock'],
    ['config.toml', 'config.toml'],
    ['Makefile', 'Makefile'],
    ['infra/Dockerfile', 'infra/Dockerfile'],
    ['assets/logo@2x.png', 'assets/logo@2x.png'],
    ['  /tmp/out/report.pdf  ', '/tmp/out/report.pdf'],
  ])('%s', (text, expected) => {
    expect(filePathCandidate(text)).toBe(expected)
  })
})

describe('filePathCandidate — false positives it refuses', () => {
  test.each([
    'npm run build',
    'cargo check',
    'https://example.com/a/b.md',
    'http://localhost:5173/files',
    'mailto:jan@example.com',
    'file:///etc/hosts.txt',
    'C:\\Users\\jan\\x.txt',
    '//cdn.example.com/x.js',
    'a/b',
    'and/or',
    'TCP/IP',
    '/api/file', // an API route, not a file
    '/Users/jan/projects/app', // a directory
    'src/components/', // a directory, said so
    '@tanstack/react-query',
    '1/2.5',
    'console.log',
    'React.lazy',
    'example.com',
    // property access and method calls that look like `name.ext`
    'process.env',
    'import.meta.env',
    'res.json',
    'req.json',
    'event.key',
    'e.key',
    'mutex.lock',
    'self.cfg',
    'df.sample',
    'schema.properties',
    'this.json',
    // products, not files
    'Next.js',
    'Node.js',
    'Vue.js',
    'Three.js',
    'Chart.js',
    'D3.js',
    'Express.js',
    'Nuxt.js',
    'v1.2.3',
    'e.g.',
    'src/**/*.ts',
    '$HOME/.zshrc',
    'foo(bar).ts',
    'a.md, b.md',
    '~root/.bashrc',
    '/',
    '~',
    '.',
    '..',
    '',
  ])('%s', (text) => {
    expect(filePathCandidate(text)).toBeNull()
  })
})

describe('a link target may carry an escaped space', () => {
  test('href mode keeps the space; inline code does not', () => {
    expect(filePathCandidate('docs/plan v2.md', { href: true })).toBe('docs/plan v2.md')
    expect(filePathCandidate('docs/plan v2.md:3', { href: true })).toBe('docs/plan v2.md')
    expect(filePathCandidate('docs/plan v2.md')).toBeNull()
    expect(filePathCandidate('npm run build', { href: true })).toBeNull()
  })
})

describe('resolveFilePath', () => {
  test('absolute passes through, normalised', () => {
    expect(resolveFilePath('/a/b/../c/./d.md', CWD)).toBe('/a/c/d.md')
    expect(resolveFilePath('/a/b.md')).toBe('/a/b.md')
  })
  test('a home path is left for the server to expand', () => {
    expect(resolveFilePath('~/x/y.md', CWD)).toBe('~/x/y.md')
    expect(resolveFilePath('~/x/y.md')).toBe('~/x/y.md')
  })
  test('relative resolves on the working dir', () => {
    expect(resolveFilePath('src/app.ts', CWD)).toBe('/home/jan/projects/app/src/app.ts')
    expect(resolveFilePath('./.env', `${CWD}/`)).toBe('/home/jan/projects/app/.env')
    expect(resolveFilePath('../other/plan.md', CWD)).toBe('/home/jan/projects/other/plan.md')
    expect(resolveFilePath('package.json', CWD)).toBe('/home/jan/projects/app/package.json')
  })
  test('relative with no working dir is not a link — never a guess', () => {
    expect(resolveFilePath('src/app.ts')).toBeNull()
    expect(resolveFilePath('src/app.ts', '')).toBeNull()
  })
  test('a line citation is dropped', () => {
    expect(resolveFilePath('src/app.ts:42', CWD)).toBe('/home/jan/projects/app/src/app.ts')
  })
  test('not a file, not a link', () => {
    expect(resolveFilePath('npm run build', CWD)).toBeNull()
  })
})

/* ── the markdown map ─────────────────────────────────────────────────────── */

type AnyComponent = ComponentType<Record<string, unknown>>

function render(name: 'code' | 'a', props: Record<string, unknown>, ctx = {}): string {
  const C = chatComponents({ cwd: CWD, onOpenPath: () => {}, ...ctx })[name] as AnyComponent
  return renderToStaticMarkup(<C {...props} />)
}

describe('the chat markdown map', () => {
  test('an inline code path is a named button that keeps its chip', () => {
    const out = render('code', { children: '/abs/path/plan.md' })
    expect(out).toContain('role="button"')
    // The accessible name is the visible text (WCAG 2.5.3).
    expect(out).not.toContain('aria-label=')
    expect(out).toContain('data-file-link="/abs/path/plan.md"')
    expect(out).toContain('tabindex="0"')
    // The chip is still the chip: same element, same wash.
    expect(out).toContain('<code')
    expect(out).toContain('bg-fill-soft')
  })

  test('a relative path carries its resolved target', () => {
    expect(render('code', { children: 'src/app.ts' })).toContain(
      'data-file-link="/home/jan/projects/app/src/app.ts"',
    )
  })

  test('code that is not a path stays plain code', () => {
    const out = render('code', { children: 'npm run build' })
    expect(out).not.toContain('role="button"')
    expect(out).toContain('<code')
  })

  test('without an opener nothing becomes a button (benches, other callers)', () => {
    const C = chatComponents({ cwd: CWD }).code as AnyComponent
    const out = renderToStaticMarkup(<C>/abs/path/plan.md</C>)
    expect(out).not.toContain('role="button"')
  })

  test('a fenced block is never a link, even when it is one path', () => {
    const out = render('code', { className: 'sm-fence', children: '/abs/path/plan.md' })
    expect(out).not.toContain('role="button"')
  })

  test('a markdown link to a file opens the quick look instead of routing', () => {
    const out = render('a', { href: 'docs/plan%20v2.md', children: 'the plan' })
    expect(out).toContain('role="button"')
    expect(out).toContain('data-file-link="/home/jan/projects/app/docs/plan v2.md"')
    expect(out).not.toContain('href=')
  })

  test('file://localhost/ is the same file as file:///', () => {
    expect(render('a', { href: 'file://localhost/tmp/x.md', children: 'x' })).toContain(
      'data-file-link="/tmp/x.md"',
    )
  })

  test('code inside a web link stays the link — no control inside a control', () => {
    const Code = chatComponents({ cwd: CWD, onOpenPath: () => {} }).code as AnyComponent
    const out = render('a', {
      href: 'https://github.com/o/r/blob/main/src/a.ts',
      children: <Code>src/a.ts</Code>,
    })
    expect(out).toContain('href="https://github.com/o/r/blob/main/src/a.ts"')
    expect(out).not.toContain('role="button"')
  })

  test('code inside a file link is not a second, nested file button', () => {
    const Code = chatComponents({ cwd: CWD, onOpenPath: () => {} }).code as AnyComponent
    const out = render('a', { href: 'docs/b.md', children: <Code>other.md</Code> })
    expect(out.match(/role="button"/g)?.length).toBe(1)
    expect(out).toContain('data-file-link="/home/jan/projects/app/docs/b.md"')
    expect(out).not.toContain('other.md"')
  })

  test('a web link stays a web link', () => {
    const out = render('a', { href: 'https://example.com/plan.md', children: 'plan' })
    expect(out).toContain('href="https://example.com/plan.md"')
    expect(out).not.toContain('role="button"')
  })
})
