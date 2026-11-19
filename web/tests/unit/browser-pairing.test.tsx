import { test, expect } from 'bun:test'
import { fileURLToPath } from 'node:url'

// Other unit files render the production panels on the server and can import
// ReactDOM/Radix before a DOM exists. Those packages cache that environment.
// Run these real DOM interactions in a fresh process; do not mutate the shared
// test runner's window, React module cache, or viewer store.
test('agent feedback settings pair, revoke, and isolate identities in a browser DOM', () => {
  const result = Bun.spawnSync({
    cmd: [process.execPath, 'run', fileURLToPath(new URL('../fixtures/browser-feedback/browser-pairing.fixture.tsx', import.meta.url))],
    cwd: fileURLToPath(new URL('../../', import.meta.url)),
    stdout: 'pipe',
    stderr: 'pipe',
  })
  const output = new TextDecoder().decode(result.stdout) + new TextDecoder().decode(result.stderr)
  if (result.exitCode !== 0) throw new Error(`Browser feedback DOM fixture failed:\n${output}`)
  expect(result.exitCode).toBe(0)
  expect(output).toContain('Browser feedback DOM fixture passed (56 assertions).')
}, 20_000)
